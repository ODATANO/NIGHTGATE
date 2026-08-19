/**
 * Real-SQLite coverage for confirmChainOutcomesViaIndexer's chainStatus write.
 *
 * The mock-based suite (background-jobs.test.ts) cannot catch SQL NULL semantics:
 * a `chainStatus IN ('pending', NULL)` guard never matches a legacy NULL row in
 * SQL, but the in-memory mock's `includes(null)` does. This boots a REAL CAP DB
 * via cds.test() and asserts a legacy NULL-chainStatus leaf is actually updated.
 */
import { test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import {
    confirmChainOutcomesViaIndexer,
    registerChainOutcomeConfirmer,
    __resetForTests
} from '../../srv/submission/background-jobs';

cds.test(__dirname + '/../..');

const BG = 'midnight.BackgroundJobs';
let db: any;

beforeAll(async () => { db = await cds.connect.to('db'); });

beforeEach(async () => {
    __resetForTests();
    await db.run(cds.ql.DELETE.from(BG));
});

afterEach(() => {
    registerChainOutcomeConfirmer(null);
    __resetForTests();
});

test('advances both a pending and a legacy NULL-chainStatus leaf (real SQL NULL semantics)', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'job-pending', kind: 'submitContractCall', status: 'succeeded', txHash: '0xpending', chainStatus: 'pending' },
        { ID: 'job-legacy',  kind: 'submitContractCall', status: 'succeeded', txHash: '0xlegacy',  chainStatus: null }
    ));
    registerChainOutcomeConfirmer(async () => ({ status: 'success' }));

    const updated = await confirmChainOutcomesViaIndexer(db);

    // The legacy NULL row must update too; an `IN (..., NULL)` guard would miss it.
    expect(updated).toBe(2);
    const rows = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'chainStatus'));
    const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r.chainStatus]));
    expect(byId['job-pending']).toBe('success');
    expect(byId['job-legacy']).toBe('success');
});

test('CAS no-op: does not overwrite a chainStatus already resolved since the scan', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'job-resolved', kind: 'submitContractCall', status: 'succeeded', txHash: '0xresolved', chainStatus: 'success' }
    ));
    // A confirmer that would (wrongly) report failure; the scan excludes resolved
    // rows, and even if it did not the CAS on the read value guards the write.
    registerChainOutcomeConfirmer(async () => ({ status: 'failure' }));

    const updated = await confirmChainOutcomesViaIndexer(db);

    expect(updated).toBe(0);
    const row = await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'job-resolved' }));
    expect(row.chainStatus).toBe('success');
});

test('resolves reconciliation_required rows of identifier-keyed sponsor kinds via the indexer (success -> succeeded, failure -> failed), others untouched', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'sp-ok',   kind: 'sponsorUnboundTransaction',   status: 'reconciliation_required', txHash: '00id-ok' },
        { ID: 'sp-bad',  kind: 'sponsorFinalizedTransaction', status: 'reconciliation_required', txHash: '00id-bad' },
        { ID: 'sp-wait', kind: 'sponsorUnboundTransaction',   status: 'reconciliation_required', txHash: '00id-wait' },
        { ID: 'other',   kind: 'submitContractCall',          status: 'reconciliation_required', txHash: '0xother' }
    ));
    registerChainOutcomeConfirmer(async (txHash: string) =>
        txHash === '00id-ok' ? { status: 'success' } : txHash === '00id-bad' ? { status: 'failure' } : null);

    await confirmChainOutcomesViaIndexer(db);

    const rows = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'status', 'chainStatus', 'errorCode', 'result'));
    const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r]));
    expect(byId['sp-ok'].status).toBe('succeeded');
    expect(byId['sp-ok'].chainStatus).toBe('success');
    expect(JSON.parse(byId['sp-ok'].result)).toMatchObject({ reconciled: true, txHash: '00id-ok' });
    expect(byId['sp-bad'].status).toBe('failed');
    expect(byId['sp-bad'].chainStatus).toBe('failure');
    expect(byId['sp-bad'].errorCode).toBe('CHAIN_EXECUTION_FAILED');
    expect(byId['sp-wait'].status).toBe('reconciliation_required'); // not indexed yet: stays
    expect(byId['other'].status).toBe('reconciliation_required');   // crawler-keyed kind: not this pass's business
});

