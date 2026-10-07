import { describe, it, expect } from 'vitest';
import { parseOwnGeneration, foreignRanges, collapseForeignGeneration, collapseDustState, verifyCollapsedDust, collapsedDustBlob, dustSaveKey } from '../../srv/midnight/worker/dust-collapse';

const A = 'a8ccef598a65df79c2546a61c85a52c1ec0684a0195858e9149dec6446ece151';
const B = '22ad1012c2dae2d5ce3f901b53bc292aaf85c5856fcf8a0ca515e9d474b55ce3';

function stateText(firstFree: number, indices: Array<[string, number]>): string {
    const map = indices.map(([n, i]) => `InitialNonce(${n}): ${i}`).join(', ');
    return `DustLocalState { generating_tree: <tree>, generating_tree_first_free: ${firstFree}, commitment_tree: <tree>, night_indices: {${map}}, dust_utxos: {} }`;
}

/** Records collapses; roots and balance stay fixed unless `breakRoot` is set. */
function fakeState(opts: { firstFree: number; indices: Array<[string, number]>; utxoNights: string[]; collapsed?: Array<[bigint, bigint]>; breakRoot?: boolean }): any {
    const collapsed = opts.collapsed ?? [];
    return {
        collapsed,
        utxos: opts.utxoNights.map(n => ({ backingNight: n })),
        syncTime: new Date('2026-09-17T07:23:48Z'),
        toString: () => stateText(opts.firstFree, opts.indices),
        collapseGenerationTree: (lo: bigint, hi: bigint) => fakeState({ ...opts, collapsed: [...collapsed, [lo, hi]] }),
        serialize: () => new Uint8Array([collapsed.length, opts.breakRoot ? 1 : 0]),
        generatingTreeRoot: () => 7n,
        commitmentTreeRoot: () => 9n,
        walletBalance: () => 5n
    };
}

const FakeDustLocalState = {
    deserialize: (bytes: Uint8Array) => ({
        utxos: [{}, {}].slice(0, 2),
        generatingTreeRoot: () => (bytes[1] ? 8n : 7n),
        commitmentTreeRoot: () => 9n,
        walletBalance: () => 5n
    })
};

describe('parseOwnGeneration', () => {
    it('reads first_free and the backing-night map', () => {
        const own = parseOwnGeneration(stateText(392693, [[A, 375407], [B, 392691]]));
        expect(own?.firstFree).toBe(392693n);
        expect([...own!.nightIndices]).toEqual([[A, 375407n], [B, 392691n]]);
    });

    it('is null without the fields', () => {
        expect(parseOwnGeneration('DustLocalState { }')).toBeNull();
    });

    it('reads an empty map', () => {
        expect(parseOwnGeneration(stateText(10, []))?.nightIndices.size).toBe(0);
    });
});

describe('foreignRanges', () => {
    it('covers everything below first_free except the kept indices', () => {
        expect(foreignRanges([3n, 7n, 8n], 12n)).toEqual([[0n, 2n], [4n, 6n], [9n, 11n]]);
    });

    it('is one range with nothing to keep', () => {
        expect(foreignRanges([], 5n)).toEqual([[0n, 4n]]);
    });

    it('leaves no range around kept edges and ignores out-of-range indices', () => {
        expect(foreignRanges([0n, 4n, 9n], 5n)).toEqual([[1n, 3n]]);
    });

    it('is empty for an empty tree', () => {
        expect(foreignRanges([], 0n)).toEqual([]);
    });
});

describe('collapseForeignGeneration', () => {
    it('collapses the gaps around the own leaves', () => {
        const s = fakeState({ firstFree: 10, indices: [[A, 2], [B, 6]], utxoNights: [A] });
        const r = collapseForeignGeneration(s);
        expect(r.state.collapsed).toEqual([[0n, 1n], [3n, 5n], [7n, 9n]]);
        expect(r).toMatchObject({ ranges: 3, ownLeaves: 2 });
    });

    it('refuses when an own UTXO is backed by a night the map does not list', () => {
        const s = fakeState({ firstFree: 10, indices: [[A, 2]], utxoNights: [A, B] });
        expect(() => collapseForeignGeneration(s)).toThrow(/missing from night_indices/);
    });

    it('matches a 0x-prefixed or upper-case backing night', () => {
        const s = fakeState({ firstFree: 4, indices: [[A, 1]], utxoNights: ['0x' + A.toUpperCase()] });
        expect(collapseForeignGeneration(s).state.collapsed).toEqual([[0n, 0n], [2n, 3n]]);
    });
});

