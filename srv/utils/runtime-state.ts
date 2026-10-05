/**
 * Holds the plugin's startup state. `src/index.ts` writes it, code in srv/ reads it.
 * It is a separate module because importing `src/index.ts` from srv/ would create an import cycle and load the Midnight SDK.
 */

export interface RuntimeState {
    initialized: boolean;
    /** 'idle': not started yet. 'active': running. 'offline': startup failed. */
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

export function __resetRuntimeStateForTests(): void {
    current = { initialized: false, mode: 'idle' };
}
