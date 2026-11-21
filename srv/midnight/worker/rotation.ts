// Planned worker restart and shutdown. Node never frees an imported module, so after many contract versions
// the worker stops taking calls, saves and unloads its wallets, and the main thread starts a new one.

// Must stay the first import. The worker modules import each other in a cycle,
// and config is read at load time.
import { configNumber } from '../../utils/config';
import { errorMessage } from '../../utils/errors';
import { WORKER_ROTATING } from '../wallet-worker-protocol';

import { parentPort } from 'node:worker_threads';
import { facades, log } from './context';
import { evict } from './facades';
import { setTimeout as sleep } from 'node:timers/promises';

export const importedGenerations = new Set<string>();
/** One shared object, so the dispatcher in another module can update it. */
export const rotationState = { pending: false, draining: false, inflight: 0, finalizing: false };
export { WORKER_ROTATING };

export function maxGenerationsBeforeRotation(): number {
    return configNumber('NIGHTGATE_WORKER_MAX_GENERATIONS');
}

/** Records a loaded contract version. Returns true once a restart is due. */
export function noteGenerationImported(digest: string): boolean {
    if (!digest) return rotationState.pending;
    importedGenerations.add(digest);
    const max = maxGenerationsBeforeRotation();
    if (max > 0 && importedGenerations.size >= max && !rotationState.pending) {
        rotationState.pending = true;
        log('warn', `worker imported ${importedGenerations.size} distinct artifact generations (NIGHTGATE_WORKER_MAX_GENERATIONS=${max}); rotating at the next idle moment to release Node's module cache`);
    }
    return rotationState.pending;
}

/** Test seam. */
export function __rotationStateForTests(): { generations: number; pending: boolean; draining: boolean; inflight: number } {
    return { generations: importedGenerations.size, pending: rotationState.pending, draining: rotationState.draining, inflight: rotationState.inflight };
}
export function __resetRotationForTests(): void {
    importedGenerations.clear(); rotationState.pending = false; rotationState.draining = false; rotationState.inflight = 0; rotationState.finalizing = false;
}

/**
 * Stops taking new calls and finishes once no call is running. A call already accepted always completes.
 */
export function rotateIfDue(): void {
    if (!rotationState.pending) return;
    if (!rotationState.draining) {
        rotationState.draining = true;
        parentPort?.postMessage({ kind: 'rotating', generations: importedGenerations.size, inflight: rotationState.inflight });
        log('info', `worker rotating after ${importedGenerations.size} artifact generations: admission closed, ${rotationState.inflight} call(s) draining; the main thread respawns it`);
    }
    if (rotationState.inflight > 0 || rotationState.finalizing) return;
    rotationState.finalizing = true;
    void (async () => {
        const { evicted, failed } = await evictAllFacades('rotation');
        parentPort?.postMessage({ kind: 'rotation-done', generations: importedGenerations.size, evicted, failed });
        log('info', `worker rotation drained: ${evicted} facade(s) saved and evicted (${failed} failed), asking the main thread to terminate this thread`);
    })();
}

/** Unloads every wallet after a final save. An unconfirmed save is counted as failed, but the wallet is still unloaded. */
export async function evictAllFacades(site: string, deadline?: number): Promise<{ evicted: number; failed: number }> {
    const ids = [...facades.keys()];
    const results = await Promise.allSettled(ids.map(sessionId => evict({ sessionId, awaitSaveAck: true, deadline })));
    let failed = 0;
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            failed++;
            log('error', `${site}: eviction of ${ids[i].slice(0, 16)} failed: ${errorMessage(r.reason)}`);
        } else if ((r.value as { saved?: boolean })?.saved === false) {
            failed++;
            log('error', `${site}: final state save of ${ids[i].slice(0, 16)} was NOT confirmed; up to one save interval of sync progress is redone on the next restore`);
        }
    });
    return { evicted: ids.length, failed };
}

/** Test seam: the dispatcher's admission decision. */
export function __admitRpcForTests(): boolean { return !rotationState.draining; }

/** Longest wait for running submits at shutdown. */
const SHUTDOWN_DRAIN_MS = 40_000;
/** Time of the budget kept for the final saves. */
const SHUTDOWN_SAVE_MS = 15_000;

/** Saves and unloads every wallet so a shutdown loses no sync progress. Sending calls get time to finish first.
 *  `budgetMs` is how long the main thread waits before it ends this thread. The drain and the saves share it. */
export async function shutdown({ budgetMs }: { budgetMs?: number } = {}) {
    rotationState.draining = true;
    const startedAt = Date.now();
    const deadline = budgetMs && budgetMs > 0 ? startedAt + budgetMs : undefined;
    const drainUntil = Math.min(startedAt + SHUTDOWN_DRAIN_MS, deadline === undefined ? Infinity : deadline - SHUTDOWN_SAVE_MS);
    while (rotationState.inflight > 0 && Date.now() < drainUntil) await sleep(100);
    if (rotationState.inflight > 0) log('warn', `shutdown: ${rotationState.inflight} submitting call(s) still running after ${Date.now() - startedAt} ms; saving the wallets anyway`);
    const { evicted, failed } = await evictAllFacades('shutdown', deadline);
    log(failed > 0 ? 'error' : 'info', `shutdown: ${evicted} facade(s) evicted, ${failed} without a confirmed final save`);
    return { evicted, failed };
}

export const rotationHandlers = { shutdown };