describe('collapseDustState + verifyCollapsedDust + collapsedDustBlob', () => {
    const sdkBlob = JSON.stringify({ publicKey: { publicKey: '1' }, state: 'aabbcc', protocolVersion: '1', networkId: 'preprod', offset: '1530131' });

    it('collapses the live state and records what a restore must reproduce', () => {
        const walletState = { serialize: () => sdkBlob, state: { state: fakeState({ firstFree: 10, indices: [[A, 2]], utxoNights: [A, A] }) } };
        const r = collapseDustState(walletState);
        expect(r.fullBlob).toBe(sdkBlob);
        expect(r.fullBytes).toBe(3);
        expect([...r.bytes]).toEqual([2, 0]);
        expect(r).toMatchObject({ ranges: 2, ownLeaves: 1 });
        expect(r.expect).toEqual({
            generatingTreeRoot: '7', commitmentTreeRoot: '9', balance: '5', utxoCount: 2,
            syncTimeMs: Date.parse('2026-09-17T07:23:48Z')
        });
    });

    it('throws when the collapse refuses, so the caller saves the full snapshot', () => {
        const walletState = { serialize: () => sdkBlob, state: { state: fakeState({ firstFree: 10, indices: [], utxoNights: [A] }) } };
        expect(() => collapseDustState(walletState)).toThrow(/missing from night_indices/);
    });

    it('verifies collapsed bytes that restore to the same roots, balance and UTXOs', () => {
        const r = collapseDustState({ serialize: () => sdkBlob, state: { state: fakeState({ firstFree: 10, indices: [[A, 2]], utxoNights: [A, A] }) } });
        expect(verifyCollapsedDust(r.bytes, r.expect, FakeDustLocalState)).toEqual({ ok: true });
    });

    it('refuses collapsed bytes that restore to another root', () => {
        const r = collapseDustState({ serialize: () => sdkBlob, state: { state: fakeState({ firstFree: 10, indices: [[A, 2]], utxoNights: [A, A], breakRoot: true }) } });
        const verdict = verifyCollapsedDust(r.bytes, r.expect, FakeDustLocalState);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(verdict.reason).toMatch(/same roots/);
    });

    it('turns a deserialize failure into a reason instead of throwing', () => {
        const Broken = { deserialize: () => { throw new Error('wasm panic'); } };
        const r = collapseDustState({ serialize: () => sdkBlob, state: { state: fakeState({ firstFree: 10, indices: [[A, 2]], utxoNights: [A, A] }) } });
        expect(verifyCollapsedDust(r.bytes, r.expect, Broken)).toEqual({ ok: false, reason: expect.stringContaining('wasm panic') });
    });

    it('replaces only the state of the SDK snapshot', () => {
        const out = JSON.parse(collapsedDustBlob(sdkBlob, new Uint8Array([2, 0])));
        expect(out).toMatchObject({ publicKey: { publicKey: '1' }, protocolVersion: '1', networkId: 'preprod', offset: '1530131' });
        expect(out.state).toBe('0200');
        expect(Object.keys(out)).toEqual(Object.keys(JSON.parse(sdkBlob)));
    });
});

describe('dustSaveKey', () => {
    it('changes with the applied index, the coins and the pending coins', () => {
        const base = { progress: { appliedIndex: '100' }, totalCoins: [{}, {}], pendingCoins: [] };
        expect(dustSaveKey(base)).toBe('100:2:0');
        expect(dustSaveKey({ ...base, progress: { appliedIndex: '101' } })).toBe('101:2:0');
        expect(dustSaveKey({ ...base, pendingCoins: [{}] })).toBe('100:2:1');
    });

    it('reads a progress nested under state and marks missing coin lists', () => {
        expect(dustSaveKey({ state: { progress: { appliedIndex: 5 } } })).toBe('5:-:-');
    });

    it('is null without an applied index, so the caller never skips', () => {
        expect(dustSaveKey({ totalCoins: [] })).toBeNull();
        expect(dustSaveKey(undefined)).toBeNull();
    });
});
