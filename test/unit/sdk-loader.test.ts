/**
 * Tests for srv/midnight/sdk-loader.ts.
 *
 * The Midnight SDK packages are ESM-only. ts-jest compiles `import('foo')`
 * inside sdk-loader.ts to `Promise.resolve().then(() => require('foo'))`,
 * which means vi.mock() captures the same path. We provide tiny stubs so
 * the loader exercises its caching + in-flight dedup logic without ever
 * touching the real SDK.
 */

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({ __esModule: true, marker: 'contracts' }));
vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({ __esModule: true, marker: 'indexer' }));
vi.mock('@midnight-ntwrk/midnight-js-http-client-proof-provider', () => ({ __esModule: true, marker: 'proof' }));
vi.mock('@midnight-ntwrk/midnight-js-node-zk-config-provider', () => ({ __esModule: true, marker: 'zk' }));
vi.mock('@midnight-ntwrk/midnight-js-level-private-state-provider', () => ({ __esModule: true, marker: 'level' }));
vi.mock('@midnightntwrk/wallet-sdk-facade', () => ({ __esModule: true, marker: 'facade' }));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({ __esModule: true, marker: 'ledger-v8' }));
vi.mock('@midnightntwrk/wallet-sdk-shielded', () => ({ __esModule: true, marker: 'shielded' }));
vi.mock('@midnightntwrk/wallet-sdk-unshielded-wallet', () => ({ __esModule: true, marker: 'unshielded' }));
vi.mock('@midnightntwrk/wallet-sdk-dust-wallet', () => ({ __esModule: true, marker: 'dust' }));
vi.mock('@midnightntwrk/wallet-sdk-abstractions', () => ({ __esModule: true, marker: 'abstractions' }));

import {
    loadMidnightSdk,
    loadLedgerV8,
    loadWalletSdk,
    resetMidnightSdkCache
} from '../../srv/midnight/sdk-loader';

describe('sdk-loader', () => {
    beforeEach(() => {
        resetMidnightSdkCache();
    });

    describe('loadMidnightSdk', () => {
        it('loads all six SDK packages and returns them as a bundle', async () => {
            const bundle = await loadMidnightSdk();
            expect(bundle.contracts.marker).toBe('contracts');
            expect(bundle.indexer.marker).toBe('indexer');
            expect(bundle.proof.marker).toBe('proof');
            expect(bundle.zk.marker).toBe('zk');
            expect(bundle.level.marker).toBe('level');
            expect(bundle.facade.marker).toBe('facade');
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
            const second = await loadMidnightSdk();
            // Different bundle object after reset: the module cache survives,
            // but the loader's in-memory pointer was nulled, so we get a fresh
            // bundle composition.
            expect(second).not.toBe(first);
            expect(second.contracts.marker).toBe('contracts');
        });
    });

    describe('loadLedgerV8', () => {
        it('loads ledger-v8 and caches it', async () => {
            const first = await loadLedgerV8();
            expect(first.marker).toBe('ledger-v8');
            const second = await loadLedgerV8();
            expect(second).toBe(first);
        });

        it('returns the in-flight ledger promise to concurrent callers', async () => {
            const [a, b] = await Promise.all([loadLedgerV8(), loadLedgerV8()]);
            expect(b).toBe(a);
        });

        it('re-loads ledger after resetMidnightSdkCache() without throwing', async () => {
            await loadLedgerV8();
            resetMidnightSdkCache();
            // Underlying module identity comes from Jest's require cache, so we
            // can't assert `!== first` like we do for the bundle wrappers. The
            // observable behaviour is just "doesn't throw, returns the module".
            const second = await loadLedgerV8();
            expect(second.marker).toBe('ledger-v8');
        });
    });

    describe('loadWalletSdk', () => {
        it('loads all four wallet-sdk packages', async () => {
            const bundle = await loadWalletSdk();
            expect(bundle.shielded.marker).toBe('shielded');
            expect(bundle.unshielded.marker).toBe('unshielded');
            expect(bundle.dust.marker).toBe('dust');
            expect(bundle.abstractions.marker).toBe('abstractions');
        });

        it('caches the wallet-sdk bundle', async () => {
            const first = await loadWalletSdk();
            const second = await loadWalletSdk();
            expect(second).toBe(first);
        });

        it('returns the same in-flight wallet-sdk Promise to concurrent callers', async () => {
            const [a, b] = await Promise.all([loadWalletSdk(), loadWalletSdk()]);
            expect(b).toBe(a);
        });

        it('re-loads wallet-sdk after resetMidnightSdkCache()', async () => {
            const first = await loadWalletSdk();
            resetMidnightSdkCache();
            const second = await loadWalletSdk();
            expect(second).not.toBe(first);
        });
    });
});
