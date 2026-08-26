import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExternalSubmissionHandle {
    submissionId?: string;
    txHash?: string;
    /** markBroadcastOn only: first boundary crossing of this job (running -> submitted) vs a rebuild attempt. */
    firstBoundary?: boolean;
}

/** Anything that runs a CQL statement: the db service or one transaction of it. */
export type StatementRunner = { run: (q: unknown) => Promise<unknown> };

interface JobExecutionContext {
    reportExternalExecution: (handle: ExternalSubmissionHandle) => Promise<void>;
    reportSubmitted: (handle: ExternalSubmissionHandle) => Promise<void>;
    /** The announced attempt was provably rejected before inclusion: drop its hash from the job (see markJobSubmissionRejected). */
    reportSubmissionRejected: (handle: ExternalSubmissionHandle) => Promise<void>;
    /** Boundary crossing + identifier in one statement on the caller's transaction (see markJobBroadcastOn). */
    markBroadcastOn: (runner: StatementRunner, handle: ExternalSubmissionHandle) => Promise<void>;
    /** Rejected identifier off the job, CAS-guarded, on the caller's transaction (see markJobSubmissionRejectedOn). */
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

/** Marks the point after which a crash cannot prove that no broadcast occurred. */
export async function reportExternalExecution(handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.reportExternalExecution(handle);
}

/**
 * The announced broadcast attempt was rejected BEFORE inclusion (a 1010 node
 * reject, pool status Invalid, the send died on a closing socket, the main
 * thread nacked the intent): nothing of it can be on-chain, so the job must
 * not keep its hash as "possibly executed". No-op outside a background job.
 */
export async function reportSubmissionRejected(handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.reportSubmissionRejected(handle);
}

/**
 * Cross the external-effect boundary and record the identifier on the
 * caller's transaction, so the job transition commits with the attempt row
 * and the grant's deploy reservation. Throws on a lost lease (rolls the
 * caller's transaction back). No-op outside a background job.
 */
export async function reportBroadcastOn(runner: StatementRunner, handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.markBroadcastOn(runner, handle);
}

/**
 * Take a provably rejected identifier off the job on the caller's
 * transaction, so attempt row, deploy refund and job hash commit together.
 * Throws on a failed CAS (lease lost, hash already moved), rolling the
 * caller's transaction back. No-op outside a background job.
 */
export async function reportSubmissionRejectedOn(runner: StatementRunner, handle: ExternalSubmissionHandle): Promise<void> {
    await storage.getStore()?.markSubmissionRejectedOn(runner, handle);
}
