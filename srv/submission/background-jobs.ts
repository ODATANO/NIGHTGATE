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

import { withLockContentionRetry as withDbLockRetry, isLockContention, lockContentionBackoffMs, LOCK_CONTENTION_ATTEMPTS, __setLockContentionBackoffForTests, __resetLockContentionBackoffForTests } from './db-write-retry';
import { REJECTED_ATTEMPT_BOOKKEEPING_PENDING, SponsorAttemptBookkeepingPendingError } from './job-execution-context';
import { JOB_KIND_TRAITS, LIGHT_KIND, type JobKindTraits } from './job-kinds';
import cds from '@sap/cds';
import crypto from 'crypto';
import { AsyncResource } from 'async_hooks';
import { BackgroundJobs, PendingSubmissions } from '#cds-models/midnight';
import { classifySubmissionError, type SubmissionErrorClassification } from './TransactionSubmitter';
import { isChainOutcome, isChainAbsent, type ChainOutcome, type ChainLookup } from './chain-outcome-confirmer';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from '../utils/nightgate-config';
import { runInJobExecutionContext } from './job-execution-context';
import { encrypt as encryptAtRest, decrypt as decryptAtRest, getEncryptionKey } from '../utils/crypto';
import { jobCommandBinding } from '../utils/envelope-bindings';
import { getArtifactGenerationDigest } from './contract-registry';
import { isCallNotAppliedFailure } from './sponsor-pool';
import { configInt, configMs, configString } from '../utils/config';
import { carriedSubmitFailure } from '../midnight/wallet-worker-protocol';
import { readReorgGeneration, lockReorgGeneration } from './reorg-generation';

const { SELECT, INSERT, UPDATE } = cds.ql;

// Created at module load, before request handling. Running job work through this
// resource leaves CAP's request/transaction AsyncLocalStorage scope without
// relying on the private `cds._with` implementation.
const detachedJobScope = new AsyncResource('nightgate.detached-job-work');

// ---- Concurrency caps ------------------------------------------------------

const DEFAULT_CONCURRENCY = { heavy: 4, light: 16, serial: 1 } as const;

/**
 * Kind traits, declared with the registration (`srv/submission/job-kinds.ts`
 * holds the table). The concurrency class, the workflow-parent set and the
 * identifier-keyed set are DERIVED from what was registered, never listed a
 * second time here.
 */
const kindTraits = new Map<string, JobKindTraits>();

function isTraits(value: unknown): value is JobKindTraits {
    const t = value as JobKindTraits | null;
    return !!t && typeof t === 'object'
        && typeof t.heavy === 'boolean' && typeof t.workflowParent === 'boolean' && typeof t.identifierKeyed === 'boolean';
}

/** Declare a kind's traits (registration does this; tests declare legacy closure kinds directly). */
export function declareJobKind(kind: string, traits: JobKindTraits): void {
    if (!kind || !isTraits(traits)) throw new Error(`declareJobKind(${kind}): heavy, workflowParent and identifierKeyed must be booleans`);
    kindTraits.set(kind, { ...traits });
}

/** Traits of a kind; an unregistered kind (a legacy row of a removed kind) counts as light. */
export function jobKindTraits(kind: string): JobKindTraits {
    return kindTraits.get(kind) ?? LIGHT_KIND;
}

/** Every registered kind carrying `trait`. */
export function kindsWithTrait(trait: 'heavy' | 'workflowParent' | 'identifierKeyed' | 'serial' | 'sessionBound'): string[] {
    return [...kindTraits.entries()].filter(([, t]) => t[trait] === true).map(([k]) => k);
}

/** Test seam: the derived workflow-parent set. */
export function __workflowParentKindsForTests(): ReadonlySet<string> { return new Set(kindsWithTrait('workflowParent')); }

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

    /** Slots a new dispatch would get without waiting. */
    available(): number {
        return Math.max(0, this.max - this.inFlight - this.waiters.length);
    }
}

const semaphores: Map<string, Semaphore> = new Map();

function getSemaphore(kind: string): Semaphore {
    const cached = semaphores.get(kind);
    if (cached) return cached;
    const userCaps = ((cds.env as any).requires?.nightgate?.jobs?.concurrency || {}) as { heavy?: number; light?: number; serial?: number };
    const traits = jobKindTraits(kind);
    const max = traits.serial
        ? (typeof userCaps.serial === 'number' ? userCaps.serial : DEFAULT_CONCURRENCY.serial)
        : traits.heavy
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
    chainBlockHeight?: number | null;
    chainBlockHash?: string | null;
    indexerTxHash?: string | null;
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
    // not in-flight ones in another tx - the constraint covers that race below.
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
    // Provenance binding (0.16.0): a persisted command names its artifact by
    // a MUTABLE registry alias (`compiledArtifactRef`). Stamp the alias's
    // CURRENT generation digest at creation time, so the executor fails
    // closed if the alias is re-pointed before the (possibly much later)
    // execution: upgrade, restart, re-configuration. Non-contract commands
    // (no compiledArtifactRef) pass through untouched.
    let effectiveCommand: unknown = command;
    if (replayable && command && typeof command === 'object'
        && typeof (command as any).compiledArtifactRef === 'string'
        && (command as any).artifactDigest === undefined) {
        effectiveCommand = {
            ...(command as object),
            artifactDigest: getArtifactGenerationDigest((command as any).compiledArtifactRef)
        };
    }
    const serializedCommand = replayable ? safeStringify(effectiveCommand) : null;
    const commandEncoding = replayable ? (encryptCommand ? 'aes-gcm-v1' : 'json-v1') : null;
    const persistedCommand = serializedCommand && encryptCommand
        ? encryptAtRest(serializedCommand, getEncryptionKey(), jobCommandBinding(jobId))
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
        attempt: 1,
        maxAttempts: 1
    });

    // ADMISSION write hardening: like the status writes below, the job-row
    // INSERT can lose the SQLite write lock to a long-held foreign commit (a
    // multi-MB wallet-state save on a box that keeps many wallets warm; live:
    // `database is locked` 500 on sponsorFinalizedTransaction while nine
    // facades were saving). A failed INSERT committed nothing, so a bounded
    // retry is safe; under the pinned request tx the savepoint is rolled back
    // between attempts so the tx stays clean.
    if (idempotencyKey && pinnedRunner) {
        // A concurrent same-key request can pass the dedupe read (winner not yet
        // committed) and collide here on the unique constraint; return the
        // WINNER's job, not a raw error. The savepoint lets ROLLBACK TO clear
        // Postgres's aborted-tx state so the handler can continue.
        const sp = 'nightgate_job_insert';
        for (let attempt = 0; ; attempt++) {
            if (lockContentionBackoffMs()[attempt]) await sleep(lockContentionBackoffMs()[attempt]);
            await pinnedRunner.run(`SAVEPOINT ${sp}`);
            try {
                await pinnedRunner.run(buildInsert());
                await pinnedRunner.run(`RELEASE SAVEPOINT ${sp}`);
                break;
            } catch (insertErr) {
                await pinnedRunner.run(`ROLLBACK TO SAVEPOINT ${sp}`);
                await pinnedRunner.run(`RELEASE SAVEPOINT ${sp}`);
                if (isLockContention(insertErr) && attempt + 1 < STATUS_WRITE_ATTEMPTS) {
                    cds.log('nightgate').warn(`startJob(${kind}): admission insert lost the SQLite lock (attempt ${attempt + 1}/${STATUS_WRITE_ATTEMPTS})`);
                    continue;
                }
                if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
                if (!isUniqueViolation(insertErr)) throw insertErr;
                const dup = await dedupExisting<TIn, TOut>(pinnedRunner, sessionId, kind, idempotencyKey, payloadFingerprint);
                if (dup) return dup;
                throw insertErr;
            }
        }
    } else if (idempotencyKey) {
        // No pinned runner (outside a request tx): autocommit insert. Each db.run
        // is its own connection, so a collision poisons nothing; recover the
        // winner on a fresh read.
        try {
            await withStatusWriteRetry(`startJob(${kind}) admission insert`, () => db.run(buildInsert()));
        } catch (insertErr) {
            // `runChildCommand` lands here, so an opaque lock error would reach
            // a workflow parent as an ordinary failure. Same translation as the
            // other branches: busy, nothing written.
            if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
            if (!isUniqueViolation(insertErr)) throw insertErr;
            const dup = await dedupExisting<TIn, TOut>(db, sessionId, kind, idempotencyKey, payloadFingerprint);
            if (dup) return dup;
            throw insertErr;
        }
    } else if (pinnedRunner) {
        for (let attempt = 0; ; attempt++) {
            if (lockContentionBackoffMs()[attempt]) await sleep(lockContentionBackoffMs()[attempt]);
            try {
                await pinnedRunner.run(buildInsert());
                break;
            } catch (insertErr) {
                if (isLockContention(insertErr) && attempt + 1 < STATUS_WRITE_ATTEMPTS) {
                    cds.log('nightgate').warn(`startJob(${kind}): admission insert lost the SQLite lock (attempt ${attempt + 1}/${STATUS_WRITE_ATTEMPTS})`);
                    continue;
                }
                if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
                throw insertErr;
            }
        }
    } else {
        try {
            await withStatusWriteRetry(`startJob(${kind}) admission insert`, () => db.run(buildInsert()));
        } catch (insertErr) {
            if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
            throw insertErr;
        }
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
    /** Indexer block height of the inclusion, when the confirmer reported one. */
    blockHeight: number;
}
type BackgroundJobReconciliationFinalizer = (
    command: unknown,
    row: BackgroundJobRow,
    evidence: ReconciliationEvidence
) => Promise<unknown>;
const processors = new Map<string, BackgroundJobProcessor>();
const reconciliationFinalizers = new Map<string, BackgroundJobReconciliationFinalizer>();
const processorKey = (kind: string, version: number): string => `${kind}\0${version}`;

