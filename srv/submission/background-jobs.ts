/**
 * Async job runner for long-running submission actions.
 *
 * Why: awaiting multi-minute-to-hours work inline kept the OData request's
 * `req.tx` open, holding a pool connection and blocking unrelated DB ops
 * (notably the periodic wallet-sync-state save, which deadlocked). Instead we
 * insert a `BackgroundJobs` row on the request's tx, return
 * `{ jobId, status: 'pending' }` in ms, and detach the work through a leased
 * scope. Clients poll `getJobStatus(jobId)`.
 *
 * Tx isolation: each row mutation in the spawn uses its own short
 * `db.tx(tx => tx.run(...))`, so the spawn holds no pool connection while the
 * long work runs; only the per-mutation txs (ms each) consume connections.
 *
 * Concurrency: a per-`kind` in-process semaphore caps concurrent jobs. Heavy
 * kinds (ZK proof + chain submit) default to 4, light (sync-bound) to 16.
 * Tunable via `cds.requires.nightgate.jobs.concurrency.{heavy,light}`.
 *
 * Idempotency: an optional `idempotencyKey` dedupes retries via a DB constraint
 * on `(sessionId, kind, idempotencyKey)`. The key stays permanently bound to the
 * first job (a new attempt needs a new key); a concurrent same-key loser
 * collides on the constraint and resolves to the winner's job (savepoint path in
 * `startJob`), never a raw error.
 *
 * Error classification: failures run through `classifySubmissionError` (shared
 * with TransactionSubmitter), so the same Substrate/SDK codes (`1014`, `1016`,
 * `TxFailed`, ...) land in the job row.
 */

import cds from '@sap/cds';
import crypto from 'crypto';
import { AsyncResource } from 'async_hooks';
import { BackgroundJobs, PendingSubmissions, Transactions, TransactionResults } from '#cds-models/midnight';
import { classifySubmissionError, type SubmissionErrorClassification } from './TransactionSubmitter';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from '../utils/nightgate-config';
import { runInJobExecutionContext } from './job-execution-context';
import { encrypt as encryptAtRest, decrypt as decryptAtRest, getEncryptionKey } from '../utils/crypto';

const { SELECT, INSERT, UPDATE } = cds.ql;

// Created at module load, before request handling. Running job work through this
// resource leaves CAP's request/transaction AsyncLocalStorage scope without
// relying on the private `cds._with` implementation.
const detachedJobScope = new AsyncResource('nightgate.detached-job-work');

// ---- Concurrency caps ------------------------------------------------------

const DEFAULT_CONCURRENCY = { heavy: 4, light: 16 } as const;

/**
 * Kinds where each job runs full ZK proof generation through the proof server.
 * 4 concurrent is enough to saturate one proof-server instance; wider just queues
 * inside it. "light" kinds (not in this set) are sync-bound (wait on
 * `waitForSyncedState`, no heavy compute here).
 */
const HEAVY_KINDS: ReadonlySet<string> = new Set([
    'registerForDustGeneration',
    'deregisterFromDustGeneration',
    'sendNight',
    'shieldFunds',
    'unshieldFunds',
    'deployContract',
    'submitContractCallBatch',
    'submitContractCall',
    'anchorDocument',
    'issuePredicateAttestation',
    'issueFieldPredicateAttestation',
    'predicateCommitValue',
    'predicateProof',
    'fieldAnchorRoot',
    'fieldPredicateProof',
    'grantDisclosure',
    'revokeDisclosure',
    'registerPassport'
]);
const WORKFLOW_PARENT_KINDS: ReadonlySet<string> = new Set([
    'issuePredicateAttestation',
    'issueFieldPredicateAttestation'
]);

