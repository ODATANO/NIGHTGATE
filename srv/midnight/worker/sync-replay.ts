/**
 * Detects a restored sub-wallet whose offset lags its state: the ledger rejects every
 * replayed event, the SDK only prints it and retries forever. The printed rejection names
 * no wallet, so it is attributed via the facade's own offsets. No worker-module imports.
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

/** The sub-wallet kind whose replayed event the ledger rejected, searched through the cause chain; null for anything else. */
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

/** Record every replay rejection among one call's `console.error` arguments. */
export function noteConsoleErrorArgs(args: unknown[], now: number = Date.now()): void {
    for (const arg of args) {
        const hit = classifyReplayRejection(arg);
        if (hit) lastReplayRejection[hit.kind] = { at: now, message: hit.message };
    }
}

const TAPPED = Symbol.for('nightgate.replayRejectionTap');

/** Wrap `target.error` so replay rejections are recorded; the original still prints. Idempotent. */
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

/** A restored sub-wallet's offset over time: where it started, where it is, since when unchanged, whether it ever moved past the start. */
export interface ReplayTrack {
    startIndex: bigint;
    lastIndex: bigint;
    since: number;
    advanced: boolean;
}

export function observeReplayTrack(track: ReplayTrack | undefined, applied: bigint, now: number): ReplayTrack {
    // A lower reading right after start restarts the track: the offset the
    // stream resumes from is the lowest one the sub-wallet reports.
    if (!track || (!track.advanced && applied < track.startIndex)) {
        return { startIndex: applied, lastIndex: applied, since: now, advanced: false };
    }
    if (applied === track.lastIndex) return track;
    return { ...track, lastIndex: applied, since: now, advanced: track.advanced || applied > track.startIndex };
}

/** Replace the sub-wallet only when it is stuck at its restored offset while the stream tip lies beyond it. */
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

/** A sub-wallet's `appliedIndex` from a `facade.state()` emission; null when absent or unreadable. */
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
    /** The dust local state's synced time (ISO). */
    dustSyncTime: string | null;
    shieldedAppliedIndex: string | null;
    /** The shielded local state's next free commitment tree index. */
    shieldedFirstFree: string | null;
}

function readSafely<T>(read: () => T): T | null {
    try {
        return read() ?? null;
    } catch {
        return null;
    }
}

/** The offsets a snapshot resumes from next to the positions of the states it carries. Never throws. */
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
