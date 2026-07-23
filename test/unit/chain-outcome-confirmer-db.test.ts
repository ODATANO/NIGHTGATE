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
