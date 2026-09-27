/**
 * Background job rows: status writes (CAS on status and lease), leases, idempotency and admission errors.
 * SPDX-License-Identifier: Apache-2.0
 */
import { withLockContentionRetry as withDbLockRetry, LOCK_CONTENTION_ATTEMPTS, __setLockContentionBackoffForTests } from './db-write-retry';
import cds from '@sap/cds';
import crypto from 'crypto';
import { AsyncResource } from 'async_hooks';
import { BackgroundJobs } from '#cds-models/midnight';
import { type SubmissionErrorClassification } from './TransactionSubmitter';
import { configString } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { NightgateError } from '../utils/errors';

const { SELECT, UPDATE } = cds.ql;

// Created at module load, outside any request: running work through it leaves
// CAP's request/tx AsyncLocalStorage scope.
const detachedJobScope = new AsyncResource('nightgate.detached-job-work');

export function safeStringify(value: unknown): string {
    return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
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
    chainSegments?: string | null;
    createdAt: string;
    modifiedAt: string;
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
        const runner: DbRunner = db.tx(cds.context);
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

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export const STATUS_WRITE_ATTEMPTS = LOCK_CONTENTION_ATTEMPTS;

/** The `BackgroundJobs.idempotencyKey` column width. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A key longer than the column: refused before anything is written (400). */
export class IdempotencyKeyInvalidError extends NightgateError {
    constructor() {
        super('IDEMPOTENCY_KEY_INVALID', `idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

/** An idempotency key reused with a different payload: the caller's error, never retryable as is. */
export class IdempotencyConflictError extends NightgateError {
    constructor(idempotencyKey: string) {
        super('IDEMPOTENCY_KEY_CONFLICT', `Idempotency key '${idempotencyKey}' was already used with a different request payload.`);
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

/** Admission refused on a busy database: nothing written or submitted, the caller may resend (503). */
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

export const withStatusWriteRetry = <T>(label: string, write: () => Promise<T>): Promise<T> =>
    withDbLockRetry(label, write, (msg: string) => cds.log('nightgate').warn(msg));

export function affectedRows(value: unknown): number {
    return typeof value === 'number' ? value : Number((value as any)?.changes ?? value ?? 0);
}

export async function markRunning(jobId: string): Promise<boolean> {
    const db = await cds.connect.to('db');
    const affected = await withStatusWriteRetry(`markRunning(${jobId})`, async () => {
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
    await withStatusWriteRetry(`markSucceeded(${jobId})`, async () => {
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
        await withStatusWriteRetry(`markFailed(${jobId})`, async () => {
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
        // Nothing upstream can act on it: log the real classification for the operator.
        cds.log('nightgate').error(
            `markFailed(${jobId}): could not persist the failure status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery. Unpersisted error: ${classification.code}: ${classification.message}`,
            err
        );
    }
}

export async function markReconciliationRequired(jobId: string, classification: { code: string; message: string }): Promise<void> {
    const db = await cds.connect.to('db');
    try {
        await withStatusWriteRetry(`markReconciliationRequired(${jobId})`, async () => {
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
            `markReconciliationRequired(${jobId}): could not persist the safety status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
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

export function __setStatusWriteBackoffForTests(ms: readonly number[]): void {
    __setLockContentionBackoffForTests(ms);
}

/** Test hook: forget the worker id. */
export function __resetStoreForTests(): void {
    runtimeWorkerId = undefined;
}
