/**
 * Async job runner for long-running submission actions.
 *
 * Why this exists: the previous synchronous handlers (`registerForDustGeneration`,
 * `sendNight`, `deployContract`, ...) awaited multi-minute-to-hours work
 * inline. That kept the OData request's `req.tx` open for the duration,
 * holding a pool connection and blocking unrelated DB ops (notably the
 * periodic wallet-sync-state save, which deadlocked on the first SELECT). The
 * fix: insert a `BackgroundJobs` row on the request's tx, return
 * `{ jobId, status: 'pending' }` in milliseconds, and detach the actual work
 * to `cds.spawn`. Clients poll `getJobStatus(jobId)` for results.
 *
 * Tx isolation: each row mutation inside the spawn uses an explicit
 * `db.tx(async tx => tx.run(...))` short transaction, so the spawn's
 * top-level tx never acquires a connection. Net effect: the spawn callback
 * holds no pool resources while the long work is in flight; only the
 * per-mutation short txs (milliseconds each) consume connections.
 *
 * Concurrency: a per-`kind` in-process semaphore caps how many jobs of a
 * given kind can run at once. Heavy kinds (full ZK proof + chain submit)
 * default to 4, light kinds (sync-bound only) to 16. Tunable via
 * `cds.requires.nightgate.jobs.concurrency.{heavy,light}`.
 *
 * Idempotency: an optional `idempotencyKey` lets the caller dedupe retries.
 * If a non-failed row exists for the same `(sessionId, kind, idempotencyKey)`,
 * `startJob` returns that row's jobId and result (if any) without starting a
 * new spawn. Failed rows do NOT block a retry: that's the intended path for
 * flaky-network recovery.
 *
 * Error classification: failures are run through `classifySubmissionError`
 * (shared with TransactionSubmitter), so the same Substrate / SDK error
 * codes (`1014`, `1016`, `TxFailed`, `WalletSigningNotAvailable`, ...) appear
 * in the job row as the synchronous path used to expose them.
 */

import cds from '@sap/cds';
import crypto from 'crypto';
import { BackgroundJobs } from '#cds-models/midnight';
import { classifySubmissionError, type SubmissionErrorClassification } from './TransactionSubmitter';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from '../utils/nightgate-config';

const { SELECT, INSERT, UPDATE } = cds.ql;

// ---- Concurrency caps ------------------------------------------------------

const DEFAULT_CONCURRENCY = { heavy: 4, light: 16 } as const;

/**
 * Kinds where each job involves full ZK proof generation through the proof
 * server. 4 concurrent jobs is enough to saturate one proof-server instance;
 * going wider just queues inside the proof server anyway.
 *
 * "light" kinds (anything not in this set) are sync-bound: they wait on the
 * wallet's `waitForSyncedState` but don't drive heavy compute on this server.
 */
const HEAVY_KINDS: ReadonlySet<string> = new Set([
    'registerForDustGeneration',
    'deregisterFromDustGeneration',
    'sendNight',
    'shieldFunds',
    'unshieldFunds',
    'deployContract',
    'submitContractCall',
    'anchorDocument',
    'issuePredicateAttestation',
    'issueFieldPredicateAttestation'
]);

class Semaphore {
    private inFlight = 0;
    private waiters: Array<() => void> = [];
    constructor(public readonly max: number) {}

    async acquire(): Promise<void> {
        if (this.inFlight < this.max) {
            this.inFlight++;
            return;
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        // Slot transferred directly from release(); inFlight already counted.
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
        } else {
            this.inFlight = Math.max(0, this.inFlight - 1);
        }
    }
}

const semaphores: Map<string, Semaphore> = new Map();

function getSemaphore(kind: string): Semaphore {
    const cached = semaphores.get(kind);
    if (cached) return cached;
    const userCaps = ((cds.env as any).requires?.nightgate?.jobs?.concurrency || {}) as { heavy?: number; light?: number };
    const max = HEAVY_KINDS.has(kind)
        ? (typeof userCaps.heavy === 'number' ? userCaps.heavy : DEFAULT_CONCURRENCY.heavy)
        : (typeof userCaps.light === 'number' ? userCaps.light : DEFAULT_CONCURRENCY.light);
    const sem = new Semaphore(max);
    semaphores.set(kind, sem);
    return sem;
}

// ---- Network resolution (memoized) -----------------------------------------

let cachedNetwork: 'preprod' | 'testnet' | 'mainnet' | undefined;
function getNetwork(): 'preprod' | 'testnet' | 'mainnet' {
    if (!cachedNetwork) {
        try {
            cachedNetwork = resolveNightgateRuntimeConfig(getNightgatePluginConfig()).network as
                'preprod' | 'testnet' | 'mainnet';
        } catch {
            cachedNetwork = 'preprod';
        }
    }
    return cachedNetwork;
}

