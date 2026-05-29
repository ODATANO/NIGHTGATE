/**
 * Tests for srv/submission/background-jobs.ts.
 *
 * Uses the same hand-rolled in-memory `cds` mock pattern as
 * `wallet-sync-state-store.test.ts`: queries are tagged with `kind` and the
 * mock dispatches against a Map. `cds.spawn` is shimmed to dispatch via
 * `setImmediate` so tests can wait for the detached work to run by flushing
 * the event loop.
 */

import crypto from 'crypto';

// ---- In-memory store -------------------------------------------------------

type Row = {
    ID: string;
    kind: string;
    sessionId: string | null;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    idempotencyKey: string | null;
    request: string | null;
    result: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    modifiedAt: string;
};

const rows = new Map<string, Row>();

function matchesWhere(row: any, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where || {})) {
        if (v && typeof v === 'object' && 'in' in (v as any)) {
            const arr = (v as any).in as unknown[];
            if (!arr.includes(row[k])) return false;
        } else if (row[k] !== v) {
            return false;
        }
    }
    return true;
}

const runMock = jest.fn(async (q: any) => {
    if (!q || typeof q !== 'object') return undefined;
    if (q.kind === 'selectOne') {
        const found = [...rows.values()].filter(r => matchesWhere(r, q.where));
        if (q.orderBy === 'createdAt desc') {
            found.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        }
        return found[0] ?? null;
    }
    if (q.kind === 'select') {
        const found = [...rows.values()].filter(r => matchesWhere(r, q.where));
        if (q.columns) {
            return found.map(r => Object.fromEntries(q.columns.map((c: string) => [c, (r as any)[c]])));
        }
        return found;
    }
    if (q.kind === 'insert') {
        const entry = Array.isArray(q.entry) ? q.entry[0] : q.entry;
        const now = new Date().toISOString();
        const row: Row = {
            ID:             entry.ID,
            kind:           entry.kind,
            sessionId:      entry.sessionId ?? null,
            status:         entry.status ?? 'pending',
            idempotencyKey: entry.idempotencyKey ?? null,
            request:        entry.request ?? null,
            result:         entry.result ?? null,
            errorCode:      entry.errorCode ?? null,
            errorMessage:   entry.errorMessage ?? null,
            startedAt:      entry.startedAt ?? null,
            finishedAt:     entry.finishedAt ?? null,
            createdAt:      now,
            modifiedAt:     now
        };
        rows.set(row.ID, row);
        return undefined;
    }
    if (q.kind === 'update') {
        for (const row of rows.values()) {
            if (matchesWhere(row, q.where)) Object.assign(row, q.set, { modifiedAt: new Date().toISOString() });
        }
        return undefined;
    }
    return undefined;
});

// ---- cds mock --------------------------------------------------------------

jest.mock('@sap/cds', () => {
    const SELECT: any = {
        from: jest.fn((entity: any) => {
            const obj: any = { kind: 'select', entity, columns: undefined, where: {}, orderBy: undefined };
            obj.columns  = jest.fn((...cols: string[]) => { obj.columns = cols.flat(); return obj; });
            obj.where    = jest.fn((where: Record<string, unknown>) => { obj.where = where; return obj; });
            obj.orderBy  = jest.fn((ob: string) => { obj.orderBy = ob; return obj; });
            return obj;
        }),
        one: {
            from: jest.fn((entity: any) => {
                const obj: any = { kind: 'selectOne', entity, where: {}, orderBy: undefined };
                obj.where   = jest.fn((where: Record<string, unknown>) => { obj.where = where; return obj; });
                obj.orderBy = jest.fn((ob: string) => { obj.orderBy = ob; return obj; });
                return obj;
            })
        }
    };
    const INSERT = {
        into: jest.fn((entity: any) => ({
            entries: jest.fn((entry: Record<string, unknown>) => ({ kind: 'insert', entity, entry }))
        }))
    };
    const UPDATE = {
        entity: jest.fn((entity: any) => ({
            set: jest.fn((set: Record<string, unknown>) => ({
                where: jest.fn((where: Record<string, unknown>) => ({ kind: 'update', entity, set, where }))
            }))
        }))
    };

    // db.tx(fn) → just call fn with db (fresh "transaction" semantics — for the
    // helper, the tx wrapper is purely a context-isolation device, so the mock
    // can collapse it to a passthrough).
    const dbHandle: any = {
        run: runMock,
        tx:  async (fn: any) => fn(dbHandle)
    };

    const cds: any = {
        ql: { SELECT, INSERT, UPDATE },
        connect: { to: jest.fn(async () => dbHandle) },
        env: { requires: {} },
        // Passthrough — the real cds._with runs fn under a cleared
        // AsyncLocalStorage store; for the mock we just invoke it.
        _with: (_ctx: any, fn: any) => fn(),
        spawn: jest.fn((_opts: any, fn: any) => {
            const cb = typeof _opts === 'function' ? _opts : fn;
            setImmediate(() => { cb().catch(() => undefined); });
            return { on: jest.fn() };
        })
    };
    cds.default = cds;
    return cds;
});

