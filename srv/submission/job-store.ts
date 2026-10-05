/**
 * Database access for background job rows: status changes, leases and job admission errors.
 * SPDX-License-Identifier: Apache-2.0
 */
import { withLockContentionRetry, LOCK_CONTENTION_ATTEMPTS } from './db-write-retry';
import cds from '@sap/cds';
import crypto from 'crypto';
import { AsyncResource } from 'async_hooks';
import { BackgroundJobs, type BackgroundJob } from '#cds-models/midnight';
import { type SubmissionErrorClassification } from './TransactionSubmitter';
import { configString } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { NightgateError, errorMessage } from '../utils/errors';

const { SELECT, UPDATE } = cds.ql;

// Created at load time, outside any request. Code run through it is not tied to
// the current request's database transaction.
const detachedJobScope = new AsyncResource('nightgate.detached-job-work');

export function safeStringify(value: unknown): string {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
}

export interface ReconciliationEvidence {
    submissionId: string | null;
    txHash: string;
    contractAddress: string | null;
    finalizedAt: string | null;
    blockHeight: number;
}

export class WorkflowReconciliationRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkflowReconciliationRequiredError';
    }
}

/**
 * Runs `fn` outside the request's transaction, so each query commits on its own.
 * It cannot see the request's uncommitted writes, so call it before the handler writes.
 */
export function runWithoutAmbientTx<T>(fn: () => Promise<T>): Promise<T> {
    return detachedJobScope.runInAsyncScope(fn);
}

export async function getJobById(jobId: string): Promise<BackgroundJob | null> {
    if (!jobId) return null;
    const db = await cds.connect.to('db');
    const row = await db.run(SELECT.one.from(BackgroundJobs).where({ ID: jobId }));
    return (row as BackgroundJob | undefined) || null;
}

/**
 * Fails pending jobs whose wallet session was closed at restart.
 * Must run before jobs start, since such a job could no longer decrypt its keys.
 */
export async function dropPendingJobsForClosedSessions(sessionIds: string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const db = await cds.connect.to('db');
    let dropped = 0;
    await withLockContentionRetry('dropPendingJobsForClosedSessions', async () => {
        dropped = 0;
        // In chunks, to stay within the driver's parameter limit.
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
 * Marks older pending or running jobs of `kind` for the session as SUPERSEDED.
 * A running job keeps running, but its result is ignored. Inside a request this
 * uses the request's transaction, so it commits together with the new job.
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
        const runner: DbRunner = db.tx(cds.context);
        // No retry inside the transaction. The savepoint keeps a failed statement
        // from aborting the caller's PostgreSQL transaction.
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
        affected = await withLockContentionRetry(
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

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));


/** The `BackgroundJobs.idempotencyKey` column width. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export class IdempotencyKeyInvalidError extends NightgateError {
    constructor() {
        super('IDEMPOTENCY_KEY_INVALID', `idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

export class IdempotencyConflictError extends NightgateError {
    constructor(idempotencyKey: string) {
        super('IDEMPOTENCY_KEY_CONFLICT', `Idempotency key '${idempotencyKey}' was already used with a different request payload.`);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

/** The database was too busy to accept the job. Nothing was written, the caller may resend (503). */
export class JobAdmissionBusyError extends NightgateError {
    /** `Retry-After`, seconds. */
    readonly retryAfterSeconds = 2;
    constructor(kind: string) {
        super('JOB_ADMISSION_BUSY', `the server is busy writing another job and could not admit this ${kind} request; nothing was submitted, retry in a moment`, { exposeMessage: true });
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

export { isUniqueViolation } from '../utils/db-errors';

export function affectedRows(value: unknown): number {
    return typeof value === 'number' ? value : Number((value as any)?.changes ?? value ?? 0);
}

export async function markRunning(jobId: string): Promise<boolean> {
    const db = await cds.connect.to('db');
    const affected = await withLockContentionRetry(`markRunning(${jobId})`, async () => {
        return db.tx(async (tx) => {
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

export async function markSucceeded(jobId: string, result: unknown): Promise<void> {
    const db = await cds.connect.to('db');
    await withLockContentionRetry(`markSucceeded(${jobId})`, async () => {
        await db.tx(async (tx) => {
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

export async function markFailed(jobId: string, classification: SubmissionErrorClassification): Promise<void> {
    const db = await cds.connect.to('db');
    try {
        await withLockContentionRetry(`markFailed(${jobId})`, async () => {
            await db.tx(async (tx) => {
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
        // No caller can handle this, so log the real error for the operator.
        cds.log('nightgate').error(
            `markFailed(${jobId}): could not persist the failure status after ${LOCK_CONTENTION_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            err
        );
    }
}

export async function markReconciliationRequired(jobId: string, classification: { code: string; message: string }): Promise<void> {
    const db = await cds.connect.to('db');
    try {
        await withLockContentionRetry(`markReconciliationRequired(${jobId})`, async () => {
            await db.tx(async (tx) => {
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
            `markReconciliationRequired(${jobId}): could not persist the safety status after ${LOCK_CONTENTION_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            writeErr
        );
    }
}

const JOB_LEASE_MS = 120_000;

const JOB_HEARTBEAT_MS = 30_000;

let runtimeWorkerId: string | undefined;

export function getRuntimeWorkerId(): string {
    return runtimeWorkerId ??= (
        configString('NIGHTGATE_INSTANCE_ID')
        || process.env.CF_INSTANCE_GUID
        || process.env.HOSTNAME
        || crypto.randomUUID()
    );
}

export function startLeaseHeartbeat(jobId: string): () => void {
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
        }).catch(err => cds.log('nightgate').warn(`heartbeat(${jobId}) failed: ${errorMessage(err)}`));
    }, JOB_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Moves a job from `running` to `external_execution`, the point after which it may have
 * changed the chain. Allowed once per job: restart recovery assumes one submission per job.
 */
export async function markJobExternalExecution(jobId: string, submission: { submissionId?: string }): Promise<void> {
    const db = await cds.connect.to('db');
    const affected = await withLockContentionRetry(`markJobExternalExecution(${jobId})`, async () => db.run(
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
    // The job is still ours but already past `running`: this is a second submission.
    const current = await getJobById(jobId);
    if (current && current.leaseOwner === getRuntimeWorkerId()
        && (current.status === 'external_execution' || current.status === 'submitted')) {
        throw new Error(`markJobExternalExecution(${jobId}): job already crossed the external-effect boundary; a background job may perform at most one external submission.`);
    }
    throw new Error(`Lease lost before markJobExternalExecution(${jobId})`);
}

/**
 * Marks the job submitted with its tx hash, inside the caller's transaction.
 * `firstBoundary` means the job comes from `running`. A rebuild updates a job already past it.
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

/** Removes a rejected tx hash from the job, inside the caller's transaction. Matches only if lease and hash are unchanged. */
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


export async function markJobSubmitted(jobId: string, submission: { submissionId?: string; txHash?: string }): Promise<void> {
    const db = await cds.connect.to('db');
    const affected = await withLockContentionRetry(`markJobSubmitted(${jobId})`, async () => {
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

/** Test hook: forget the worker id. */
export function __resetStoreForTests(): void {
    runtimeWorkerId = undefined;
}
