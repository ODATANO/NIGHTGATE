/**
 * Dust snapshot without foreign generation leaves. The ledger re-expands a foreign leaf on
 * every dtime update and never collapses it again, so the snapshot and its restore time grow
 * with the chain. Only leaves behind `night_indices` (the wallet's own backing nights) are
 * needed to spend; collapsed subtrees keep their hash, so roots and spend paths are unchanged.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OwnGeneration {
    firstFree: bigint;
    /** Backing night (hex) -> generation index. */
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

/** Inclusive index ranges in [0, firstFree) that hold none of `keep`. */
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

/**
 * Collapses every foreign leaf. Throws when an own UTXO's backing night is not in the parsed
 * `night_indices`: collapsing its leaf would make `generationInfo` panic inside the wasm.
 */
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

/**
 * The SDK snapshot of `walletState` (a DustWalletState) with its dust state collapsed, or the
 * SDK snapshot unchanged when the collapsed state does not restore to the same roots, balance
 * and UTXOs. Blob, state and offset all come from the one `walletState`.
 */
export function collapsedDustSnapshot(walletState: any, DustLocalState: any): { blob: string; collapsed: boolean; fullBytes: number; bytes: number; reason?: string } {
    const blob: string = walletState.serialize();
    const snapshot = JSON.parse(blob);
    const fullBytes = typeof snapshot.state === 'string' ? snapshot.state.length / 2 : 0;
    try {
        const full = walletState.state.state;
        const { state } = collapseForeignGeneration(full);
        const bytes: Uint8Array = state.serialize();
        const back = DustLocalState.deserialize(bytes);
        const at = full.syncTime;
        const same = String(back.generatingTreeRoot()) === String(full.generatingTreeRoot())
            && String(back.commitmentTreeRoot()) === String(full.commitmentTreeRoot())
            && back.walletBalance(at) === full.walletBalance(at)
            && back.utxos.length === full.utxos.length;
        if (!same) return { blob, collapsed: false, fullBytes, bytes: fullBytes, reason: 'collapsed state does not restore to the same roots, balance and UTXOs' };
        snapshot.state = Buffer.from(bytes).toString('hex');
        return { blob: JSON.stringify(snapshot), collapsed: true, fullBytes, bytes: bytes.length };
    } catch (err: any) {
        return { blob, collapsed: false, fullBytes, bytes: fullBytes, reason: String(err?.message ?? err) };
    }
}
