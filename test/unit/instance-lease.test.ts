/**
 * The background-work lease against a real CAP database: two holders stand for
 * two processes on one database.
 */
import { test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runtimeUnavailableReason } from '../../srv/utils/runtime-gate';
import { reportBroadcastOn } from '../../srv/submission/job-execution-context';
import {
    setActiveLease, assertLeaseHeld, isBackgroundFenced, fenceBackgroundWork, __resetInstanceLeaseForTests,
    tryAcquireInstanceLease, acquireInstanceLease, renewInstanceLease, releaseInstanceLease,
    startInstanceLeaseHeartbeat, InstanceLeaseHeldError
} from '../../srv/utils/instance-lease';

cds.test(__dirname + '/../..');

const T = 'midnight.InstanceLeases';
const ROLE = 'background';
const TTL = 60_000;
let db: any;

beforeAll(async () => { db = await cds.connect.to('db'); });
beforeEach(async () => { await db.run(cds.ql.DELETE.from(T)); __resetInstanceLeaseForTests(); });
afterEach(() => __resetInstanceLeaseForTests());

const holderOf = async () => (await db.run(cds.ql.SELECT.one.from(T).where({ role: ROLE })))?.instanceId;

test('the first process takes the free lease, a second one sees the live holder', async () => {
    expect(await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL)).toEqual({ acquired: true });
    const second = await tryAcquireInstanceLease(db, ROLE, 'host-b/2', TTL);
    expect(second).toMatchObject({ acquired: false, holder: 'host-a/1' });
    expect(await holderOf()).toBe('host-a/1');
});

test('the holder re-acquires its own lease (restart with the same id)', async () => {
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL);
    expect(await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL)).toEqual({ acquired: true });
});

test('an expired lease is taken over, and the old holder learns it on its next renewal', async () => {
    const past = Date.now() - 2 * TTL;
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL, past);
    expect(await tryAcquireInstanceLease(db, ROLE, 'host-b/2', TTL)).toEqual({ acquired: true });
    expect(await holderOf()).toBe('host-b/2');
    expect(await renewInstanceLease(db, ROLE, 'host-a/1')).toBe(false);
    expect(await renewInstanceLease(db, ROLE, 'host-b/2')).toBe(true);
});

test('two processes racing for an expired lease: exactly one wins', async () => {
    await tryAcquireInstanceLease(db, ROLE, 'dead/0', TTL, Date.now() - 2 * TTL);
    const [a, b] = await Promise.all([
        tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL),
        tryAcquireInstanceLease(db, ROLE, 'host-b/2', TTL)
    ]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
});

test('a released lease is free for the next process at once', async () => {
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL);
    await releaseInstanceLease(db, ROLE, 'host-a/1');
    expect(await tryAcquireInstanceLease(db, ROLE, 'host-b/2', TTL)).toEqual({ acquired: true });
});

test('releasing never removes another holder\'s lease', async () => {
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL);
    await releaseInstanceLease(db, ROLE, 'host-b/2');
    expect(await holderOf()).toBe('host-a/1');
});

test('acquire waits for a killed holder\'s lease to expire, then takes it', async () => {
    // Heartbeat 200 of 300 ms ago: expires within the wait.
    const shortTtl = 300;
    await tryAcquireInstanceLease(db, ROLE, 'killed/9', shortTtl, Date.now() - 200);
    const waits: number[] = [];
    await acquireInstanceLease(db, ROLE, 'host-b/2', shortTtl, { pollMs: 50, onWait: (_h, ms) => waits.push(ms) });
    expect(await holderOf()).toBe('host-b/2');
    expect(waits.length).toBeGreaterThan(0);
});

test('acquire refuses when the holder keeps renewing', async () => {
    const shortTtl = 300;
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', shortTtl);
    const stop = startInstanceLeaseHeartbeat(db, ROLE, 'host-a/1', 50, () => undefined, () => undefined);
    try {
        await expect(acquireInstanceLease(db, ROLE, 'host-b/2', shortTtl, { pollMs: 50 }))
            .rejects.toBeInstanceOf(InstanceLeaseHeldError);
    } finally {
        stop();
    }
    expect(await holderOf()).toBe('host-a/1');
});

test('the heartbeat reports a takeover once and stops', async () => {
    await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL);
    let lost = 0;
    const stop = startInstanceLeaseHeartbeat(db, ROLE, 'host-a/1', 30, () => { lost++; }, () => undefined);
    await db.run(cds.ql.UPDATE.entity(T).set({ instanceId: 'host-b/2' }).where({ role: ROLE }));
    await new Promise(r => setTimeout(r, 200));
    stop();
    expect(lost).toBe(1);
});

describe('insert failures', () => {
    // UPDATE matches nothing, the row stays absent, INSERT fails as given.
    const stub = (insertError: () => Error) => {
        const calls = { insert: 0 };
        const db = {
            run: async (q: any) => {
                if (q?.INSERT) { calls.insert++; throw insertError(); }
                if (q?.SELECT) return undefined;
                return 0;
            }
        };
        return { db, calls };
    };

    test('a failure other than a unique conflict is thrown, not retried', async () => {
        const { db, calls } = stub(() => new Error('disk I/O error'));
        await expect(tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL)).rejects.toThrow(/disk I\/O/);
        expect(calls.insert).toBe(1);
    });

    test('a unique conflict is retried once, then thrown', async () => {
        const { db, calls } = stub(() => new Error('UNIQUE constraint failed: midnight_InstanceLeases.role'));
        await expect(tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL)).rejects.toThrow(/UNIQUE/);
        expect(calls.insert).toBe(2);
    });
});

describe('a process that lost its lease', () => {
    test('passes the broadcast boundary while the row names it', async () => {
        await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL);
        setActiveLease(ROLE, 'host-a/1');
        await expect(assertLeaseHeld(db)).resolves.toBeUndefined();
        await expect(reportBroadcastOn(db, { txHash: 'x' })).resolves.toBeUndefined();
    });

    test('is refused at the broadcast boundary once another process holds the row, and stays fenced', async () => {
        await tryAcquireInstanceLease(db, ROLE, 'host-a/1', TTL, Date.now() - 2 * TTL);
        setActiveLease(ROLE, 'host-a/1');
        await tryAcquireInstanceLease(db, ROLE, 'host-b/2', TTL);
        await expect(reportBroadcastOn(db, { txHash: 'x' })).rejects.toMatchObject({ code: 'INSTANCE_LEASE_HELD' });
        expect(isBackgroundFenced()).toBe(true);
        expect(runtimeUnavailableReason({ initialized: true, mode: 'active' })).toMatch(/lost the database instance lease/);
    });

    test('a fenced process refuses without reading the row', async () => {
        fenceBackgroundWork();
        await expect(assertLeaseHeld({ run: async () => { throw new Error('must not read'); } })).rejects.toMatchObject({ code: 'INSTANCE_LEASE_HELD' });
    });
});
