/**
 * Wallet worker thread entry. The SDK's Effect scheduler monopolises the
 * microtask queue during a sync, so it runs here, off the cds-serve thread.
 * Composition root only; the pieces live under `worker/` (methods: worker/rpc.ts).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { setKeyRing } from '../utils/crypto';
import { log } from './worker/context';
import { handleMessage } from './worker/rpc';
import { installReplayRejectionTap } from './worker/sync-replay';

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
export * from './worker/sync-replay';
export { handlers, handleMessage } from './worker/rpc';

if (!parentPort) {
    throw new Error('wallet-worker must be loaded as a worker_threads worker (no parentPort)');
}
// Key ring and config come from the main thread (workerData), never the worker's env.
if (workerData?.encryptionKeyRing) setKeyRing(workerData.encryptionKeyRing);
// The SDK only prints a rejected sync apply; checkSnapshotReplay needs it recorded.
installReplayRejectionTap();

parentPort.on('message', (msg: any) => { void handleMessage(msg); });

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
