/**
 * Durable async job runner: the request tx only inserts the row, the leased work
 * runs detached with short per-write txs (no pool connection held for hours).
 * `idempotencyKey` dedupes via the (sessionId, kind, key) constraint.
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

// Created at module load, outside any request: running work through it leaves
// CAP's request/tx AsyncLocalStorage scope.
const detachedJobScope = new AsyncResource('nightgate.detached-job-work');

// ---- Concurrency caps ------------------------------------------------------

const DEFAULT_CONCURRENCY = { heavy: 4, light: 16, serial: 1 } as const;

// Filled by registration; every kind set below derives from it.
const kindTraits = new Map<string, JobKindTraits>();

function isTraits(value: unknown): value is JobKindTraits {
    const t = value as JobKindTraits | null;
    return !!t && typeof t === 'object'
        && typeof t.heavy === 'boolean' && typeof t.workflowParent === 'boolean' && typeof t.identifierKeyed === 'boolean';
}

export function declareJobKind(kind: string, traits: JobKindTraits): void {
    if (!kind || !isTraits(traits)) throw new Error(`declareJobKind(${kind}): heavy, workflowParent and identifierKeyed must be booleans`);
    kindTraits.set(kind, { ...traits });
}

/** An unregistered kind (row of a removed kind) counts as light. */
export function jobKindTraits(kind: string): JobKindTraits {
    return kindTraits.get(kind) ?? LIGHT_KIND;
}

export function kindsWithTrait(trait: 'heavy' | 'workflowParent' | 'identifierKeyed' | 'serial' | 'sessionBound'): string[] {
    return [...kindTraits.entries()].filter(([, t]) => t[trait] === true).map(([k]) => k);
}

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

function safeStringify(value: unknown): string {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
}

// ---- Types -----------------------------------------------------------------

export interface StartJobArgs<TIn, TOut> {
    kind: string;
    sessionId: string;
    idempotencyKey?: string | null;
    /** Persisted as plain JSON: strip secrets first. */
    request: TIn;
    /** Fingerprinted instead of `request` when that contains generated IDs. */
    idempotencyPayload?: unknown;
    /** Revalidates session ownership on replay. */
    requestedBy?: string;
    grantId?: string | null;
    /** Versioned replayable command; requires a registered processor for `kind`. */
    command?: unknown;
    commandVersion?: number;
    /** Required for private circuit inputs. */
    encryptCommand?: boolean;
    parentJobId?: string;
    workflowStep?: string;
    /** Legacy in-memory execution. Omit for replayable commands. */
    work?: () => Promise<TOut>;
}

export interface StartJobResult<TOut = unknown, TIn = unknown> {
    jobId: string;
    status: BackgroundJobRow['status'];
    /** Only when an idempotent retry hit an already-succeeded row. */
    result?: TOut;
    deduplicated?: boolean;
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
    grantId?: string | null;
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

/** Insert the job row on the caller's tx and detach the work; returns at once. */
export async function startJob<TIn, TOut>(
    args: StartJobArgs<TIn, TOut>
): Promise<StartJobResult<TOut>> {
    const { kind, sessionId, idempotencyKey, request, idempotencyPayload, requestedBy, grantId, command, commandVersion, encryptCommand, parentJobId, workflowStep, work } = args;
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

    // Savepoints need one pinned connection, which only an ambient request tx
    // gives; outside one db.run autocommits. Reads share it to see its own writes.
    const pinnedRunner: { run: (q: any) => Promise<any> } | undefined =
        cds.context ? (db as any).tx(cds.context) : undefined;
    const reader = pinnedRunner ?? db;

    // Fast path only: in-flight same-key rows are caught by the constraint below.
    if (idempotencyKey) {
        const dup = await dedupExisting<TIn, TOut>(reader, sessionId, kind, idempotencyKey, payloadFingerprint);
        if (dup) return dup;
    }

    // The INSERT rides the caller's ambient tx: handlers often write first, so
    // that tx already holds the SQLite write lock.
    const jobId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    // `compiledArtifactRef` is a mutable alias: stamp its digest now so the
    // executor fails closed if it is re-pointed before execution.
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
        grantId: grantId ?? null,
        parentJobId: parentJobId ?? null,
        workflowStep: workflowStep ?? null,
        queuedAt,
        attempt: 1,
        maxAttempts: 1
    });

    // A failed INSERT committed nothing, so retrying on lock contention is safe.
    if (idempotencyKey && pinnedRunner) {
        // A same-key collision resolves to the winner's job; ROLLBACK TO clears
        // Postgres's aborted-tx state so the handler's tx can continue.
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
        // Autocommit: a collision poisons nothing, recover the winner on a fresh read.
        try {
            await withStatusWriteRetry(`startJob(${kind}) admission insert`, () => db.run(buildInsert()));
        } catch (insertErr) {
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

    scheduleJob(jobId, kind, work);

    return { jobId, status: 'pending', deduplicated: false };
}

type BackgroundJobProcessor = (command: unknown, row: BackgroundJobRow) => Promise<unknown>;
export interface ReconciliationEvidence {
    submissionId: string | null;
    txHash: string;
    contractAddress: string | null;
    finalizedAt: string | null;
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

export function registerBackgroundJobProcessor(kind: string, version: number, traits: JobKindTraits, processor: BackgroundJobProcessor): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof processor !== 'function') {
        throw new Error('registerBackgroundJobProcessor: kind, positive version, traits and processor are required');
    }
    declareJobKind(kind, traits);
    processors.set(processorKey(kind, version), processor);
}

