// `profileWorker` returns this summary of a V8 CPU profile taken inside the
// wallet worker thread; the shape is what an operator reads, so it is pinned.
import { describe, it, expect } from 'vitest';
import { summarizeCpuProfile } from '../../srv/midnight/cpu-profile-summary';

// root(1) -> runLoop(2) -> serialize(3) -> wasm(4); root -> (idle)(5); root -> (garbage collector)(6)
const profile = {
    nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 5, 6] },
        { id: 2, callFrame: { functionName: 'runLoop', url: 'file:///app/node_modules/effect/dist/esm/internal/fiberRuntime.js', lineNumber: 1117 }, children: [3] },
        { id: 3, callFrame: { functionName: 'serialize', url: 'file:///app/node_modules/@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js', lineNumber: 60 }, children: [4] },
        { id: 4, callFrame: { functionName: 'wasm-function[9230]', url: 'wasm://wasm/026b209a', lineNumber: 0 } },
        { id: 5, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
        { id: 6, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } }
    ],
    // 10 samples of 100 ms: 6 idle, 2 wasm (under serialize), 1 serialize self, 1 gc
    samples: [5, 5, 5, 5, 5, 5, 4, 4, 3, 6],
    timeDeltas: Array(10).fill(100_000)
};

describe('summarizeCpuProfile', () => {
    it('attributes self time by function and file, inclusive time up the stack, and the idle/gc/wasm shares', () => {
        const s = summarizeCpuProfile(profile, 5);
        expect(s.sampledMs).toBe(1000);
        expect(s.idlePercent).toBe(60);
        expect(s.gcPercent).toBe(10);
        expect(s.wasmPercent).toBe(20);
        expect(s.topFunctions[0]).toEqual({ label: '(idle)', percent: 60 });
        expect(s.topFunctions[1]).toEqual({ label: 'wasm-function[9230]  wasm://wasm/026b209a:1', percent: 20 });
        expect(s.topFunctions[2]).toEqual({ label: 'serialize  nm/@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js:61', percent: 10 });
        expect(s.topFiles.map(f => f.label)).toEqual(['(native/(idle))', 'wasm://wasm/026b209a', 'nm/@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js', '(native/(garbage collector))']);
        // inclusive: serialize covers its own sample + the two wasm samples; runLoop the same three; root/idle/gc buckets are skipped
        const incl = Object.fromEntries(s.topInclusive.map(e => [e.label, e.percent]));
        expect(incl['runLoop  nm/effect/dist/esm/internal/fiberRuntime.js:1118']).toBe(30);
        expect(incl['serialize  nm/@midnightntwrk/wallet-sdk-dust-wallet/dist/DustWallet.js:61']).toBe(30);
        expect(incl['wasm-function[9230]  wasm://wasm/026b209a:1']).toBe(20);
        expect(s.topInclusive.some(e => /^\((root|idle|garbage collector)\)/.test(e.label))).toBe(false);
    });

    it('handles an empty profile', () => {
        const s = summarizeCpuProfile({ nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } }], samples: [], timeDeltas: [] });
        expect(s.sampledMs).toBe(0);
        expect(s.topFunctions).toEqual([]);
    });
});