class Semaphore {
    private inFlight = 0;
    private waiters: Array<() => void> = [];
    constructor(public readonly max: number) { }

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

/** JSON.stringify with a BigInt → string replacer, so a stray bigint still serializes cleanly. */
function safeStringify(value: unknown): string {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
}

// ---- Types -----------------------------------------------------------------

export interface StartJobArgs<TIn, TOut> {
    /** Discriminator; must match one of the kinds the consumer cares about. */
    kind: string;
    /** Owner scope. Job rows are SELECTed by `sessionId` in `getJobStatus`. */
    sessionId: string;
    /** Optional dedupe key; see module docs for semantics. */
    idempotencyKey?: string | null;
    /** Inbound action args, JSON-stringified into `request`. Strip secrets first. */
    request: TIn;
    /** Stable semantic input used for idempotency when request contains generated IDs. */
    idempotencyPayload?: unknown;
    /** Authenticated principal used to revalidate session ownership on replay. */
    requestedBy?: string;
    /** Versioned replayable command. Requires a registered processor for `kind`. */
    command?: unknown;
    commandVersion?: number;
    /** Encrypt the persisted command with ENCRYPTION_KEY (required for private circuit inputs). */
    encryptCommand?: boolean;
    parentJobId?: string;
    workflowStep?: string;
    /** Legacy in-memory execution. Omit for replayable commands. */
    work?: () => Promise<TOut>;
}

export interface StartJobResult<TOut = unknown, TIn = unknown> {
    jobId: string;
    status: BackgroundJobRow['status'];
    /** Only present when an idempotent retry hit an already-succeeded row. */
    result?: TOut;
    /** True when the database already contained the immutable idempotency key. */
    deduplicated?: boolean;
    /** Original persisted request, useful for returning its stable resource IDs. */
    originalRequest?: TIn;
}

export interface BackgroundJobRow {
    ID: string;
    kind: string;
    sessionId: string | null;
    status: 'pending' | 'running' | 'external_execution' | 'submitted' | 'reconciliation_required' | 'succeeded' | 'failed';
    idempotencyKey: string | null;
    request: string | null;
    payloadFingerprint: string | null;
    commandVersion: number | null;
    command: string | null;
    commandEncoding: 'json-v1' | 'aes-gcm-v1' | null;
    requestedBy: string | null;
    parentJobId: string | null;
    workflowStep: string | null;
    result: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    queuedAt: string | null;
    externalExecutionAt: string | null;
    submittedAt: string | null;
    finishedAt: string | null;
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    heartbeatAt: string | null;
    submissionId: string | null;
    txHash: string | null;
    chainStatus: 'pending' | 'success' | 'failure' | null;
    chainFinalizedAt: string | null;
    createdAt: string;
    modifiedAt: string;
}

// Public API

/**
 * Insert a `BackgroundJobs` row on the caller's tx and detach the long work.
 * Returns the `jobId` immediately so the handler responds in ms.
 */
export async function startJob<TIn, TOut>(
    args: StartJobArgs<TIn, TOut>
): Promise<StartJobResult<TOut>> {
    const { kind, sessionId, idempotencyKey, request, idempotencyPayload, requestedBy, command, commandVersion, encryptCommand, parentJobId, workflowStep, work } = args;
    if (!kind) throw new Error('startJob: kind is required');
    if (!sessionId) throw new Error('startJob: sessionId is required');
    const replayable = command !== undefined;
    if (!replayable && typeof work !== 'function') throw new Error('startJob: work or command is required');
    if (replayable && (!Number.isInteger(commandVersion) || Number(commandVersion) < 1)) {
        throw new Error('startJob: commandVersion must be a positive integer for replayable commands');
    }
    if (replayable && !requestedBy) throw new Error('startJob: requestedBy is required for replayable commands');
    if (replayable && !processors.has(processorKey(kind, Number(commandVersion)))) {
        throw new Error(`startJob: no command processor registered for '${kind}' v${commandVersion}`);
    }

    const db = await cds.connect.to('db');

    const serializedRequest = safeStringify(request);
    const fingerprintPayload = safeStringify(idempotencyPayload ?? request);
    const payloadFingerprint = crypto.createHash('sha256')
        .update(`${kind}\0${sessionId}\0${fingerprintPayload}`)
        .digest('hex');

    // Savepoints only protect the outer tx when SAVEPOINT/INSERT/ROLLBACK share
    // one pinned connection, i.e. inside an ambient request tx (`cds.context` set
    // → `db.tx(cds.context)`). Outside one, db.run autocommits on pooled
    // connections, so skip the savepoint. Same runner for reads so the fast-path
    // dedupe sees the ambient tx's own writes.
    const pinnedRunner: { run: (q: any) => Promise<any> } | undefined =
        cds.context ? (db as any).tx(cds.context) : undefined;
    const reader = pinnedRunner ?? db;

    // Idempotency dedupe (fast path): sees rows committed by prior requests but
    // not in-flight ones in another tx — the constraint covers that race below.
    if (idempotencyKey) {
        const dup = await dedupExisting<TIn, TOut>(reader, sessionId, kind, idempotencyKey, payloadFingerprint);
        if (dup) return dup;
    }

    // The INSERT stays on the caller's AMBIENT tx on purpose: CAP wraps each
    // action handler in a root tx, and handlers commonly WRITE before startJob
    // (anchorDocument inserts its Documents row first), so that tx already holds
    // the sqlite write lock.
    const jobId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    const serializedCommand = replayable ? safeStringify(command) : null;
    const commandEncoding = replayable ? (encryptCommand ? 'aes-gcm-v1' : 'json-v1') : null;
    const persistedCommand = serializedCommand && encryptCommand
        ? encryptAtRest(serializedCommand, getEncryptionKey())
        : serializedCommand;
    const buildInsert = () => INSERT.into(BackgroundJobs).entries({
        ID: jobId,
        kind,
        sessionId,
        status: 'pending',
        idempotencyKey: idempotencyKey || null,
        request: serializedRequest,
        payloadFingerprint,
        commandVersion: replayable ? commandVersion : null,
        command: persistedCommand,
        commandEncoding,
        requestedBy: requestedBy ?? null,
        parentJobId: parentJobId ?? null,
        workflowStep: workflowStep ?? null,
        queuedAt,
        attempt: 0,
        maxAttempts: 1
    });

    if (idempotencyKey && pinnedRunner) {
        // A concurrent same-key request can pass the dedupe read (winner not yet
        // committed) and collide here on the unique constraint; return the
        // WINNER's job, not a raw error. The savepoint lets ROLLBACK TO clear
        // Postgres's aborted-tx state so the handler can continue.
        const sp = 'nightgate_job_insert';
        await pinnedRunner.run(`SAVEPOINT ${sp}`);
        try {
            await pinnedRunner.run(buildInsert());
        } catch (insertErr) {
            await pinnedRunner.run(`ROLLBACK TO SAVEPOINT ${sp}`);
            await pinnedRunner.run(`RELEASE SAVEPOINT ${sp}`);
            if (!isUniqueViolation(insertErr)) throw insertErr;
            const dup = await dedupExisting<TIn, TOut>(pinnedRunner, sessionId, kind, idempotencyKey, payloadFingerprint);
            if (dup) return dup;
            throw insertErr;
        }
        await pinnedRunner.run(`RELEASE SAVEPOINT ${sp}`);
    } else if (idempotencyKey) {
        // No pinned runner (outside a request tx): autocommit insert. Each db.run
        // is its own connection, so a collision poisons nothing; recover the
        // winner on a fresh read.
        try {
            await db.run(buildInsert());
        } catch (insertErr) {
            if (!isUniqueViolation(insertErr)) throw insertErr;
            const dup = await dedupExisting<TIn, TOut>(db, sessionId, kind, idempotencyKey, payloadFingerprint);
            if (dup) return dup;
            throw insertErr;
        }
    } else {
        await db.run(buildInsert());
    }

    // Detach; the semaphore caps concurrent jobs of this kind.
    scheduleJob(jobId, kind, work);

    return { jobId, status: 'pending', deduplicated: false };
}

type BackgroundJobProcessor = (command: unknown, row: BackgroundJobRow) => Promise<unknown>;
export interface ReconciliationEvidence {
    submissionId: string | null;
    txHash: string;
    contractAddress: string | null;
    finalizedAt: string | null;
}
type BackgroundJobReconciliationFinalizer = (
    command: unknown,
    row: BackgroundJobRow,
    evidence: ReconciliationEvidence
) => Promise<unknown>;
const processors = new Map<string, BackgroundJobProcessor>();
const reconciliationFinalizers = new Map<string, BackgroundJobReconciliationFinalizer>();
const processorKey = (kind: string, version: number): string => `${kind}\0${version}`;

/** Register one deterministic processor per durable job kind. */
export function registerBackgroundJobProcessor(kind: string, version: number, processor: BackgroundJobProcessor): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof processor !== 'function') {
        throw new Error('registerBackgroundJobProcessor: kind, positive version and processor are required');
    }
    processors.set(processorKey(kind, version), processor);
}