/** Register one deterministic processor per durable job kind, with the kind's traits. */
export function registerBackgroundJobProcessor(kind: string, version: number, traits: JobKindTraits, processor: BackgroundJobProcessor): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof processor !== 'function') {
        throw new Error('registerBackgroundJobProcessor: kind, positive version, traits and processor are required');
    }
    declareJobKind(kind, traits);
    processors.set(processorKey(kind, version), processor);
}

/** Kinds declared in the table but registered by nobody: the runner refuses to start with any. */
export function undeclaredOrUnregisteredJobKinds(): string[] {
    const registered = new Set([...processors.keys()].map(k => k.split('\0')[0]));
    return Object.keys(JOB_KIND_TRAITS).filter(kind => !registered.has(kind));
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

/**
 * Defer job dispatch until the row is committed. The ambient-tx detection is
 * deliberately the SAME truthy `cds.context` check the insert in startJob
 * uses: whenever the insert rode the caller's tx, the row exists only once
 * that tx commits, and CAP's context 'succeeded' hook fires exactly then (on
 * rollback it never fires and no phantom work runs). Without an ambient
 * context (durable poller, boot recovery) the insert autocommitted and the
 * row is already visible, so dispatch directly. Should a 'succeeded' hook
 * ever be lost (process death between commit and dispatch), the 2s command
 * poller re-schedules the persisted command.
 */
function scheduleJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    const ctx = cds.context as { on?: (event: string, handler: () => void) => void } | undefined;
    if (!ctx) return dispatchJob(jobId, kind, legacyWork);
    if (typeof ctx.on === 'function') {
        ctx.on('succeeded', () => dispatchJob(jobId, kind, legacyWork));
        return;
    }
    // Ambient context without lifecycle events: the insert detection says the
    // row may ride an uncommitted tx, but there is no commit signal to wait
    // for. Real CAP contexts always expose `.on`; this shape only appears
    // with hand-rolled mock contexts whose db writes autocommit, so dispatch
    // now but say so. If the write really was deferred, the pending-only
    // claim finds no row and the durable poller re-schedules the persisted
    // command after commit; only a legacy in-memory `work` closure (no
    // production caller passes one) would stay pending until then.
    cds.log('nightgate').warn(
        `startJob(${kind}): ambient context without lifecycle events; dispatching job ${jobId} immediately (its row may not be committed yet)`
    );
    dispatchJob(jobId, kind, legacyWork);
}

/**
 * Jobs with a dispatch in flight in THIS process (queued behind the
 * semaphore, or running). The poller skips them, so a row is dispatched once
 * per lease instead of once per tick.
 */
const dispatching = new Set<string>();

function dispatchJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    if (dispatching.has(jobId)) return;
    dispatching.add(jobId);
    const semaphore = getSemaphore(kind);
    setImmediate(() => void runWithoutAmbientTx(async () => {
        try {
            await semaphore.acquire();
        } catch (err) {
            dispatching.delete(jobId);
            throw err;
        }
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
                        reportSubmitted: handle => markJobSubmitted(jobId, handle),
                        markBroadcastOn: (runner, handle) => markJobBroadcastOn(runner, jobId, handle),
                        markSubmissionRejectedOn: (runner, handle) => markJobSubmissionRejectedOn(runner, jobId, handle)
                    },
                    executable
                ));
                try {
                    await markSucceeded(jobId, result);
                } catch (persistErr) {
                    const current = await getJobById(jobId);
                    if (current?.status === 'failed' && current.errorCode === 'SUPERSEDED') {
                        // Expected refusal: a newer job of the same kind took
                        // over this session while the work was in flight.
                        cds.log('nightgate').info(`markSucceeded(${jobId}): job was superseded mid-run; discarding its result`);
                    } else {
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
                // fails cleanly - a legitimately rejected job (e.g. a false
                // predicate) must not demand operator reconciliation. Crash
                // recovery still fail-closes `external_execution` rows, which
                // is the genuinely ambiguous case.
                if (current?.status === 'failed' && current.errorCode === 'SUPERSEDED') {
                    cds.log('nightgate').info(
                        `Job ${jobId} errored after being superseded mid-run; keeping SUPERSEDED (dropped: ${classification.code})`
                    );
                } else if (current?.txHash && jobKindTraits(current.kind).identifierKeyed && isCallNotAppliedFailure(err)) {
                    // The worker PROVED the outcome via the indexer (in a block,
                    // call not applied): terminal, no reconciliation detour (a
                    // client polling waitForJob must not see a transient
                    // reconciliation_required that flips seconds later).
                    await markChainFailureAfterBroadcast(jobId, current, err);
                } else if (err instanceof SponsorAttemptBookkeepingPendingError && current?.txHash) {
                    // Rejected attempt whose close/refund/hash-clear did not commit:
                    // park under the marker settleRejectedSponsorAttempts looks for,
                    // not under the generic code (the indexer would never resolve it).
                    await markReconciliationRequired(jobId, { code: err.code, message: err.message });
                } else if (current?.txHash && classification.code === 'SubmitAmbiguous') {
                    // Broadcast attempted, nothing observed: neither a status from
                    // the node nor the transaction on the indexer. Not a failure
                    // yet, so not the failure code: the confirmer ends the job
                    // from chain evidence (indexed -> succeeded/failed) or from
                    // its absence past the ttl (BROADCAST_NOT_INCLUDED).
                    await markReconciliationRequired(jobId, {
                        code: BROADCAST_UNCONFIRMED,
                        message: `Broadcast of ${current.txHash} is unconfirmed: ${classification.message}. The job ends succeeded or failed once the indexer shows the transaction, or failed/${BROADCAST_NOT_INCLUDED} once the indexer tip is past its validity window; a new attempt needs a new idempotencyKey either way.`
                    });
                } else if (current?.txHash) {
                    await markReconciliationRequired(jobId, {
                        code: 'EXTERNAL_EXECUTION_FAILED',
                        message: `Execution failed after broadcasting ${current.txHash}; verify chain state before retrying. ${classification.message}`
                    });
                } else {
                    await markFailed(jobId, classification);
                }
            }
        } finally {
            dispatching.delete(jobId);
            semaphore.release();
        }
    }).catch(err => cds.log('nightgate').error(`Detached job ${jobId} crashed outside its guarded execution path`, err)));
}

