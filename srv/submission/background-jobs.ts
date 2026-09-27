/**
 * Durable async job runner: the request tx only inserts the row, the leased work
 * runs detached with short per-write txs (no pool connection held for hours).
 * `idempotencyKey` dedupes via the (sessionId, kind, key) constraint.
 */

import { isLockContention, lockContentionBackoffMs, __resetLockContentionBackoffForTests } from './db-write-retry';
import cds from '@sap/cds';
import crypto from 'crypto';
import { BackgroundJobs } from '#cds-models/midnight';
import { encrypt as encryptAtRest, getEncryptionKey } from '../utils/crypto';
import { jobCommandBinding } from '../utils/envelope-bindings';
import { getArtifactGenerationDigest } from './contract-registry';
import { configInt, configMs } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { BackgroundJobRow, safeStringify, sleep, STATUS_WRITE_ATTEMPTS, IDEMPOTENCY_KEY_MAX_LENGTH, IdempotencyKeyInvalidError, JobAdmissionBusyError, isUniqueViolation, withStatusWriteRetry, WorkflowReconciliationRequiredError, getJobById, IdempotencyConflictError, __resetStoreForTests } from './job-store';
import { processors, processorKey } from './job-registry';
import { scheduleJob, __resetSchedulerForTests } from './job-scheduler';
import { __resetReconciliationForTests } from './job-reconciliation';

export { declareJobKind, jobKindTraits, kindsWithTrait, __workflowParentKindsForTests, registerBackgroundJobProcessor, undeclaredOrUnregisteredJobKinds, registerBackgroundJobReconciliationFinalizer, type BackgroundJobProcessor, type BackgroundJobReconciliationFinalizer } from './job-registry';
export { type BackgroundJobRow, type ReconciliationEvidence, WorkflowReconciliationRequiredError, runWithoutAmbientTx, getJobById, dropPendingJobsForClosedSessions, findLatestJob, supersedeQueuedJobs, IDEMPOTENCY_KEY_MAX_LENGTH, IdempotencyKeyInvalidError, IdempotencyConflictError, JobAdmissionBusyError, markJobExternalExecution, markJobBroadcastOn, markJobSubmissionRejectedOn, withLockContentionRetry, markJobSubmitted, __setStatusWriteBackoffForTests } from './job-store';
export { recoverInterruptedJobs, BROADCAST_UNCONFIRMED, BROADCAST_NOT_INCLUDED, settleRejectedSponsorAttempts, registerChainOutcomeConfirmer, reconcileBackgroundJobs, refreshSucceededChainOutcomes, confirmChainOutcomesViaIndexer } from './job-reconciliation';
export { startBackgroundJobProcessor, stopBackgroundJobProcessor, reclaimExpiredLeases, __pollOnceForTests } from './job-scheduler';
export { REJECTED_ATTEMPT_BOOKKEEPING_PENDING, SponsorAttemptBookkeepingPendingError } from './job-execution-context';

const { SELECT, INSERT } = cds.ql;

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
    const pinnedRunner: DbRunner | undefined =
        cds.context ? db.tx(cds.context) : undefined;
    const reader = pinnedRunner ?? db;

    if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new IdempotencyKeyInvalidError();
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

/** The existing job for an idempotency identity, or null; throws on a reused key with a changed payload. */
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