/** Register idempotent post-submit writes for one durable leaf command. */
export function registerBackgroundJobReconciliationFinalizer(
    kind: string,
    version: number,
    finalizer: BackgroundJobReconciliationFinalizer
): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof finalizer !== 'function') {
        throw new Error('registerBackgroundJobReconciliationFinalizer: kind, positive version and finalizer are required');
    }
    reconciliationFinalizers.set(processorKey(kind, version), finalizer);
}

function scheduleJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    const semaphore = getSemaphore(kind);
    setImmediate(() => void runWithoutAmbientTx(async () => {
        // Commit visibility does not consume scarce proof/submission capacity.
        const visible = await waitForJobRowVisible(jobId, 10 * 60_000);
        if (!visible) {
            cds.log('nightgate').warn(`startJob(${kind}): job row ${jobId} never became visible (caller rolled back or is holding its tx for 10+ min); skipping work`);
            return;
        }

        await semaphore.acquire();
        try {
            const claimed = await markRunning(jobId);
            if (!claimed) {
                cds.log('nightgate').debug(`startJob(${kind}): job ${jobId} was already claimed or is no longer pending; skipping work`);
                return;
            }
            const stopHeartbeat = startLeaseHeartbeat(jobId);
            // CRITICAL: run `work()` with the ambient cds.context CLEARED.
            try {
                const row = await getJobById(jobId);
                if (!row) throw new Error(`Background job ${jobId} disappeared after claim`);
                const executable = row.command && row.commandVersion
                    ? () => executePersistedCommand(row)
                    : legacyWork;
                if (!executable) throw new Error(`Background job ${jobId} has neither a persisted command nor in-memory work`);
                const result = await runWithoutAmbientTx(() => runInJobExecutionContext(
                    {
                        reportExternalExecution: handle => markJobExternalExecution(jobId, handle),
                        reportSubmitted: handle => markJobSubmitted(jobId, handle)
                    },
                    executable
                ));
                try {
                    await markSucceeded(jobId, result);
                } catch (persistErr) {
                    // The work itself completed; only the status write kept losing
                    cds.log('nightgate').error(
                        `markSucceeded(${jobId}): could not persist the result after ${STATUS_WRITE_ATTEMPTS} attempts; marking failed:RESULT_PERSIST_FAILED`,
                        persistErr
                    );
                    await markFailed(jobId, {
                        code: 'RESULT_PERSIST_FAILED',
                        retryable: false,
                        message: 'The job work completed but its result could not be persisted (database lock contention or a lost worker lease). On-chain effects may exist; verify chain state before retrying.'
                    });
                }
            } finally {
                stopHeartbeat();
            }
        } catch (err) {
            if (err instanceof WorkflowReconciliationRequiredError) {
                await markReconciliationRequired(jobId, {
                    code: 'CHILD_RECONCILIATION_REQUIRED',
                    message: err.message
                });
            } else {
                const classification = classifySubmissionError(err, getNetwork());
                const current = await getJobById(jobId);
                // Only a job that recorded a real transaction hash may have an
                // on-chain effect worth reconciling. A failure while still in
                // `external_execution` with no txHash (proof generation or
                // balancing failed before any broadcast) is unambiguous, so it
                // fails cleanly — a legitimately rejected job (e.g. a false
                // predicate) must not demand operator reconciliation. Crash
                // recovery still fail-closes `external_execution` rows, which
                // is the genuinely ambiguous case.
                if (current?.txHash) {
                    await markReconciliationRequired(jobId, {
                        code: 'EXTERNAL_EXECUTION_FAILED',
                        message: `Execution failed after broadcasting ${current.txHash}; verify chain state before retrying. ${classification.message}`
                    });
                } else {
                    await markFailed(jobId, classification);
                }
            }
        } finally {
            semaphore.release();
        }
    }).catch(err => cds.log('nightgate').error(`Detached job ${jobId} crashed outside its guarded execution path`, err)));
}

async function executePersistedCommand(row: BackgroundJobRow): Promise<unknown> {
    const processor = processors.get(processorKey(row.kind, row.commandVersion!));
    if (!processor) throw new Error(`No background-job processor registered for '${row.kind}' v${row.commandVersion}`);
    const serialized = row.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(row.command!, getEncryptionKey())
        : row.command!;
    return processor(JSON.parse(serialized), row);
}

export class WorkflowReconciliationRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkflowReconciliationRequiredError';
    }
}

class ChildReconciliationRequiredError extends WorkflowReconciliationRequiredError {
    constructor(public readonly childJobId: string, public readonly step: string) {
        super(`Child job ${childJobId} for workflow step '${step}' requires reconciliation`);
        this.name = 'ChildReconciliationRequiredError';
    }
}

