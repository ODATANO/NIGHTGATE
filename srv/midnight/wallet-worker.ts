/**
 * Entry point of the wallet worker thread.
 * A wallet sync keeps the SDK busy for long stretches, so it runs here and not on the server thread.
 * The worker's code lives in `worker/`. The callable methods are in `worker/rpc.ts`.
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
// The encryption keys come from the main thread, never from the worker's environment.
if (workerData?.encryptionKeyRing) setKeyRing(workerData.encryptionKeyRing);
// The SDK only prints a failed sync update. checkSnapshotReplay needs it recorded.
installReplayRejectionTap();

parentPort.on('message', (msg: any) => { void handleMessage(msg); });

parentPort.postMessage({ kind: 'ready' });
log('info', 'ready');
