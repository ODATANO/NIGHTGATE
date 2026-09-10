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
    reconcileBackgroundJobs,
    registerChainOutcomeConfirmer,
    declareJobKind,
    __resetForTests
} from '../../srv/submission/background-jobs';
import { JOB_KIND_TRAITS } from '../../srv/submission/job-kinds';
import { CHAIN_ABSENT, chainAbsent } from '../../srv/submission/chain-outcome-confirmer';

cds.test(__dirname + '/../..');

const BG = 'midnight.BackgroundJobs';
let db: any;
const GRANT_ROW = (ID: string, extra: Record<string, unknown> = {}) => ({
    ID, userId: 'op', sessionId: '00000000-0000-4000-8000-000000000001', tokenHash: 'h'.padEnd(64, 'h'),
    allowedActions: '[]', isActive: true, ...extra
});

beforeAll(async () => {
    db = await cds.connect.to('db');
    // the kind table is declared at processor registration; this suite boots no processors
    for (const [kind, traits] of Object.entries(JOB_KIND_TRAITS)) declareJobKind(kind, traits);
});

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
    registerChainOutcomeConfirmer(async () => ({ status: 'success', blockHeight: 4711 }));

    const updated = await confirmChainOutcomesViaIndexer(db);

    // The legacy NULL row must update too; an `IN (..., NULL)` guard would miss it.
    expect(updated).toBe(2);
    const rows = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'chainStatus'));
    const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r.chainStatus]));
    expect(byId['job-pending']).toBe('success');
    expect(byId['job-legacy']).toBe('success');
});

test('a reorg rollback during the indexer lookup refuses the commit; the next tick records the fresh outcome', async () => {
    const SYNC = 'midnight.SyncState';
    await db.run(cds.ql.DELETE.from(SYNC));
    await db.run(cds.ql.INSERT.into(SYNC).entries({ ID: 'SINGLETON', syncStatus: 'synced', reorgGeneration: 3 }));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'job-race', kind: 'submitContractCall', status: 'succeeded', txHash: '00race', chainStatus: 'pending' }
    ));
    // The lookup answers with the OLD fork's block while a rollback bumps the generation.
    registerChainOutcomeConfirmer(async () => {
        await db.run(cds.ql.UPDATE.entity(SYNC).set({ reorgGeneration: 4 }).where({ ID: 'SINGLETON' }));
        return { status: 'success', blockHeight: 900, blockHash: '0xoldfork' };
    });
    expect(await confirmChainOutcomesViaIndexer(db)).toBe(0);
    let row = await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'job-race' }));
    expect(row).toMatchObject({ chainStatus: 'pending', chainBlockHeight: null });
    // Same generation from here on: the fresh outcome commits.
    registerChainOutcomeConfirmer(async () => ({ status: 'success', blockHeight: 901, blockHash: '0xnewfork' }));
    expect(await confirmChainOutcomesViaIndexer(db)).toBe(1);
    row = await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'job-race' }));
    expect(row).toMatchObject({ chainStatus: 'success', chainBlockHeight: 901, chainBlockHash: '0xnewfork' });
    await db.run(cds.ql.DELETE.from(SYNC));
});

test('CAS no-op: does not overwrite a chainStatus already resolved since the scan', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'job-resolved', kind: 'submitContractCall', status: 'succeeded', txHash: '0xresolved', chainStatus: 'success' }
    ));
    // A confirmer that would (wrongly) report failure; the scan excludes resolved
    // rows, and even if it did not the CAS on the read value guards the write.
    registerChainOutcomeConfirmer(async () => ({ status: 'failure', blockHeight: 4711 }));

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
        txHash === '00id-ok' ? { status: 'success', blockHeight: 4711 } : txHash === '00id-bad' ? { status: 'failure', blockHeight: 4711 } : null);

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
    registerChainOutcomeConfirmer(async (txHash: string) => txHash === '00id-ok2' ? { status: 'success', blockHeight: 4711 } : { status: 'failure', blockHeight: 4711 });
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
    registerChainOutcomeConfirmer(async () => ({ status: 'success', blockHeight: 4711 }));
    const updated = await confirmChainOutcomesViaIndexer(db);
    expect(updated).toBe(1);
    const job = (await db.run(cds.ql.SELECT.one.from(BG).columns('status', 'chainStatus', 'result').where({ ID: 'j-inc' })));
    expect(job.chainStatus).toBe('success');
    expect(job.result).toBe('{"txHash":"00id-inc"}'); // the original result is kept on a succeeded job
    const sub = await db.run(cds.ql.SELECT.one.from(PS).columns('status', 'finalizedAt').where({ ID: 'sub-inc' }));
    expect(sub.status).toBe('finalized');
    expect(sub.finalizedAt).toBeTruthy();
});