function childWaitTimeoutMs(): number {
    const explicit = Number(process.env.NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const configuredWorkerTimeout = Number(process.env.NIGHTGATE_WORKER_RPC_TIMEOUT_MS);
    const workerTimeout = Number.isFinite(configuredWorkerTimeout) && configuredWorkerTimeout > 0
        ? configuredWorkerTimeout
        : 30 * 60_000;
    return workerTimeout + 5 * 60_000;
}

/**
 * Execute one deterministic child command and wait for its durable result.
 * Each child may cross the external-effect boundary at most once. Re-running a
 * parent after a crash resolves the same child through its immutable key.
 */
export async function runChildCommand<T>(args: {
    parent: BackgroundJobRow;
    kind: string;
    step: string;
    commandVersion: number;
    command: unknown;
    request: unknown;
    encryptCommand?: boolean;
}): Promise<T> {
    const { parent, kind, step, commandVersion, command, request, encryptCommand = true } = args;
    if (!parent.sessionId || !parent.requestedBy) throw new Error(`Parent job ${parent.ID} lacks execution identity`);
    const child = await startJob({
        kind,
        sessionId: parent.sessionId,
        requestedBy: parent.requestedBy,
        idempotencyKey: `workflow:${parent.ID}:${step}`,
        idempotencyPayload: { parentJobId: parent.ID, step, commandVersion, command },
        request,
        commandVersion,
        command,
        encryptCommand,
        parentJobId: parent.ID,
        workflowStep: step
    });
    if (child.status === 'succeeded' && child.result !== undefined) return child.result as T;

    const deadline = Date.now() + childWaitTimeoutMs();
    for (;;) {
        const row = await getJobById(child.jobId);
        if (!row) throw new Error(`Child job ${child.jobId} disappeared`);
        if (row.status === 'succeeded') return (row.result ? JSON.parse(row.result) : undefined) as T;
        if (row.status === 'reconciliation_required') throw new ChildReconciliationRequiredError(row.ID, step);
        if (row.status === 'failed') throw new Error(`Child job ${row.ID} failed [${row.errorCode ?? 'UNKNOWN'}]: ${row.errorMessage ?? 'unknown error'}`);
        if (Date.now() >= deadline) {
            throw new WorkflowReconciliationRequiredError(
                `Timed out waiting for child job ${row.ID} at workflow step '${step}' while it remained ${row.status}; the child may still cross the external-effect boundary`
            );
        }
        await sleep(500);
    }
}

/**
 * Run `fn` with `cds.context` cleared so any `db.run(...)` gets a fresh
 * short-lived tx instead of joining a long-lived ambient one (matters at
 * pool.max=1). The module-level AsyncResource has no CAP transaction, and Node
 * propagates that empty scope through `fn`'s promise chain.
 */
function runWithoutAmbientTx<T>(fn: () => Promise<T>): Promise<T> {
    return detachedJobScope.runInAsyncScope(fn);
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

export async function getJobById(jobId: string): Promise<BackgroundJobRow | null> {
    if (!jobId) return null;
    const db = await cds.connect.to('db');
    const row = await db.run(SELECT.one.from(BackgroundJobs).where({ ID: jobId }));
    return (row as BackgroundJobRow | undefined) || null;
}

/**
 * Look up the existing job for an idempotency identity and shape it into the
 * deduplicated `StartJobResult`. Rejects a reused key whose payload changed.
 * Returns null when no row exists yet. Used both on the fast dedupe path and to
 * resolve a concurrent-insert loser to the winner (see `startJob`).
 */
async function dedupExisting<TIn, TOut>(
    runner: { run: (q: any) => Promise<any> },
    sessionId: string,
    kind: string,
    idempotencyKey: string,
    payloadFingerprint: string
): Promise<StartJobResult<TOut, TIn> | null> {
    const existing = await runner.run(
        SELECT.one.from(BackgroundJobs)
            .where({ sessionId, kind, idempotencyKey })
            .orderBy('createdAt desc')
    );
    if (!existing) return null;
    if (existing.payloadFingerprint && existing.payloadFingerprint !== payloadFingerprint) {
        throw new Error(`Idempotency key '${idempotencyKey}' was already used with a different request payload.`);
    }
    return {
        jobId: existing.ID,
        status: existing.status,
        result: existing.status === 'succeeded' && existing.result
            ? JSON.parse(existing.result) as TOut
            : undefined,
        deduplicated: true,
        originalRequest: existing.request ? JSON.parse(existing.request) as TIn : undefined
    };
}

/**
 * Resolve jobs left behind by a process restart without risking a duplicate
 * external effect. Versioned commands stay queued or reset from pre-effect
 * `running` to `pending`; legacy closures become terminal (can't be
 * reconstructed); external-effect states require reconciliation before retry.
 * Called once at plugin init (`cds.on('served')`); idempotent. Returns the count
 * of classified rows.
 */
export async function recoverInterruptedJobs(): Promise<number> {
    const db = await cds.connect.to('db');
    const stuck = await db.run(
        SELECT.from(BackgroundJobs)
            .columns('ID', 'status', 'commandVersion')
            .where({ status: { in: ['pending', 'running', 'external_execution', 'submitted'] } })
    );
    const count = Array.isArray(stuck) ? stuck.length : 0;
    if (count === 0) return 0;
    await withStatusWriteRetry('recoverInterruptedJobs', async () => {
        // Replayable commands are safe to put back in the queue only while
        // still before the persisted external-effect boundary.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'pending',
                    errorCode: null,
                    errorMessage: null,
                    startedAt: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: 'running', commandVersion: { '!=': null } })
        );
        // Legacy closures cannot be reconstructed. Pending and pre-effect
        // running rows without a command remain terminal after restart.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_BEFORE_EXECUTION',
                    errorMessage: 'The process restarted before the job crossed the external-effect boundary. A new idempotency key may be used for an intentional retry.',
                    finishedAt: new Date().toISOString()
                })
                .where({ status: { in: ['pending', 'running'] }, commandVersion: null })
        );
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'reconciliation_required',
                    errorCode: 'PROCESS_RESTART_RECONCILE',
                    errorMessage: 'Execution was interrupted after an external effect may have occurred. Verify submission/chain state before retrying.',
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: { in: ['external_execution', 'submitted'] } })
        );
    });
    return count;
}

let commandPollTimer: ReturnType<typeof setInterval> | undefined;
let commandPollActive = false;
const SCAN_PAGE_SIZE = 100;
let reconciliationCursor: string | undefined;
let chainPendingCursor: string | undefined;
let chainLegacyCursor: string | undefined;
let parentPendingCursor: string | undefined;
let parentLegacyCursor: string | undefined;
let confirmerPendingCursor: string | undefined;
let confirmerLegacyCursor: string | undefined;