async function executePersistedCommand(row: BackgroundJobRow): Promise<unknown> {
    const processor = processors.get(processorKey(row.kind, row.commandVersion!));
    if (!processor) throw new Error(`No background-job processor registered for '${row.kind}' v${row.commandVersion}`);
    const serialized = row.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(row.command!, getEncryptionKey(), jobCommandBinding(String(row.ID)))
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
    const explicit = configInt('NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS');
    if (explicit !== undefined) return explicit;
    return configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS') + 5 * 60_000;
}

/**
 * Has any step of this workflow already finished, successfully or by leaving
 * an effect behind? `succeeded` is the plain case; a child that reached
 * `reconciliation_required` or recorded a txHash also means the workflow is
 * no longer a clean no-op.
 */
async function hasCompletedChild(parentJobId: string): Promise<boolean> {
    try {
        const db = await cds.connect.to('db');
        if (!db) return true;
        const children = await db.run(
            SELECT.from(BackgroundJobs).columns('status', 'txHash').where({ parentJobId })
        ) as Array<{ status?: string; txHash?: string | null }>;
        if (!Array.isArray(children)) return true;
        return children.some(c => c.status === 'succeeded' || c.status === 'reconciliation_required' || !!c.txHash);
    } catch (err) {
        // This runs precisely BECAUSE the database was too busy to admit a
        // job, so the read can lose the same lock. An unreadable answer is
        // not "nothing happened": it is "we do not know", and the two are
        // opposite in consequence. Guessing "nothing" marks a workflow whose
        // first step may be on chain as plainly failed, which no reconciler
        // revisits and a retry pays for twice. Guessing "something" costs an
        // operator one look at a job that was in fact clean.
        cds.log('nightgate').warn(
            `hasCompletedChild(${parentJobId}) could not read child state (${String((err as Error)?.message ?? err)}); ` +
            'assuming the workflow is partially executed'
        );
        return true;
    }
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
    let child;
    try {
        child = await startJob({
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
    } catch (err) {
        // The workflow could not even ENQUEUE this step. That is harmless on a
        // parent that has done nothing yet, and it is not harmless once an
        // earlier step is on chain: the parent carries no txHash of its own, so
        // the generic failure path would mark it `failed`, the parent
        // reconciler never looks at it again, and a retry would repeat the
        // steps that already spent fees. Escalate to reconciliation instead,
        // but only when there is something to reconcile.
        if (err instanceof JobAdmissionBusyError && await hasCompletedChild(parent.ID)) {
            throw new WorkflowReconciliationRequiredError(
                `Could not admit workflow step '${step}' (${err.message}), and an earlier step of job ${parent.ID} already completed; verify chain state before retrying`
            );
        }
        throw err;
    }
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
 *
 * Exported for request handlers that must not hold their CAP request tx (and
 * with it a pinned pool connection) across a slow await: DB reads routed
 * through here autocommit on a pooled connection that is returned immediately,
 * so a subsequent multi-minute wallet-worker wait pins nothing. Trade-off: the
 * read cannot see uncommitted writes of the ambient request tx, so only route
 * reads through here BEFORE the handler writes anything.
 */
export function runWithoutAmbientTx<T>(fn: () => Promise<T>): Promise<T> {
    return detachedJobScope.runInAsyncScope(fn);
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
 * Job kinds whose ONLY product is in-process state (a warm wallet facade for a
 * caller that holds the session id). They carry a `commandVersion` because the
 * command shape is persisted, but replaying them after a restart is pure cost:
 * the caller that wanted the warm facade died with the old process, and there
 * is no external effect left to complete.
 *
 * Replaying them is also actively harmful. Every wallet facade lives in the ONE
 * singleton worker thread (`startWalletWorker`), and SDK catch-up is CPU-bound
 * single-threaded work, so each unrequested facade time-shares the same core
 * with the one the host actually asked for. Since each ungraceful stop leaves
 * one more such row behind, boot cost grew with the number of previous crashes
 * (observed live: 7 stuck rows, 3 unrequested facades, >70 min catch-up).
 *
 * Criterion for adding a kind here: interrupting it can leave nothing behind
 * that a later caller could observe or would have to reconcile.
 */

/**
 * Resolve jobs left behind by a process restart without risking a duplicate
 * external effect. Session-bound kinds become terminal (their product died with
 * the process); other versioned commands stay queued or reset from pre-effect
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
        // FIRST, so the generic re-queue below cannot claim these rows: a
        // session-bound job has no external effect and no surviving caller.
        // Terminal, with its own code so an operator can tell a dropped
        // prewarm apart from a genuinely failed one.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_SESSION_JOB_DROPPED',
                    errorMessage: 'Dropped on restart: this job only warms in-process session state, and the caller that requested it did not survive the restart. Call the action again if a warm session is still wanted.',
                    finishedAt: new Date().toISOString(),
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: { in: ['pending', 'running'] }, kind: { in: kindsWithTrait('sessionBound') } })
        );
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
        // A job in external_execution WITHOUT a hash never broadcast: every
        // submitting worker path announces the identifier to the main thread
        // and waits for the ack before it sends (submit-intent), and the ack is
        // the persisted hash. So the process died before any broadcast (or after
        // a rejected attempt whose hash was taken off the job while it waited to
        // rebuild): nothing of it can be on chain, and no confirmer could ever
        // resolve it. Fail it plainly instead of parking it forever.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_BEFORE_BROADCAST',
                    errorMessage: 'The process restarted before this job announced a transaction for broadcast (or after its last attempt was rejected); nothing of it is on chain. A new idempotency key may be used for an intentional retry.',
                    finishedAt: new Date().toISOString(),
                    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
                })
                .where({ status: 'external_execution', txHash: null })
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

/**
 * Terminally fail every still-pending job whose signing session was closed by
 * the restart cleanup (`closeSessionsFromPreviousProcess`). Runs at plugin init
 * between that cleanup and `startBackgroundJobProcessor`, so the poller never
 * schedules them: their replay reloads signing material from the session row
 * (`executeWalletCommand` / the contract processors' walletFactory), and that
 * row's keys are gone, so every one of them would die later with a misleading
 * "Session not found" instead of a restart-shaped error code.
 *
 * Only `pending` rows are touched. `reconciliation_required` resolves from
 * chain evidence and needs no session; exempt fee-sponsor sessions are never
 * passed in, so jobs signed by them keep their replay guarantee.
 */
export async function dropPendingJobsForClosedSessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const db = await cds.connect.to('db');
    let dropped = 0;
    await withStatusWriteRetry('dropPendingJobsForClosedSessions', async () => {
        dropped = 0;
        // Same chunking rationale as the session close itself: stay within the
        // driver's parameter limit on a large backlog.
        for (let i = 0; i < sessionIds.length; i += 200) {
            const affected = await db.run(
                UPDATE.entity(BackgroundJobs)
                    .set({
                        status: 'failed',
                        errorCode: 'PROCESS_RESTART_SESSION_CLOSED',
                        errorMessage: 'Dropped on restart: the wallet session this job signs with was closed by the restart cleanup, so a replay could no longer decrypt its signing material. Reconnect and submit the action again if it is still wanted.',
                        finishedAt: new Date().toISOString(),
                        leaseOwner: null,
                        leaseExpiresAt: null,
                        heartbeatAt: null
                    })
                    .where({ status: 'pending', sessionId: { in: sessionIds.slice(i, i + 200) } })
            );
            dropped += affectedRows(affected);
        }
    });
    return dropped;
}

/**
 * Terminally mark every queued or running job of `kind` for `sessionId` as
 * failed with errorCode 'SUPERSEDED', excluding `excludeJobId` (the successor).
 *
 * Boot hygiene for prewarm jobs (worker-calls-outside-request-tx FR item 4):
 * restart recovery re-queues an orphaned `connectWalletForSigning` while the
 * consumer's boot prewarm starts a fresh one, so every hard restart multiplied
 * the concurrent worker waits against the same account. Superseded pending
 * rows never start (the pending-only claim guard skips them); a row superseded
 * mid-run keeps executing but its completion write is discarded quietly and it
 * stays terminally SUPERSEDED for status readers. This is STATUS hygiene, not
 * cancellation: an in-flight worker wait runs until it resolves on its own.
 *
 * Runs on the caller's ambient request tx when present: the sweep is then
 * atomic with the successor insert (which is visible there - excludeJobId
 * guards it), and no second pool connection is requested while the request tx
 * still pins one (that second acquire deadlocks at pool.max=1 and collides
 * with the open writer on SQLite). On the ambient tx the UPDATE is wrapped in
 * a SAVEPOINT: a failed sweep must stay best-effort for the caller, and
 * without ROLLBACK TO SAVEPOINT a failed statement leaves a PostgreSQL tx
 * aborted - the caller's catch would then mask a connect whose seed write and
 * job insert can no longer commit. Outside a request tx it autocommits.
 */
/**
 * The most recent job of one kind for a session (any status), or null.
 * Detached read: callers are diagnostics that must not hold a request tx.
 */
export async function findLatestJob(kind: string, sessionId: string): Promise<{ ID: string; status: string } | null> {
    const db = await cds.connect.to('db');
    const row = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(BackgroundJobs).columns('ID', 'status')
            .where({ sessionId, kind })
            .orderBy('createdAt desc')
    ));
    return row ? { ID: row.ID, status: row.status } : null;
}

export async function supersedeQueuedJobs(kind: string, sessionId: string, excludeJobId?: string): Promise<number> {
    const db = await cds.connect.to('db');
    const where: Record<string, unknown> = { kind, sessionId, status: { in: ['pending', 'running'] } };
    if (excludeJobId) where.ID = { '!=': excludeJobId };
    const buildUpdate = () => UPDATE.entity(BackgroundJobs)
        .set({
            status: 'failed',
            errorCode: 'SUPERSEDED',
            errorMessage: 'Superseded by a newer job of the same kind for this session; the successor job carries the live status.',
            finishedAt: new Date().toISOString(),
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null
        })
        .where(where);

    let affected: unknown;
    if (cds.context) {
        const runner: { run: (q: any) => Promise<any> } = (db as any).tx(cds.context);
        // No lock-contention retry here: on SQLite the ambient tx already
        // holds the writer, and on PostgreSQL lock waits block instead of
        // erroring, so a retry loop inside the tx buys nothing.
        const sp = 'nightgate_supersede_sweep';
        await runner.run(`SAVEPOINT ${sp}`);
        try {
            affected = await runner.run(buildUpdate());
        } catch (sweepErr) {
            await runner.run(`ROLLBACK TO SAVEPOINT ${sp}`);
            await runner.run(`RELEASE SAVEPOINT ${sp}`);
            throw sweepErr;
        }
        await runner.run(`RELEASE SAVEPOINT ${sp}`);
    } else {
        affected = await withStatusWriteRetry(
            `supersedeQueuedJobs(${kind})`,
            () => db.run(buildUpdate())
        );
    }
    const count = affectedRows(affected);
    if (count > 0) {
        cds.log('nightgate').info(
            `supersedeQueuedJobs(${kind}): marked ${count} predecessor job(s) SUPERSEDED for session ${sessionId.slice(0, 8)}`
        );
    }
    return count;
}

let commandPollTimer: ReturnType<typeof setInterval> | undefined;
let commandPollActive = false;
const SCAN_PAGE_SIZE = 100;
let reconciliationCursor: string | undefined;
let parentPendingCursor: string | undefined;
let parentLegacyCursor: string | undefined;
let confirmerPendingCursor: string | undefined;
let confirmerLegacyCursor: string | undefined;

// Crawler-free chain-outcome confirmer, injected at startup only when the
// crawler is disabled (or explicitly opted in). Null keeps the pass a no-op, so
// crawler deployments see no behavior change.
type ChainOutcomeConfirmer = (txHash: string) => Promise<ChainLookup>;

/** The evidence columns written with every confirmed outcome (job row and attempt row alike). */
function chainEvidencePatch(outcome: ChainOutcome): Record<string, unknown> {
    return {
        chainBlockHeight: Number.isInteger(outcome.blockHeight) ? outcome.blockHeight : null,
        chainBlockHash: outcome.blockHash ?? null,
        indexerTxHash: outcome.indexerTxHash ?? null
    };
}
let chainOutcomeConfirmer: ChainOutcomeConfirmer | null = null;
let confirmerReconcileCursor: string | undefined;
let chainConfirmActive = false;
const CHAIN_CONFIRM_CONCURRENCY = 8;

/** Park code while a broadcast is neither seen on chain nor provably absent. */
export const BROADCAST_UNCONFIRMED = 'BROADCAST_UNCONFIRMED';
/** Terminal code once the indexer tip is past the transaction's ttl and the transaction is still unknown. */
export const BROADCAST_NOT_INCLUDED = 'BROADCAST_NOT_INCLUDED';
/** Rows announced before the ttl was recorded: the longest ttl any submitting path balances with. */
const LEGACY_BROADCAST_TTL_MS = 60 * 60 * 1000;

/**
 * A parked job whose transaction the indexer does not know: is its absence
 * proof by now? The ttl comes from the attempt row (announced at the submit
 * intent), else the submit time plus the longest ttl any path sets. The
 * verdict needs the indexer tip PAST the ttl by the margin, and the tip is
 * the one THE ABSENCE ANSWER ITSELF carried (same request, same replica): an
 * indexer that lags behind the chain, or a fresher replica answering a
 * separate tip query, must not turn a landed transaction into a lost one
 * (the caller would rebuild and pay twice). No tip, no verdict.
 */
async function finalizeLostBroadcast(db: any, job: BackgroundJobRow, tipMs: number | null, generation: number): Promise<number> {
    if (tipMs === null || job.errorCode === REJECTED_ATTEMPT_BOOKKEEPING_PENDING || jobKindTraits(job.kind).workflowParent) return 0;
    const submission = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    let coordinates: any = {};
    try { coordinates = submission?.submitIntentData ? JSON.parse(submission.submitIntentData) : {}; } catch { coordinates = {}; }
    const reservation: { grantId?: string; count?: number } | null = coordinates?.deployReservation ?? null;
    const recorded = typeof coordinates.ttl === 'string' ? Date.parse(coordinates.ttl) : NaN;
    const submittedAt = Date.parse(String(submission?.submittedAt ?? job.submittedAt ?? ''));
    const ttlMs = Number.isFinite(recorded) ? recorded : Number.isFinite(submittedAt) ? submittedAt + LEGACY_BROADCAST_TTL_MS : NaN;
    if (!Number.isFinite(ttlMs)) return 0;
    const margin = configMs('NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS');
    if (tipMs <= ttlMs + margin) return 0;
    const now = new Date().toISOString();
    const ttlIso = new Date(ttlMs).toISOString();
    const message = `Transaction ${job.txHash} was broadcast but never included: the indexer tip (${new Date(tipMs).toISOString()}) is past its validity window (ttl ${ttlIso}${Number.isFinite(recorded) ? '' : ', assumed from the submit time'}) and the indexer does not know it. Nothing of it is on chain; a new attempt needs a new idempotencyKey.`;
    return withStatusWriteRetry(`finalizeLostBroadcast(${job.ID})`, () => (db as any).tx(async (tx: any) => {
        if (await lockReorgGeneration(tx) !== generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set({
            status: 'failed', chainStatus: 'dropped', finishedAt: now,
            errorCode: BROADCAST_NOT_INCLUDED, errorMessage: message
        } as any).where({ ID: job.ID, status: 'reconciliation_required' })));
        let rowClosed = 0;
        if (affected === 1 && submission?.ID) {
            rowClosed = affectedRows(await tx.run(UPDATE.entity(PendingSubmissions).set({
                status: 'failed', finalizedAt: now, errorCode: BROADCAST_NOT_INCLUDED,
                errorMessage: `not included before ttl ${ttlIso}`
            } as any).where({ ID: submission.ID, status: 'pending' })));
        }
        // A deploy that never landed must not keep the grant's lifetime budget:
        // refund the reservation the attempt row holds, exactly once (only the
        // row closed HERE, still pending, can still hold it; same rule as the
        // rejected-attempt settlement).
        if (rowClosed === 1 && reservation?.grantId && Number.isInteger(reservation.count) && (reservation.count as number) > 0) {
            await tx.run(
                UPDATE.entity('midnight.AgentGrants')
                    .set({ deploysUsed: { '-=': reservation.count } })
                    .where({ ID: reservation.grantId, deploysUsed: { '>=': reservation.count } })
            );
        }
        if (affected === 1) cds.log('nightgate').warn(`${job.kind} job ${job.ID}: ${message}${rowClosed === 1 && reservation?.count ? ` (refunded ${reservation.count} deploy reservation(s) on grant ${String(reservation.grantId).slice(0, 8)})` : ''}`);
        return affected;
    }));
}

