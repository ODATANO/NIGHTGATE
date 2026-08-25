/**
 * The plugin's initialisation state, published by src/index.ts and read by
 * anything in srv/ that needs it (today: the readiness builder).
 *
 * It exists to avoid the obvious alternative. `src/index.ts` already holds
 * this state, but it also pulls in half of srv/ and, through it, the Midnight
 * SDK, so importing it from srv/ closes a cycle; requiring it lazily drags
 * that whole graph into any code path that merely wants to know whether
 * initialisation succeeded, with the side effects that come with it. A flat
 * holder costs nothing and points the dependency the way it already runs.
 */

export interface RuntimeState {
    initialized: boolean;
    /** 'idle' = never initialised, 'active' = up, 'offline' = it FAILED. */
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
}

let current: RuntimeState = { initialized: false, mode: 'idle' };

export function publishRuntimeState(state: RuntimeState): void {
    current = { initialized: state.initialized, mode: state.mode, lastError: state.lastError };
}

export function readRuntimeState(): RuntimeState {
    return current;
}

/** Test-only: back to the pristine never-initialised state. */
export function __resetRuntimeStateForTests(): void {
    current = { initialized: false, mode: 'idle' };
}