/** Declared kinds without a processor: the runner refuses to start with any. */
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
 * Dispatch after commit: must use the same `cds.context` check as startJob's
 * insert, so a row on the caller's tx dispatches on 'succeeded' (never on
 * rollback). A lost hook is recovered by the command poller.
 */
function scheduleJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    const ctx = cds.context as { on?: (event: string, handler: () => void) => void } | undefined;
    if (!ctx) return dispatchJob(jobId, kind, legacyWork);
    if (typeof ctx.on === 'function') {
        ctx.on('succeeded', () => dispatchJob(jobId, kind, legacyWork));
        return;
    }
    // No commit signal (only mock contexts lack `.on`): dispatch now. An
    // uncommitted row is not claimable; the poller picks it up after commit.
    cds.log('nightgate').warn(
        `startJob(${kind}): ambient context without lifecycle events; dispatching job ${jobId} immediately (its row may not be committed yet)`
    );
    dispatchJob(jobId, kind, legacyWork);
}

// Dispatches in flight in this process; the poller skips them (once per lease, not per tick).
const dispatching = new Set<string>();
/** Queued this long with a free slot: the claim path was slow, log it. */
const CLAIM_LATENCY_WARN_MS = 15_000;

function dispatchJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    if (dispatching.has(jobId)) return;
    dispatching.add(jobId);
    const semaphore = getSemaphore(kind);
    const dispatchedAt = Date.now();
    setImmediate(() => void runWithoutAmbientTx(async () => {
        try {
            await semaphore.acquire();
        } catch (err) {
            dispatching.delete(jobId);
            throw err;
        }
        const semaphoreWaitMs = Date.now() - dispatchedAt;
        try {
            const claimed = await markRunning(jobId);
            if (!claimed) {
                cds.log('nightgate').debug(`startJob(${kind}): job ${jobId} was already claimed or is no longer pending; skipping work`);
                return;
            }
            const stopHeartbeat = startLeaseHeartbeat(jobId);
            try {
                const row = await getJobById(jobId);
                if (!row) throw new Error(`Background job ${jobId} disappeared after claim`);
                const queuedMs = row.queuedAt && row.startedAt ? Date.parse(row.startedAt) - Date.parse(row.queuedAt) : NaN;
                if (queuedMs > CLAIM_LATENCY_WARN_MS && semaphoreWaitMs < 1_000) {
                    cds.log('nightgate').warn(`Job ${jobId} (${kind}) started ${Math.round(queuedMs / 1000)}s after it was queued, with a free slot`);
                }
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
                        cds.log('nightgate').info(`markSucceeded(${jobId}): job was superseded mid-run; discarding its result`);
                    } else {
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
                if (current?.txHash) {
                    cds.log('nightgate').warn(`Job ${jobId} (${current.kind}) failed after announcing ${current.txHash.slice(0, 16)}: ${classification.code}: ${classification.message.slice(0, 300)}`);
                } else if (current?.submissionId) {
                    cds.log('nightgate').warn(`Job ${jobId} (${current.kind}) failed after an announced attempt was closed: ${classification.code}: ${classification.message.slice(0, 300)}`);
                }
                // Only a recorded txHash can mean an on-chain effect; without one
                // the job fails plainly (a false predicate must not need an operator).
                if (current?.status === 'failed' && current.errorCode === 'SUPERSEDED') {
                    cds.log('nightgate').info(
                        `Job ${jobId} errored after being superseded mid-run; keeping SUPERSEDED (dropped: ${classification.code})`
                    );
                } else if (current?.txHash && jobKindTraits(current.kind).identifierKeyed && isCallNotAppliedFailure(err)) {
                    // Outcome proven via the indexer: terminal, no transient reconciliation state.
                    await markChainFailureAfterBroadcast(jobId, current, err);
                } else if (err instanceof SponsorAttemptBookkeepingPendingError && current?.txHash) {
                    // Park under the code settleRejectedSponsorAttempts looks for; the indexer never resolves it.
                    await markReconciliationRequired(jobId, { code: err.code, message: err.message });
                } else if (current?.txHash && classification.code === 'SubmitAmbiguous') {
                    // Not a failure yet: the confirmer ends it from chain evidence or absence past the ttl.
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

/** Did any step of this workflow succeed or leave a possible effect (txHash, reconciliation)? */
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
        // Unknown counts as "something happened": the other guess could plainly
        // fail a workflow with a step on chain, and a retry would pay twice.
        cds.log('nightgate').warn(
            `hasCompletedChild(${parentJobId}) could not read child state (${String((err as Error)?.message ?? err)}); ` +
            'assuming the workflow is partially executed'
        );
        return true;
    }
}

/**
 * Run one child command and wait for its durable result. A re-run parent
 * resolves the same child through its immutable idempotency key.
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
            grantId: parent.grantId ?? null,
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
        // Once an earlier step may be on chain, a plain failure (the parent has no
        // txHash) would never be reconciled and a retry would repeat fee-spending steps.
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
 * Run `fn` outside the ambient CAP tx: its db calls autocommit and pin no pool
 * connection. They cannot see the request tx's uncommitted writes, so use it before the handler writes.
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

/** The existing job for an idempotency identity, or null; throws on a reused key with a changed payload. */
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

/** Classify jobs left by a restart without risking a duplicate external effect. Idempotent. */
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
        // FIRST, before the re-queue below can claim them: a session-bound job's
        // product died with the process.
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
        // `running` is before the external-effect boundary: safe to re-queue.
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
        // Legacy closures cannot be reconstructed.
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
        // No hash = never broadcast: every submit path persists the identifier
        // (submit-intent ack) before sending. Nothing is on chain, fail plainly.
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
 * Fail pending jobs whose signing session the restart cleanup closed. Must run
 * before the job processor starts: a replay could no longer decrypt its keys.
 */
export async function dropPendingJobsForClosedSessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const db = await cds.connect.to('db');
    let dropped = 0;
    await withStatusWriteRetry('dropPendingJobsForClosedSessions', async () => {
        dropped = 0;
        // Chunked: stay within the driver's parameter limit.
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

/** Latest job of one kind for a session; detached read (must not hold a request tx). */
export async function findLatestJob(kind: string, sessionId: string): Promise<{ ID: string; status: string } | null> {
    const db = await cds.connect.to('db');
    const row = await runWithoutAmbientTx(() => db.run(
        SELECT.one.from(BackgroundJobs).columns('ID', 'status')
            .where({ sessionId, kind })
            .orderBy('createdAt desc')
    ));
    return row ? { ID: row.ID, status: row.status } : null;
}

/**
 * Mark queued/running jobs of `kind` for the session SUPERSEDED (status only: a
 * running one continues, its result is discarded). Uses the ambient request tx
 * when present: atomic with the successor insert, and no second pool connection.
 */
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
        // No retry inside the tx; the savepoint keeps a failed statement from
        // aborting the caller's PostgreSQL tx.
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

type ChainOutcomeConfirmer = (txHash: string) => Promise<ChainLookup>;

/** Evidence columns written with every confirmed outcome, on job and attempt row alike. */
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
/** Terminal code once the indexer tip is past the ttl and the transaction is still unknown. */
export const BROADCAST_NOT_INCLUDED = 'BROADCAST_NOT_INCLUDED';
/** For rows without a recorded ttl: the longest ttl any submitting path sets. */
const LEGACY_BROADCAST_TTL_MS = 60 * 60 * 1000;

/**
 * Fail a parked job as never included once the absence answer's own tip is past
 * its ttl plus margin. Only that tip counts: a lagging or other replica must not
 * turn a landed tx into a lost one (the caller would pay twice).
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
    const earlier = job.errorCode ? ` Earlier: ${job.errorCode}${job.errorMessage ? `: ${String(job.errorMessage).slice(0, 1000)}` : ''}` : '';
    return withStatusWriteRetry(`finalizeLostBroadcast(${job.ID})`, () => (db as any).tx(async (tx: any) => {
        if (await lockReorgGeneration(tx) !== generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set({
            status: 'failed', chainStatus: 'dropped', finishedAt: now,
            errorCode: BROADCAST_NOT_INCLUDED, errorMessage: (message + earlier).slice(0, 4000)
        } as any).where({ ID: job.ID, status: 'reconciliation_required' })));
        let rowClosed = 0;
        if (affected === 1 && submission?.ID) {
            rowClosed = affectedRows(await tx.run(UPDATE.entity(PendingSubmissions).set({
                status: 'failed', finalizedAt: now, errorCode: BROADCAST_NOT_INCLUDED,
                errorMessage: `not included before ttl ${ttlIso}`
            } as any).where({ ID: submission.ID, status: 'pending' })));
        }
        // Refund the deploy reservation exactly once: only the row closed here can still hold it.
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

/**
 * Finalize an identifier-keyed job and its attempt row in ONE transaction. A
 * reconciled success gets the action's canonical result, rebuilt from the
 * submit-intent coordinates. `succeeded` only advances chainStatus (CAS).
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
    // The kind's finalizer runs first; if it throws, the job stays parked.
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
 * Settle rejected attempts whose bookkeeping did not commit: close the row,
 * refund, clear the hash, fail the job. One idempotent transaction per job.
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

/** Every reconciliation path runs this: no job closes as succeeded without its finalizer's writes. */
async function runReconciliationFinalizer(job: BackgroundJobRow, evidence: ReconciliationEvidence): Promise<unknown | undefined> {
    const finalizer = job.commandVersion
        ? reconciliationFinalizers.get(processorKey(job.kind, job.commandVersion))
        : undefined;
    if (!finalizer) return undefined;
    const serialized = job.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(job.command!, getEncryptionKey(), jobCommandBinding(String(job.ID)))
        : job.command!;
    return finalizer(JSON.parse(serialized), job, evidence);
}

export function registerChainOutcomeConfirmer(confirmer: ChainOutcomeConfirmer | null): void {
    chainOutcomeConfirmer = confirmer;
}

// Single-flight and detached: slow indexer lookups must not stall the command poller.
function triggerChainConfirmPass(): void {
    if (!chainOutcomeConfirmer || chainConfirmActive) return;
    chainConfirmActive = true;
    void confirmChainOutcomesViaIndexer()
        .catch(err => cds.log('nightgate').warn(
            `Chain-outcome confirm pass failed: ${String((err as Error)?.message ?? err)}`))
        .finally(() => { chainConfirmActive = false; });
}

/**
 * One bounded page that advances past every inspected row (poison rows too) and
 * wraps. Process-local cursors suffice because the deployment is single-instance.
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
 * Start the durable command poller after processors and the wallet worker are
 * ready. The atomic `pending -> running` claim is the final duplicate guard.
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
 * Only `running` leases are reclaimable: past the external-effect boundary a
 * second dispatch could spend a second fee, reconciliation resolves those.
 */
const JOB_LEASE_TTL_MS = configMs('NIGHTGATE_JOB_LEASE_TTL_MS');
/** Fail instead of re-queue after this many reclaims: a crash loop must end. */
const MAX_LEASE_RECLAIMS = 3;

/** Re-queue silent `running` jobs; the CAS includes heartbeatAt, so a late heartbeat keeps the lease. */
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
        // Dispatch only up to free capacity; the rest waits for the next tick.
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
 * Re-queue parked workflow parents once all children succeeded (the processor
 * rebuilds the result without re-submitting). Leaf jobs resolve only via the indexer confirmer.
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
            // A failed child can never re-run under its immutable step key: the parent fails too.
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

/** Aggregate a succeeded workflow parent's `chainStatus` from its children. */
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
 * Chain evidence for leaf jobs: per-tx indexer lookup advances succeeded jobs'
 * `chainStatus` and resolves parked ones, recording the inclusion height a rollback reverts by.
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
    // Every parked kind with a hash resolves here: the indexer is the only evidence.
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
            // Only absence is evidence; an indexed-but-unconfirmable tx may be on chain.
            if (isChainAbsent(outcome)) {
                try { updated += await finalizeLostBroadcast(db, job, outcome.asOfMs, generation); } catch { /* next pass */ }
            }
            continue;
        }
        try {
            updated += await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'reconciliation_required', generation });
        } catch (err) {
            cds.log('nightgate').debug(`Crawler-free reconciliation of ${job.kind} job ${job.ID} deferred: ${String((err as Error)?.message ?? err)}`);
        }
    }
    const jobs = [...pendingPage.rows, ...legacyPage.rows]
        .filter(job => !jobKindTraits(job.kind).workflowParent);
    let lookupErrors = 0;
    let writeErrors = 0;
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
        if (!isChainOutcome(outcome)) return;
        // CAS on the exact chainStatus read: `IN (...)` would never match a NULL.
        try {
            if (jobKindTraits(job.kind).identifierKeyed) {
                // Not `updated += await f()`: that reads `updated` before the await
                // and loses concurrent increments.
                const n = await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'succeeded', chainStatusWas: job.chainStatus ?? null, generation });
                updated += n;
            } else {
                const now = new Date().toISOString();
                const evidence = chainEvidencePatch(outcome);
                // One transaction: a terminal job leaves the scan, its attempt row must not stay behind.
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

// The mark* status writes are idempotent and retried on lock contention; the job
// work never is (double-submit risk).

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * At most `limit` in flight; resolves only when ALL items finished, errors
 * swallowed per item, so the caller's single-flight guard holds for the whole pass.
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

const STATUS_WRITE_ATTEMPTS = LOCK_CONTENTION_ATTEMPTS;

export { REJECTED_ATTEMPT_BOOKKEEPING_PENDING, SponsorAttemptBookkeepingPendingError } from './job-execution-context';

/** Admission refused on a busy database: nothing written or submitted, the caller may resend (503). */
export class JobAdmissionBusyError extends Error {
    readonly httpStatus = 503;
    // CAP reads `status`/`statusCode`, not `httpStatus`; some actions return startJob's promise to CAP directly.
    readonly status = 503;
    readonly statusCode = 503;
    readonly code = 'JOB_ADMISSION_BUSY';
    /** `Retry-After`, seconds. */
    readonly retryAfterSeconds = 2;
    /** Otherwise CAP replaces 5xx messages in production; this one must reach the client. */
    readonly $sanitize = false;
    constructor(kind: string) {
        super(`the server is busy writing another job and could not admit this ${kind} request; nothing was submitted, retry in a moment`);
        this.name = 'JobAdmissionBusyError';
    }
}

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
        // Nothing upstream can act on it: log the real classification for the operator.
        cds.log('nightgate').error(
            `markFailed(${jobId}): could not persist the failure status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            err
        );
    }
}

/** Terminal failure straight from the running job, for an outcome the worker proved (in a block, call not applied). */
async function markChainFailureAfterBroadcast(jobId: string, current: BackgroundJobRow, err: unknown): Promise<void> {
    // The worker's probe is not generation-protected: re-ask the confirmer under
    // a captured generation, else park for the reconciliation pass.
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
 * Mark the single `running -> external_execution` crossing. Not re-entrant: restart
 * recovery reasons about one external effect per job, so split multi-submit work.
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
    // Still ours but past `running`: a second submission, not a lost lease.
    const current = await getJobById(jobId);
    if (current && current.leaseOwner === getRuntimeWorkerId()
        && (current.status === 'external_execution' || current.status === 'submitted')) {
        throw new Error(`markJobExternalExecution(${jobId}): job already crossed the external-effect boundary; a background job may perform at most one external submission.`);
    }
    throw new Error(`Lease lost before markJobExternalExecution(${jobId})`);
}

/**
 * Boundary crossing + identifier in one statement on the caller's transaction.
 * `firstBoundary` = running -> submitted; a rebuild moves an already-crossed job.
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

/** Take a rejected identifier off the job on the caller's transaction, CAS on lease and hash. */
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

export const withLockContentionRetry = withStatusWriteRetry;

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

export function __pollOnceForTests(): Promise<void> { return pollPersistedCommands(); }

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

export function __setStatusWriteBackoffForTests(ms: readonly number[]): void {
    __setLockContentionBackoffForTests(ms);
}
