// HTTP timeout for one proof server request. The client retries a timeout up to three times, so a short one repeats slow proofs.
// `initialize()` copies the value into `NIGHTGATE_PROOF_TIMEOUT_MS` before the wallet worker starts.
// This module does not import `@sap/cds`, because the worker thread loads it too.
export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;

export function proofRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_PROOF_TIMEOUT_MS', env);
}

import { configNumberFrom } from './config';