jest.mock('../../srv/utils/nightgate-config', () => ({
    resolveNightgateRuntimeConfig: jest.fn(() => ({ network: 'preprod' })),
    getNightgatePluginConfig:      jest.fn(() => ({}))
}));

// classifySubmissionError is the real implementation — it doesn't touch
// modules we'd need to stub. Verified by importing it without further mocks.

import {
    startJob,
    getJobById,
    recoverInterruptedJobs,
    __resetForTests
} from '../../srv/submission/background-jobs';

async function flushSpawn(): Promise<void> {
    // Two ticks: setImmediate (spawn dispatch) → microtasks (the async body).
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    rows.clear();
    runMock.mockClear();
    __resetForTests();
});

// ---- startJob: insert + spawn + transitions --------------------------------

describe('startJob — insert row + return jobId', () => {
    test('returns { jobId, status: "pending" } and inserts a row before spawn runs', async () => {
        const work = jest.fn(async () => ({ txId: 'tx-123' }));

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   { receiverAddress: 'addr', amount: '100' },
            work
        });

        expect(ret.status).toBe('pending');
        expect(ret.jobId).toMatch(/^[0-9a-f-]{36}$/i);
        const row = rows.get(ret.jobId)!;
        expect(row).toBeDefined();
        expect(row.status).toBe('pending');
        expect(row.kind).toBe('sendNight');
        expect(row.sessionId).toBe('sess-1');
        expect(row.request).toBe(JSON.stringify({ receiverAddress: 'addr', amount: '100' }));
        // Work has NOT started yet — spawn dispatches via setImmediate.
        expect(work).not.toHaveBeenCalled();
    });

    test('transitions pending → running → succeeded after spawn completes', async () => {
        const work = jest.fn(async () => ({ ok: true, value: 42 }));

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   { receiverAddress: 'addr', amount: '100' },
            work
        });

        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('succeeded');
        expect(row.startedAt).toBeTruthy();
        expect(row.finishedAt).toBeTruthy();
        expect(JSON.parse(row.result!)).toEqual({ ok: true, value: 42 });
        expect(work).toHaveBeenCalledTimes(1);
    });

    test('failure path: row transitions to failed with classified errorCode', async () => {
        const err: any = new Error('Transaction pool full: 1016 Immediately Dropped');
        const work = jest.fn(async () => { throw err; });

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work
        });

        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('1016');
        expect(row.errorMessage).toMatch(/Transaction pool full/);
        expect(row.finishedAt).toBeTruthy();
    });

    test('unknown errors get a non-retryable default classification', async () => {
        const work = jest.fn(async () => { throw new Error('something exotic'); });

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work
        });

        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('Error');
        expect(row.errorMessage).toContain('something exotic');
    });

    test('BigInt return values serialize cleanly into result', async () => {
        const work = jest.fn(async () => ({ amount: 12345678901234567890n }));

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work
        });

        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('succeeded');
        expect(JSON.parse(row.result!)).toEqual({ amount: '12345678901234567890' });
    });

    test('throws when kind / sessionId / work are missing', async () => {
        await expect(startJob({ kind: '',   sessionId: 'x', request: {}, work: async () => 1 } as any)).rejects.toThrow(/kind/);
        await expect(startJob({ kind: 'k',  sessionId: '',  request: {}, work: async () => 1 } as any)).rejects.toThrow(/sessionId/);
        await expect(startJob({ kind: 'k',  sessionId: 'x', request: {}, work: undefined } as any)).rejects.toThrow(/work/);
    });
});