// ---- Serialization ---------------------------------------------------------

/**
 * JSON.stringify with a BigInt → string replacer. The Midnight SDK returns
 * NIGHT/DUST amounts as decimal strings already, but defensive: any handler
 * that returns a bigint by accident still serializes cleanly into `result`.
 */
function safeStringify(value: unknown): string {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
}

// ---- Types -----------------------------------------------------------------

export interface StartJobArgs<TIn, TOut> {
    /** Discriminator; must match one of the kinds the consumer cares about. */
    kind:            string;
    /** Owner scope. Job rows are SELECTed by `sessionId` in `getJobStatus`. */
    sessionId:       string;
    /** Optional dedupe key; see module docs for semantics. */
    idempotencyKey?: string | null;
    /** Inbound action args, JSON-stringified into `request`. Strip secrets first. */
    request:         TIn;
    /** The actual long-running work. Should NOT touch the CAP DB on the main thread. */
    work:            () => Promise<TOut>;
}

export interface StartJobResult<TOut = unknown> {
    jobId:  string;
    status: 'pending' | 'succeeded';
    /** Only present when an idempotent retry hit an already-succeeded row. */
    result?: TOut;
}

export interface BackgroundJobRow {
    ID:             string;
    kind:           string;
    sessionId:      string | null;
    status:         'pending' | 'running' | 'succeeded' | 'failed';
    idempotencyKey: string | null;
    request:        string | null;
    result:         string | null;
    errorCode:      string | null;
    errorMessage:   string | null;
    startedAt:      string | null;
    finishedAt:     string | null;
    createdAt:      string;
    modifiedAt:     string;
}

// ---- Public API ------------------------------------------------------------

/**
 * Insert a `BackgroundJobs` row on the caller's tx and detach the long work
 * to `cds.spawn`. Returns the `jobId` immediately so the OData handler can
 * respond in milliseconds.
 */
export async function startJob<TIn, TOut>(
    args: StartJobArgs<TIn, TOut>
): Promise<StartJobResult<TOut>> {
    const { kind, sessionId, idempotencyKey, request, work } = args;
    if (!kind)                    throw new Error('startJob: kind is required');
    if (!sessionId)               throw new Error('startJob: sessionId is required');
    if (typeof work !== 'function') throw new Error('startJob: work must be a function');

    const db = await cds.connect.to('db');

    // Idempotency dedupe: runs on the caller's tx so this read sees rows
    // committed by prior requests but not in-flight ones in the same tx.
    if (idempotencyKey) {
        const existing = await db.run(
            SELECT.one.from(BackgroundJobs)
                .where({ sessionId, kind, idempotencyKey })
                .orderBy('createdAt desc')
        );
        if (existing && existing.status !== 'failed') {
            return {
                jobId:  existing.ID,
                status: existing.status === 'succeeded' ? 'succeeded' : 'pending',
                result: existing.status === 'succeeded' && existing.result
                    ? JSON.parse(existing.result) as TOut
                    : undefined
            };
        }
    }

    // The INSERT stays on the caller's AMBIENT tx on purpose. CAP wraps every
    // action handler in its own root tx, and handlers commonly WRITE before
    // calling startJob (anchorDocument inserts its Documents row first), so
    // that tx already holds the sqlite write lock. A detached insert here
    // would wait on that very lock from a second connection while the handler
    // waits on us: a deterministic self-deadlock, observed as
    // "database is locked" on every anchorDocument call. Instead the row
    // simply commits together with the handler, and the SPAWN below waits
    // until it is visible before touching it.
    const jobId = crypto.randomUUID();
    await db.run(
        INSERT.into(BackgroundJobs).entries({
            ID:             jobId,
            kind,
            sessionId,
            status:         'pending',
            idempotencyKey: idempotencyKey || null,
            request:        safeStringify(request)
        })
    );

    // Detach. The semaphore caps concurrent jobs of this kind. Each mutation
    // inside the spawn uses its own short tx (see markRunning/Succeeded/Failed),
    // so the spawn's top-level tx never acquires a pool connection.
    const semaphore = getSemaphore(kind);
    // First arg is an empty options object; `cds.spawn` typings require it,
    // and the default behaviour (one-shot via setImmediate, no tenant, no
    // interval) is exactly what we want.
    cds.spawn({}, async () => {
        await semaphore.acquire();
        try {
            // Wait until the caller's tx committed and the row is VISIBLE
            // from a fresh connection. This solves the two failure modes a
            // caller-joined insert would otherwise have: (a) a caller that
            // holds its tx open while waiting inline no longer starves the
            // job's first mutation (we wait READING, without holding any
            // lock); (b) a caller ROLLBACK means the row never appears, and
            // the work is skipped instead of running as an orphan no poller
            // can see.
            const visible = await waitForJobRowVisible(jobId, 10 * 60_000);
            if (!visible) {
                cds.log('nightgate').warn(`startJob(${kind}): job row ${jobId} never became visible (caller rolled back or is holding its tx for 10+ min); skipping work`);
                return;
            }
            await markRunning(jobId);
            // CRITICAL: run `work()` with the ambient cds.context CLEARED.
            //
            // @cap-js/sqlite uses a single pooled connection (pool.max=1). If
            // `work()` ran inside the spawn's transaction, the first db.run it
            // makes (e.g. loadSyncState's SELECT during a facade build) would
            // open a transaction on that ONE connection and hold it for the
            // entire multi-minute-to-hours worker round-trip, starving every
            // other query (periodic wallet-state saves, getJobStatus polls) at
            // pool.acquire(). Clearing the context makes each db.run inside
            // `work()` its own short acquire, commit, release cycle, so the
            // connection stays free during the long awaits.
            const result = await runWithoutAmbientTx(work);
            await markSucceeded(jobId, result);
        } catch (err) {
            const classification = classifySubmissionError(err, getNetwork());
            await markFailed(jobId, classification);
        } finally {
            semaphore.release();
        }
    });

    return { jobId, status: 'pending' };
}

