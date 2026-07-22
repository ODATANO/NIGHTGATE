/**
 * Tests for srv/submission/background-jobs.ts.
 *
 * Uses the same hand-rolled in-memory `cds` mock pattern as
 * `wallet-sync-state-store.test.ts`: queries are tagged with `kind` and the
 * mock dispatches against a Map. Tests wait for the detached worker's
 * `setImmediate` dispatch by flushing the event loop.
 */

import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

// ---- In-memory store -------------------------------------------------------

type Row = {
    ID: string;
    kind: string;
    sessionId: string | null;
    status: 'pending' | 'running' | 'external_execution' | 'submitted' | 'reconciliation_required' | 'succeeded' | 'failed';
    idempotencyKey: string | null;
    request: string | null;
    payloadFingerprint?: string | null;
    commandVersion?: number | null;
    command?: string | null;
    commandEncoding?: string | null;
    requestedBy?: string | null;
    parentJobId?: string | null;
    workflowStep?: string | null;
    result: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    queuedAt?: string | null;
    externalExecutionAt?: string | null;
    submittedAt?: string | null;
    finishedAt: string | null;
    attempt?: number;
    maxAttempts?: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: string | null;
    heartbeatAt?: string | null;
    submissionId?: string | null;
    txHash?: string | null;
    chainStatus?: 'pending' | 'success' | 'failure' | null;
    chainFinalizedAt?: string | null;
    createdAt: string;
    modifiedAt: string;
};

const rows = new Map<string, Row>();
const evidenceTables = new Map<string, any[]>([
    ['midnight.PendingSubmissions', []],
    ['midnight.Transactions', []],
    ['midnight.TransactionResults', []]
]);

function matchesWhere(row: any, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where || {})) {
        if (v && typeof v === 'object' && 'in' in (v as any)) {
            const arr = (v as any).in as unknown[];
            if (!arr.includes(row[k])) return false;
        } else if (v && typeof v === 'object' && '!=' in (v as any)) {
            if ((v as any)['!='] === null && row[k] == null) return false;
        } else if (v && typeof v === 'object' && '>' in (v as any)) {
            if (!(row[k] > (v as any)['>'])) return false;
        } else if (v === null ? row[k] != null : row[k] !== v) {
            return false;
        }
    }
    return true;
}

// Injects "database is locked" failures into UPDATE queries, optionally only
// for updates that set a specific target status. Simulates the SQLite write
// lock being held by a foreign long commit.
const lockInjector = vi.hoisted(() => ({ failUpdates: 0, matchStatus: null as string | null }));

const runMock = vi.hoisted(() => (vi.fn(async (q: any) => {
    if (!q || typeof q !== 'object') return undefined;
    const entityName = q.entity?.name ?? String(q.entity ?? '');
    const evidence = evidenceTables.get(entityName);
    if (evidence) {
        const found = evidence.filter(row => matchesWhere(row, q.where));
        return q.kind === 'selectOne' ? (found[0] ?? null) : found;
    }
    if (q.kind === 'selectOne') {
        const found = [...rows.values()].filter(r => matchesWhere(r, q.where));
        if (q.orderBy === 'createdAt desc') {
            found.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        }
        return found[0] ?? null;
    }
    if (q.kind === 'select') {
        let found = [...rows.values()].filter(r => matchesWhere(r, q.where));
        if (q.orderBy === 'ID asc') found.sort((a, b) => a.ID.localeCompare(b.ID));
        if (typeof q.limitValue === 'number') found = found.slice(0, q.limitValue);
        if (Array.isArray(q.columns)) {
            return found.map(r => Object.fromEntries(q.columns.map((c: string) => [c, (r as any)[c]])));
        }
        return found;
    }
    if (q.kind === 'insert') {
        const entry = Array.isArray(q.entry) ? q.entry[0] : q.entry;
        // Enforce the (sessionId, kind, idempotencyKey) unique constraint the
        // real DB carries, so the concurrent-collision recovery path is testable.
        // NULL keys never collide (matches SQLite/Postgres NULL-distinct semantics).
        if (entry.idempotencyKey != null) {
            for (const r of rows.values()) {
                if (r.sessionId === (entry.sessionId ?? null)
                    && r.kind === entry.kind
                    && r.idempotencyKey === entry.idempotencyKey) {
                    throw new Error('UNIQUE constraint failed: midnight_BackgroundJobs.sessionId, midnight_BackgroundJobs.kind, midnight_BackgroundJobs.idempotencyKey');
                }
            }
        }
        const now = new Date().toISOString();
        const row: Row = {
            ID:             entry.ID,
            kind:           entry.kind,
            sessionId:      entry.sessionId ?? null,
            status:         entry.status ?? 'pending',
            idempotencyKey: entry.idempotencyKey ?? null,
            request:        entry.request ?? null,
            payloadFingerprint: entry.payloadFingerprint ?? null,
            commandVersion: entry.commandVersion ?? null,
            command: entry.command ?? null,
            commandEncoding: entry.commandEncoding ?? null,
            requestedBy: entry.requestedBy ?? null,
            parentJobId: entry.parentJobId ?? null,
            workflowStep: entry.workflowStep ?? null,
            result:         entry.result ?? null,
            errorCode:      entry.errorCode ?? null,
            errorMessage:   entry.errorMessage ?? null,
            startedAt:      entry.startedAt ?? null,
            queuedAt:       entry.queuedAt ?? null,
            externalExecutionAt: entry.externalExecutionAt ?? null,
            submittedAt:    entry.submittedAt ?? null,
            finishedAt:     entry.finishedAt ?? null,
            attempt:        entry.attempt ?? 0,
            maxAttempts:    entry.maxAttempts ?? 1,
            leaseOwner:     entry.leaseOwner ?? null,
            leaseExpiresAt: entry.leaseExpiresAt ?? null,
            heartbeatAt:    entry.heartbeatAt ?? null,
            submissionId:   entry.submissionId ?? null,
            txHash:         entry.txHash ?? null,
            createdAt:      now,
            modifiedAt:     now
        };
        rows.set(row.ID, row);
        return undefined;
    }
    if (q.kind === 'update') {
        if (lockInjector.failUpdates > 0 && (!lockInjector.matchStatus || q.set?.status === lockInjector.matchStatus)) {
            lockInjector.failUpdates--;
            throw new Error('database is locked');
        }
        let affected = 0;
        for (const row of rows.values()) {
            if (matchesWhere(row, q.where)) {
                Object.assign(row, q.set, { modifiedAt: new Date().toISOString() });
                affected++;
            }
        }
        return affected;
    }
    return undefined;
})));

