/**
 * Tests for srv/submission/wallet-facade-builder.ts.
 *
 * The builder is now a thin glue layer over the wallet worker (Phase 1
 * post-migration). We mock the worker RPC and the sync-state store so we can
 * exercise the restore-blob load, init-args forwarding, eviction, and the
 * state-save sink without touching the real SDK or DB.
 */

import cds from '@sap/cds';

const mockWalletInit = vi.hoisted(() => (vi.fn()));
const mockWalletEvict = vi.hoisted(() => (vi.fn()));
const mockSetStateSaveSink = vi.hoisted(() => (vi.fn()));
const mockLoadSyncState = vi.hoisted(() => (vi.fn()));
const mockSaveSyncState = vi.hoisted(() => (vi.fn()));
const mockGetWalletSdkVersion = vi.hoisted(() => (vi.fn(() => 'sdk-test')));
const mockEvictEncryptionKey = vi.hoisted(() => (vi.fn(async () => undefined)));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletInit: mockWalletInit,
    walletEvict: mockWalletEvict,
    setStateSaveSink: mockSetStateSaveSink
}));

vi.mock('../../srv/submission/wallet-sync-state-store', () => ({
    loadSyncState: mockLoadSyncState,
    saveSyncState: mockSaveSyncState,
    getWalletSdkVersion: mockGetWalletSdkVersion,
    evictEncryptionKey: mockEvictEncryptionKey
}));

import {
    getOrBuildWalletFacade,
    evictWalletFacade,
    __getCacheSizeForTests,
    __clearAllFacadesForTests,
    wireWorkerStateSaveSink,
    type WalletFacadeBuildArgs
} from '../../srv/submission/wallet-facade-builder';

const baseArgs: WalletFacadeBuildArgs = {
    seedHex: 'a'.repeat(64),
    networkId: 'preprod',
    indexerHttpUrl: 'https://indexer/',
    indexerWsUrl: 'wss://indexer/ws',
    proofServerUrl: 'http://proof',
    relayUrl: 'wss://relay/',
    syncStatePassphrase: 'pass-phrase-of-sufficient-length'
};

