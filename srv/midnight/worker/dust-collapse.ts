// Shrinks the saved dust state. Its tree holds entries for other wallets' NIGHT UTXOs, which the ledger never shrinks.
// Only our own entries are needed to spend. Collapsed parts keep their hash, so the tree roots stay the same.
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '../../utils/errors';

export interface OwnGeneration {
    firstFree: bigint;
    /** The wallet's own NIGHT UTXOs (hex) and their position in the tree. */
    nightIndices: Map<string, bigint>;
}

/** Reads `generating_tree_first_free` and `night_indices` from `DustLocalState.toString(true)`. */
export function parseOwnGeneration(text: string): OwnGeneration | null {
    const ff = /generating_tree_first_free:\s*(\d+)/.exec(text);
    const at = text.indexOf('night_indices:');
    if (!ff || at < 0) return null;
    const end = text.indexOf('}', at);
    if (end < 0) return null;
    const nightIndices = new Map<string, bigint>();
    for (const m of text.slice(at, end).matchAll(/InitialNonce\(([0-9a-f]+)\):\s*(\d+)/g)) {
        nightIndices.set(m[1], BigInt(m[2]));
    }
    return { firstFree: BigInt(ff[1]), nightIndices };
}

/** Index ranges below `firstFree` that contain none of `keep`. Both ends are included. */
export function foreignRanges(keep: Iterable<bigint>, firstFree: bigint): Array<[bigint, bigint]> {
    const sorted = [...new Set(keep)].filter(i => i >= 0n && i < firstFree).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Array<[bigint, bigint]> = [];
    let next = 0n;
    for (const i of [...sorted, firstFree]) {
        if (i > next) out.push([next, i - 1n]);
        next = i + 1n;
    }
    return out;
}

/** Collapses every entry of other wallets. Throws when one of our dust UTXOs has no entry, because collapsing it would crash the ledger wasm later. */
export function collapseForeignGeneration(state: any): { state: any; ranges: number; ownLeaves: number } {
    const own = parseOwnGeneration(state.toString(true));
    if (!own) throw new Error('dust state string form has no generating_tree_first_free / night_indices');
    for (const utxo of state.utxos as any[]) {
        const night = String(utxo.backingNight).replace(/^0x/, '').toLowerCase();
        if (!own.nightIndices.has(night)) throw new Error(`own dust UTXO backing night ${night.slice(0, 16)} missing from night_indices`);
    }
    const ranges = foreignRanges(own.nightIndices.values(), own.firstFree);
    let out = state;
    for (const [lo, hi] of ranges) out = out.collapseGenerationTree(lo, hi);
    return { state: out, ranges: ranges.length, ownLeaves: own.nightIndices.size };
}

/** What a restore of the collapsed bytes must reproduce. Plain values, so they cross a thread boundary. */
export interface CollapsedDustExpectation {
    generatingTreeRoot: string;
    commitmentTreeRoot: string;
    /** Dust balance at `syncTimeMs`, decimal. */
    balance: string;
    utxoCount: number;
    syncTimeMs: number;
}

export interface CollapsedDust {
    /** The SDK snapshot as saved today, with the full dust state. */
    fullBlob: string;
    fullBytes: number;
    /** The collapsed ledger state. */
    bytes: Uint8Array;
    expect: CollapsedDustExpectation;
    ranges: number;
    ownLeaves: number;
}

/** Collapses an SDK dust wallet state and records what a restore must reproduce. On a throw the caller saves `walletState.serialize()`. */
export function collapseDustState(walletState: any): CollapsedDust {
    const fullBlob: string = walletState.serialize();
    const snapshot = JSON.parse(fullBlob);
    const fullBytes = typeof snapshot.state === 'string' ? snapshot.state.length / 2 : 0;
    const full = walletState.state.state;
    const { state, ranges, ownLeaves } = collapseForeignGeneration(full);
    const bytes: Uint8Array = state.serialize();
    const at: Date = full.syncTime;
    return {
        fullBlob,
        fullBytes,
        bytes,
        ranges,
        ownLeaves,
        expect: {
            generatingTreeRoot: String(full.generatingTreeRoot()),
            commitmentTreeRoot: String(full.commitmentTreeRoot()),
            balance: String(full.walletBalance(at)),
            utxoCount: full.utxos.length,
            syncTimeMs: at.getTime()
        }
    };
}

export type CollapsedDustVerdict = { ok: true } | { ok: false; reason: string };

/** Restores the collapsed bytes and compares roots, balance and UTXO count with the full state's. */
export function verifyCollapsedDust(bytes: Uint8Array, expect: CollapsedDustExpectation, DustLocalState: any): CollapsedDustVerdict {
    try {
        const back = DustLocalState.deserialize(bytes);
        const same = String(back.generatingTreeRoot()) === expect.generatingTreeRoot
            && String(back.commitmentTreeRoot()) === expect.commitmentTreeRoot
            && String(back.walletBalance(new Date(expect.syncTimeMs))) === expect.balance
            && back.utxos.length === expect.utxoCount;
        if (!same) return { ok: false, reason: 'collapsed state does not restore to the same roots, balance and UTXOs' };
        return { ok: true };
    } catch (err: unknown) {
        return { ok: false, reason: errorMessage(err) };
    }
}

/** The SDK snapshot with its `state` replaced by the collapsed bytes. Every other field stays. */
export function collapsedDustBlob(fullBlob: string, bytes: Uint8Array): string {
    const snapshot = JSON.parse(fullBlob);
    snapshot.state = Buffer.from(bytes).toString('hex');
    return JSON.stringify(snapshot);
}

/** Changes with every applied ledger event and spend, so an equal key means the saved dust state is current. Null when the figures are missing. */
export function dustSaveKey(walletState: any): string | null {
    const applied = walletState?.progress?.appliedIndex ?? walletState?.state?.progress?.appliedIndex;
    if (applied == null) return null;
    const count = (coins: unknown): string => (Array.isArray(coins) ? String(coins.length) : '-');
    return `${applied}:${count(walletState?.totalCoins)}:${count(walletState?.pendingCoins)}`;
}
