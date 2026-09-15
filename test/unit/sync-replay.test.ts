import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    classifyReplayRejection,
    noteConsoleErrorArgs,
    lastReplayRejection,
    installReplayRejectionTap,
    observeReplayTrack,
    shouldResetRestoredSubWallet,
    appliedIndexOf,
    describeSyncState,
    formatSyncState
} from '../../srv/midnight/worker/sync-replay';

// The two ledger rejections as the wallet SDK prints them: its own wrapper
// with the ledger error as the cause.
function sdkApplyError(cause: string): Error {
    const err = new Error('Error while applying sync update');
    (err as any)._tag = 'Wallet.Other';
    (err as any).cause = new Error(cause);
    return err;
}
const DUST_CAUSE = 'received an event with a timestamp prior to the time already synced to (synced to: Timestamp(1789396236), event time: Timestamp(1789394442))';
const SHIELDED_CAUSE = 'values inserted non-linearly into zswap commitment tree; expected to insert index 21424, but received 21420.';

beforeEach(() => {
    delete lastReplayRejection.dust;
    delete lastReplayRejection.shielded;
});

describe('classifyReplayRejection', () => {
    it('recognises the dust rejection through the SDK wrapper', () => {
        expect(classifyReplayRejection(sdkApplyError(DUST_CAUSE))).toEqual({ kind: 'dust', message: DUST_CAUSE });
    });

    it('recognises the dust tree-index rejection', () => {
        const cause = 'values inserted non-linearly into dust commitment tree; expected to insert index 1128516, but received 1128496.';
        expect(classifyReplayRejection(sdkApplyError(cause))).toEqual({ kind: 'dust', message: cause });
    });

    it('recognises the shielded rejection through the SDK wrapper', () => {
        expect(classifyReplayRejection(sdkApplyError(SHIELDED_CAUSE))?.kind).toBe('shielded');
    });

    it('reads a plain string and a deeper cause chain', () => {
        expect(classifyReplayRejection(DUST_CAUSE)?.kind).toBe('dust');
        const outer = new Error('stream failed');
        (outer as any).cause = sdkApplyError(SHIELDED_CAUSE);
        expect(classifyReplayRejection(outer)?.kind).toBe('shielded');
    });

    it('ignores every other error', () => {
        expect(classifyReplayRejection(sdkApplyError('Wallet.Sync: [object CloseEvent]'))).toBeNull();
        expect(classifyReplayRejection(new Error('Error while applying sync update'))).toBeNull();
        expect(classifyReplayRejection(undefined)).toBeNull();
        expect(classifyReplayRejection({ message: 42 })).toBeNull();
    });
});

describe('noteConsoleErrorArgs / installReplayRejectionTap', () => {
    it('records the time of the last rejection per kind and nothing else', () => {
        noteConsoleErrorArgs(['Error processing tx history metadata', sdkApplyError(DUST_CAUSE)], 1000);
        expect(lastReplayRejection.dust).toEqual({ at: 1000, message: DUST_CAUSE });
        expect(lastReplayRejection.shielded).toBeUndefined();
    });

    it('records through the tap and still prints the line, wrapping only once', () => {
        const print = vi.fn();
        const target = { error: print as (...args: any[]) => void };
        installReplayRejectionTap(target);
        installReplayRejectionTap(target);
        const err = sdkApplyError(SHIELDED_CAUSE);
        target.error(err);
        expect(print).toHaveBeenCalledTimes(1);
        expect(print).toHaveBeenCalledWith(err);
        expect(lastReplayRejection.shielded?.message).toBe(SHIELDED_CAUSE);
    });
});

