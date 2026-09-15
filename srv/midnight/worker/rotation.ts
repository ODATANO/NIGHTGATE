/** Worker rotation and shutdown: admission drain, evict-all with acked final saves. */

// First import on purpose: the worker modules import each other in cycles and
// a module-level read must resolve before the cycle re-enters.
import { configNumber } from '../../utils/config';
import { WORKER_ROTATING } from '../wallet-worker-protocol';
import { formatErr } from '../../utils/format-error';
import { parentPort } from 'node:worker_threads';
import { facades, log } from './context';
import { evict } from './facades';

/**
 * Node's ESM cache keeps every imported generation for the thread's life, so
 * after NIGHTGATE_WORKER_MAX_GENERATIONS the worker exits when idle and is respawned.
 */
export const importedGenerations = new Set<string>();
/** One object so the dispatcher can count in-flight RPCs from its own module. */
export const rotationState = { pending: false, draining: false, inflight: 0, finalizing: false };
export { WORKER_ROTATING };

export function maxGenerationsBeforeRotation(): number {
    return configNumber('NIGHTGATE_WORKER_MAX_GENERATIONS');
}

/** Records an imported generation; returns true once a rotation is due. */
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
 * Runs on every RPC completion and when a rotation becomes due: close admission
 * first, exit once nothing is in flight. An admitted call always completes.
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

/** Evict every facade with an acked final save; an unconfirmed save is counted, the eviction still proceeds. */
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
 * Process shutdown: close admission, evict every facade (else a SIGTERM loses a
 * save interval). Each eviction waits for its session lock, so an in-flight submit completes.
 */
export async function shutdown() {
    rotationState.draining = true;
    const { evicted, failed } = await evictAllFacades('shutdown');
    log(failed > 0 ? 'error' : 'info', `shutdown: ${evicted} facade(s) evicted, ${failed} without a confirmed final save`);
    return { evicted, failed };
}

export const rotationHandlers = { shutdown };
