/**
 * Retry a short database write that lost a lock. SQLite reports
 * `database is locked` / `SQLITE_BUSY` while a multi-MB wallet-state save
 * holds the writer; PostgreSQL reports serialization failures, deadlocks and
 * lock timeouts, and a saturated pool times out the acquire. All of these are
 * "try again in a moment", not "the write is wrong". Only STATUS-style writes
 * go through here, never job work (double-submit risk).
 * SPDX-License-Identifier: Apache-2.0
 */

export const LOCK_CONTENTION_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS: readonly number[] = [0, 500, 1500, 4000, 8000];
let backoffMs: readonly number[] = DEFAULT_BACKOFF_MS;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** PostgreSQL SQLSTATEs that mean "retry": serialization failure, deadlock, lock not available, statement/lock timeout cancel. */
const PG_RETRY_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);

/** SQLite busy, PostgreSQL by SQLSTATE (`err.code`, node-postgres) with the message as fallback, generic-pool acquire timeout. */
export function isLockContention(err: unknown): boolean {
    const code = String((err as any)?.code ?? '');
    if (PG_RETRY_SQLSTATES.has(code) || code === 'SQLITE_BUSY') return true;
    const msg = String((err as Error)?.message ?? err);
    return /database is locked|SQLITE_BUSY|could not serialize access|deadlock detected|lock timeout|canceling statement due to lock timeout|ResourceRequest timed out/i.test(msg);
}

/** The per-attempt backoff (read per attempt so tests can shrink it). */
export function lockContentionBackoffMs(): readonly number[] {
    return backoffMs;
}

/**
 * Run `write` up to LOCK_CONTENTION_ATTEMPTS times while it fails with lock
 * contention; any other error propagates at once. `label` names the write in
 * the warning.
 */
export async function withLockContentionRetry<T>(label: string, write: () => Promise<T>, warn: (msg: string) => void = defaultWarn): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < LOCK_CONTENTION_ATTEMPTS; attempt++) {
        if (backoffMs[attempt]) await sleep(backoffMs[attempt]);
        try {
            return await write();
        } catch (err) {
            if (!isLockContention(err)) throw err;
            lastErr = err;
            warn(`${label}: write lost the database lock (attempt ${attempt + 1}/${LOCK_CONTENTION_ATTEMPTS})`);
        }
    }
    throw lastErr;
}

function defaultWarn(msg: string): void {
    // Lazy require keeps this module usable without a booted CAP runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    try { require('@sap/cds').log('nightgate').warn(msg); } catch { /* no logger */ }
}

/** Test seam: shrink the backoff. */
export function __setLockContentionBackoffForTests(ms: readonly number[]): void {
    backoffMs = ms;
}
export function __resetLockContentionBackoffForTests(): void {
    backoffMs = DEFAULT_BACKOFF_MS;
}