describe('observeReplayTrack', () => {
    it('starts at the first reading and keeps the start time while the offset stands still', () => {
        const first = observeReplayTrack(undefined, 10n, 1000);
        expect(first).toEqual({ startIndex: 10n, lastIndex: 10n, since: 1000, advanced: false });
        expect(observeReplayTrack(first, 10n, 5000)).toBe(first);
    });

    it('marks a sub-wallet that moved past its start as advanced, for good', () => {
        const moved = observeReplayTrack(observeReplayTrack(undefined, 10n, 1000), 11n, 2000);
        expect(moved).toMatchObject({ advanced: true, lastIndex: 11n, since: 2000 });
        expect(observeReplayTrack(moved, 9n, 3000).advanced).toBe(true);
    });

    it('restarts on a lower reading before it ever advanced', () => {
        const lower = observeReplayTrack(observeReplayTrack(undefined, 10n, 1000), 4n, 2000);
        expect(lower).toEqual({ startIndex: 4n, lastIndex: 4n, since: 2000, advanced: false });
    });
});

describe('shouldResetRestoredSubWallet', () => {
    const stuck = { startIndex: 10n, lastIndex: 10n, since: 0, advanced: false };
    const base = { track: stuck, streamTip: 100n, rejection: { at: 50_000, message: DUST_CAUSE }, now: 60_000, windowMs: 60_000, tipGap: 8n };

    it('replaces a sub-wallet stuck for the window with a recent rejection and events beyond it', () => {
        expect(shouldResetRestoredSubWallet(base)).toBe(true);
    });

    it('keeps it in every other case', () => {
        expect(shouldResetRestoredSubWallet({ ...base, windowMs: 0 })).toBe(false);
        expect(shouldResetRestoredSubWallet({ ...base, track: undefined })).toBe(false);
        expect(shouldResetRestoredSubWallet({ ...base, track: { ...stuck, advanced: true } })).toBe(false);
        expect(shouldResetRestoredSubWallet({ ...base, rejection: undefined })).toBe(false);
        // the last rejection is older than the window
        expect(shouldResetRestoredSubWallet({ ...base, now: 200_000, track: { ...stuck, since: 100_000 } })).toBe(false);
        // stuck for less than the window
        expect(shouldResetRestoredSubWallet({ ...base, track: { ...stuck, since: 30_000 } })).toBe(false);
        // nothing to apply beyond the offset
        expect(shouldResetRestoredSubWallet({ ...base, streamTip: 18n })).toBe(false);
        expect(shouldResetRestoredSubWallet({ ...base, streamTip: null })).toBe(false);
    });
});

describe('appliedIndexOf / describeSyncState', () => {
    it('reads the offset from the wallet wrapper and from its core state', () => {
        expect(appliedIndexOf({ dust: { progress: { appliedIndex: 7n } } }, 'dust')).toBe(7n);
        expect(appliedIndexOf({ shielded: { state: { progress: { appliedIndex: '9' } } } }, 'shielded')).toBe(9n);
        expect(appliedIndexOf({}, 'dust')).toBeNull();
        expect(appliedIndexOf({ dust: { progress: { appliedIndex: 'x' } } }, 'dust')).toBeNull();
    });

    it('describes offsets next to the synced time and tree index, never throwing', () => {
        const state = {
            dust: { progress: { appliedIndex: 1520690n }, state: { state: { syncTime: new Date('2026-09-14T14:30:36Z') } } },
            shielded: { progress: { appliedIndex: 21420n }, state: { state: { firstFree: 21424n } } }
        };
        const d = describeSyncState(state);
        expect(d).toEqual({
            dustAppliedIndex: '1520690',
            dustSyncTime: '2026-09-14T14:30:36.000Z',
            shieldedAppliedIndex: '21420',
            shieldedFirstFree: '21424'
        });
        expect(formatSyncState(d)).toBe('dust appliedIndex=1520690 syncTime=2026-09-14T14:30:36.000Z shielded appliedIndex=21420 firstFree=21424');

        const throwing = { dust: { state: { get state() { throw new Error('wasm freed'); } } } };
        expect(describeSyncState(throwing)).toEqual({ dustAppliedIndex: null, dustSyncTime: null, shieldedAppliedIndex: null, shieldedFirstFree: null });
    });
});