test('the succeeded-pass confirms every kind with a hash, identifier-keyed or not', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'sp',    kind: 'sponsorUnboundTransaction', status: 'succeeded', txHash: '00id-sp', chainStatus: 'pending' },
        { ID: 'call',  kind: 'submitContractCall',        status: 'succeeded', txHash: '0xcall',  chainStatus: 'pending' }
    ));
    registerChainOutcomeConfirmer(async () => ({ status: 'success', blockHeight: 4711 }));
    const updated = await confirmChainOutcomesViaIndexer(db);
    expect(updated).toBe(2);
    const rows = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'chainStatus'));
    const byId = Object.fromEntries(rows.map((r: any) => [r.ID, r.chainStatus]));
    expect(byId['sp']).toBe('success');
    expect(byId['call']).toBe('success'); // the crawler's CAS on 'pending' is then a no-op
});

test('records the inclusion coordinates on the job and the attempt row (what a reorg rollback reverts by)', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-ev', txHash: '00id-ev', actionType: 'CALL', submittedAt: new Date().toISOString(), status: 'included', sessionId: 's' },
        { ID: 'sub-ev-recon', txHash: '00id-ev2', actionType: 'CALL', submittedAt: new Date().toISOString(), status: 'included', sessionId: 's' }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-ev', kind: 'submitContractCall', status: 'succeeded', txHash: '00id-ev', submissionId: 'sub-ev', chainStatus: 'pending' },
        { ID: 'j-ev-recon', kind: 'sponsorUnboundTransaction', sessionId: 's', status: 'reconciliation_required', txHash: '00id-ev2', submissionId: 'sub-ev-recon' }
    ));
    registerChainOutcomeConfirmer(async (txHash: string) => ({
        status: 'success', blockHeight: txHash === '00id-ev' ? 2415919 : 2415920, blockHash: `0xblock-${txHash}`, indexerTxHash: `0xindexer-${txHash}`
    }));
    await confirmChainOutcomesViaIndexer(db);
    const jobs = Object.fromEntries((await db.run(cds.ql.SELECT.from(BG).columns('ID', 'status', 'chainStatus', 'chainBlockHeight', 'chainBlockHash', 'indexerTxHash'))).map((r: any) => [r.ID, r]));
    expect(jobs['j-ev']).toMatchObject({ chainStatus: 'success', chainBlockHeight: 2415919, chainBlockHash: '0xblock-00id-ev', indexerTxHash: '0xindexer-00id-ev' });
    expect(jobs['j-ev-recon']).toMatchObject({ status: 'succeeded', chainBlockHeight: 2415920, chainBlockHash: '0xblock-00id-ev2' });
    const subs = Object.fromEntries((await db.run(cds.ql.SELECT.from(PS).columns('ID', 'status', 'chainBlockHeight', 'indexerTxHash'))).map((r: any) => [r.ID, r]));
    expect(subs['sub-ev']).toMatchObject({ status: 'finalized', chainBlockHeight: 2415919, indexerTxHash: '0xindexer-00id-ev' });
    expect(subs['sub-ev-recon']).toMatchObject({ status: 'finalized', chainBlockHeight: 2415920 });
});

