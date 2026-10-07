/**
 * Entry point of the dust verify worker thread, started by the wallet worker.
 * Restoring a collapsed dust state through the ledger wasm blocks the thread it runs on for
 * seconds and grows with the chain, so it runs here and never on the wallet thread.
 */

import { parentPort } from 'node:worker_threads';
import { createDispatcher, type WorkerRpcHandlers } from './worker-rpc/dispatch';
import { loadLedgerV8 } from './sdk-loader';
import { verifyCollapsedDust, type CollapsedDustExpectation, type CollapsedDustVerdict } from './worker/dust-collapse';

export interface VerifyCollapsedDustArgs {
    bytes: Uint8Array;
    expect: CollapsedDustExpectation;
}

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

/** The callable methods. The client in `worker/dust-verify.ts` has one typed wrapper per entry. */
export const handlers: WorkerRpcHandlers = {
    verifyCollapsedDust: async (args): Promise<CollapsedDustVerdict> => {
        const { bytes, expect } = args as VerifyCollapsedDustArgs;
        const ledger = await loadLedgerV8();
        return verifyCollapsedDust(bytes, expect, ledger.DustLocalState);
    }
};

if (!parentPort) {
    throw new Error('dust-verify-worker must be loaded as a worker_threads worker (no parentPort)');
}

const dispatch = createDispatcher(handlers, log);
parentPort.on('message', (msg: unknown) => { void dispatch(msg); });

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