/**
 * Run `fn` with `cds.context` cleared, so any `db.run(...)` it performs gets a
 * fresh short-lived transaction instead of joining a long-lived ambient one.
 * See the call site in `startJob` for why this matters (pool.max=1).
 *
 * `cds._with(undefined, fn)` runs `fn` under an AsyncLocalStorage store of
 * `undefined`, which propagates through `fn`'s entire async chain.
 */
function runWithoutAmbientTx<T>(fn: () => Promise<T>): Promise<T> {
    return (cds as any)._with(undefined, fn);
}

/**
 * Poll (from fresh short read txs) until the BackgroundJobs row is visible,
 * i.e. the caller's transaction committed. Returns false on timeout, which
 * means the caller rolled back (or holds its tx absurdly long) and the work
 * must not run.
 */
async function waitForJobRowVisible(jobId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 100;
    while (Date.now() < deadline) {
        const row = await runWithoutAmbientTx(() => getJobById(jobId));
        if (row) return true;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 2000);
    }
    return false;
}

/**
 * Look up a job by ID. Returns null when not found.
 */
export async function getJobById(jobId: string): Promise<BackgroundJobRow | null> {
    if (!jobId) return null;
    const db = await cds.connect.to('db');
    const row = await db.run(SELECT.one.from(BackgroundJobs).where({ ID: jobId }));
    return (row as BackgroundJobRow | undefined) || null;
}

/**
 * Flip every still-`pending` or `running` row to `failed:PROCESS_RESTART`.
 * Called once at plugin init (`cds.on('served')`) so jobs interrupted by a
 * crash don't linger forever. Idempotent.
 *
 * Returns the count of rows updated for logging.
 */
export async function recoverInterruptedJobs(): Promise<number> {
    const db = await cds.connect.to('db');
    const stuck = await db.run(
        SELECT.from(BackgroundJobs)
            .columns('ID')
            .where({ status: { in: ['pending', 'running'] } })
    );
    const count = Array.isArray(stuck) ? stuck.length : 0;
    if (count === 0) return 0;
    await db.run(
        UPDATE.entity(BackgroundJobs)
            .set({
                status:       'failed',
                errorCode:    'PROCESS_RESTART',
                errorMessage: 'Job was interrupted by a server restart.',
                finishedAt:   new Date().toISOString()
            })
            .where({ status: { in: ['pending', 'running'] } })
    );
    return count;
}

// ---- Internal --------------------------------------------------------------

async function markRunning(jobId: string): Promise<void> {
    const db = await cds.connect.to('db');
    await (db as any).tx(async (tx: any) => {
        await tx.run(
            UPDATE.entity(BackgroundJobs)
                .set({ status: 'running', startedAt: new Date().toISOString() })
                .where({ ID: jobId })
        );
    });
}

async function markSucceeded(jobId: string, result: unknown): Promise<void> {
    const db = await cds.connect.to('db');
    await (db as any).tx(async (tx: any) => {
        await tx.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status:     'succeeded',
                    result:     safeStringify(result),
                    finishedAt: new Date().toISOString()
                })
                .where({ ID: jobId })
        );
    });
}

async function markFailed(jobId: string, classification: SubmissionErrorClassification): Promise<void> {
    const db = await cds.connect.to('db');
    await (db as any).tx(async (tx: any) => {
        await tx.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status:       'failed',
                    errorCode:    classification.code.slice(0, 64),
                    errorMessage: classification.message.slice(0, 4000),
                    finishedAt:   new Date().toISOString()
                })
                .where({ ID: jobId })
        );
    });
}

/** Test-only reset of the in-memory caches. */
export function __resetForTests(): void {
    semaphores.clear();
    cachedNetwork = undefined;
}
