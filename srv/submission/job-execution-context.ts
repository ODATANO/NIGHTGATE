import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExternalSubmissionHandle {
    submissionId?: string;
    txHash?: string;
}

interface JobExecutionContext {
    reportExternalExecution: (handle: ExternalSubmissionHandle) => Promise<void>;
    reportSubmitted: (handle: ExternalSubmissionHandle) => Promise<void>;
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
