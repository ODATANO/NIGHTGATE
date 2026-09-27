/**
 * Caller cancellation of a worker RPC: the client posts `cancel` on the reply port when
 * its timeout fires, and the call's own wait points stop there. Never past the submit
 * intent (a broadcast may follow), and never inside work other calls share.
 * SPDX-License-Identifier: Apache-2.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RpcScope { method: string; signal: AbortSignal; announced: boolean }

const scope = new AsyncLocalStorage<RpcScope>();

export class RpcCancelledError extends Error {
    constructor(method: string, where: string) {
        super(`${method} cancelled by the caller at ${where}; nothing was broadcast`);
        this.name = 'RpcCancelledError';
    }
}

export function runInRpcScope<T>(method: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    return scope.run({ method, signal, announced: false }, fn);
}

/** From the submit intent on, the call runs to its end. */
export function markIntentAnnounced(): void {
    const s = scope.getStore();
    if (s) s.announced = true;
}

export function throwIfRpcCancelled(where: string): void {
    const s = scope.getStore();
    if (s && !s.announced && s.signal.aborted) throw new RpcCancelledError(s.method, where);
}

/** Rejects once the caller cancels (not after the intent); race it against a wait, then `dispose`. */
export function rpcCancellation(where: string): { promise: Promise<never>; dispose: () => void } {
    const s = scope.getStore();
    if (!s) return { promise: new Promise<never>(() => undefined), dispose: () => undefined };
    let onAbort: () => void = () => undefined;
    const promise = new Promise<never>((_, reject) => {
        onAbort = () => { if (!s.announced) reject(new RpcCancelledError(s.method, where)); };
        if (s.signal.aborted) onAbort();
        else s.signal.addEventListener('abort', onAbort, { once: true });
    });
    promise.catch(() => undefined);
    return { promise, dispose: () => s.signal.removeEventListener('abort', onAbort) };
}
