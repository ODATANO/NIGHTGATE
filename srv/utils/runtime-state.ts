// The startup state of NIGHTGATE. `src/index.ts` writes it and code in srv/ reads it.
// It is a separate module because importing `src/index.ts` from srv/ would create an import cycle and load the Midnight SDK.

export interface RuntimeState {
    initialized: boolean;
    /** 'idle': not started yet. 'active': running. 'offline': startup failed. */
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
    /** True when the crawler's start was the only thing that failed. Starting the crawler later then ends the offline state. */
    crawlerOnly?: boolean;
}

let current: RuntimeState = { initialized: false, mode: 'idle' };

export function publishRuntimeState(state: RuntimeState): void {
    current = { initialized: state.initialized, mode: state.mode, lastError: state.lastError, crawlerOnly: state.crawlerOnly === true };
}

/** Called once the crawler runs. Ends an offline state that only the crawler caused; any other startup failure stays. */
export function noteCrawlerRunning(): void {
    if (current.mode === 'offline' && current.crawlerOnly) current = { initialized: current.initialized, mode: 'active' };
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