// ---- Idempotency -----------------------------------------------------------

describe('startJob — idempotency', () => {
    test('reusing an idempotencyKey on a succeeded job returns the same jobId + result', async () => {
        const work1 = jest.fn(async () => ({ txId: 'tx-AAA' }));
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-1',
            request:        {},
            work:           work1
        });
        await flushSpawn();

        const work2 = jest.fn(async () => ({ txId: 'tx-BBB-should-not-be-called' }));
        const second = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-1',
            request:        {},
            work:           work2
        });
        await flushSpawn();

        expect(second.jobId).toBe(first.jobId);
        expect(second.status).toBe('succeeded');
        expect(second.result).toEqual({ txId: 'tx-AAA' });
        expect(work2).not.toHaveBeenCalled();
    });

    test('reusing an idempotencyKey on a pending/running job returns the same jobId without spawning again', async () => {
        let resolveWork!: (v: any) => void;
        const work1 = jest.fn(() => new Promise<any>(r => { resolveWork = r; }));
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-2',
            request:        {},
            work:           work1
        });
        await flushSpawn();
        // work1 has started but not resolved — row should be 'running'
        expect(rows.get(first.jobId)?.status).toBe('running');

        const work2 = jest.fn(async () => ({ should: 'not be called' }));
        const second = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-2',
            request:        {},
            work:           work2
        });

        expect(second.jobId).toBe(first.jobId);
        expect(work2).not.toHaveBeenCalled();

        // Cleanup: let work1 resolve so the spawn finishes cleanly.
        resolveWork({});
        await flushSpawn();
    });

    test('a previously failed job does NOT block a retry with the same key', async () => {
        const work1 = jest.fn(async () => { throw new Error('boom'); });
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-3',
            request:        {},
            work:           work1
        });
        await flushSpawn();
        expect(rows.get(first.jobId)?.status).toBe('failed');

        const work2 = jest.fn(async () => ({ ok: true }));
        const second = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-3',
            request:        {},
            work:           work2
        });
        await flushSpawn();

        expect(second.jobId).not.toBe(first.jobId);
        expect(work2).toHaveBeenCalledTimes(1);
        expect(rows.get(second.jobId)?.status).toBe('succeeded');
    });

    test('different sessionIds with the same key do not collide', async () => {
        const a = await startJob({
            kind: 'sendNight', sessionId: 'sess-A', idempotencyKey: 'shared',
            request: {}, work: async () => ({ from: 'A' })
        });
        const b = await startJob({
            kind: 'sendNight', sessionId: 'sess-B', idempotencyKey: 'shared',
            request: {}, work: async () => ({ from: 'B' })
        });
        await flushSpawn();

        expect(a.jobId).not.toBe(b.jobId);
        expect(JSON.parse(rows.get(a.jobId)!.result!)).toEqual({ from: 'A' });
        expect(JSON.parse(rows.get(b.jobId)!.result!)).toEqual({ from: 'B' });
    });
});

// ---- Concurrency / semaphore ----------------------------------------------