// Crawler-free chain-outcome confirmer, injected at startup only when the
// crawler is disabled (or explicitly opted in). Null keeps the pass a no-op, so
// crawler deployments see no behavior change.
type ChainOutcomeConfirmer = (txHash: string) => Promise<{ status: 'success' | 'failure' } | null>;
let chainOutcomeConfirmer: ChainOutcomeConfirmer | null = null;
let chainConfirmActive = false;
const CHAIN_CONFIRM_CONCURRENCY = 8;

/** Register (or clear, with null) the crawler-free tx-outcome confirmer. */
export function registerChainOutcomeConfirmer(confirmer: ChainOutcomeConfirmer | null): void {
    chainOutcomeConfirmer = confirmer;
}

/**
 * Kick a confirm pass without blocking the caller. Decoupled from the command
 * poller: the pass runs to completion in the background and a single-flight
 * guard drops overlapping kicks, so slow Indexer lookups never stall command
 * polling or reconciliation.
 */
function triggerChainConfirmPass(): void {
    if (!chainOutcomeConfirmer || chainConfirmActive) return;
    chainConfirmActive = true;
    void confirmChainOutcomesViaIndexer()
        .catch(err => cds.log('nightgate').warn(
            `Chain-outcome confirm pass failed: ${String((err as Error)?.message ?? err)}`))
        .finally(() => { chainConfirmActive = false; });
}

/**
 * Read one bounded, deterministic page, advancing past every inspected row
 * (including poison rows) and wrapping to the start at the end. NIGHTGATE's
 * enforced single-instance topology makes these process-local cursors
 * sufficient; a restart just begins a new fair pass from the first key.
 */
async function scanBackgroundJobPage(
    db: any,
    where: Record<string, unknown>,
    cursor: string | undefined
): Promise<{ rows: BackgroundJobRow[]; cursor: string | undefined }> {
    const select = async (after?: string): Promise<BackgroundJobRow[]> => db.run(
        SELECT.from(BackgroundJobs)
            .where(after ? { ...where, ID: { '>': after } } : where)
            .orderBy('ID asc')
            .limit(SCAN_PAGE_SIZE)
    ) as Promise<BackgroundJobRow[]>;

    let rows = await select(cursor);
    if (rows.length === 0 && cursor) rows = await select();
    return {
        rows,
        cursor: rows.length > 0 ? rows[rows.length - 1].ID : undefined
    };
}

/**
 * Start the single-instance durable command poller. Atomic `pending -> running`
 * claims remain the final guard, so duplicate scans can only schedule no-op
 * contenders. Call after processors and the wallet worker are ready.
 */
export async function startBackgroundJobProcessor(): Promise<void> {
    if (commandPollTimer) return;
    await pollPersistedCommands();
    await reconcileBackgroundJobs();
    await refreshSucceededChainOutcomes();
    triggerChainConfirmPass();
    commandPollTimer = setInterval(() => void pollPersistedCommands().catch(err => {
        cds.log('nightgate').warn(`Background-job poll failed: ${String((err as Error)?.message ?? err)}`);
    }), 2000);
    commandPollTimer.unref?.();
}

export function stopBackgroundJobProcessor(): void {
    if (commandPollTimer) clearInterval(commandPollTimer);
    commandPollTimer = undefined;
}

async function pollPersistedCommands(): Promise<void> {
    if (commandPollActive) return;
    commandPollActive = true;
    try {
        const db = await cds.connect.to('db');
        const rows = await db.run(
            SELECT.from(BackgroundJobs)
                .columns('ID', 'kind', 'commandVersion')
                .where({ status: 'pending', commandVersion: { '!=': null } })
                .limit(100)
        );
        for (const row of rows as Array<{ ID: string; kind: string; commandVersion: number }>) {
            if (processors.has(processorKey(row.kind, row.commandVersion))) scheduleJob(row.ID, row.kind);
        }
        await reconcileBackgroundJobs(db);
        await refreshSucceededChainOutcomes(db);
        triggerChainConfirmPass();
    } finally {
        commandPollActive = false;
    }
}

/**
 * Conservatively resolve ambiguous jobs from durable chain evidence. A job
 * completes only when its exact tx is finalized in PendingSubmissions AND indexed
 * by the crawler (proves submission/inclusion, not business success); a txHash or
 * an `included` PendingSubmission alone is not enough. Workflow parents are
 * re-queued only after every child step succeeded; their processor then rebuilds
 * the typed result without re-submitting any child.
 */