test('reconcile-by-identifier also finalizes the attempt PendingSubmissions row and rebuilds the typed result from it', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-ok',  txHash: '00id-ok2',  contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL', submittedAt: new Date().toISOString(), status: 'included', sessionId: 'sp-sess' },
        { ID: 'sub-bad', txHash: '00id-bad2', contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL', submittedAt: new Date().toISOString(), status: 'pending',  sessionId: 'sp-sess' }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-ok',  kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', txHash: '00id-ok2',  submissionId: 'sub-ok' },
        { ID: 'j-bad', kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', txHash: '00id-bad2', submissionId: 'sub-bad' }
    ));
    // the attempt row carries the coordinates the worker announced (JSON in the internal submitIntentData)
    await db.run(cds.ql.UPDATE.entity(PS).set({ submitIntentData: JSON.stringify({ feeSponsor: 'concrete-sponsor', sponsorAccountId: 'acct-1', circuits: ['attest', 'anchorContentRoot'], contractAddress: 'c8f4'.padEnd(64, '0'), note: 'backing-Z' }) }).where({ ID: 'sub-ok' }));
    registerChainOutcomeConfirmer(async (txHash: string) => txHash === '00id-ok2' ? { status: 'success' } : { status: 'failure' });
    await confirmChainOutcomesViaIndexer(db);
    const jobs = Object.fromEntries((await db.run(cds.ql.SELECT.from(BG).columns('ID', 'status', 'result'))).map((r: any) => [r.ID, r]));
    expect(jobs['j-ok'].status).toBe('succeeded');
    // canonical shape: what the action documents, from the announced coordinates (concrete sponsor, not the job's pool-sentinel session)
    expect(JSON.parse(jobs['j-ok'].result)).toEqual({ txHash: '00id-ok2', circuits: ['attest', 'anchorContentRoot'], contractAddress: 'c8f4'.padEnd(64, '0'), note: 'backing-Z', feeSponsor: 'concrete-sponsor', reconciled: true });
    expect(jobs['j-bad'].status).toBe('failed');
    const subs = Object.fromEntries((await db.run(cds.ql.SELECT.from(PS).columns('ID', 'status', 'finalizedAt', 'errorCode'))).map((r: any) => [r.ID, r]));
    expect(subs['sub-ok'].status).toBe('finalized');
    expect(subs['sub-ok'].finalizedAt).toBeTruthy();
    expect(subs['sub-bad'].status).toBe('failed');
    expect(subs['sub-bad'].errorCode).toBe('CHAIN_EXECUTION_FAILED');
});

test('the normal succeeded-confirm pass ALSO finalizes the sponsor attempt row (crawler-free operation left it included before)', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-inc', txHash: '00id-inc', contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL', submittedAt: new Date().toISOString(), status: 'included', sessionId: 'sp-sess' }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-inc', kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'succeeded', txHash: '00id-inc', submissionId: 'sub-inc', chainStatus: 'pending', result: '{"txHash":"00id-inc"}' }
    ));
    registerChainOutcomeConfirmer(async () => ({ status: 'success' }));
    const updated = await confirmChainOutcomesViaIndexer(db);
    expect(updated).toBe(1);
    const job = (await db.run(cds.ql.SELECT.one.from(BG).columns('status', 'chainStatus', 'result').where({ ID: 'j-inc' })));
    expect(job.chainStatus).toBe('success');
    expect(job.result).toBe('{"txHash":"00id-inc"}'); // the original result is kept on a succeeded job
    const sub = await db.run(cds.ql.SELECT.one.from(PS).columns('status', 'finalizedAt').where({ ID: 'sub-inc' }));
    expect(sub.status).toBe('finalized');
    expect(sub.finalizedAt).toBeTruthy();
});

test('identifierKindsOnly (crawler on): the succeeded-pass confirms sponsor kinds only', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'sp',    kind: 'sponsorUnboundTransaction', status: 'succeeded', txHash: '00id-sp', chainStatus: 'pending' },
        { ID: 'call',  kind: 'submitContractCall',        status: 'succeeded', txHash: '0xcall',  chainStatus: 'pending' }
    ));
    registerChainOutcomeConfirmer(async () => ({ status: 'success' }), { identifierKindsOnly: true });
    const updated = await confirmChainOutcomesViaIndexer(db);
    expect(updated).toBe(1);
    const rows = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'chainStatus'));
    const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r.chainStatus]));
    expect(byId['sp']).toBe('success');
    expect(byId['call']).toBe('pending'); // the crawler owns this one
});
