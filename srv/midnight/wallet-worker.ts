/**
 * Wallet worker thread entry.
 *
 * Lives in its OWN Node `worker_threads` worker so the Midnight wallet SDK's
 * Effect.ts Fiber scheduler (which monopolises the microtask queue while a
 * chain sync is running) only blocks THIS thread's event loop. The main
 * cds-serve thread stays responsive for OData requests and CAP DB writes.
 *
 * Communication: per-call `MessageChannel`. Main thread posts
 *   { kind: 'rpc', method, args, port: MessagePort }
 * and the worker replies on `port` with
 *   { ok: true, result } | { ok: false, error: string }
 *
 * Push events (worker → main, on `parentPort`):
 *   - { kind: 'state-save', sessionId, sdkVersion, blobs }
 *     emitted ~every 30 s while a facade is active so the main thread can
 *     persist via standard `cds.connect.to('db').run(...)`.
 *   - { kind: 'log', level, message }
 *     surfaces worker-side console.log/warn lines into the main thread's
 *     unified log stream.
 *
 * Surface: the RPC handler map (`handlers` in `worker/rpc.ts`) is the
 * authoritative method list; core ops are init / waitForSyncedState / evict,
 * token + dust ops (transferNight, getBalance, estimate fees, register/
 * deregister dust), and the contract path (deployContract,
 * submitContractCall(+Batch)). This file is the composition root: the thread
 * guard, the key ring hand-over and the parentPort wiring; every pure piece
 * lives under `worker/` and imports without a parentPort.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { setKeyRing } from '../utils/crypto';
import { log } from './worker/context';
import { handleMessage } from './worker/rpc';

// Re-exports for the tests and for the main-thread code that shares the
// worker's pure pieces (shape check, snapshots, providers).
export * from './worker/context';
export * from './worker/bounded-cache';
export * from './worker/artifacts';
export * from './worker/rotation';
export * from './worker/facades';
export * from './worker/submit';
export * from './worker/sponsor';
export * from './worker/tokens';
export * from './worker/contracts';
export * from './worker/private-state';
export { handlers, handleMessage } from './worker/rpc';

// ---- Thread entry --------------------------------------------------------

if (!parentPort) {
    throw new Error('wallet-worker must be loaded as a worker_threads worker (no parentPort)');
}
// Encryption key ring and the resolved configuration come from the main
// thread (workerData), never from the worker's env (`srv/utils/config.ts`
// pins the snapshot when it loads inside a worker).
if (workerData?.encryptionKeyRing) setKeyRing(workerData.encryptionKeyRing);

parentPort.on('message', (msg: any) => { void handleMessage(msg); });

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
