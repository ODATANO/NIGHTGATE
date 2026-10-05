/**
 * HTTP timeout for one request to the proof server.
 * The client retries a timed-out proof up to three times, so a timeout that is too short makes slow proofs fail and repeat.
 * `initialize()` writes the value into `NIGHTGATE_PROOF_TIMEOUT_MS` before the wallet worker starts.
 * This module does not import `@sap/cds`, because the worker thread loads it too.
 */
export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;

export function proofRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return configNumberFrom('NIGHTGATE_PROOF_TIMEOUT_MS', env);
}

import { configNumberFrom } from './config';