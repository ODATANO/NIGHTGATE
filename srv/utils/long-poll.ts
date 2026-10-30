// SPDX-License-Identifier: Apache-2.0
import type { Request } from '@sap/cds';
import { setTimeout as sleep } from 'node:timers/promises';

/** Longest hold of a long-polling call, in ms. */
export const LONG_POLL_MAX_MS = 25_000;
const STEP_MS = 500;

/** The waiting calls of one kind. Past `max`, a new call answers at once. */
export interface WaiterPool { count: number; readonly max: number }

export const waiterPool = (max = 100): WaiterPool => ({ count: 0, max });

/** True once the HTTP client has gone away. An internal call has no client and never ends early. */
export function clientGone(req: Request): boolean {
    const res = req.http?.res;
    return Boolean(res && (res.closed || res.destroyed));
}

/** Re-reads every 500 ms until `done`, the time is up, or the client has gone. Past the pool's cap it returns `first` at once. */
export async function holdUntil<T>(req: Request, waitMs: number, pool: WaiterPool, first: T, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    let current = first;
    if (done(current) || pool.count >= pool.max) return current;
    const deadline = Date.now() + waitMs;
    pool.count++;
    try {
        while (!done(current) && Date.now() < deadline && !clientGone(req)) {
            await sleep(Math.min(STEP_MS, deadline - Date.now()));
            if (clientGone(req)) break;
            current = await read();
        }
    } finally {
        pool.count--;
    }
    return current;
}