/** Register (or clear, with null) the crawler-free tx-outcome confirmer. */
/**
 * Finalize an identifier-keyed sponsor job from its indexer outcome: the job
 * row and the attempt's PendingSubmissions row change in ONE transaction (a
 * lost second write cannot strand the submission as `pending`/`included`
 * while the job is terminal). The result written on a reconciled success is
 * the CANONICAL shape the action documents (`txHash, circuits,
 * contractAddress, note?, feeSponsor`), rebuilt from the coordinates the
 * worker announced at submit time (stored as JSON in the attempt row's
 * internal `submitIntentData`; `finalizedTxData` stays the indexed-tx snapshot).
 * `fromStatus: 'reconciliation_required'` moves the job to its terminal state;
 * `fromStatus: 'in_flight'` does the same straight from the running job (the
 * worker proved the outcome; lease-guarded); `fromStatus: 'succeeded'` only
 * advances chainStatus (CAS on chainStatusWas).
 */
async function finalizeIdentifierKeyedJob(
    db: any, job: BackgroundJobRow, outcome: ChainOutcome,
    opts: { fromStatus: 'reconciliation_required' | 'in_flight' | 'succeeded'; chainStatusWas?: string | null; generation: number }
): Promise<number> {
    const status = outcome.status;
    const evidence = chainEvidencePatch(outcome);
    const now = new Date().toISOString();
    const submission = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    let coordinates: any = {};
    try { coordinates = submission?.submitIntentData ? JSON.parse(submission.submitIntentData) : {}; } catch { coordinates = {}; }
    const canonicalResult = {
        txHash: job.txHash,
        circuits: Array.isArray(coordinates.circuits) && coordinates.circuits.length ? coordinates.circuits : (submission?.circuitName ? [submission.circuitName] : []),
        contractAddress: coordinates.contractAddress ?? submission?.contractAddress ?? '',
        ...(coordinates.note ? { note: coordinates.note } : {}),
        feeSponsor: coordinates.feeSponsor ?? job.sessionId,
        reconciled: true
    };
    const terminal = opts.fromStatus === 'reconciliation_required' || opts.fromStatus === 'in_flight';
    // A reconciled success runs the kind's finalizer first (same as the
    // crawler-evidence path); its result becomes the job result. A throwing
    // finalizer keeps the job in reconciliation_required for the next pass.
    let finalizedResult: unknown = canonicalResult;
    if (opts.fromStatus === 'reconciliation_required' && status === 'success') {
        const reconciliationEvidence: ReconciliationEvidence = {
            submissionId: submission?.ID ?? job.submissionId ?? null,
            txHash: job.txHash!,
            contractAddress: submission?.contractAddress ?? null,
            finalizedAt: submission?.finalizedAt ?? null,
            blockHeight: outcome.blockHeight
        };
        const fromFinalizer = await runReconciliationFinalizer(job, reconciliationEvidence);
        if (fromFinalizer !== undefined) finalizedResult = { ...canonicalResult, ...(fromFinalizer as object) };
    }
    const jobPatch: Record<string, unknown> = {
        ...(terminal
            ? (status === 'success'
                ? { status: 'succeeded', chainStatus: 'success', chainFinalizedAt: now, errorCode: null, errorMessage: null, finishedAt: now, result: safeStringify(finalizedResult) }
                : { status: 'failed', chainStatus: 'failure', chainFinalizedAt: now, finishedAt: now,
                    errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: `Transaction ${job.txHash} is on-chain but its contract call did not apply (ledger result failure)` })
            : { chainStatus: status, chainFinalizedAt: now }),
        ...evidence
    };
    if (opts.fromStatus === 'in_flight') Object.assign(jobPatch, { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null });
    const jobWhere: Record<string, unknown> = opts.fromStatus === 'reconciliation_required'
        ? { ID: job.ID, status: 'reconciliation_required' }
        : opts.fromStatus === 'in_flight'
            ? { ID: job.ID, leaseOwner: getRuntimeWorkerId(), status: { in: ['running', 'external_execution', 'submitted'] } }
            : { ID: job.ID, status: 'succeeded', chainStatus: opts.chainStatusWas ?? null };
    const subPatch: Record<string, unknown> = {
        status: status === 'success' ? 'finalized' : 'failed',
        finalizedAt: now,
        ...evidence,
        ...(status === 'failure' ? { errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: 'contract call did not apply (ledger result failure)' } : {})
    };
    return withStatusWriteRetry(`finalizeIdentifierKeyedJob(${job.ID})`, () => (db as any).tx(async (tx: any) => {
        // A rollback since the lookup: the outcome may describe the old fork.
        if (await lockReorgGeneration(tx) !== opts.generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set(jobPatch as any).where(jobWhere)));
        if (affected === 1 && submission?.ID) {
            await tx.run(UPDATE.entity(PendingSubmissions).set(subPatch as any).where({ ID: submission.ID }));
        }
        return affected;
    }));
}