describe('startJob — per-kind semaphore', () => {
    test('heavy kind: jobs beyond the cap of 4 are queued, not run in parallel', async () => {
        const releaseGates: Array<() => void> = [];
        const inFlight = { count: 0, peak: 0 };

        const makeWork = () => jest.fn(async () => {
            inFlight.count++;
            inFlight.peak = Math.max(inFlight.peak, inFlight.count);
            await new Promise<void>(r => releaseGates.push(r));
            inFlight.count--;
            return { done: true };
        });

        // Fire 7 deployContract (heavy=4) jobs.
        const jobIds: string[] = [];
        for (let i = 0; i < 7; i++) {
            const r = await startJob({
                kind:      'deployContract',
                sessionId: `sess-${i}`,
                request:   {},
                work:      makeWork()
            });
            jobIds.push(r.jobId);
        }

        // Let all spawns dispatch.
        await flushSpawn();
        // Peak should be 4 with 3 queued.
        expect(inFlight.peak).toBeLessThanOrEqual(4);
        expect(inFlight.count).toBe(4);
        expect(releaseGates.length).toBe(4);

        // Drain the queue iteratively: each release lets one queued job pick up
        // a slot and push its own gate. Loop until all 7 jobIds are succeeded.
        const drainStart = Date.now();
        while (jobIds.some(id => rows.get(id)?.status !== 'succeeded') && Date.now() - drainStart < 2000) {
            const next = releaseGates.shift();
            if (next) next();
            await flushSpawn();
        }

        for (const id of jobIds) {
            expect(rows.get(id)?.status).toBe('succeeded');
        }
        expect(inFlight.peak).toBeLessThanOrEqual(4);
    });

    test('light kind defaults to cap of 16', async () => {
        const releaseGates: Array<() => void> = [];
        const inFlight = { count: 0, peak: 0 };
        const makeWork = () => jest.fn(async () => {
            inFlight.count++;
            inFlight.peak = Math.max(inFlight.peak, inFlight.count);
            await new Promise<void>(r => releaseGates.push(r));
            inFlight.count--;
        });

        for (let i = 0; i < 20; i++) {
            await startJob({
                kind:      'connectWalletForSigning',   // not in HEAVY_KINDS → light
                sessionId: `sess-${i}`,
                request:   {},
                work:      makeWork()
            });
        }
        await flushSpawn();

        expect(inFlight.peak).toBeLessThanOrEqual(16);
        expect(inFlight.count).toBe(16);
        releaseGates.forEach(r => r());
        await flushSpawn();
        await flushSpawn();
    });
});

// ---- getJobById ------------------------------------------------------------

describe('getJobById', () => {
    test('returns null for unknown id', async () => {
        expect(await getJobById('does-not-exist')).toBeNull();
        expect(await getJobById('')).toBeNull();
    });

    test('returns the row for a known id', async () => {
        const r = await startJob({
            kind: 'sendNight', sessionId: 'sess-X',
            request: { foo: 'bar' },
            work: async () => ({ ok: true })
        });
        await flushSpawn();

        const fetched = await getJobById(r.jobId);
        expect(fetched).not.toBeNull();
        expect(fetched!.ID).toBe(r.jobId);
        expect(fetched!.status).toBe('succeeded');
    });
});

// ---- recoverInterruptedJobs ------------------------------------------------

describe('recoverInterruptedJobs', () => {
    test('flips pending + running rows to failed:PROCESS_RESTART; leaves succeeded/failed alone', async () => {
        const now = new Date().toISOString();
        rows.set('p1', { ID: 'p1', kind: 'sendNight', sessionId: 's', status: 'pending', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: null, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('r1', { ID: 'r1', kind: 'sendNight', sessionId: 's', status: 'running', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: now, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('s1', { ID: 's1', kind: 'sendNight', sessionId: 's', status: 'succeeded', idempotencyKey: null, request: null, result: '{"ok":true}', errorCode: null, errorMessage: null, startedAt: now, finishedAt: now, createdAt: now, modifiedAt: now });
        rows.set('f1', { ID: 'f1', kind: 'sendNight', sessionId: 's', status: 'failed', idempotencyKey: null, request: null, result: null, errorCode: 'OldErr', errorMessage: 'old', startedAt: now, finishedAt: now, createdAt: now, modifiedAt: now });

        const count = await recoverInterruptedJobs();
        expect(count).toBe(2);

        expect(rows.get('p1')!.status).toBe('failed');
        expect(rows.get('p1')!.errorCode).toBe('PROCESS_RESTART');
        expect(rows.get('p1')!.errorMessage).toMatch(/interrupted/i);
        expect(rows.get('p1')!.finishedAt).toBeTruthy();

        expect(rows.get('r1')!.status).toBe('failed');
        expect(rows.get('r1')!.errorCode).toBe('PROCESS_RESTART');

        expect(rows.get('s1')!.status).toBe('succeeded');
        expect(rows.get('f1')!.errorCode).toBe('OldErr');
    });

    test('returns 0 and is a no-op when no rows are in flight', async () => {
        expect(await recoverInterruptedJobs()).toBe(0);
    });
});