test('a broadcast the indexer never shows ends failed/BROADCAST_NOT_INCLUDED once the tip is past its ttl; a live ttl, a lagging tip, a bookkeeping-pending row and a workflow parent stay parked', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    const H = 60 * 60 * 1000;
    const now = Date.now();
    const lostTtl = new Date(now - 2 * H).toISOString();
    const sub = (ID: string, txHash: string, submittedAt: number, intent: Record<string, unknown>) => ({
        ID, txHash, contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL',
        submittedAt: new Date(submittedAt).toISOString(), status: 'pending', sessionId: 'sp-sess', submitIntentData: JSON.stringify(intent)
    });
    await db.run(cds.ql.INSERT.into(PS).entries(
        sub('sub-lost',   '00lost',   now - 3 * H, { circuits: ['attest'], ttl: lostTtl }),
        sub('sub-live',   '00live',   now,         { circuits: ['attest'], ttl: new Date(now + 10 * 60_000).toISOString() }),
        sub('sub-legacy', '00legacy', now - 3 * H, { circuits: ['attest'] }),           // announced before the ttl was recorded
        sub('sub-lag',    '00lag',    now - 3 * H, { circuits: ['attest'], ttl: new Date(now - 4 * 60_000).toISOString() }),
        sub('sub-book',   '00book',   now - 3 * H, { circuits: ['attest'], ttl: lostTtl })
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-lost',   kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00lost',   submissionId: 'sub-lost' },
        { ID: 'j-live',   kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00live',   submissionId: 'sub-live' },
        { ID: 'j-legacy', kind: 'submitContractCall',        sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'EXTERNAL_EXECUTION_FAILED', txHash: '00legacy', submissionId: 'sub-legacy' },
        { ID: 'j-lag',    kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00lag',    submissionId: 'sub-lag' },
        { ID: 'j-book',   kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'REJECTED_ATTEMPT_BOOKKEEPING_PENDING', txHash: '00book', submissionId: 'sub-book' },
        { ID: 'j-parent', kind: 'anchorDocumentGuarded',     sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'CHILD_RECONCILIATION_REQUIRED', txHash: '00parent' }
    ));
    // the indexer has none of them (ABSENT, not merely unconfirmable); the answer's own tip is "now" (4 min past j-lag's ttl: inside the 5 min margin)
    registerChainOutcomeConfirmer(async () => chainAbsent(now));

    await confirmChainOutcomesViaIndexer(db);

    const jobs = Object.fromEntries((await db.run(cds.ql.SELECT.from(BG).columns('ID', 'status', 'errorCode', 'errorMessage', 'chainStatus', 'finishedAt'))).map((r: any) => [r.ID, r]));
    expect(jobs['j-lost']).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED', chainStatus: 'dropped' });
    expect(jobs['j-lost'].finishedAt).toBeTruthy();
    expect(String(jobs['j-lost'].errorMessage)).toMatch(/never included/);
    expect(jobs['j-legacy']).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED', chainStatus: 'dropped' });
    expect(String(jobs['j-legacy'].errorMessage)).toMatch(/assumed from the submit time/);
    expect(jobs['j-live'].status).toBe('reconciliation_required');
    expect(jobs['j-lag'].status).toBe('reconciliation_required');
    expect(jobs['j-book']).toMatchObject({ status: 'reconciliation_required', errorCode: 'REJECTED_ATTEMPT_BOOKKEEPING_PENDING' });
    expect(jobs['j-parent'].status).toBe('reconciliation_required');
    const subs = Object.fromEntries((await db.run(cds.ql.SELECT.from(PS).columns('ID', 'status', 'errorCode', 'finalizedAt'))).map((r: any) => [r.ID, r]));
    expect(subs['sub-lost']).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED' });
    expect(subs['sub-lost'].finalizedAt).toBeTruthy();
    expect(subs['sub-live'].status).toBe('pending');
    expect(subs['sub-lag'].status).toBe('pending');

    // the margin passes: the lagging one ends too
    registerChainOutcomeConfirmer(async () => chainAbsent(now + 6 * 60_000));
    await confirmChainOutcomesViaIndexer(db);
    const lag = await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-lag' }));
    expect(lag).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED' });
});

test('an indexed but not yet confirmable transaction (null lookup: unknown status, no height) is NOT absence: the job stays parked past its ttl', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-future', txHash: '00future', contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL', submittedAt: old, status: 'pending', sessionId: 'sp-sess', submitIntentData: JSON.stringify({ circuits: ['attest'], ttl: old }) }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-future', kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00future', submissionId: 'sub-future' }
    ));
    // the indexer HAS the transaction, with a status this build cannot classify (a future status / no block height yet)
    registerChainOutcomeConfirmer(async () => null);
    await confirmChainOutcomesViaIndexer(db);
    expect(await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-future' }))).toMatchObject({ status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED' });
    expect((await db.run(cds.ql.SELECT.one.from(PS).where({ ID: 'sub-future' }))).status).toBe('pending');
});

