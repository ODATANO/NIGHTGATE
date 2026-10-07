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
    prewarm = { running: false, total: 0, warmed: 0, failed: 0, startedAt: null, finishedAt: null };
}

/** Progress of the sponsor pool prewarm. Readiness reports `warming` while `running` is true. */
export interface PrewarmState {
    running: boolean;
    total: number;
    warmed: number;
    failed: number;
    startedAt: string | null;
    finishedAt: string | null;
}

let prewarm: PrewarmState = { running: false, total: 0, warmed: 0, failed: 0, startedAt: null, finishedAt: null };

export function publishPrewarmState(state: PrewarmState): void {
    prewarm = { ...state };
}

export function readPrewarmState(): PrewarmState {
    return prewarm;
}