let settleRejectedCursor: string | undefined;

/**
 * Re-run the bookkeeping of sponsoring attempts that were provably rejected
 * before inclusion but not booked in-process (job errorCode
 * `REJECTED_ATTEMPT_BOOKKEEPING_PENDING`): close the attempt row REJECTED,
 * refund a deploy reservation the row still holds, take the hash off the job
 * and fail the job terminally. One transaction per job, idempotent (a closed
 * row refunds nothing, a moved job is skipped by its CAS). Runs on every
 * reconciliation tick and at startup.
 */
export async function settleRejectedSponsorAttempts(existingDb?: any): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const page = await scanBackgroundJobPage(db, {
        status: 'reconciliation_required', errorCode: REJECTED_ATTEMPT_BOOKKEEPING_PENDING
    }, settleRejectedCursor);
    settleRejectedCursor = page.cursor;
    let settled = 0;
    for (const job of page.rows) {
        try {
            const submission: any = job.submissionId
                ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: job.submissionId }))
                : (job.txHash ? await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: job.txHash, status: 'pending' })) : null);
            let reservation: { grantId?: string; count?: number } | null = null;
            try { reservation = submission?.submitIntentData ? JSON.parse(submission.submitIntentData)?.deployReservation ?? null : null; } catch { reservation = null; }
            const now = new Date().toISOString();
            const affected = await withStatusWriteRetry(`settleRejectedSponsorAttempt(${job.ID})`, () => (db as any).tx(async (tx: any) => {
                let rowClosed = 0;
                if (submission?.ID) {
                    rowClosed = affectedRows(await tx.run(
                        UPDATE.entity(PendingSubmissions)
                            .set({ status: 'failed', errorCode: 'REJECTED', errorMessage: 'rejected before inclusion; bookkeeping settled by the reconciler' })
                            .where({ ID: submission.ID, status: 'pending' })
                    ));
                }
                // Only a row closed here (still pending) can still hold the reservation.
                if (rowClosed === 1 && reservation?.grantId && Number.isInteger(reservation.count) && (reservation.count as number) > 0) {
                    await tx.run(
                        UPDATE.entity('midnight.AgentGrants')
                            .set({ deploysUsed: { '-=': reservation.count } })
                            .where({ ID: reservation.grantId, deploysUsed: { '>=': reservation.count } })
                    );
                }
                return affectedRows(await tx.run(
                    UPDATE.entity(BackgroundJobs)
                        .set({
                            status: 'failed', txHash: null, chainStatus: null, finishedAt: now,
                            errorCode: 'SPONSOR_ATTEMPT_REJECTED',
                            errorMessage: `The sponsoring attempt was rejected before inclusion (nothing is on chain) and its bookkeeping was settled by the reconciler. ${String(job.errorMessage ?? '').slice(0, 1500)}`
                        })
                        .where({ ID: job.ID, status: 'reconciliation_required', errorCode: REJECTED_ATTEMPT_BOOKKEEPING_PENDING })
                ));
            }));
            if (affected === 1) {
                settled++;
                cds.log('nightgate').info(`settled the rejected sponsoring attempt of job ${job.ID}${reservation?.count ? ` (refunded ${reservation.count} deploy reservation(s) on grant ${String(reservation.grantId).slice(0, 8)}…)` : ''}`);
            }
        } catch (err) {
            cds.log('nightgate').warn(`could not settle the rejected sponsoring attempt of job ${job.ID} this tick: ${String((err as Error)?.message ?? err)}`);
        }
    }
    return settled;
}

