/**
 * Reorg rollback of submission evidence (srv/crawler/rollback.ts): what the
 * indexer confirmer recorded at/above the fork height is undone in the
 * rollback's own transaction, against the real in-memory CAP DB. The
 * correlation is the confirmed block HEIGHT: a job's txHash is the ledger
 * identifier, the crawler indexes the Substrate extrinsic hash, the indexer
 * reports a third hash, so the fixtures below use three unrelated values.
 * The chain-data cascade itself is covered by the handleReorg tests in
 * crawler-orchestration.test.ts.
 */

import cds from '@sap/cds';
import { rollbackIndexedDataFromHeight } from '../../srv/crawler/rollback';

cds.test(__dirname + '/../..');

const SYNC_STATE = 'midnight.SyncState';
const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const PENDING = 'midnight.PendingSubmissions';
const JOBS = 'midnight.BackgroundJobs';
const DOCUMENTS = 'midnight.Documents';

let db: any;

async function seedBlock(height: number, hash: string): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: id, hash, height, protocolVersion: 1, timestamp: 1_700_000_000 + height, ledgerParameters: '0xabcd'
    }));
    return id;
}

async function seedTransaction(blockId: string, hash: string, index = 0): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID: id, transactionId: index, hash, protocolVersion: 1, transactionType: 'Regular', block_ID: blockId
    }));
    return id;
}

async function seedSubmission(ID: string, txHash: string, status: string, confirmedAt?: number, extra: Record<string, unknown> = {}): Promise<void> {
    await db.run(cds.ql.INSERT.into(PENDING).entries({
        ID, txHash, status, actionType: 'CALL', submittedAt: new Date().toISOString(),
        finalizedAt: status === 'finalized' ? new Date().toISOString() : null,
        finalizedTxData: status === 'finalized' ? JSON.stringify({ blockHeight: confirmedAt ?? null }) : null,
        chainBlockHeight: confirmedAt ?? null,
        chainBlockHash: confirmedAt != null ? `0xblock${confirmedAt}` : null,
        indexerTxHash: confirmedAt != null ? `0xindexer-${ID}` : null,
        ...extra
    }));
}

async function seedJob(ID: string, patch: Record<string, unknown>): Promise<void> {
    await db.run(cds.ql.INSERT.into(JOBS).entries({
        ID, kind: 'submitContractCall', sessionId: 'sess-1', status: 'succeeded', chainStatus: 'success',
        chainFinalizedAt: new Date().toISOString(), ...patch
    }));
}

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    for (const t of [DOCUMENTS, JOBS, PENDING, TRANSACTIONS, BLOCKS, SYNC_STATE]) await db.run(cds.ql.DELETE.from(t));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'synced', lastIndexedHeight: 11 }));
});