export async function reconcileBackgroundJobs(existingDb?: any): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const page = await scanBackgroundJobPage(
        db, { status: 'reconciliation_required' }, reconciliationCursor
    );
    reconciliationCursor = page.cursor;
    const candidates = page.rows;
    let resolved = 0;

    for (const job of candidates) {
        if (WORKFLOW_PARENT_KINDS.has(job.kind)) {
            const children = await db.run(
                SELECT.from(BackgroundJobs).where({ parentJobId: job.ID })
            ) as BackgroundJobRow[];
            if (children.length > 0 && children.every(child => child.status === 'succeeded')) {
                const affected = await withStatusWriteRetry(`requeueReconciledParent(${job.ID})`, () => db.run(
                    UPDATE.entity(BackgroundJobs).set({
                        status: 'pending', errorCode: null, errorMessage: null,
                        startedAt: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
                    }).where({ ID: job.ID, status: 'reconciliation_required' })
                ));
                resolved += affectedRows(affected);
            }
            continue;
        }

        const submission = job.submissionId
            ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: job.submissionId }))
            : job.txHash
                ? await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: job.txHash }))
                : null;
        const txHash = job.txHash ?? submission?.txHash;
        if (!txHash || submission?.status !== 'finalized') continue;

        const indexedTx = await db.run(SELECT.one.from(Transactions).columns('ID', 'hash').where({ hash: txHash }));
        if (!indexedTx?.ID) continue;
        const txResult = await db.run(
            SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: indexedTx.ID })
        );
        if (txResult?.outcomeSource !== 'substrate-system-events'
            || (txResult.status !== 'SUCCESS' && txResult.status !== 'FAILURE')) continue;
        const chainFinalizedAt = submission?.finalizedAt ?? new Date().toISOString();
        if (txResult.status === 'FAILURE') {
            const affected = await withStatusWriteRetry(`reconcileFailedJob(${job.ID})`, () => db.run(
                UPDATE.entity(BackgroundJobs).set({
                    status: 'failed', chainStatus: 'failure', chainFinalizedAt,
                    errorCode: 'CHAIN_EXECUTION_FAILED',
                    errorMessage: `Transaction ${txHash} was finalized with system.ExtrinsicFailed`,
                    finishedAt: new Date().toISOString()
                }).where({ ID: job.ID, status: 'reconciliation_required' })
            ));
            resolved += affectedRows(affected);
            continue;
        }
        const evidence: ReconciliationEvidence = {
            submissionId: submission?.ID ?? job.submissionId,
            txHash,
            contractAddress: submission?.contractAddress ?? null,
            finalizedAt: submission?.finalizedAt ?? null
        };
        const finalizer = job.commandVersion
            ? reconciliationFinalizers.get(processorKey(job.kind, job.commandVersion))
            : undefined;
        let result: unknown = {
            reconciled: true, ...evidence, status: 'finalized'
        };
        if (finalizer) {
            try {
                const serialized = job.commandEncoding === 'aes-gcm-v1'
                    ? decryptAtRest(job.command!, getEncryptionKey())
                    : job.command!;
                result = await finalizer(JSON.parse(serialized), job, evidence);
            } catch (err) {
                cds.log('nightgate').warn(
                    `Reconciliation finalizer for ${job.kind} job ${job.ID} failed; keeping reconciliation_required: ${String((err as Error)?.message ?? err)}`
                );
                continue;
            }
        }
        const affected = await withStatusWriteRetry(`reconcileJob(${job.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set({
                status: 'succeeded',
                chainStatus: 'success', chainFinalizedAt,
                result: safeStringify(result),
                errorCode: null, errorMessage: null, finishedAt: new Date().toISOString()
            }).where({ ID: job.ID, status: 'reconciliation_required' })
        ));
        resolved += affectedRows(affected);
    }
    return resolved;
}

/** Enrich already-completed submission workflows with their later chain outcome. */
export async function refreshSucceededChainOutcomes(existingDb?: any): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const pendingPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: 'pending'
    }, chainPendingCursor);
    chainPendingCursor = pendingPage.cursor;
    const legacyPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: null
    }, chainLegacyCursor);
    chainLegacyCursor = legacyPage.cursor;
    const jobs = [...pendingPage.rows, ...legacyPage.rows];
    let updated = 0;
    for (const job of jobs) {
        const submission = job.submissionId
            ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: job.submissionId }))
            : await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: job.txHash }));
        if (submission?.status !== 'finalized') continue;
        const indexedTx = await db.run(SELECT.one.from(Transactions).columns('ID').where({ hash: job.txHash }));
        if (!indexedTx?.ID) continue;
        const outcome = await db.run(
            SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: indexedTx.ID })
        );
        if (outcome?.outcomeSource !== 'substrate-system-events'
            || (outcome.status !== 'SUCCESS' && outcome.status !== 'FAILURE')) continue;
        const affected = await withStatusWriteRetry(`refreshChainOutcome(${job.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set({
                chainStatus: outcome.status === 'SUCCESS' ? 'success' : 'failure',
                chainFinalizedAt: submission.finalizedAt ?? new Date().toISOString()
            }).where({ ID: job.ID, status: 'succeeded' })
        ));
        updated += affectedRows(affected);
    }

    const pendingParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: [...WORKFLOW_PARENT_KINDS] }, chainStatus: 'pending'
    }, parentPendingCursor);
    parentPendingCursor = pendingParents.cursor;
    const legacyParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: [...WORKFLOW_PARENT_KINDS] }, chainStatus: null
    }, parentLegacyCursor);
    parentLegacyCursor = legacyParents.cursor;
    const parents = [...pendingParents.rows, ...legacyParents.rows];
    for (const parent of parents) {
        const children = await db.run(SELECT.from(BackgroundJobs).where({ parentJobId: parent.ID })) as BackgroundJobRow[];
        if (children.length === 0) continue;
        const aggregate = children.some(child => child.chainStatus === 'failure')
            ? 'failure'
            : children.every(child => child.chainStatus === 'success') ? 'success' : 'pending';
        if (parent.chainStatus === aggregate) continue;
        const affected = await withStatusWriteRetry(`refreshParentChainOutcome(${parent.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set({
                chainStatus: aggregate,
                chainFinalizedAt: aggregate === 'pending' ? null : new Date().toISOString()
            }).where({ ID: parent.ID, status: 'succeeded' })
        ));
        updated += affectedRows(affected);
    }
    return updated;
}

/**
 * Crawler-free twin of `refreshSucceededChainOutcomes`' leaf pass: advance a
 * succeeded leaf job's `chainStatus` by a per-tx Indexer lookup instead of the
 * crawler-populated `Transactions`/`TransactionResults`. No-op unless a confirmer
 * is registered (crawler on -> not registered). Workflow parents are skipped;
 * their `chainStatus` is aggregated from children by `refreshSucceededChainOutcomes`.
 */
export async function confirmChainOutcomesViaIndexer(existingDb?: any): Promise<number> {
    const confirmer = chainOutcomeConfirmer;
    if (!confirmer) return 0;
    const db = existingDb ?? await cds.connect.to('db');
    const pendingPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: 'pending'
    }, confirmerPendingCursor);
    confirmerPendingCursor = pendingPage.cursor;
    const legacyPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: null
    }, confirmerLegacyCursor);
    confirmerLegacyCursor = legacyPage.cursor;
    const jobs = [...pendingPage.rows, ...legacyPage.rows].filter(job => !WORKFLOW_PARENT_KINDS.has(job.kind));
    let updated = 0;
    let lookupErrors = 0;
    let writeErrors = 0;
    // Bounded parallelism: each lookup is one short Indexer query. Serial would
    // let a full page stack per-lookup latency; unbounded would hammer the Indexer.
    await mapWithConcurrency(jobs, CHAIN_CONFIRM_CONCURRENCY, async job => {
        let outcome: { status: 'success' | 'failure' } | null;
        try {
            outcome = await confirmer(job.txHash!);
        } catch {
            lookupErrors++;
            return;
        }
        if (!outcome) return; // not yet indexed -> retry next tick
        // CAS on the exact chainStatus we read (compiles to `= 'pending'` or,
        // for legacy rows, `IS NULL` - not `IN (...)`, which never matches NULL in
        // SQL). Keeps the write a safe no-op if the value changed since the scan.
        try {
            const affected = await withStatusWriteRetry(`confirmChainOutcome(${job.ID})`, () => db.run(
                UPDATE.entity(BackgroundJobs).set({
                    chainStatus: outcome!.status,
                    chainFinalizedAt: new Date().toISOString()
                }).where({ ID: job.ID, status: 'succeeded', chainStatus: job.chainStatus ?? null })
            ));
            updated += affectedRows(affected);
        } catch {
            writeErrors++;
        }
    });
    if (lookupErrors > 0 || writeErrors > 0) {
        cds.log('nightgate').warn(
            `Crawler-free chain confirm: ${lookupErrors} lookup / ${writeErrors} write error(s) of ${jobs.length} this pass`
        );
    }
    return updated;
}

// ---- Internal --------------------------------------------------------------

// Status-write hardening. The mark* writes are tiny single-row UPDATEs, but under
// parallel runs they can lose the SQLite write lock to a long-held foreign commit
// (e.g. a multi-MB wallet facade save outliving busy_timeout). A lost write leaves
// the row non-terminal forever. The writes are idempotent, so a bounded in-place
// retry is safe. Only the STATUS write is retried, never the job work (double-submit risk).

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Run `fn` over `items` with at most `limit` in flight, awaiting ALL workers to
 * completion. A throwing `fn` is swallowed per-item so one failure never abandons
 * siblings or resolves the whole early (the caller relies on this to keep its
 * single-flight guard held until the pass truly finishes). `fn` should handle its
 * own errors; this is only a backstop.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            try { await fn(items[next++]); } catch { /* per-item backstop; fn owns its errors */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const STATUS_WRITE_ATTEMPTS = 3;
const DEFAULT_STATUS_WRITE_BACKOFF_MS: readonly number[] = [0, 1500, 4000];
let statusWriteBackoffMs: readonly number[] = DEFAULT_STATUS_WRITE_BACKOFF_MS;

function isLockContention(err: unknown): boolean {
    return /database is locked|SQLITE_BUSY/i.test(String((err as Error)?.message ?? err));
}

/**
 * True for a unique-constraint violation from either backend: SQLite reports
 * `UNIQUE constraint failed: ...`, Postgres uses SQLSTATE `23505` /
 * `duplicate key value violates unique constraint`.
 */
function isUniqueViolation(err: unknown): boolean {
    const anyErr = err as { code?: unknown; message?: unknown };
    if (anyErr?.code === '23505') return true;
    return /UNIQUE constraint failed|duplicate key value|violates unique constraint/i
        .test(String(anyErr?.message ?? err));
}

async function withStatusWriteRetry<T>(label: string, write: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < STATUS_WRITE_ATTEMPTS; attempt++) {
        if (statusWriteBackoffMs[attempt]) await sleep(statusWriteBackoffMs[attempt]);
        try {
            return await write();
        } catch (err) {
            if (!isLockContention(err)) throw err;
            lastErr = err;
            cds.log('nightgate').warn(`${label}: status write lost the SQLite lock (attempt ${attempt + 1}/${STATUS_WRITE_ATTEMPTS})`);
        }
    }
    throw lastErr;
}

function affectedRows(value: unknown): number {
    return typeof value === 'number' ? value : Number((value as any)?.changes ?? value ?? 0);
}

async function markRunning(jobId: string): Promise<boolean> {
    const db = await cds.connect.to('db');
    const affected = await withStatusWriteRetry(`markRunning(${jobId})`, async () => {
        return (db as any).tx(async (tx: any) => {
            return tx.run(
                UPDATE.entity(BackgroundJobs)
                    .set({
                        status: 'running',
                        startedAt: new Date().toISOString(),
                        attempt: 1,
                        leaseOwner: getRuntimeWorkerId(),
                        heartbeatAt: new Date().toISOString(),
                        leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
                    })
                    .where({ ID: jobId, status: 'pending' })
            );
        });
    });
    return affectedRows(affected) === 1;
}

async function markSucceeded(jobId: string, result: unknown): Promise<void> {
    const db = await cds.connect.to('db');
    await withStatusWriteRetry(`markSucceeded(${jobId})`, async () => {
        await (db as any).tx(async (tx: any) => {
            const affected = await tx.run(
                UPDATE.entity(BackgroundJobs)
                    .set({
                        status: 'succeeded',
                        result: safeStringify(result),
                        finishedAt: new Date().toISOString(),
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        heartbeatAt: null
                    })
                    .where({
                        ID: jobId,
                        leaseOwner: getRuntimeWorkerId(),
                        status: { in: ['running', 'external_execution', 'submitted'] }
                    })
            );
            if (affectedRows(affected) !== 1) throw new Error(`Lease lost before markSucceeded(${jobId})`);
        });
    });
}

async function markFailed(jobId: string, classification: SubmissionErrorClassification): Promise<void> {
    const db = await cds.connect.to('db');
    try {
        await withStatusWriteRetry(`markFailed(${jobId})`, async () => {
            await (db as any).tx(async (tx: any) => {
                const affected = await tx.run(
                    UPDATE.entity(BackgroundJobs)
                        .set({
                            status: 'failed',
                            errorCode: classification.code.slice(0, 64),
                            errorMessage: classification.message.slice(0, 4000),
                            finishedAt: new Date().toISOString(),
                            leaseOwner: null,
                            leaseExpiresAt: null,
                            heartbeatAt: null
                        })
                        .where({
                            ID: jobId,
                            leaseOwner: getRuntimeWorkerId(),
                            status: { in: ['running', 'external_execution', 'submitted'] }
                        })
                );
                if (affectedRows(affected) !== 1) throw new Error(`Lease lost before markFailed(${jobId})`);
            });
        });
    } catch (err) {
        // Last line of defense. Nothing upstream can act on this failure, but
        // the operator needs the real classification in the log to correlate
        // a later poller timeout with what actually happened. The row stays
        // non-terminal until restart recovery sweeps it.
        cds.log('nightgate').error(
            `markFailed(${jobId}): could not persist the failure status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            err
        );
    }
}

