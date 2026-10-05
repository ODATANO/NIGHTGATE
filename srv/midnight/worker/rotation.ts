/**
 * Planned worker restart and shutdown.
 * Node never frees an imported module, so after loading many contract versions the worker
 * stops taking calls, saves and unloads its wallets, and the main thread starts a new one.
 */

// Must stay the first import. The worker modules import each other in a cycle,
// and config is read at load time.
import { configNumber } from '../../utils/config';
import { WORKER_ROTATING } from '../wallet-worker-protocol';
import { formatErr } from '../../utils/format-error';
import { parentPort } from 'node:worker_threads';
import { facades, log } from './context';
import { evict } from './facades';

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
export async function evictAllFacades(site: string): Promise<{ evicted: number; failed: number }> {
    const ids = [...facades.keys()];
    const results = await Promise.allSettled(ids.map(sessionId => evict({ sessionId, awaitSaveAck: true })));
    let failed = 0;
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            failed++;
            log('error', `${site}: eviction of ${ids[i].slice(0, 16)} failed: ${formatErr(r.reason)}`);
        } else if ((r.value as { saved?: boolean })?.saved === false) {
            failed++;
            log('error', `${site}: final state save of ${ids[i].slice(0, 16)} was NOT confirmed; up to one save interval of sync progress is redone on the next restore`);
        }
    });
    return { evicted: ids.length, failed };
}

/** Test seam: the dispatcher's admission decision. */
export function __admitRpcForTests(): boolean { return !rotationState.draining; }


/**
 * Saves and unloads every wallet so a shutdown loses no sync progress.
 * Each unload waits for its session lock, so a running submit completes first.
 */
export async function shutdown() {
    rotationState.draining = true;
    const { evicted, failed } = await evictAllFacades('shutdown');
    log(failed > 0 ? 'error' : 'info', `shutdown: ${evicted} facade(s) evicted, ${failed} without a confirmed final save`);
    return { evicted, failed };
}

export const rotationHandlers = { shutdown };