/**
 * Run the finalizer registered for the job's kind/version with the decrypted
 * command; undefined when none is registered. Shared by both reconciliation
 * paths (crawler evidence and the crawler-free indexer confirmer) so neither
 * closes a job as succeeded without the finalizer's writes.
 */
async function runReconciliationFinalizer(job: BackgroundJobRow, evidence: ReconciliationEvidence): Promise<unknown | undefined> {
    const finalizer = job.commandVersion
        ? reconciliationFinalizers.get(processorKey(job.kind, job.commandVersion))
        : undefined;
    if (!finalizer) return undefined;
    const serialized = job.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(job.command!, getEncryptionKey())
        : job.command!;
    return finalizer(JSON.parse(serialized), job, evidence);
}

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
    const missing = undeclaredOrUnregisteredJobKinds();
    if (missing.length > 0) {
        throw new Error(`background-job kinds declared without a processor: ${missing.join(', ')} (srv/submission/job-kinds.ts vs the registrations)`);
    }
    await pollPersistedCommands();
    await settleRejectedSponsorAttempts();
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

/**
 * Heartbeat silence after which a `running` lease counts as dead (the owning
 * process is gone or wedged). `running` is the only reclaimable state: a row
 * past the external-effect boundary carries an identifier the reconciliation
 * sweeps resolve, and a second dispatch could spend a second fee.
 */
const JOB_LEASE_TTL_MS = configMs('NIGHTGATE_JOB_LEASE_TTL_MS');
/** A job whose lease died this often is failed instead of re-queued (a crash loop must end). */
const MAX_LEASE_RECLAIMS = 3;

/**
 * Re-queue `running` jobs whose heartbeat stopped for longer than the lease
 * TTL. CAS on (ID, leaseOwner, status, heartbeatAt): a heartbeat that lands
 * between the scan and the write keeps the lease. Legacy closures cannot be
 * re-dispatched (their work lived in the dead process) and fail; a job
 * reclaimed MAX_LEASE_RECLAIMS times fails too.
 */
