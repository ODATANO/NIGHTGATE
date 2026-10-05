import { AsyncLocalStorage } from 'node:async_hooks';
import { assertLeaseHeld } from '../utils/instance-lease';

/**
 * The node surely rejected the attempt, but saving that result to the database failed.
 * The job waits under this code and `settleRejectedSponsorAttempts` retries the save on every tick.
 * The indexer cannot resolve it, because the transaction never reached a mempool.
 */
export const REJECTED_ATTEMPT_BOOKKEEPING_PENDING = 'REJECTED_ATTEMPT_BOOKKEEPING_PENDING';

export class SponsorAttemptBookkeepingPendingError extends Error {
    readonly code = REJECTED_ATTEMPT_BOOKKEEPING_PENDING;
    constructor(message: string, public readonly details: { submissionId: string; txHash?: string; grantId?: string; refund: number }) {
        super(message);
        this.name = 'SponsorAttemptBookkeepingPendingError';
    }
}

export interface ExternalSubmissionHandle {
    submissionId?: string;
    txHash?: string;
    /** Used by markBroadcastOn only. True for the job's first broadcast, false for a rebuilt retry. */
    firstBoundary?: boolean;
}

/** Anything that runs a CQL statement: the db service or one transaction of it. */
export type StatementRunner = { run: (q: unknown) => Promise<unknown> };

interface JobExecutionContext {
    reportExternalExecution: (handle: ExternalSubmissionHandle) => Promise<void>;
    reportSubmitted: (handle: ExternalSubmissionHandle) => Promise<void>;
    markBroadcastOn: (runner: StatementRunner, handle: ExternalSubmissionHandle) => Promise<void>;
    markSubmissionRejectedOn: (runner: StatementRunner, handle: ExternalSubmissionHandle) => Promise<void>;
}

const storage = new AsyncLocalStorage<JobExecutionContext>();

export function runInJobExecutionContext<T>(
    context: JobExecutionContext,
    work: () => Promise<T>
): Promise<T> {
    return storage.run(context, work);
}

/** No-op outside a background job (TransactionSubmitter is also public API). */
export async function reportExternalSubmission(handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.reportSubmitted(handle);
}

/** Marks the point after which a crash leaves it unknown whether the transaction was sent. */
export async function reportExternalExecution(handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.reportExternalExecution(handle);
}

/**
 * Mark the job as broadcast inside the caller's database transaction.
 * The job update then commits together with the attempt row and the deploy budget reservation.
 */
export async function reportBroadcastOn(runner: StatementRunner, handle: ExternalSubmissionHandle): Promise<void> {
    // A process that lost its instance lease throws here, so its worker never broadcasts.
    await assertLeaseHeld(runner);
    await storage.getStore()?.markBroadcastOn(runner, handle);
}

/**
 * Remove a rejected transaction id from the job inside the caller's database transaction.
 * The attempt row, the deploy refund and the job update then commit together.
 * Throws if the job's stored id changed in the meantime.
 */
export async function reportSubmissionRejectedOn(runner: StatementRunner, handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.markSubmissionRejectedOn(runner, handle);
}
