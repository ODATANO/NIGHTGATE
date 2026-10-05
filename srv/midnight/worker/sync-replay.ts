/**
 * Detects a restored wallet part (dust or shielded) whose saved position is behind its saved state.
 * The ledger then rejects every event it replays, and the SDK only prints the error and retries forever.
 * The printed error names no wallet, so the wallet is found by watching which one stops moving.
 */

export type ReplayKind = 'dust' | 'shielded';

const REJECTION_SIGNATURES: ReadonlyArray<readonly [ReplayKind, RegExp]> = [
    ['dust', /received an event with a timestamp prior to the time already synced to/],
    ['dust', /inserted non-linearly into dust commitment tree/],
    ['shielded', /inserted non-linearly into zswap commitment tree/]
];

export interface ReplayRejection {
    at: number;
    message: string;
}

/** Last ledger replay rejection seen in this thread, per sub-wallet kind. */
export const lastReplayRejection: Partial<Record<ReplayKind, ReplayRejection>> = {};

/** Which wallet part a replay error belongs to, or null when it is no replay error. */
export function classifyReplayRejection(value: unknown): { kind: ReplayKind; message: string } | null {
    let current: any = value;
    for (let depth = 0; depth < 6 && current != null; depth++) {
        const message = typeof current === 'string'
            ? current
            : (typeof current.message === 'string' ? current.message : '');
        for (const [kind, pattern] of REJECTION_SIGNATURES) {
            if (pattern.test(message)) return { kind, message: message.slice(0, 300) };
        }
        current = typeof current === 'object' ? current.cause : undefined;
    }
    return null;
}

export function noteConsoleErrorArgs(args: unknown[], now: number = Date.now()): void {
    for (const arg of args) {
        const hit = classifyReplayRejection(arg);
        if (hit) lastReplayRejection[hit.kind] = { at: now, message: hit.message };
    }
}

const TAPPED = Symbol.for('nightgate.replayRejectionTap');

/** Wraps `console.error` to record replay errors. The original still prints. */
export function installReplayRejectionTap(target: { error: (...args: any[]) => void } = console): void {
    if ((target.error as any)[TAPPED]) return;
    const original = target.error;
    const tapped = (...args: any[]) => {
        try { noteConsoleErrorArgs(args); } catch { /* recording never breaks the log line */ }
        return original.apply(target, args);
    };
    (tapped as any)[TAPPED] = true;
    target.error = tapped;
}

/** How a restored wallet part's position changes over time. */
export interface ReplayTrack {
    startIndex: bigint;
    lastIndex: bigint;
    since: number;
    advanced: boolean;
}

export function observeReplayTrack(track: ReplayTrack | undefined, applied: bigint, now: number): ReplayTrack {
    // Before any progress, a lower value replaces the start, because the
    // sync resumes from the lowest position the wallet reports.
    if (!track || (!track.advanced && applied < track.startIndex)) {
        return { startIndex: applied, lastIndex: applied, since: now, advanced: false };
    }
    if (applied === track.lastIndex) return track;
    return { ...track, lastIndex: applied, since: now, advanced: track.advanced || applied > track.startIndex };
}

/** True only when the part is stuck at its restored position while the chain is clearly ahead. */
export function shouldResetRestoredSubWallet(input: {
    track: ReplayTrack | undefined;
    streamTip: bigint | null;
    rejection: ReplayRejection | undefined;
    now: number;
    windowMs: number;
    tipGap: bigint;
}): boolean {
    const { track, streamTip, rejection, now, windowMs, tipGap } = input;
    if (windowMs <= 0 || !track || track.advanced || !rejection) return false;
    if (now - rejection.at > windowMs) return false;
    if (now - track.since < windowMs) return false;
    return streamTip != null && streamTip > track.startIndex + tipGap;
}

/** A wallet part's `appliedIndex`, or null when it cannot be read. */
export function appliedIndexOf(state: any, kind: ReplayKind): bigint | null {
    try {
        const progress = state?.[kind]?.progress ?? state?.[kind]?.state?.progress;
        const value = progress?.appliedIndex;
        return value == null ? null : BigInt(value);
    } catch {
        return null;
    }
}

export interface SyncStateDescription {
    dustAppliedIndex: string | null;
    dustSyncTime: string | null;
    shieldedAppliedIndex: string | null;
    /** The next free index in the shielded commitment tree. */
    shieldedFirstFree: string | null;
}

function readSafely<T>(read: () => T): T | null {
    try {
        return read() ?? null;
    } catch {
        return null;
    }
}

/** The positions a saved state resumes from, for logging. Never throws. */
export function describeSyncState(state: any): SyncStateDescription {
    const syncTime = readSafely(() => state?.dust?.state?.state?.syncTime);
    const firstFree = readSafely(() => state?.shielded?.state?.state?.firstFree);
    const dustApplied = appliedIndexOf(state, 'dust');
    const shieldedApplied = appliedIndexOf(state, 'shielded');
    return {
        dustAppliedIndex: dustApplied != null ? dustApplied.toString() : null,
        dustSyncTime: syncTime instanceof Date && !Number.isNaN(syncTime.getTime()) ? syncTime.toISOString() : null,
        shieldedAppliedIndex: shieldedApplied != null ? shieldedApplied.toString() : null,
        shieldedFirstFree: firstFree != null ? String(firstFree) : null
    };
}

export function formatSyncState(d: SyncStateDescription): string {
    return `dust appliedIndex=${d.dustAppliedIndex ?? '?'} syncTime=${d.dustSyncTime ?? '?'} shielded appliedIndex=${d.shieldedAppliedIndex ?? '?'} firstFree=${d.shieldedFirstFree ?? '?'}`;
}