// ---- cds mock --------------------------------------------------------------

vi.mock('@sap/cds', () => {
    const SELECT: any = {
        from: vi.fn((entity: any) => {
            const obj: any = { kind: 'select', entity, columns: undefined, where: {}, orderBy: undefined, limitValue: undefined };
            obj.columns  = vi.fn((...cols: string[]) => { obj.columns = cols.flat(); return obj; });
            obj.where    = vi.fn((where: Record<string, unknown>) => { obj.where = where; return obj; });
            obj.orderBy  = vi.fn((ob: string) => { obj.orderBy = ob; return obj; });
            obj.limit    = vi.fn((value: number) => { obj.limitValue = value; return obj; });
            return obj;
        }),
        one: {
            from: vi.fn((entity: any) => {
                const obj: any = { kind: 'selectOne', entity, where: {}, orderBy: undefined };
                obj.columns = vi.fn((...cols: string[]) => { obj.columns = cols.flat(); return obj; });
                obj.where   = vi.fn((where: Record<string, unknown>) => { obj.where = where; return obj; });
                obj.orderBy = vi.fn((ob: string) => { obj.orderBy = ob; return obj; });
                return obj;
            })
        }
    };
    const INSERT = {
        into: vi.fn((entity: any) => ({
            entries: vi.fn((entry: Record<string, unknown>) => ({ kind: 'insert', entity, entry }))
        }))
    };
    const UPDATE = {
        entity: vi.fn((entity: any) => ({
            set: vi.fn((set: Record<string, unknown>) => ({
                where: vi.fn((where: Record<string, unknown>) => ({ kind: 'update', entity, set, where }))
            }))
        }))
    };

    // db.tx(fn) → just call fn with db (fresh "transaction" semantics; for the
    // helper, the tx wrapper is purely a context-isolation device, so the mock
    // can collapse it to a passthrough).
    const dbHandle: any = {
        run: runMock,
        tx:  async (fn: any) => fn(dbHandle)
    };

    const logHandle = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const cds: any = {
        ql: { SELECT, INSERT, UPDATE },
        connect: { to: vi.fn(async () => dbHandle) },
        log: vi.fn(() => logHandle),
        env: { requires: {} },
        spawn: vi.fn((_opts: any, fn: any) => {
            const cb = typeof _opts === 'function' ? _opts : fn;
            setImmediate(() => { cb().catch(() => undefined); });
            return { on: vi.fn() };
        })
    };
    cds.default = cds;
    return cds;
});

vi.mock('../../srv/utils/nightgate-config', () => ({
    resolveNightgateRuntimeConfig: vi.fn(() => ({ network: 'preprod' })),
    getNightgatePluginConfig:      vi.fn(() => ({}))
}));

// classifySubmissionError is the real implementation; it doesn't touch
// modules we'd need to stub. Verified by importing it without further mocks.

import {
    startJob,
    registerBackgroundJobProcessor,
    registerBackgroundJobReconciliationFinalizer,
    runChildCommand,
    WorkflowReconciliationRequiredError,
    getJobById,
    recoverInterruptedJobs,
    reconcileBackgroundJobs,
    refreshSucceededChainOutcomes,
    __resetForTests,
    __setStatusWriteBackoffForTests
} from '../../srv/submission/background-jobs';
import { reportExternalExecution, reportExternalSubmission } from '../../srv/submission/job-execution-context';

async function flushSpawn(): Promise<void> {
    // Two ticks: setImmediate (spawn dispatch) → microtasks (the async body).
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    rows.clear();
    for (const table of evidenceTables.values()) table.length = 0;
    runMock.mockClear();
    lockInjector.failUpdates = 0;
    lockInjector.matchStatus = null;
    __resetForTests();
});