export async function reclaimExpiredLeases(existingDb?: any): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const cutoff = new Date(Date.now() - JOB_LEASE_TTL_MS).toISOString();
    const columns = ['ID', 'kind', 'attempt', 'leaseOwner', 'heartbeatAt', 'startedAt', 'commandVersion'];
    const silent = await db.run(
        SELECT.from(BackgroundJobs).columns(...columns).where({ status: 'running', heartbeatAt: { '<': cutoff } }).limit(SCAN_PAGE_SIZE)
    ) as BackgroundJobRow[];
    const neverBeat = await db.run(
        SELECT.from(BackgroundJobs).columns(...columns).where({ status: 'running', heartbeatAt: null, startedAt: { '<': cutoff } }).limit(SCAN_PAGE_SIZE)
    ) as BackgroundJobRow[];
    let reclaimed = 0;
    for (const row of [...(silent ?? []), ...(neverBeat ?? [])]) {
        const guard = { ID: row.ID, status: 'running', leaseOwner: row.leaseOwner ?? null, heartbeatAt: row.heartbeatAt ?? null };
        const attempt = (row.attempt ?? 1) + 1;
        const terminal = !row.commandVersion
            ? 'its work was an in-process closure that died with the lease owner'
            : attempt > MAX_LEASE_RECLAIMS + 1
                ? `its lease expired ${MAX_LEASE_RECLAIMS} times`
                : null;
        const patch: Record<string, unknown> = terminal
            ? {
                status: 'failed', errorCode: 'LEASE_EXPIRED',
                errorMessage: `no heartbeat from ${row.leaseOwner ?? 'unknown owner'} for more than ${JOB_LEASE_TTL_MS} ms; ${terminal}`.slice(0, 4000),
                finishedAt: new Date().toISOString(), leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
            }
            : { status: 'pending', attempt, startedAt: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null };
        const affected = await withStatusWriteRetry(`reclaimLease(${row.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set(patch).where(guard)
        ));
        if (affectedRows(affected) !== 1) continue;
        reclaimed++;
        (terminal ? cds.log('nightgate').error : cds.log('nightgate').warn).call(cds.log('nightgate'),
            `lease of ${row.kind} job ${row.ID} held by ${row.leaseOwner ?? 'unknown'} expired (no heartbeat since ${row.heartbeatAt ?? row.startedAt}): ` +
            (terminal ? `failed LEASE_EXPIRED, ${terminal}` : `re-queued as attempt ${attempt}`));
    }
    return reclaimed;
}

async function pollPersistedCommands(): Promise<void> {
    if (commandPollActive) return;
    commandPollActive = true;
    try {
        const db = await cds.connect.to('db');
        await reclaimExpiredLeases(db);
        const rows = await db.run(
            SELECT.from(BackgroundJobs)
                .columns('ID', 'kind', 'commandVersion')
                .where({ status: 'pending', commandVersion: { '!=': null } })
                .orderBy('createdAt asc')
                .limit(100)
        );
        // Dispatch up to the FREE capacity of each concurrency class, once per
        // job: a row already dispatched in this process is skipped, the rest
        // wait for the next tick instead of piling up behind the semaphore.
        const budget = new Map<Semaphore, number>();
        for (const row of rows as Array<{ ID: string; kind: string; commandVersion: number }>) {
            if (dispatching.has(row.ID)) continue;
            if (!processors.has(processorKey(row.kind, row.commandVersion))) continue;
            const semaphore = getSemaphore(row.kind);
            const free = budget.get(semaphore) ?? semaphore.available();
            if (free <= 0) continue;
            budget.set(semaphore, free - 1);
            scheduleJob(row.ID, row.kind);
        }
        await settleRejectedSponsorAttempts(db);
        await reconcileBackgroundJobs(db);
        await refreshSucceededChainOutcomes(db);
        triggerChainConfirmPass();
    } finally {
        commandPollActive = false;
    }
}

/**
 * Workflow parents parked in `reconciliation_required` are re-queued once
 * every child step succeeded; their processor then rebuilds the typed result
 * without re-submitting any child. Leaf jobs are NOT resolved here: their only
 * chain evidence is the indexer confirmer (`confirmChainOutcomesViaIndexer`),
 * keyed by the ledger identifier the job stores. The crawler cannot correlate
 * them: it indexes the Substrate extrinsic hash, a different value.
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
        if (jobKindTraits(job.kind).workflowParent) {
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
                continue;
            }
            // A child that ended TERMINALLY failed (a lost broadcast, a call
            // that did not apply) can never be re-run under its immutable step
            // key, so the parent ends the same way the in-flight path ends it
            // (`Child job X failed [CODE]`), naming the steps that did land.
            const failedChild = children.find(child => child.status === 'failed');
            if (failedChild) {
                const landed = children.filter(child => child.status === 'succeeded').map(child => child.workflowStep ?? child.ID);
                const affected = await withStatusWriteRetry(`failReconciledParent(${job.ID})`, () => db.run(
                    UPDATE.entity(BackgroundJobs).set({
                        status: 'failed', errorCode: 'CHILD_FAILED', finishedAt: new Date().toISOString(),
                        errorMessage: `Child job ${failedChild.ID} (workflow step '${failedChild.workflowStep ?? '?'}') failed [${failedChild.errorCode ?? 'UNKNOWN'}]: ${String(failedChild.errorMessage ?? 'unknown error').slice(0, 1500)}` +
                            (landed.length ? ` Steps already on chain: ${landed.join(', ')}.` : ' No step of this workflow is on chain.') +
                            ' A new attempt needs a new idempotencyKey.'
                    }).where({ ID: job.ID, status: 'reconciliation_required' })
                ));
                resolved += affectedRows(affected);
            }
            continue;
        }

    }
    return resolved;
}

/**
 * Aggregate a succeeded workflow parent's `chainStatus` from its children.
 * Leaf outcomes come from the indexer confirmer only.
 */
export async function refreshSucceededChainOutcomes(existingDb?: any): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    let updated = 0;

    const pendingParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: kindsWithTrait('workflowParent') }, chainStatus: 'pending'
    }, parentPendingCursor);
    parentPendingCursor = pendingParents.cursor;
    const legacyParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: kindsWithTrait('workflowParent') }, chainStatus: null
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
 * The chain evidence path for leaf jobs: advance a succeeded leaf job's
 * `chainStatus` and resolve a parked `reconciliation_required` job by a per-tx
 * Indexer lookup keyed by the ledger identifier the job stores. The inclusion
 * coordinates the indexer reports (block height/hash, its transaction hash)
 * are recorded on the job and the attempt row; a reorg rollback reverts by
 * that block height. Workflow parents are skipped; their `chainStatus` is
 * aggregated from children by `refreshSucceededChainOutcomes`.
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
    // EVERY kind parked in reconciliation_required with a hash is resolved
    // here: since 0.23.0 the bound channel records the ledger transaction
    // identifier the worker announces before broadcasting (what the indexer
    // answers), and a crawler-off deployment has no other evidence. The
    // indexer's apply result is exactly what reconciliation needs. Success ->
    // succeeded (result carries the identifier), failure -> failed, not indexed
    // -> stays (the crawler path keeps trying too when it runs).
    const reconcilePage = await scanBackgroundJobPage(db, {
        status: 'reconciliation_required', txHash: { '!=': null }
    }, confirmerReconcileCursor);
    confirmerReconcileCursor = reconcilePage.cursor;
    let updated = 0;
    // Captured before the lookups; each commit compares under the row lock.
    let generation = await readReorgGeneration(db);
    for (const job of reconcilePage.rows) {
        let outcome: ChainLookup;
        try { outcome = await confirmer(job.txHash!); } catch { continue; }
        if (!isChainOutcome(outcome)) {
            // Only ABSENCE is evidence: an indexed-but-unconfirmable
            // transaction (null) may be on chain and keeps the job parked.
            // The tip the absence is judged against is the answer's own.
            if (isChainAbsent(outcome)) {
                try { updated += await finalizeLostBroadcast(db, job, outcome.asOfMs, generation); } catch { /* next pass */ }
            }
            continue;
        }
        try {
            updated += await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'reconciliation_required', generation });
        } catch (err) {
            // next pass; a finalizer that keeps throwing is visible here
            cds.log('nightgate').debug(`Crawler-free reconciliation of ${job.kind} job ${job.ID} deferred: ${String((err as Error)?.message ?? err)}`);
        }
    }
    const jobs = [...pendingPage.rows, ...legacyPage.rows]
        .filter(job => !jobKindTraits(job.kind).workflowParent);
    let lookupErrors = 0;
    let writeErrors = 0;
    // Bounded parallelism: each lookup is one short Indexer query. Serial would
    // let a full page stack per-lookup latency; unbounded would hammer the Indexer.
    generation = await readReorgGeneration(db);
    let staleGeneration = 0;
    await mapWithConcurrency(jobs, CHAIN_CONFIRM_CONCURRENCY, async job => {
        let outcome: ChainLookup;
        try {
            outcome = await confirmer(job.txHash!);
        } catch {
            lookupErrors++;
            return;
        }
        if (!isChainOutcome(outcome)) return; // not yet indexed / not confirmable -> retry next tick
        // CAS on the exact chainStatus we read (compiles to `= 'pending'` or,
        // for legacy rows, `IS NULL` - not `IN (...)`, which never matches NULL in
        // SQL). Keeps the write a safe no-op if the value changed since the scan.
        try {
            if (jobKindTraits(job.kind).identifierKeyed) {
                // Sponsor jobs: job chainStatus AND the attempt's PendingSubmissions
                // row are finalized together (the crawler never sees these rows).
                // `updated += await f()` would read `updated` BEFORE the await and lose the
                // increments of the callbacks running concurrently with it.
                const n = await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'succeeded', chainStatusWas: job.chainStatus ?? null, generation });
                updated += n;
            } else {
                const now = new Date().toISOString();
                const evidence = chainEvidencePatch(outcome);
                // Job CAS and attempt row in ONE transaction: a job with a
                // terminal chainStatus leaves the scan for good, so its attempt
                // must never be left behind by a failed second write.
                const n: number = await withStatusWriteRetry(`confirmChainOutcome(${job.ID})`, () => (db as any).tx(async (tx: any): Promise<number> => {
                    // A rollback since the lookup: the outcome may describe the old fork.
                    if (await lockReorgGeneration(tx) !== generation) { staleGeneration++; return 0; }
                    const affected = affectedRows(await tx.run(
                        UPDATE.entity(BackgroundJobs).set({
                            chainStatus: outcome!.status,
                            chainFinalizedAt: now,
                            ...evidence
                        }).where({ ID: job.ID, status: 'succeeded', chainStatus: job.chainStatus ?? null })
                    ));
                    // The attempt row follows the outcome: nothing else moves it
                    // past `included` (the crawler cannot correlate it).
                    if (affected === 1) {
                        await tx.run(
                            UPDATE.entity(PendingSubmissions).set({
                                status: outcome!.status === 'success' ? 'finalized' : 'failed',
                                finalizedAt: now,
                                ...evidence,
                                ...(outcome!.status === 'failure' ? { errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: 'contract call did not apply (ledger result failure)' } : {})
                            }).where(job.submissionId
                                ? { ID: job.submissionId, status: { in: ['pending', 'included'] } }
                                : { txHash: job.txHash, status: { in: ['pending', 'included'] } })
                        );
                    }
                    return affected;
                }));
                updated += n;
            }
        } catch {
            writeErrors++;
        }
    });
    if (staleGeneration > 0) {
        cds.log('nightgate').info(`Crawler-free chain confirm: ${staleGeneration} outcome(s) read before a reorg rollback were not recorded; next tick looks again`);
    }
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

// Five attempts over ~14s. Three over 5.5s was not enough: a sponsored submit
// that arrives while the PREVIOUS one is still writing its completion loses
// the lock for longer than that, and the caller then sees a 500 for a
// transaction the server would happily have taken a moment later. The call it
// guards takes 40s of proving and submitting anyway, so patience here is
// cheap; what is expensive is a rejected submission.
const STATUS_WRITE_ATTEMPTS = LOCK_CONTENTION_ATTEMPTS;

/**
 * The job was never admitted because the database stayed busy for the whole
 * retry budget. Nothing was written and nothing was submitted, so the caller
 * may simply send the same request again; raw `database is locked` reached
 * them as a 500, which reads as "your transaction broke the server" rather
 * than "come back in a second".
 */
/**
 * Job errorCode for a sponsoring attempt provably rejected before inclusion
 * whose bookkeeping (attempt row REJECTED, deploy reservation refunded, hash
 * off the job) did not commit. The job parks in reconciliation_required under
 * this code and `settleRejectedSponsorAttempts` re-runs the transaction on
 * every reconciliation tick. The indexer cannot resolve such a job: the
 * identifier never reached a mempool.
 */
export { REJECTED_ATTEMPT_BOOKKEEPING_PENDING, SponsorAttemptBookkeepingPendingError } from './job-execution-context';

export class JobAdmissionBusyError extends Error {
    readonly httpStatus = 503;
    // CAP normalises a thrown error over `status` / `statusCode` / a numeric
    // `code`, and it never sees `httpStatus`. The wallet actions
    // (registerForDustGeneration, deregisterFromDustGeneration, sendNight)
    // return startJob's promise straight to CAP without passing through
    // runSubmission, so without these the caller would still get a 500.
    readonly status = 503;
    readonly statusCode = 503;
    /** Stable wire code for clients to switch on. */
    readonly code = 'JOB_ADMISSION_BUSY';
    /** Value for the `Retry-After` header, seconds. */
    readonly retryAfterSeconds = 2;
    /**
     * CAP's HTTP adapter replaces the message of every 5xx with the generic
     * reason phrase under NODE_ENV=production unless the error carries
     * `$sanitize: false`. This 503 tells the caller "nothing was written,
     * send it again"; the message must reach the client.
     */
    readonly $sanitize = false;
    constructor(kind: string) {
        super(`the server is busy writing another job and could not admit this ${kind} request; nothing was submitted, retry in a moment`);
        this.name = 'JobAdmissionBusyError';
    }
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

const withStatusWriteRetry = <T>(label: string, write: () => Promise<T>): Promise<T> =>
    withDbLockRetry(label, write, (msg: string) => cds.log('nightgate').warn(msg));

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

/**
 * Terminal failure of an identifier-keyed job whose on-chain outcome the
 * worker already PROVED (transaction in a block, contract call not applied):
 * same writes as the reconcile pass's FAILURE branch, but straight from the
 * running job (lease-guarded CAS), job row + attempt row in one transaction.
 */
async function markChainFailureAfterBroadcast(jobId: string, current: BackgroundJobRow, err: unknown): Promise<void> {
    // The rollback correlates by block height only: a terminal failure without
    // the height could never be reverted after a reorg. The worker carries the
    // indexer's height on the error; without it the job parks for the
    // confirmer, which records the full coordinates before finalizing.
    // The worker proved the failure against the indexer, but its answer is not
    // generation-protected: a rollback between that probe and this write would
    // record the old fork. Ask the registered confirmer again under a captured
    // generation; without a confirmer or an answer the job parks for the
    // reconciliation pass, which does the same with its coordinates.
    const db = await cds.connect.to('db');
    const carried = carriedSubmitFailure(err)?.blockHeight;
    const generation = await readReorgGeneration(db);
    let outcome: ChainLookup = null;
    try { outcome = chainOutcomeConfirmer ? await chainOutcomeConfirmer(current.txHash!) : null; } catch { outcome = null; }
    if (!isChainOutcome(outcome)) {
        await markReconciliationRequired(jobId, {
            code: 'CHAIN_EXECUTION_FAILED_UNCONFIRMED',
            message: `Transaction ${current.txHash} is on-chain and its contract call did not apply` +
                (Number.isInteger(carried) ? ` (worker saw block ${carried})` : '') +
                `; the indexer confirmer finalizes it with generation-checked coordinates`
        });
        return;
    }
    try {
        const affected = await finalizeIdentifierKeyedJob(db, current, outcome, { fromStatus: 'in_flight', generation });
        if (affected !== 1) {
            // Lease lost, or a rollback since the lookup: park rather than guess.
            await markReconciliationRequired(jobId, { code: 'CHAIN_EXECUTION_FAILED_UNCONFIRMED', message: `Transaction ${current.txHash}: terminal chain-failure write refused (lease or reorg generation changed); the reconciliation pass finalizes it` });
            return;
        }
    } catch (writeErr) {
        cds.log('nightgate').error(
            `markChainFailureAfterBroadcast(${jobId}): could not persist the terminal status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery (identifier ${current.txHash}).`,
            writeErr
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
        configString('NIGHTGATE_INSTANCE_ID')
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

/**
 * Cross the external-effect boundary and record the identifier in one
 * statement on the given runner (a transaction the caller owns), so the job
 * transition commits with the attempt row and grant reservation, or not at
 * all. `firstBoundary` selects running -> submitted (at most once per job); a
 * rebuild attempt moves external_execution|submitted -> submitted with the new
 * identifier. Throws on a lost lease (the caller's transaction rolls back).
 */
export async function markJobBroadcastOn(
    runner: { run: (q: unknown) => Promise<unknown> },
    jobId: string,
    submission: { submissionId?: string; txHash?: string; firstBoundary?: boolean }
): Promise<void> {
    const now = new Date().toISOString();
    const first = submission.firstBoundary !== false;
    const affected = await runner.run(
        UPDATE.entity(BackgroundJobs)
            .set({
                status: 'submitted',
                submissionId: submission.submissionId ?? null,
                txHash: submission.txHash ?? null,
                chainStatus: 'pending',
                ...(first ? { externalExecutionAt: now } : {}),
                submittedAt: now,
                heartbeatAt: now,
                leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
            })
            .where(first
                ? { ID: jobId, status: 'running', leaseOwner: getRuntimeWorkerId() }
                : { ID: jobId, status: { in: ['external_execution', 'submitted'] }, leaseOwner: getRuntimeWorkerId() })
    );
    if (affectedRows(affected) === 1) return;
    throw new Error(`Lease lost before markJobBroadcastOn(${jobId})${first ? '' : ' (rebuild attempt)'}`);
}

/**
 * Twin of `markJobBroadcastOn` for a rejected attempt: take the identifier
 * off the job (back to external_execution, no hash) in one statement on the
 * caller's transaction, CAS-guarded on the lease and on the rejected hash.
 * Throws when the guard does not hold (the caller's transaction rolls back).
 */
export async function markJobSubmissionRejectedOn(
    runner: { run: (q: unknown) => Promise<unknown> },
    jobId: string,
    submission: { submissionId?: string; txHash?: string }
): Promise<void> {
    const affected = await runner.run(
        UPDATE.entity(BackgroundJobs)
            .set({
                status: 'external_execution',
                txHash: null,
                chainStatus: null,
                submissionId: submission.submissionId ?? null,
                heartbeatAt: new Date().toISOString(),
                leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS).toISOString()
            })
            .where({ ID: jobId, status: { in: ['external_execution', 'submitted'] }, leaseOwner: getRuntimeWorkerId(), ...(submission.txHash ? { txHash: submission.txHash } : {}) })
    );
    if (affectedRows(affected) === 1) return;
    throw new Error(`Lease lost (or hash already moved) before markJobSubmissionRejectedOn(${jobId})`);
}

/** Same lock-contention retry for callers writing status inside their own transaction. */
export const withLockContentionRetry = withStatusWriteRetry;

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

/** Test seam: one poller tick (reclaim, budgeted dispatch, sweeps). */
export function __pollOnceForTests(): Promise<void> { return pollPersistedCommands(); }

/** Test-only reset of the in-memory caches. */
export function __resetForTests(): void {
    dispatching.clear();
    confirmerReconcileCursor = undefined;
    stopBackgroundJobProcessor();
    semaphores.clear();
    cachedNetwork = undefined;
    runtimeWorkerId = undefined;
    commandPollActive = false;
    reconciliationCursor = undefined;
    parentPendingCursor = undefined;
    parentLegacyCursor = undefined;
    confirmerPendingCursor = undefined;
    confirmerLegacyCursor = undefined;
    chainOutcomeConfirmer = null;
    chainConfirmActive = false;
    __resetLockContentionBackoffForTests();
}

/** Test-only override of the status-write retry backoff schedule. */
export function __setStatusWriteBackoffForTests(ms: readonly number[]): void {
    __setLockContentionBackoffForTests(ms);
}