test("a lost sponsored DEPLOY refunds the grant's deploy reservation exactly once", async () => {
    const PS = 'midnight.PendingSubmissions';
    const AG = 'midnight.AgentGrants';
    await db.run(cds.ql.DELETE.from(PS));
    await db.run(cds.ql.DELETE.from(AG).where({ ID: 'grant-deploy' }));
    await db.run(cds.ql.INSERT.into(AG).entries(GRANT_ROW('grant-deploy', { allowDeploy: true, maxDeploys: 1, deploysUsed: 1 })));
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-deploy', txHash: '00deploy', contractAddress: null, circuitName: null, actionType: 'DEPLOY', submittedAt: old, status: 'pending', sessionId: 'sp-sess',
          submitIntentData: JSON.stringify({ circuits: [], deployed: ['d1'.padEnd(64, '0')], deployReservation: { grantId: 'grant-deploy', count: 1 }, ttl: old }) }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-deploy', kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00deploy', submissionId: 'sub-deploy' }
    ));
    registerChainOutcomeConfirmer(async () => chainAbsent(Date.now()));
    await confirmChainOutcomesViaIndexer(db);
    expect(await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-deploy' }))).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED' });
    expect((await db.run(cds.ql.SELECT.one.from(AG).where({ ID: 'grant-deploy' }))).deploysUsed).toBe(0); // the budget is free again
    // a second pass changes nothing (the row is closed, the job is terminal)
    await confirmChainOutcomesViaIndexer(db);
    expect((await db.run(cds.ql.SELECT.one.from(AG).where({ ID: 'grant-deploy' }))).deploysUsed).toBe(0);
});

test('a workflow parent whose child broadcast was lost ends failed/CHILD_FAILED instead of staying parked', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-child', txHash: '00child', contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'anchorReveal', actionType: 'CALL', submittedAt: old, status: 'pending', sessionId: 'sp-sess', submitIntentData: JSON.stringify({ channel: 'bound', circuits: ['anchorReveal'], ttl: old }) }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-parent2', kind: 'anchorDocumentGuarded', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'CHILD_RECONCILIATION_REQUIRED' },
        { ID: 'j-commit',  kind: 'anchorCommit', sessionId: 'sp-sess', status: 'succeeded', parentJobId: 'j-parent2', workflowStep: 'commit', txHash: '00commit' },
        { ID: 'j-reveal',  kind: 'anchorReveal', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', parentJobId: 'j-parent2', workflowStep: 'reveal', txHash: '00child', submissionId: 'sub-child' }
    ));
    registerChainOutcomeConfirmer(async (txHash: string) => txHash === '00child' ? chainAbsent(Date.now()) : { status: 'success', blockHeight: 1 });
    await confirmChainOutcomesViaIndexer(db);
    expect(await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-reveal' }))).toMatchObject({ status: 'failed', errorCode: 'BROADCAST_NOT_INCLUDED' });
    // the parent reconciler propagates the terminal child failure
    await reconcileBackgroundJobs(db);
    const parent = await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-parent2' }));
    expect(parent).toMatchObject({ status: 'failed', errorCode: 'CHILD_FAILED' });
    expect(String(parent.errorMessage)).toMatch(/step 'reveal'.*BROADCAST_NOT_INCLUDED/);
    expect(String(parent.errorMessage)).toMatch(/already on chain: commit/);
    expect(parent.finishedAt).toBeTruthy();
});

test('an absence whose answer carried no tip gives no verdict: the never-indexed broadcast stays parked', async () => {
    const PS = 'midnight.PendingSubmissions';
    await db.run(cds.ql.DELETE.from(PS));
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await db.run(cds.ql.INSERT.into(PS).entries(
        { ID: 'sub-notip', txHash: '00notip', contractAddress: 'c8f4'.padEnd(64, '0'), circuitName: 'attest', actionType: 'CALL', submittedAt: old, status: 'pending', sessionId: 'sp-sess', submitIntentData: JSON.stringify({ circuits: ['attest'], ttl: old }) }
    ));
    await db.run(cds.ql.INSERT.into(BG).entries(
        { ID: 'j-notip', kind: 'sponsorUnboundTransaction', sessionId: 'sp-sess', status: 'reconciliation_required', errorCode: 'BROADCAST_UNCONFIRMED', txHash: '00notip', submissionId: 'sub-notip' }
    ));
    registerChainOutcomeConfirmer(async () => CHAIN_ABSENT);
    await confirmChainOutcomesViaIndexer(db);
    expect((await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-notip' }))).status).toBe('reconciliation_required');
    registerChainOutcomeConfirmer(async () => chainAbsent(null));
    await confirmChainOutcomesViaIndexer(db);
    expect((await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-notip' }))).status).toBe('reconciliation_required');
    // and a tip that is NOT past the ttl + margin (a lagging replica answered) keeps it parked too
    registerChainOutcomeConfirmer(async () => chainAbsent(Date.parse(old) + 60_000));
    await confirmChainOutcomesViaIndexer(db);
    expect((await db.run(cds.ql.SELECT.one.from(BG).where({ ID: 'j-notip' }))).status).toBe('reconciliation_required');
});
