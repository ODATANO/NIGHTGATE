/**
 * Lease reclaim and budgeted dispatch of the durable job poller, against a
 * real CAP database (cds.test boots the app, so the production kinds are
 * registered; the test re-registers one kind with a gated processor).
 */
import { test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import {
    registerBackgroundJobProcessor, reclaimExpiredLeases, getJobById,
    __pollOnceForTests, __resetForTests
} from '../../srv/submission/background-jobs';
import { declaredJobKindTraits } from '../../srv/submission/job-kinds';

cds.test(__dirname + '/../..');

const BG = 'midnight.BackgroundJobs';
let db: any;

beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => {
    __resetForTests();
    await db.run(cds.ql.DELETE.from(BG));
});
afterEach(() => __resetForTests());

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function row(ID: string, patch: Record<string, unknown>) {
    return {
        ID, kind: 'submitContractCall', sessionId: 'sess-1', status: 'running', attempt: 1, maxAttempts: 1,
        commandVersion: 1, command: JSON.stringify({ op: 'call' }), commandEncoding: 'json-v1',
        leaseOwner: 'dead-host', startedAt: minutesAgo(30), heartbeatAt: minutesAgo(10),
        ...patch
    };
}

async function statusOf(ID: string) {
    const job = await getJobById(ID);
    return { status: job?.status, attempt: job?.attempt, errorCode: job?.errorCode, leaseOwner: job?.leaseOwner };
}

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('condition not met in time');
}

test('a running job without a heartbeat for longer than the TTL is re-queued with the next attempt; fresh, submitted and legacy rows are handled by their rule', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(
        row('stale', {}),
        row('fresh', { heartbeatAt: minutesAgo(1) }),
        row('never-beat', { heartbeatAt: null }),
        row('past-boundary', { status: 'submitted', txHash: 'id-1' }),
        row('legacy-closure', { commandVersion: null, command: null }),
        row('worn-out', { attempt: 4 })
    ));
    const reclaimed = await reclaimExpiredLeases(db);
    expect(reclaimed).toBe(4);
    expect(await statusOf('stale')).toEqual({ status: 'pending', attempt: 2, errorCode: null, leaseOwner: null });
    expect(await statusOf('never-beat')).toEqual({ status: 'pending', attempt: 2, errorCode: null, leaseOwner: null });
    expect((await statusOf('fresh')).status).toBe('running');
    expect((await statusOf('past-boundary')).status).toBe('submitted');
    expect(await statusOf('legacy-closure')).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' });
    expect(await statusOf('worn-out')).toMatchObject({ status: 'failed', errorCode: 'LEASE_EXPIRED' });
    // idempotent: nothing left to reclaim
    expect(await reclaimExpiredLeases(db)).toBe(0);
});

test('the reclaim is a CAS on owner and heartbeat: a lease renewed between scan and write is kept', async () => {
    await db.run(cds.ql.INSERT.into(BG).entries(row('renewed', {})));
    // Simulate the owner heartbeating after the scan: run reclaim against a
    // snapshot whose heartbeat no longer matches the row.
    const before = await getJobById('renewed');
    await db.run(cds.ql.UPDATE.entity(BG).set({ heartbeatAt: new Date().toISOString() }).where({ ID: 'renewed' }));
    // The scan hands back the stale snapshot (as if the heartbeat landed after
    // it); the UPDATE goes to the real database, where the CAS must miss.
    const reclaimed = await reclaimExpiredLeases({ run: async (q: any) => (q?.SELECT ? [{ ...before }] : db.run(q)) });
    expect(reclaimed).toBe(0);
    expect((await statusOf('renewed')).status).toBe('running');
});

test('one poller tick dispatches pending rows up to the free heavy capacity, the rest after completions; a dispatched row is not re-selected', async () => {
    const gates: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    registerBackgroundJobProcessor('submitContractCall', 1, declaredJobKindTraits('submitContractCall'), async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>(r => gates.push(r));
        running--;
        return { ok: true };
    });
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    await db.run(cds.ql.INSERT.into(BG).entries(...ids.map(id => row(id, { status: 'pending', leaseOwner: null, startedAt: null, heartbeatAt: null }))));

    await __pollOnceForTests();
    await until(async () => running === 4);
    // a second tick while the four run must not stack the remaining two behind the semaphore
    await __pollOnceForTests();
    await new Promise(r => setTimeout(r, 100));
    expect(running).toBe(4);
    const claimed = await db.run(cds.ql.SELECT.from(BG).columns('ID', 'status').where({ status: 'running' }));
    expect(claimed).toHaveLength(4);
    expect(gates).toHaveLength(4);

    gates.splice(0).forEach(r => r());
    await until(async () => (await db.run(cds.ql.SELECT.from(BG).columns('ID').where({ status: 'succeeded' }))).length === 4);
    await __pollOnceForTests();
    await until(async () => running === 2);
    gates.splice(0).forEach(r => r());
    await until(async () => (await db.run(cds.ql.SELECT.from(BG).columns('ID').where({ status: 'succeeded' }))).length === 6);
    expect(peak).toBe(4);
});
