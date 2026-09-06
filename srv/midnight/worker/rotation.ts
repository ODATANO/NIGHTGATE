/**
 * Worker rotation and shutdown: admission drain after the generation budget,
 * evict-all with acked final saves, the rotation-done handshake.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
import { configNumber } from '../../utils/config';
import { WORKER_ROTATING } from '../wallet-worker-protocol';
import { formatErr } from '../../utils/format-error';
import { parentPort } from 'node:worker_threads';
import { facades, log } from './context';
import { evict } from './facades';

// ---- Worker rotation ---------------------------------------------------------

/**
 * Node's ESM module cache keeps every imported generation for the life of the thread.
 * After NIGHTGATE_WORKER_MAX_GENERATIONS (default 32, 0 = never) distinct generations the
 * worker exits at the next idle moment (no RPC in flight, so no session lock held and no
 * proof running); the main thread respawns it and counts a rotation, not a crash.
 * A rotation makes the facade set cold (a large dust snapshot deserialises for minutes).
 */
export const importedGenerations = new Set<string>();
/**
 * Rotation state, one object so the dispatcher can account in-flight submits
 * from its own module. `draining`: admission closed, in-flight RPCs drain, new
 * ones are refused with WORKER_ROTATING and retried by the client.
 */
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
 * Runs on every RPC completion (success or failure) and when a rotation becomes due:
 * close admission first (the main thread holds new calls until the respawn), then exit
 * once nothing is in flight. An admitted proof or submission always completes.
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
    // Every facade gets its final, acked save first: a rotation used to lose
    // up to one save interval per facade, exactly like an unflushed stop.
    // Then the MAIN thread terminates this worker on `rotation-done`: every
    // reply posted before this message is delivered first, whereas a
    // process.exit() from in here could drop a reply still in a port queue.
    void (async () => {
        const { evicted, failed } = await evictAllFacades('rotation');
        parentPort?.postMessage({ kind: 'rotation-done', generations: importedGenerations.size, evicted, failed });
        log('info', `worker rotation drained: ${evicted} facade(s) saved and evicted (${failed} failed), asking the main thread to terminate this thread`);
    })();
}

/**
 * Evict every facade with an acked final save (shutdown, rotation). A save
 * that did not confirm is reported per session at error level and counted;
 * the eviction itself still proceeds (the thread is going away).
 */
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
 * Process shutdown: close admission, then evict EVERY facade (final save,
 * acked by the main thread's sink, keys zeroed, facade stopped). The main
 * thread terminates this worker after the reply; without this call a
 * SIGTERM lost up to one save interval of sync and dust progress per
 * facade. Evictions run in parallel; each waits for its own session lock,
 * so an in-flight submit on a session completes before its keys go.
 */
export async function shutdown() {
    rotationState.draining = true;
    const { evicted, failed } = await evictAllFacades('shutdown');
    log(failed > 0 ? 'error' : 'info', `shutdown: ${evicted} facade(s) evicted, ${failed} without a confirmed final save`);
    return { evicted, failed };
}

export const rotationHandlers = { shutdown };