async function markReconciliationRequired(jobId: string, classification: { code: string; message: string }): Promise<void> {
    const db = await cds.connect.to('db');
    try {
        await withStatusWriteRetry(`markReconciliationRequired(${jobId})`, async () => {
            await (db as any).tx(async (tx: any) => {
                const affected = await tx.run(
                    UPDATE.entity(BackgroundJobs)
                        .set({
                            status: 'reconciliation_required',
                            errorCode: classification.code.slice(0, 64),
                            errorMessage: classification.message.slice(0, 4000),
                            leaseOwner: null,
                            leaseExpiresAt: null,
                            heartbeatAt: null
                        })
                        .where({
                            ID: jobId,
                            leaseOwner: getRuntimeWorkerId(),
                            status: { in: ['running', 'external_execution', 'submitted'] }
                        })
                );
                if (affectedRows(affected) !== 1) throw new Error(`Lease lost before parent reconciliation update (${jobId})`);
            });
        });
    } catch (writeErr) {
        cds.log('nightgate').error(
            `markReconciliationRequired(${jobId}): could not persist the safety status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            writeErr
        );
    }
}

const JOB_LEASE_MS = 120_000;
const JOB_HEARTBEAT_MS = 30_000;
let runtimeWorkerId: string | undefined;

function getRuntimeWorkerId(): string {
    return runtimeWorkerId ??= (
        process.env.NIGHTGATE_INSTANCE_ID
        || process.env.CF_INSTANCE_GUID
        || process.env.HOSTNAME
        || crypto.randomUUID()
    );
}

function startLeaseHeartbeat(jobId: string): () => void {
    const timer = setInterval(() => {
        void runWithoutAmbientTx(async () => {
            const db = await cds.connect.to('db');
            await db.run(
                UPDATE.entity(BackgroundJobs)
                    .set({
                        heartbeatAt: new Date().toISOString(),
                        leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
                    })
                    .where({ ID: jobId, status: { in: ['running', 'external_execution', 'submitted'] }, leaseOwner: getRuntimeWorkerId() })
            );
        }).catch(err => cds.log('nightgate').warn(`heartbeat(${jobId}) failed: ${String((err as Error)?.message ?? err)}`));
    }, JOB_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Enter the SDK call that combines proof generation, balancing and broadcast.
 *
 * INVARIANT: a job performs at most ONE external submission. This marks the
 * single `running -> external_execution` crossing and is intentionally not
 * re-entrant. A job whose `work()` drives two chain-effecting operations would
 * call this twice, and the second call throws below, because the restart
 * contract (`external_execution`/`submitted -> reconciliation_required`) can
 * reason about only one external effect per job. Split such work into two jobs.
 */
export async function markJobExternalExecution(jobId: string, submission: { submissionId?: string }): Promise<void> {
    const db = await cds.connect.to('db');
    const affected = await withStatusWriteRetry(`markJobExternalExecution(${jobId})`, async () => db.run(
        UPDATE.entity(BackgroundJobs)
            .set({
                status: 'external_execution',
                submissionId: submission.submissionId ?? null,
                externalExecutionAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString(),
                leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
            })
            .where({ ID: jobId, status: 'running', leaseOwner: getRuntimeWorkerId() })
    ));
    if (affectedRows(affected) === 1) return;
    // Disambiguate the no-op so the error is actionable. A row still owned by
    // this worker but already past 'running' means the job attempted a SECOND
    // external submission (unsupported), not a genuinely lost lease.
    const current = await getJobById(jobId);
    if (current && current.leaseOwner === getRuntimeWorkerId()
        && (current.status === 'external_execution' || current.status === 'submitted')) {
        throw new Error(`markJobExternalExecution(${jobId}): job already crossed the external-effect boundary; a background job may perform at most one external submission.`);
    }
    throw new Error(`Lease lost before markJobExternalExecution(${jobId})`);
}

/** Persist the external transaction hash after the SDK call returned. */
export async function markJobSubmitted(jobId: string, submission: { submissionId?: string; txHash?: string }): Promise<void> {
    const db = await cds.connect.to('db');
    const affected = await withStatusWriteRetry(`markJobSubmitted(${jobId})`, async () => {
        return db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'submitted',
                    submissionId: submission.submissionId ?? null,
                    txHash: submission.txHash ?? null,
                    chainStatus: 'pending',
                    submittedAt: new Date().toISOString(),
                    heartbeatAt: new Date().toISOString(),
                    leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
                })
                .where({ ID: jobId, status: { in: ['external_execution', 'submitted'] }, leaseOwner: getRuntimeWorkerId() })
        );
    });
    if (affectedRows(affected) !== 1) throw new Error(`Lease lost before markJobSubmitted(${jobId})`);
}

/** Test-only reset of the in-memory caches. */
export function __resetForTests(): void {
    stopBackgroundJobProcessor();
    semaphores.clear();
    cachedNetwork = undefined;
    runtimeWorkerId = undefined;
    commandPollActive = false;
    reconciliationCursor = undefined;
    chainPendingCursor = undefined;
    chainLegacyCursor = undefined;
    parentPendingCursor = undefined;
    parentLegacyCursor = undefined;
    confirmerPendingCursor = undefined;
    confirmerLegacyCursor = undefined;
    chainOutcomeConfirmer = null;
    chainConfirmActive = false;
    statusWriteBackoffMs = DEFAULT_STATUS_WRITE_BACKOFF_MS;
}

/** Test-only override of the status-write retry backoff schedule. */
export function __setStatusWriteBackoffForTests(ms: readonly number[]): void {
    statusWriteBackoffMs = ms;
}