// ---- startJob: insert + spawn + transitions --------------------------------

describe('startJob: insert row + return jobId', () => {
    test('marks a partially effective workflow for reconciliation instead of failed', async () => {
        registerBackgroundJobProcessor('partialWorkflow', 1, async () => {
            throw new WorkflowReconciliationRequiredError('step one succeeded; step two failed');
        });
        const ret = await startJob({
            kind: 'partialWorkflow', sessionId: 'sess-1', requestedBy: 'alice',
            request: {}, commandVersion: 1, command: { op: 'workflow' }
        });
        await flushSpawn();

        expect(rows.get(ret.jobId)).toMatchObject({
            status: 'reconciliation_required',
            errorCode: 'CHILD_RECONCILIATION_REQUIRED',
            errorMessage: 'step one succeeded; step two failed'
        });
    });

    test('deduplicates a deterministic workflow child and executes it only once', async () => {
        const processor = vi.fn(async () => ({ txHash: '0xchild' }));
        registerBackgroundJobProcessor('childStep', 1, processor);
        const parent = {
            ID: 'parent-1', kind: 'workflow', sessionId: 'sess-1', requestedBy: 'alice',
            commandVersion: 1
        } as any;
        const args = {
            parent, kind: 'childStep', step: 'submit-one', commandVersion: 1,
            request: { step: 'submit-one' }, command: { op: 'submit' }
        };
        const firstPromise = runChildCommand<{ txHash: string }>(args);
        await flushSpawn();
        const first = await firstPromise;
        const second = await runChildCommand<{ txHash: string }>(args);

        expect(first.txHash).toBe('0xchild');
        expect(second.txHash).toBe('0xchild');
        expect(processor).toHaveBeenCalledTimes(1);
        const children = [...rows.values()].filter(row => row.parentJobId === 'parent-1');
        expect(children).toHaveLength(1);
        expect(children[0]).toMatchObject({ workflowStep: 'submit-one', status: 'succeeded' });
    });
    test('executes a versioned persisted command without an in-memory work closure', async () => {
        const processor = vi.fn(async (command: unknown) => ({ echoed: command }));
        registerBackgroundJobProcessor('durableTest', 1, processor);
        const ret = await startJob({
            kind: 'durableTest', sessionId: 'sess-1', requestedBy: 'alice',
            request: { value: 7 }, commandVersion: 1, command: { value: 7 }
        });
        await flushSpawn();

        expect(processor).toHaveBeenCalledWith({ value: 7 }, expect.objectContaining({
            ID: ret.jobId, commandVersion: 1, requestedBy: 'alice'
        }));
        expect(rows.get(ret.jobId)).toMatchObject({ status: 'succeeded', commandVersion: 1, requestedBy: 'alice' });
    });

    test('encrypts private commands at rest and decrypts only for the processor', async () => {
        const processor = vi.fn(async () => ({ ok: true }));
        registerBackgroundJobProcessor('encryptedTest', 1, processor);
        const ret = await startJob({
            kind: 'encryptedTest', sessionId: 'sess-1', requestedBy: 'alice',
            request: { secretPresent: true }, commandVersion: 1,
            command: { privateState: 'top-secret-value' }, encryptCommand: true
        });
        const persisted = rows.get(ret.jobId)!;
        expect(persisted.commandEncoding).toBe('aes-gcm-v1');
        expect(persisted.command).not.toContain('top-secret-value');
        await flushSpawn();
        expect(processor).toHaveBeenCalledWith({ privateState: 'top-secret-value' }, expect.anything());
    });
    test('returns { jobId, status: "pending" } and inserts a row before spawn runs', async () => {
        const work = vi.fn(async () => ({ txId: 'tx-123' }));

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
        expect(row.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
        // Work has NOT started yet; spawn dispatches via setImmediate.
        expect(work).not.toHaveBeenCalled();
    });

    test('transitions pending → running → succeeded after spawn completes', async () => {
        const work = vi.fn(async () => ({ ok: true, value: 42 }));

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
        const work = vi.fn(async () => { throw err; });

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
        const work = vi.fn(async () => { throw new Error('something exotic'); });

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
        const work = vi.fn(async () => ({ amount: 12345678901234567890n }));

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

    test('persists an external submission handle before the work completes', async () => {
        let release!: () => void;
        const ret = await startJob({
            kind: 'deployContract',
            sessionId: 'sess-1',
            request: {},
            work: async () => {
                await reportExternalExecution({ submissionId: 'sub-1' });
                await reportExternalSubmission({ submissionId: 'sub-1', txHash: '0xabc' });
                await new Promise<void>(resolve => { release = resolve; });
                return { ok: true };
            }
        });
        await flushSpawn();

        expect(rows.get(ret.jobId)).toMatchObject({
            status: 'submitted', submissionId: 'sub-1', txHash: '0xabc'
        });
        release();
        await flushSpawn();
        expect(rows.get(ret.jobId)?.status).toBe('succeeded');
    });

    test('routes a pre-broadcast live failure (no txHash) to failed, not reconciliation', async () => {
        const ret = await startJob({
            kind: 'deployContract', sessionId: 'sess-1', request: {},
            work: async () => {
                await reportExternalExecution({ submissionId: 'sub-nobroadcast' });
                throw new Error('proof generation failed'); // no txHash recorded -> no chain effect
            }
        });
        await flushSpawn();
        expect(rows.get(ret.jobId)?.status).toBe('failed');
    });

    test('routes a live failure after a real txHash to reconciliation', async () => {
        const ret = await startJob({
            kind: 'deployContract', sessionId: 'sess-1', request: {},
            work: async () => {
                await reportExternalExecution({ submissionId: 'sub-ambiguous' });
                await reportExternalSubmission({ submissionId: 'sub-ambiguous', txHash: '0xmaybe' });
                throw new Error('connection closed after broadcast');
            }
        });
        await flushSpawn();
        expect(rows.get(ret.jobId)).toMatchObject({
            status: 'reconciliation_required',
            errorCode: 'EXTERNAL_EXECUTION_FAILED',
            txHash: '0xmaybe'
        });
    });

    test('automatically succeeds a reconciliation job from exact finalized/indexed evidence', async () => {
        const ret = await startJob({
            kind: 'deployContract', sessionId: 'sess-1', request: {},
            work: async () => {
                await reportExternalExecution({ submissionId: 'sub-final' });
                await reportExternalSubmission({ submissionId: 'sub-final', txHash: '0xfinal' });
                throw new Error('reply lost');
            }
        });
        await flushSpawn();
        evidenceTables.get('midnight.PendingSubmissions')!.push({
            ID: 'sub-final', txHash: '0xfinal', contractAddress: '0xcontract', status: 'finalized'
        });
        evidenceTables.get('midnight.Transactions')!.push({ ID: 'indexed-1', hash: '0xfinal' });
        evidenceTables.get('midnight.TransactionResults')!.push({
            transaction_ID: 'indexed-1', status: 'SUCCESS', outcomeSource: 'substrate-system-events'
        });

        expect(await reconcileBackgroundJobs()).toBe(1);
        expect(rows.get(ret.jobId)).toMatchObject({ status: 'succeeded', errorCode: null });
        expect(rows.get(ret.jobId)?.chainStatus).toBe('success');
        expect(JSON.parse(rows.get(ret.jobId)!.result!)).toMatchObject({
            reconciled: true, txHash: '0xfinal', contractAddress: '0xcontract'
        });
    });

    test('keeps the job in reconciliation when its projection finalizer fails', async () => {
        registerBackgroundJobProcessor('projectionLeaf', 1, async () => {
            await reportExternalExecution({ submissionId: 'sub-projection' });
            await reportExternalSubmission({ submissionId: 'sub-projection', txHash: '0xprojection' });
            throw new Error('reply lost');
        });
        registerBackgroundJobReconciliationFinalizer('projectionLeaf', 1, async () => {
            throw new Error('projection database unavailable');
        });
        const ret = await startJob({
            kind: 'projectionLeaf', sessionId: 'sess-1', requestedBy: 'alice',
            request: {}, commandVersion: 1, command: { resourceId: 'r1' }
        });
        await flushSpawn();
        evidenceTables.get('midnight.PendingSubmissions')!.push({
            ID: 'sub-projection', txHash: '0xprojection', status: 'finalized'
        });
        evidenceTables.get('midnight.Transactions')!.push({ ID: 'indexed-projection', hash: '0xprojection' });
        evidenceTables.get('midnight.TransactionResults')!.push({
            transaction_ID: 'indexed-projection', status: 'SUCCESS', outcomeSource: 'substrate-system-events'
        });

        expect(await reconcileBackgroundJobs()).toBe(0);
        expect(rows.get(ret.jobId)?.status).toBe('reconciliation_required');
    });

    test('keeps an included but not finalized submission open', async () => {
        const makeAmbiguous = async (submissionId: string, txHash: string) => {
            const ret = await startJob({
                kind: 'submitContractCall', sessionId: 'sess-1', request: {},
                work: async () => {
                    await reportExternalExecution({ submissionId });
                    await reportExternalSubmission({ submissionId, txHash });
                    throw new Error('reply lost');
                }
            });
            await flushSpawn();
            return ret;
        };
        const unresolved = await makeAmbiguous('sub-open', '0xopen');
        evidenceTables.get('midnight.PendingSubmissions')!.push({ ID: 'sub-open', txHash: '0xopen', status: 'included' });
        expect(await reconcileBackgroundJobs()).toBe(0);
        expect(rows.get(unresolved.jobId)?.status).toBe('reconciliation_required');

        evidenceTables.get('midnight.Transactions')!.push({ ID: 'indexed-open', hash: '0xopen' });
        expect(await reconcileBackgroundJobs()).toBe(0);
        expect(rows.get(unresolved.jobId)?.status).toBe('reconciliation_required');
    });

    test('keeps workflow success separate from a later canonical chain failure', async () => {
        const ret = await startJob({
            kind: 'submitContractCall', sessionId: 'sess-1', request: {},
            work: async () => {
                await reportExternalExecution({ submissionId: 'sub-chain-fail' });
                await reportExternalSubmission({ submissionId: 'sub-chain-fail', txHash: '0xchainfail' });
                return { txHash: '0xchainfail', status: 'included' };
            }
        });
        await flushSpawn();
        evidenceTables.get('midnight.PendingSubmissions')!.push({
            ID: 'sub-chain-fail', txHash: '0xchainfail', status: 'finalized', finalizedAt: '2026-07-22T12:00:00Z'
        });
        evidenceTables.get('midnight.Transactions')!.push({ ID: 'indexed-chain-fail', hash: '0xchainfail' });
        evidenceTables.get('midnight.TransactionResults')!.push({
            transaction_ID: 'indexed-chain-fail', status: 'FAILURE', outcomeSource: 'substrate-system-events'
        });

        expect(await refreshSucceededChainOutcomes()).toBe(1);
        expect(rows.get(ret.jobId)).toMatchObject({
            status: 'succeeded', chainStatus: 'failure', chainFinalizedAt: '2026-07-22T12:00:00Z'
        });
    });

    test('requeues a reconciliation parent only after every durable child succeeded', async () => {
        const now = new Date().toISOString();
        const base = { sessionId: 'sess-1', idempotencyKey: null, request: '{}', result: null,
            errorCode: null, errorMessage: null, startedAt: now, finishedAt: null,
            createdAt: now, modifiedAt: now };
        rows.set('parent-ready', { ...base, ID: 'parent-ready', kind: 'issuePredicateAttestation',
            status: 'reconciliation_required', parentJobId: null, workflowStep: null,
            commandVersion: 1, command: '{}', requestedBy: 'alice' } as Row);
        rows.set('child-a', { ...base, ID: 'child-a', kind: 'predicateCommitValue', status: 'succeeded',
            parentJobId: 'parent-ready', workflowStep: 'commitValue' } as Row);
        rows.set('child-b', { ...base, ID: 'child-b', kind: 'predicateProof', status: 'succeeded',
            parentJobId: 'parent-ready', workflowStep: 'provePredicate' } as Row);

        expect(await reconcileBackgroundJobs()).toBe(1);
        expect(rows.get('parent-ready')).toMatchObject({ status: 'pending', errorCode: null, errorMessage: null });
    });

    test('runs work outside the caller async context', async () => {
        const requestContext = new AsyncLocalStorage<string>();
        let contextSeenByWork: string | undefined;

        const ret = await requestContext.run('request-transaction', () => startJob({
            kind: 'sendNight',
            sessionId: 'sess-1',
            request: {},
            work: async () => {
                contextSeenByWork = requestContext.getStore();
                await Promise.resolve();
                expect(requestContext.getStore()).toBeUndefined();
                return { ok: true };
            }
        }));

        await flushSpawn();

        expect(contextSeenByWork).toBeUndefined();
        expect(rows.get(ret.jobId)?.status).toBe('succeeded');
    });

    test('does not execute work when the guarded pending claim affects zero rows', async () => {
        const work = vi.fn(async () => ({ ok: true }));
        const ret = await startJob({ kind: 'sendNight', sessionId: 'sess-1', request: {}, work });
        Object.assign(rows.get(ret.jobId)!, { status: 'running', leaseOwner: 'another-worker' });

        await flushSpawn();

        expect(work).not.toHaveBeenCalled();
        expect(rows.get(ret.jobId)).toMatchObject({ status: 'running', leaseOwner: 'another-worker' });
    });

    test('throws when kind / sessionId / work are missing', async () => {
        await expect(startJob({ kind: '',   sessionId: 'x', request: {}, work: async () => 1 } as any)).rejects.toThrow(/kind/);
        await expect(startJob({ kind: 'k',  sessionId: '',  request: {}, work: async () => 1 } as any)).rejects.toThrow(/sessionId/);
        await expect(startJob({ kind: 'k',  sessionId: 'x', request: {}, work: undefined } as any)).rejects.toThrow(/work/);
    });
});

describe('bounded background scans remain fair beyond one page', () => {
    const putRow = (ID: string, patch: Partial<Row>): Row => {
        const now = new Date().toISOString();
        const row = {
            ID, kind: 'submitContractCall', sessionId: 'sess-1', status: 'succeeded',
            idempotencyKey: null, request: '{}', result: '{}', errorCode: null,
            errorMessage: null, startedAt: now, finishedAt: now, createdAt: now,
            modifiedAt: now, chainStatus: null, ...patch
        } as Row;
        rows.set(ID, row);
        return row;
    };

    test('advances past 100 unresolved reconciliation rows', async () => {
        for (let i = 0; i < 101; i++) {
            putRow(`recon-${String(i).padStart(3, '0')}`, {
                status: 'reconciliation_required', result: null,
                submissionId: i === 100 ? 'sub-late' : `sub-open-${i}`,
                txHash: i === 100 ? '0xlate' : `0xopen${i}`
            });
        }
        evidenceTables.get('midnight.PendingSubmissions')!.push({
            ID: 'sub-late', txHash: '0xlate', status: 'finalized', finalizedAt: '2026-07-22T12:00:00Z'
        });
        evidenceTables.get('midnight.Transactions')!.push({ ID: 'tx-late', hash: '0xlate' });
        evidenceTables.get('midnight.TransactionResults')!.push({
            transaction_ID: 'tx-late', status: 'SUCCESS', outcomeSource: 'substrate-system-events'
        });

        expect(await reconcileBackgroundJobs()).toBe(0);
        expect(await reconcileBackgroundJobs()).toBe(1);
        expect(rows.get('recon-100')).toMatchObject({ status: 'succeeded', chainStatus: 'success' });
    });

    test('advances past 100 unresolved pending chain outcomes', async () => {
        for (let i = 0; i < 101; i++) {
            putRow(`chain-${String(i).padStart(3, '0')}`, {
                chainStatus: 'pending', submissionId: i === 100 ? 'sub-late' : `sub-open-${i}`,
                txHash: i === 100 ? '0xlate' : `0xopen${i}`
            });
        }
        evidenceTables.get('midnight.PendingSubmissions')!.push({
            ID: 'sub-late', txHash: '0xlate', status: 'finalized', finalizedAt: '2026-07-22T12:00:00Z'
        });
        evidenceTables.get('midnight.Transactions')!.push({ ID: 'tx-late', hash: '0xlate' });
        evidenceTables.get('midnight.TransactionResults')!.push({
            transaction_ID: 'tx-late', status: 'SUCCESS', outcomeSource: 'substrate-system-events'
        });

        expect(await refreshSucceededChainOutcomes()).toBe(0);
        expect(await refreshSucceededChainOutcomes()).toBe(1);
        expect(rows.get('chain-100')).toMatchObject({ chainStatus: 'success' });
    });

    test('advances past 100 unresolved workflow parents', async () => {
        for (let i = 0; i < 101; i++) {
            putRow(`parent-${String(i).padStart(3, '0')}`, {
                kind: 'issuePredicateAttestation', chainStatus: 'pending', txHash: null
            });
        }
        putRow('child-late', {
            kind: 'predicateProof', parentJobId: 'parent-100', chainStatus: 'success', txHash: '0xchild'
        });

        expect(await refreshSucceededChainOutcomes()).toBe(0);
        expect(await refreshSucceededChainOutcomes()).toBe(1);
        expect(rows.get('parent-100')).toMatchObject({ chainStatus: 'success' });
    });
});

// ---- Idempotency -----------------------------------------------------------

describe('startJob: idempotency', () => {
    test('reusing an idempotencyKey on a succeeded job returns the same jobId + result', async () => {
        const work1 = vi.fn(async () => ({ txId: 'tx-AAA' }));
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-1',
            request:        {},
            work:           work1
        });
        await flushSpawn();

        const work2 = vi.fn(async () => ({ txId: 'tx-BBB-should-not-be-called' }));
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
        const work1 = vi.fn(() => new Promise<any>(r => { resolveWork = r; }));
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-2',
            request:        {},
            work:           work1
        });
        await flushSpawn();
        // work1 has started but not resolved, so the row should be 'running'
        expect(rows.get(first.jobId)?.status).toBe('running');

        const work2 = vi.fn(async () => ({ should: 'not be called' }));
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

    test('rejects reuse of an idempotency key with a different payload', async () => {
        await startJob({
            kind: 'sendNight', sessionId: 'sess-1', idempotencyKey: 'idem-drift',
            request: { amount: '1' }, work: async () => ({ ok: true })
        });

        await expect(startJob({
            kind: 'sendNight', sessionId: 'sess-1', idempotencyKey: 'idem-drift',
            request: { amount: '2' }, work: async () => ({ ok: true })
        })).rejects.toThrow(/different request payload/);
    });

    test('deduplicates generated resource IDs using a stable semantic payload', async () => {
        const first = await startJob({
            kind: 'anchorDocument', sessionId: 'sess-1', idempotencyKey: 'anchor-1',
            request: { sha256: 'abc', documentId: 'doc-1' },
            idempotencyPayload: { sha256: 'abc' },
            work: async () => ({ ok: true })
        });
        const second = await startJob({
            kind: 'anchorDocument', sessionId: 'sess-1', idempotencyKey: 'anchor-1',
            request: { sha256: 'abc', documentId: 'doc-2' },
            idempotencyPayload: { sha256: 'abc' },
            work: async () => ({ ok: true })
        });

        expect(second).toMatchObject({
            jobId: first.jobId,
            deduplicated: true,
            originalRequest: { sha256: 'abc', documentId: 'doc-1' }
        });
    });

    test('a failed job remains bound to its idempotency key', async () => {
        const work1 = vi.fn(async () => { throw new Error('boom'); });
        const first = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-3',
            request:        {},
            work:           work1
        });
        await flushSpawn();
        expect(rows.get(first.jobId)?.status).toBe('failed');

        const work2 = vi.fn(async () => ({ ok: true }));
        const second = await startJob({
            kind:           'sendNight',
            sessionId:      'sess-1',
            idempotencyKey: 'idem-3',
            request:        {},
            work:           work2
        });
        await flushSpawn();

        expect(second.jobId).toBe(first.jobId);
        expect(second.status).toBe('failed');
        expect(work2).not.toHaveBeenCalled();
        expect(rows.get(second.jobId)?.status).toBe('failed');
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

    test('a concurrent duplicate that collides on INSERT resolves to the winner job', async () => {
        const key = 'idem-concurrent';
        const winnerRow: any = {
            ID: 'winner-job', kind: 'sendNight', sessionId: 'sess-1', status: 'pending',
            idempotencyKey: key, request: JSON.stringify({ a: 1 }), payloadFingerprint: null,
            result: null, errorCode: null, errorMessage: null, startedAt: null, queuedAt: null,
            externalExecutionAt: null, submittedAt: null, finishedAt: null, attempt: 0, maxAttempts: 1,
            leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, submissionId: null, txHash: null,
            createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString()
        };

        // Simulate the race: the winner's row is invisible to the loser's first
        // dedupe SELECT and appears only once the loser's INSERT has collided.
        let winnerVisible = false;
        const base = runMock.getMockImplementation()!;
        runMock.mockImplementation(async (q: any) => {
            if (q && typeof q === 'object' && q.kind === 'insert' && q.entry?.idempotencyKey === key) {
                winnerVisible = true;
                throw new Error('UNIQUE constraint failed: midnight_BackgroundJobs.idempotencyKey');
            }
            if (q && typeof q === 'object' && q.kind === 'selectOne' && q.where?.idempotencyKey === key) {
                return winnerVisible ? winnerRow : null;
            }
            return base(q);
        });

        try {
            const work = vi.fn(async () => ({ ok: true }));
            const ret = await startJob({
                kind: 'sendNight', sessionId: 'sess-1', idempotencyKey: key,
                request: { a: 1 }, work
            });
            expect(ret).toMatchObject({ jobId: 'winner-job', deduplicated: true });
            await flushSpawn();
            expect(work).not.toHaveBeenCalled(); // the loser must never run the work
        } finally {
            runMock.mockImplementation(base);
        }
    });
});

// ---- Concurrency / semaphore ----------------------------------------------

describe('startJob: per-kind semaphore', () => {
    test('heavy kind: jobs beyond the cap of 4 are queued, not run in parallel', async () => {
        const releaseGates: Array<() => void> = [];
        const inFlight = { count: 0, peak: 0 };

        const makeWork = () => vi.fn(async () => {
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
        const makeWork = () => vi.fn(async () => {
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
    test('fails pre-effect work but sends external execution to reconciliation after restart', async () => {
        const now = new Date().toISOString();
        rows.set('p1', { ID: 'p1', kind: 'sendNight', sessionId: 's', status: 'pending', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: null, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('r1', { ID: 'r1', kind: 'sendNight', sessionId: 's', status: 'running', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: now, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('d1', { ID: 'd1', kind: 'sendNight', sessionId: 's', status: 'running', idempotencyKey: null, request: null, commandVersion: 1, command: '{"op":"sendNight"}', requestedBy: 'alice', result: null, errorCode: null, errorMessage: null, startedAt: now, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('e1', { ID: 'e1', kind: 'sendNight', sessionId: 's', status: 'external_execution', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: now, finishedAt: null, createdAt: now, modifiedAt: now });
        rows.set('s1', { ID: 's1', kind: 'sendNight', sessionId: 's', status: 'succeeded', idempotencyKey: null, request: null, result: '{"ok":true}', errorCode: null, errorMessage: null, startedAt: now, finishedAt: now, createdAt: now, modifiedAt: now });
        rows.set('f1', { ID: 'f1', kind: 'sendNight', sessionId: 's', status: 'failed', idempotencyKey: null, request: null, result: null, errorCode: 'OldErr', errorMessage: 'old', startedAt: now, finishedAt: now, createdAt: now, modifiedAt: now });

        const count = await recoverInterruptedJobs();
        expect(count).toBe(4);

        expect(rows.get('p1')!.status).toBe('failed');
        expect(rows.get('p1')!.errorCode).toBe('PROCESS_RESTART_BEFORE_EXECUTION');
        expect(rows.get('p1')!.errorMessage).toMatch(/external-effect boundary/i);
        expect(rows.get('p1')!.finishedAt).toBeTruthy();

        expect(rows.get('r1')!.status).toBe('failed');
        expect(rows.get('r1')!.errorCode).toBe('PROCESS_RESTART_BEFORE_EXECUTION');
        expect(rows.get('d1')).toMatchObject({ status: 'pending', leaseOwner: null, errorCode: null });
        expect(rows.get('e1')!.status).toBe('reconciliation_required');
        expect(rows.get('e1')!.errorCode).toBe('PROCESS_RESTART_RECONCILE');

        expect(rows.get('s1')!.status).toBe('succeeded');
        expect(rows.get('f1')!.errorCode).toBe('OldErr');
    });

    test('returns 0 and is a no-op when no rows are in flight', async () => {
        expect(await recoverInterruptedJobs()).toBe(0);
    });

    test('survives transient lock contention on the recovery UPDATE', async () => {
        __setStatusWriteBackoffForTests([0, 0, 0]);
        const now = new Date().toISOString();
        rows.set('p1', { ID: 'p1', kind: 'sendNight', sessionId: 's', status: 'pending', idempotencyKey: null, request: null, result: null, errorCode: null, errorMessage: null, startedAt: null, finishedAt: null, createdAt: now, modifiedAt: now });

        lockInjector.failUpdates = 2;
        lockInjector.matchStatus = 'failed';

        const count = await recoverInterruptedJobs();
        expect(count).toBe(1);
        expect(rows.get('p1')!.status).toBe('failed');
        expect(rows.get('p1')!.errorCode).toBe('PROCESS_RESTART_BEFORE_EXECUTION');
    });
});

// ---- Status-write contention hardening ---------------------------------------
//
// Simulates the live incident of 2026-07-19: a foreign long commit (multi-MB
// facade save) holds the SQLite write lock past busy_timeout, so the tiny
// mark* status UPDATEs throw "database is locked". Without retries, the job
// row is stranded in a non-terminal state and pollers die on their own
// watchdog timeout.

describe('status-write contention hardening', () => {
    beforeEach(() => {
        // Backoff without waiting; the schedule only skips zero entries.
        __setStatusWriteBackoffForTests([0, 0, 0]);
    });

    test('markSucceeded survives transient lock contention (2 lost races)', async () => {
        lockInjector.failUpdates = 2;
        lockInjector.matchStatus = 'succeeded';

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work:      async () => ({ txId: 'tx-locked-then-fine' })
        });
        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('succeeded');
        expect(JSON.parse(row.result!)).toEqual({ txId: 'tx-locked-then-fine' });
        expect(lockInjector.failUpdates).toBe(0);
    });

    test('markFailed survives transient lock contention and persists the real classification', async () => {
        lockInjector.failUpdates = 2;
        lockInjector.matchStatus = 'failed';

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work:      async () => { throw new Error('Transaction pool full: 1016 Immediately Dropped'); }
        });
        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('1016');
    });

    test('markReconciliationRequired survives transient lock contention', async () => {
        lockInjector.failUpdates = 2;
        lockInjector.matchStatus = 'reconciliation_required';

        registerBackgroundJobProcessor('partialWorkflow', 1, async () => {
            throw new WorkflowReconciliationRequiredError('first chain step already succeeded');
        });
        const ret = await startJob({
            kind: 'partialWorkflow', sessionId: 'sess-1', requestedBy: 'alice',
            request: {}, commandVersion: 1, command: { op: 'workflow' }
        });
        await flushSpawn();

        expect(rows.get(ret.jobId)).toMatchObject({
            status: 'reconciliation_required',
            errorCode: 'CHILD_RECONCILIATION_REQUIRED'
        });
        expect(lockInjector.failUpdates).toBe(0);
    });

    test('markSucceeded exhausted: job ends failed:RESULT_PERSIST_FAILED instead of stranded running', async () => {
        // 3 lost races exhaust the succeeded write; the fallback markFailed
        // write (status 'failed') must go through.
        lockInjector.failUpdates = 3;
        lockInjector.matchStatus = 'succeeded';

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work:      async () => ({ txId: 'tx-landed-on-chain' })
        });
        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('RESULT_PERSIST_FAILED');
        expect(row.errorMessage).toMatch(/On-chain effects may exist/);
    });

    test('markFailed exhausted: logs and returns without throwing; row stays non-terminal', async () => {
        // All 'failed' writes lose the lock, including the fallback. The
        // function must swallow the failure (nothing upstream can act on it);
        // the row remains 'running' until restart recovery sweeps it.
        lockInjector.failUpdates = 99;
        lockInjector.matchStatus = 'failed';

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work:      async () => { throw new Error('boom'); }
        });
        await flushSpawn();

        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('running');
        expect(row.finishedAt).toBeNull();
    });

    test('non-lock errors in a status write are NOT retried', async () => {
        // A genuine defect must surface immediately instead of burning the
        // retry budget. Inject a non-lock failure into the succeeded write.
        let updateCalls = 0;
        const original = runMock.getMockImplementation()!;
        runMock.mockImplementation(async (q: any) => {
            if (q?.kind === 'update' && q.set?.status === 'succeeded') {
                updateCalls++;
                throw new Error('no such column: bogus');
            }
            return original(q);
        });

        const ret = await startJob({
            kind:      'sendNight',
            sessionId: 'sess-1',
            request:   {},
            work:      async () => ({ ok: true })
        });
        await flushSpawn();

        // The write was attempted exactly once, and the RESULT_PERSIST_FAILED
        // fallback still turned the row terminal.
        expect(updateCalls).toBe(1);
        const row = rows.get(ret.jobId)!;
        expect(row.status).toBe('failed');
        expect(row.errorCode).toBe('RESULT_PERSIST_FAILED');

        runMock.mockImplementation(original);
    });
});