describe('wallet-facade-builder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __clearAllFacadesForTests();
        mockWalletInit.mockResolvedValue({ facadeReady: true, alreadyExisted: false, sdkVersion: 'sdk-test' });
        mockWalletEvict.mockResolvedValue({ evicted: true });
        mockLoadSyncState.mockResolvedValue(undefined);
        mockSaveSyncState.mockResolvedValue(undefined);
    });

    describe('getOrBuildWalletFacade', () => {
        it('forwards args to walletInit and registers the session for state-save persistence', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            try {
                const result = await getOrBuildWalletFacade('cache-key-aaaaaaaaaa', baseArgs);

                expect(mockLoadSyncState).toHaveBeenCalledWith(expect.objectContaining({
                    accountId: 'cache-key-aaaaaaaaaa',
                    passphrase: baseArgs.syncStatePassphrase,
                    expectedSdkVersion: 'sdk-test'
                }));
                expect(mockWalletInit).toHaveBeenCalledWith(expect.objectContaining({
                    sessionId: 'cache-key-aaaaaaaaaa',
                    seedHex: baseArgs.seedHex,
                    networkId: 'preprod',
                    indexerHttpUrl: baseArgs.indexerHttpUrl,
                    indexerWsUrl: baseArgs.indexerWsUrl,
                    proofServerUrl: baseArgs.proofServerUrl,
                    relayUrl: baseArgs.relayUrl
                }));
                expect(result.facade).toBeDefined();
                expect(__getCacheSizeForTests()).toBe(1);
            } finally {
                logSpy.mockRestore();
            }
        });

        it('passes the restored blobs into walletInit when loadSyncState returns a snapshot', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            mockLoadSyncState.mockResolvedValue({
                shielded: 'sh-blob',
                unshielded: 'un-blob',
                dust: 'du-blob'
            });
            try {
                await getOrBuildWalletFacade('cache-key', baseArgs);

                expect(mockWalletInit).toHaveBeenCalledWith(expect.objectContaining({
                    restoreBlobs: { shielded: 'sh-blob', unshielded: 'un-blob', dust: 'du-blob' }
                }));
            } finally {
                logSpy.mockRestore();
            }
        });

        it('skips persistence wiring when no syncStatePassphrase is provided', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            const { syncStatePassphrase: _drop, ...argsWithoutPass } = baseArgs;
            try {
                await getOrBuildWalletFacade('no-pass-key', argsWithoutPass as WalletFacadeBuildArgs);

                expect(mockLoadSyncState).not.toHaveBeenCalled();
                expect(mockWalletInit).toHaveBeenCalledWith(expect.objectContaining({
                    restoreBlobs: undefined
                }));
                expect(__getCacheSizeForTests()).toBe(0);
            } finally {
                logSpy.mockRestore();
            }
        });

        it('returns phase-2 stubs that throw when their methods are called', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            try {
                const result = await getOrBuildWalletFacade('cache-key', baseArgs);
                expect(() => result.facade.submitTransaction()).toThrow(/phase-1 worker migration/);
                expect(() => result.facade.shielded.start()).toThrow(/phase-1 worker migration/);
            } finally {
                logSpy.mockRestore();
            }
        });
    });

    describe('evictWalletFacade', () => {
        it('forwards eviction to the worker and clears the registry entry', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            try {
                await getOrBuildWalletFacade('evict-me', baseArgs);
                expect(__getCacheSizeForTests()).toBe(1);

                await evictWalletFacade('evict-me');

                expect(mockWalletEvict).toHaveBeenCalledWith('evict-me');
                expect(__getCacheSizeForTests()).toBe(0);
                // The memoized storage key goes with the facade, so key
                // material of disconnected wallets doesn't linger.
                expect(mockEvictEncryptionKey).toHaveBeenCalledWith('evict-me');
            } finally {
                logSpy.mockRestore();
            }
        });

        it('swallows errors from the worker and logs a warning', async () => {
            mockWalletEvict.mockRejectedValueOnce(new Error('worker gone'));
            const warnSpy = vi.spyOn(cds.log('nightgate:facade'), 'warn').mockImplementation(() => {});
            try {
                await expect(evictWalletFacade('any-key')).resolves.toBeUndefined();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('evict failed'), expect.stringContaining('worker gone'));
                // Key eviction still runs when the worker RPC fails.
                expect(mockEvictEncryptionKey).toHaveBeenCalledWith('any-key');
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('evicts the storage key even when key eviction itself rejects (logged, not thrown)', async () => {
            mockEvictEncryptionKey.mockRejectedValueOnce(new Error('zeroize boom'));
            const warnSpy = vi.spyOn(cds.log('nightgate:facade'), 'warn').mockImplementation(() => {});
            try {
                await expect(evictWalletFacade('any-key')).resolves.toBeUndefined();
                expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('key evict failed'), expect.stringContaining('zeroize boom'));
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe('__clearAllFacadesForTests / __getCacheSizeForTests', () => {
        it('drops every registry entry when cleared', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            try {
                await getOrBuildWalletFacade('k1', baseArgs);
                await getOrBuildWalletFacade('k2', baseArgs);
                expect(__getCacheSizeForTests()).toBe(2);

                __clearAllFacadesForTests();
                expect(__getCacheSizeForTests()).toBe(0);
            } finally {
                logSpy.mockRestore();
            }
        });
    });

    describe('wireWorkerStateSaveSink', () => {
        it('saves blobs via the sync-state store when a state-save event arrives', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            try {
                await getOrBuildWalletFacade('save-key', baseArgs);

                wireWorkerStateSaveSink();
                expect(mockSetStateSaveSink).toHaveBeenCalledTimes(1);
                const sink = mockSetStateSaveSink.mock.calls[0][0];

                await sink({
                    sessionId: 'save-key',
                    sdkVersion: 'sdk-test',
                    blobs: { shielded: 'sh', unshielded: 'un', dust: 'du' }
                });

                expect(mockSaveSyncState).toHaveBeenCalledWith(expect.objectContaining({
                    accountId: 'save-key',
                    passphrase: baseArgs.syncStatePassphrase,
                    sdkVersion: 'sdk-test',
                    states: { shielded: 'sh', unshielded: 'un', dust: 'du' }
                }));
            } finally {
                logSpy.mockRestore();
            }
        });

        it('rejects (no ack) when the session was evicted before the event arrived', async () => {
            wireWorkerStateSaveSink();
            const sink = mockSetStateSaveSink.mock.calls[0][0];

            // A dropped save THROWS so the worker-client does not ack
            // it and the worker re-pushes the blobs on a later tick.
            await expect(sink({
                sessionId: 'unknown-session',
                sdkVersion: 'sdk-test',
                blobs: {}
            })).rejects.toThrow('session not registered');

            expect(mockSaveSyncState).not.toHaveBeenCalled();
        });

        it('logs a warning when saveSyncState throws', async () => {
            const logSpy = vi.spyOn(cds.log('nightgate:facade'), 'info').mockImplementation(() => {});
            const warnSpy = vi.spyOn(cds.log('nightgate:facade'), 'warn').mockImplementation(() => {});
            mockSaveSyncState.mockRejectedValueOnce(new Error('db down'));
            try {
                await getOrBuildWalletFacade('warn-key', baseArgs);
                wireWorkerStateSaveSink();
                const sink = mockSetStateSaveSink.mock.calls[0][0];

                // The failure is logged AND rethrown so the
                // worker-client does not ack the save.
                await expect(sink({
                    sessionId: 'warn-key',
                    sdkVersion: 'sdk-test',
                    blobs: { shielded: 'sh' }
                })).rejects.toThrow('db down');

                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('save failed'),
                    expect.stringContaining('db down')
                );
            } finally {
                warnSpy.mockRestore();
                logSpy.mockRestore();
            }
        });
    });
});
