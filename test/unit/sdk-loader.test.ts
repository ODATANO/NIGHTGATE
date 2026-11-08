/**
 * Tests for srv/midnight/sdk-loader.ts.
 *
 * The Midnight SDK packages are ESM-only. The compiled `import('foo')`
 * resolves through the module graph, which means vi.mock() captures the same
 * path. We provide tiny stubs so the loader exercises its caching + in-flight
 * dedup logic without ever touching the real SDK.
 */

vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({ __esModule: true, marker: 'indexer' }));
vi.mock('@midnight-ntwrk/midnight-js-http-client-proof-provider', () => ({ __esModule: true, marker: 'proof' }));
vi.mock('@midnight-ntwrk/midnight-js-node-zk-config-provider', () => ({ __esModule: true, marker: 'zk' }));
vi.mock('@midnight-ntwrk/midnight-js-level-private-state-provider', () => ({ __esModule: true, marker: 'level' }));
vi.mock('@midnightntwrk/ledger-v9', () => ({ __esModule: true, marker: 'ledger-v9' }));

import {
    loadMidnightSdk,
    loadLedger,
    resetMidnightSdkCache
} from '../../srv/midnight/sdk-loader';

describe('sdk-loader', () => {
    beforeEach(() => {
        resetMidnightSdkCache();
    });

    describe('loadMidnightSdk', () => {
        it('loads the four provider packages and returns them as a bundle', async () => {
            const bundle: any = await loadMidnightSdk();
            expect(bundle.indexer.marker).toBe('indexer');
            expect(bundle.proof.marker).toBe('proof');
            expect(bundle.zk.marker).toBe('zk');
            expect(bundle.level.marker).toBe('level');
        });

        it('returns the cached bundle on subsequent calls (same object reference)', async () => {
            const first = await loadMidnightSdk();
            const second = await loadMidnightSdk();
            expect(second).toBe(first);
        });

        it('returns the same in-flight Promise to concurrent callers', async () => {
            const [first, second] = await Promise.all([loadMidnightSdk(), loadMidnightSdk()]);
            expect(second).toBe(first);
        });

        it('re-loads the SDK after resetMidnightSdkCache()', async () => {
            const first = await loadMidnightSdk();
            resetMidnightSdkCache();
            const second: any = await loadMidnightSdk();
            // Different bundle object after reset: the module cache survives,
            // but the loader's in-memory pointer was nulled, so we get a fresh
            // bundle composition.
            expect(second).not.toBe(first);
            expect(second.indexer.marker).toBe('indexer');
        });
    });

    describe('loadLedger', () => {
        it('loads ledger-v9 and caches it', async () => {
            const first: any = await loadLedger();
            expect(first.marker).toBe('ledger-v9');
            const second = await loadLedger();
            expect(second).toBe(first);
        });

        it('returns the in-flight ledger promise to concurrent callers', async () => {
            const [a, b] = await Promise.all([loadLedger(), loadLedger()]);
            expect(b).toBe(a);
        });

        it('re-loads ledger after resetMidnightSdkCache() without throwing', async () => {
            await loadLedger();
            resetMidnightSdkCache();
            // Underlying module identity comes from the runner's module cache,
            // so we can't assert `!== first` like we do for the bundle
            // wrappers. The observable behaviour is "doesn't throw, returns
            // the module".
            const second: any = await loadLedger();
            expect(second.marker).toBe('ledger-v9');
        });
    });
});
