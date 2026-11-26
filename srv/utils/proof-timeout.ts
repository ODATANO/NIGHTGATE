// Deadline for one proof server request, its retries included. A request that runs into it is not retried.
// `initialize()` copies the value into `NIGHTGATE_PROOF_TIMEOUT_MS` before the wallet worker starts.
// This module does not import `@sap/cds`, because the worker thread loads it too.
export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;

export function proofRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_PROOF_TIMEOUT_MS', env);
}

import { configNumberFrom } from './config';