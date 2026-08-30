/**
 * HTTP timeout of ONE proof request to the proof server (server proving mode).
 * midnight-js' `httpClientProofProvider` defaults to 5 min and re-requests a
 * timed-out proof up to three times, so a slow proof (large custom relation,
 * cold SRS, busy server) failed the job and then proved three more times.
 * `initialize()` pins the effective value into `NIGHTGATE_PROOF_TIMEOUT_MS`
 * before the wallet worker spawns; worker and provider sites read it here.
 * No cds import: the worker thread loads this module too.
 */
export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;

export function proofRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env.NIGHTGATE_PROOF_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PROOF_TIMEOUT_MS;
}