describe('rollbackIndexedDataFromHeight: submission evidence', () => {
    it('returns submissions and jobs confirmed at or above the fork height to their pre-inclusion state, by block height only', async () => {
        const b9 = await seedBlock(9, '0x9');
        const b10 = await seedBlock(10, '0x10');
        // The crawler's rows carry extrinsic hashes that match NOTHING a job stores.
        await seedTransaction(b9, '0xextrinsic-keep');
        await seedTransaction(b10, '0xextrinsic-gone');
        await seedTransaction(b10, '0xextrinsic-failed', 1);
        // Ledger identifiers (what jobs and attempt rows store), confirmed by the indexer at a height.
        await seedSubmission('sub-keep', '00idkeep', 'finalized', 9);
        await seedSubmission('sub-gone', '00idgone', 'finalized', 10);
        await seedSubmission('sub-gone-included', '00idinc', 'included', 11);
        await seedSubmission('sub-unconfirmed', '00idopen', 'included');        // no evidence yet: untouched
        await seedSubmission('sub-failed', '00idfailed', 'failed');             // rejected before the mempool: no height, stays rejected
        await seedSubmission('sub-chain-failed', '00idchainfailed', 'failed', 10, { errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: 'contract call did not apply' });
        await seedJob('job-keep', { txHash: '00idkeep', chainBlockHeight: 9, chainBlockHash: '0xblock9' });
        await seedJob('job-gone', { txHash: '00idgone', chainBlockHeight: 10, chainBlockHash: '0xblock10', indexerTxHash: '0xindexer-gone' });
        await seedJob('job-chain-failed', {
            txHash: '00idfailed', status: 'failed', chainStatus: 'failure', errorCode: 'CHAIN_EXECUTION_FAILED',
            errorMessage: 'Transaction 00idfailed is on-chain but its contract call did not apply', finishedAt: new Date().toISOString(),
            chainBlockHeight: 10
        });
        await seedJob('job-unconfirmed', { txHash: '00idopen', chainStatus: 'pending', chainFinalizedAt: null });
        await seedJob('job-other-failure', { txHash: '00idgone', status: 'failed', chainStatus: null, errorCode: 'TIMEOUT', chainBlockHeight: 10 });
        await db.run(cds.ql.INSERT.into(DOCUMENTS).entries({
            ID: 'doc-1', sha256: 'ab'.repeat(32), anchoredTxHash: '00idgone', anchoredAt: new Date().toISOString()
        }));

        const result = await db.tx((tx: any) => rollbackIndexedDataFromHeight(tx, 10, { syncStatus: 'syncing' }));
        expect(result).toMatchObject({ blocksRolledBack: 1, transactionsRolledBack: 2, submissionsReverted: 3, jobsReverted: 2, reorgGeneration: 1 });
        expect(Number((await db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }))).reorgGeneration)).toBe(1);

        const subs = Object.fromEntries((await db.run(cds.ql.SELECT.from(PENDING))).map((r: any) => [r.ID, r]));
        expect(subs['sub-keep']).toMatchObject({ status: 'finalized', chainBlockHeight: 9 });
        expect(subs['sub-gone']).toMatchObject({ status: 'pending', txHash: '00idgone', finalizedAt: null, finalizedTxData: null, chainBlockHeight: null, chainBlockHash: null, indexerTxHash: null });
        expect(subs['sub-gone-included']).toMatchObject({ status: 'pending', chainBlockHeight: null });
        expect(subs['sub-unconfirmed']).toMatchObject({ status: 'included' });
        expect(subs['sub-failed']).toMatchObject({ status: 'failed' });
        // A chain-proven execution failure is inclusion evidence: back to pending with the job.
        expect(subs['sub-chain-failed']).toMatchObject({ status: 'pending', errorCode: null, errorMessage: null, chainBlockHeight: null });

        const jobs = Object.fromEntries((await db.run(cds.ql.SELECT.from(JOBS))).map((r: any) => [r.ID, r]));
        expect(jobs['job-keep']).toMatchObject({ status: 'succeeded', chainStatus: 'success', chainBlockHeight: 9 });
        expect(jobs['job-gone']).toMatchObject({ status: 'succeeded', chainStatus: 'pending', chainFinalizedAt: null, chainBlockHeight: null, chainBlockHash: null, indexerTxHash: null });
        expect(jobs['job-chain-failed']).toMatchObject({
            status: 'reconciliation_required', chainStatus: 'pending', errorCode: null, errorMessage: null, finishedAt: null, chainBlockHeight: null
        });
        expect(jobs['job-unconfirmed']).toMatchObject({ status: 'succeeded', chainStatus: 'pending' });
        expect(jobs['job-other-failure']).toMatchObject({ status: 'failed', errorCode: 'TIMEOUT' });

        // The anchoring hash names the submitted transaction, not its inclusion: it stays.
        const doc = await db.run(cds.ql.SELECT.one.from(DOCUMENTS).where({ ID: 'doc-1' }));
        expect(doc.anchoredTxHash).toBe('00idgone');
    });

    it('reverts confirmed evidence at the height even when no local block is indexed there (crawler off, manual reindex)', async () => {
        await seedSubmission('sub-x', '00idx', 'finalized', 12);
        await seedJob('job-x', { txHash: '00idx', chainBlockHeight: 12 });
        const result = await db.tx((tx: any) => rollbackIndexedDataFromHeight(tx, 10, { syncStatus: 'stopped' }));
        expect(result).toMatchObject({ blocksRolledBack: 0, submissionsReverted: 1, jobsReverted: 1 });
        expect((await db.run(cds.ql.SELECT.one.from(JOBS).where({ ID: 'job-x' }))).chainStatus).toBe('pending');
    });

    it('bumps the reorg generation as the FIRST write of the rollback, atomically (the confirmer lock waits on it)', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../srv/crawler/rollback.ts'), 'utf8') as string;
        const body = src.slice(src.indexOf('export async function rollbackIndexedDataFromHeight'));
        const bump = body.indexOf('await bumpReorgGeneration(tx)');
        const firstOtherWrite = Math.min(...['DELETE.from', 'UPDATE.entity', 'revertSubmissionEvidence(tx'].map(t => body.indexOf(t)).filter(i => i >= 0));
        expect(bump).toBeGreaterThan(0);
        expect(bump).toBeLessThan(firstOtherWrite);
        expect(body.split('await bumpReorgGeneration(tx)').length - 1).toBe(1);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const helper = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../srv/submission/reorg-generation.ts'), 'utf8') as string;
        expect(helper).toMatch(/SET reorgGeneration = COALESCE\(reorgGeneration, 0\) \+ 1/);
    });

    it('reports zero reverts when nothing was confirmed at or above the fork height', async () => {
        const b10 = await seedBlock(10, '0x10');
        await seedTransaction(b10, '0xforeign');
        await seedSubmission('sub-x', '00idelsewhere', 'finalized', 9);
        const result = await db.tx((tx: any) => rollbackIndexedDataFromHeight(tx, 10, { syncStatus: 'syncing' }));
        expect(result).toMatchObject({ blocksRolledBack: 1, submissionsReverted: 0, jobsReverted: 0 });
        expect((await db.run(cds.ql.SELECT.one.from(PENDING).where({ ID: 'sub-x' }))).status).toBe('finalized');
    });

    it('reports zero reverts when there is nothing to roll back', async () => {
        const result = await db.tx((tx: any) => rollbackIndexedDataFromHeight(tx, 10, { syncStatus: 'stopped' }));
        expect(result).toMatchObject({ blocksRolledBack: 0, submissionsReverted: 0, jobsReverted: 0 });
    });
});
