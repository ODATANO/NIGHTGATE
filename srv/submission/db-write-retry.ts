/**
 * Retry a short database write that lost a lock.
 * Use it only for status updates, never for job work, which could then submit twice.
 * SPDX-License-Identifier: Apache-2.0
 */
import { errorMessage } from '../utils/errors';

export const LOCK_CONTENTION_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS: readonly number[] = [0, 500, 1500, 4000, 8000];
let backoffMs: readonly number[] = DEFAULT_BACKOFF_MS;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Serialization failure, deadlock, lock not available, statement/lock timeout cancel. */
const PG_RETRY_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);

export function isLockContention(err: unknown): boolean {
    const code = String((err as any)?.code ?? '');
    if (PG_RETRY_SQLSTATES.has(code) || code === 'SQLITE_BUSY') return true;
    const msg = errorMessage(err);
    return /database is locked|SQLITE_BUSY|could not serialize access|deadlock detected|lock timeout|canceling statement due to lock timeout|ResourceRequest timed out/i.test(msg);
}

export function lockContentionBackoffMs(): readonly number[] {
    return backoffMs;
}

/** Retries only on lock conflicts. Any other error is thrown at once. */
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
    // Required lazily, so this module also works without a running CAP server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    try { require('@sap/cds').log('nightgate').warn(msg); } catch { /* no logger */ }
}

export function __setLockContentionBackoffForTests(ms: readonly number[]): void {
    backoffMs = ms;
}
export function __resetLockContentionBackoffForTests(): void {
    backoffMs = DEFAULT_BACKOFF_MS;
}
