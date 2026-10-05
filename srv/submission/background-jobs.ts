/**
 * Runs long work as background jobs stored in the database.
 * The request only inserts the job row. The work runs later in short database
 * transactions, so no connection stays open for hours.
 * A unique (sessionId, kind, idempotencyKey) prevents duplicate jobs.
 */

import { isLockContention, lockContentionBackoffMs, __resetLockContentionBackoffForTests, LOCK_CONTENTION_ATTEMPTS, withLockContentionRetry } from './db-write-retry';
import cds from '@sap/cds';
import crypto from 'crypto';
import { BackgroundJobs, type BackgroundJob } from '#cds-models/midnight';
import { encrypt as encryptAtRest, getEncryptionKey } from '../utils/crypto';
import { jobCommandBinding } from '../utils/envelope-bindings';
import { getArtifactGenerationDigest } from './contract-registry';
import { configInt, configMs } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { safeStringify, sleep, IDEMPOTENCY_KEY_MAX_LENGTH, IdempotencyKeyInvalidError, JobAdmissionBusyError, isUniqueViolation, WorkflowReconciliationRequiredError, getJobById, IdempotencyConflictError, __resetStoreForTests } from './job-store';
import { processors, processorKey } from './job-registry';
import { scheduleJob, __resetSchedulerForTests } from './job-scheduler';
import { __resetReconciliationForTests } from './job-reconciliation';
import { errorMessage } from '../utils/errors';

export { declareJobKind, jobKindTraits, kindsWithTrait, __workflowParentKindsForTests, registerBackgroundJobProcessor, undeclaredOrUnregisteredJobKinds, registerBackgroundJobReconciliationFinalizer, type BackgroundJobProcessor, type BackgroundJobReconciliationFinalizer } from './job-registry';
export { type ReconciliationEvidence, WorkflowReconciliationRequiredError, runWithoutAmbientTx, getJobById, dropPendingJobsForClosedSessions, findLatestJob, supersedeQueuedJobs, IDEMPOTENCY_KEY_MAX_LENGTH, IdempotencyKeyInvalidError, IdempotencyConflictError, JobAdmissionBusyError, markJobExternalExecution, markJobBroadcastOn, markJobSubmissionRejectedOn, markJobSubmitted } from './job-store';
export { recoverInterruptedJobs, BROADCAST_UNCONFIRMED, BROADCAST_NOT_INCLUDED, settleRejectedSponsorAttempts, registerChainOutcomeConfirmer, reconcileBackgroundJobs, refreshSucceededChainOutcomes, confirmChainOutcomesViaIndexer } from './job-reconciliation';
export { startBackgroundJobProcessor, stopBackgroundJobProcessor, reclaimExpiredLeases, __pollOnceForTests } from './job-scheduler';
export { REJECTED_ATTEMPT_BOOKKEEPING_PENDING, SponsorAttemptBookkeepingPendingError } from './job-execution-context';

const { SELECT, INSERT } = cds.ql;

export interface StartJobArgs<TIn, TOut> {
    kind: string;
    sessionId: string;
    idempotencyKey?: string | null;
    /** Stored as plain JSON, so remove secrets first. */
    request: TIn;
    /** Used for duplicate detection instead of `request` when the request contains generated IDs. */
    idempotencyPayload?: unknown;
    /** Checked again on a re-run to confirm the caller still owns the session. */
    requestedBy?: string;
    grantId?: string | null;
    /** Stored command that can be re-run after a restart. Needs a registered processor for `kind`. */
    command?: unknown;
    commandVersion?: number;
    /** Must be set when the command holds private circuit inputs. */
    encryptCommand?: boolean;
    parentJobId?: string;
    workflowStep?: string;
    /** In-memory work that cannot be re-run after a restart. Omit when `command` is set. */
    work?: () => Promise<TOut>;
}

export interface StartJobResult<TOut = unknown, TIn = unknown> {
    jobId: string;
    status: BackgroundJob['status'];
    /** Set only when a repeated request found a job that already succeeded. */
    result?: TOut;
    deduplicated?: boolean;
    originalRequest?: TIn;
}

/** Inserts the job row in the caller's transaction and starts the work in the background. Returns at once. */
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

    // Savepoints need one fixed connection, which only the request's transaction provides.
    // Without one, each db.run commits on its own. Reads use the same connection to see its writes.
    const pinnedRunner: DbRunner | undefined =
        cds.context ? db.tx(cds.context) : undefined;
    const reader = pinnedRunner ?? db;

    if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new IdempotencyKeyInvalidError();
    // Quick check only. A parallel insert with the same key is caught by the unique constraint below.
    if (idempotencyKey) {
        const dup = await dedupExisting<TIn, TOut>(reader, sessionId, kind, idempotencyKey, payloadFingerprint);
        if (dup) return dup;
    }

    // Insert in the caller's transaction. Handlers often write first, so it already holds the SQLite write lock.
    const jobId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    // `compiledArtifactRef` is a name that can later point to another contract build.
    // Store the build's digest now so the job refuses to run if the name changes.
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
        // On a duplicate key, return the job that was inserted first.
        // Rolling back to the savepoint lets the caller's Postgres transaction continue after the error.
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
                if (isLockContention(insertErr) && attempt + 1 < LOCK_CONTENTION_ATTEMPTS) {
                    cds.log('nightgate').warn(`startJob(${kind}): admission insert lost the SQLite lock (attempt ${attempt + 1}/${LOCK_CONTENTION_ATTEMPTS})`);
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
        // No surrounding transaction, so a duplicate key breaks nothing. Read the existing job.
        try {
            await withLockContentionRetry(`startJob(${kind}) admission insert`, () => db.run(buildInsert()));
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
                if (isLockContention(insertErr) && attempt + 1 < LOCK_CONTENTION_ATTEMPTS) {
                    cds.log('nightgate').warn(`startJob(${kind}): admission insert lost the SQLite lock (attempt ${attempt + 1}/${LOCK_CONTENTION_ATTEMPTS})`);
                    continue;
                }
                if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
                throw insertErr;
            }
        }
    } else {
        try {
            await withLockContentionRetry(`startJob(${kind}) admission insert`, () => db.run(buildInsert()));
        } catch (insertErr) {
            if (isLockContention(insertErr)) throw new JobAdmissionBusyError(kind);
            throw insertErr;
        }
    }

    scheduleJob(jobId, kind, work);

    return { jobId, status: 'pending', deduplicated: false };
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

/** True when a step of this workflow succeeded or may have reached the chain. */
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
        // When unsure, assume a step ran. Otherwise a retry could pay for a step that is already on chain.
        cds.log('nightgate').warn(
            `hasCompletedChild(${parentJobId}) could not read child state (${errorMessage(err)}); ` +
            'assuming the workflow is partially executed'
        );
        return true;
    }
}

/**
 * Runs one workflow step as its own job and waits for its result.
 * A re-run parent finds the same step job again through its fixed idempotency key.
 */
export async function runChildCommand<T>(args: {
    parent: BackgroundJob;
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
        // An earlier step may be on chain. A plain failure would never be checked against
        // the chain, and a retry would repeat steps that cost fees.
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

/** The existing job for this idempotency key, or null. Throws when the key is reused with a different payload. */
async function dedupExisting<TIn, TOut>(
    runner: DbRunner,
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
        throw new IdempotencyConflictError(idempotencyKey);
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

export function __resetForTests(): void {
    __resetSchedulerForTests();
    __resetStoreForTests();
    __resetReconciliationForTests();
    __resetLockContentionBackoffForTests();
}
