/**
 * Tests for srv/submission/wallet-sync-state-store.ts.
 *
 * The store goes through standard CAP `cds.connect.to('db').run(...)` again
 * (after Phase 1 of the worker migration, the wallet SDK no longer blocks
 * the main-thread microtask queue). Tests use a hand-rolled in-memory `cds`
 * mock, same pattern as `block-processor-persistence.test.ts`.
 */

import { CURRENT_ENCRYPTION_VERSION } from '../../srv/utils/storage-encryption';

const store = new Map<string, any>();

const runMock = vi.hoisted(() => (vi.fn(async (q: any) => {
    if (!q || typeof q !== 'object') return undefined;
    if (q.kind === 'selectOne') {
        return store.get(q.where.accountId) ?? null;
    }
    if (q.kind === 'insert') {
        const entry = Array.isArray(q.entry) ? q.entry[0] : q.entry;
        store.set(entry.accountId, { ...entry });
        return undefined;
    }
    if (q.kind === 'update') {
        const existing = store.get(q.where.accountId);
        if (existing) store.set(q.where.accountId, { ...existing, ...q.set });
        return undefined;
    }
    if (q.kind === 'delete') {
        store.delete(q.where.accountId);
        return undefined;
    }
    return undefined;
})));

vi.mock('@sap/cds', () => {
    const SELECT = {
        one: {
            from: vi.fn((entity: string) => ({
                where: vi.fn((where: Record<string, unknown>) => ({
                    kind: 'selectOne', entity, where
                }))
            }))
        }
    };
    const INSERT = {
        into: vi.fn((entity: string) => ({
            entries: vi.fn((entry: Record<string, unknown>) => ({
                kind: 'insert', entity, entry
            }))
        }))
    };
    const UPDATE = {
        entity: vi.fn((entity: string) => ({
            set: vi.fn((set: Record<string, unknown>) => ({
                where: vi.fn((where: Record<string, unknown>) => ({
                    kind: 'update', entity, set, where
                }))
            }))
        }))
    };
    const DELETE = {
        from: vi.fn((entity: string) => ({
            where: vi.fn((where: Record<string, unknown>) => ({
                kind: 'delete', entity, where
            }))
        }))
    };
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
        ql: { SELECT, INSERT, UPDATE, DELETE },
        connect: { to: vi.fn(async () => ({ run: runMock })) },
        env: { requires: {} }
    };
    cds.default = cds;
    return cds;
});

vi.mock('../../srv/utils/cds-model', () => ({
    ensureNightgateModelLoaded: vi.fn(async () => undefined)
}));

import {
    saveSyncState,
    loadSyncState,
    getWalletSdkVersion,
    evictEncryptionKey,
    clearAllEncryptionKeys,
    __resetDbHandleForTests,
    __resetEncryptionCacheForTests,
    __getEncryptionCacheSizeForTests
} from '../../srv/submission/wallet-sync-state-store';
import { extractEncryptedComponents } from '../../srv/utils/storage-encryption';

const PASS = 'a-deterministic-passphrase-32-bytes-or-more-please';
const SDK  = 'wallet-sdk-facade@1.2.3';

beforeEach(() => {
    store.clear();
    runMock.mockClear();
    __resetDbHandleForTests();
    __resetEncryptionCacheForTests();
});

describe('saveSyncState / loadSyncState round-trip', () => {
    test('persists all three sub-state blobs and restores them byte-identical', async () => {
        await saveSyncState({
            accountId: 'acct-A',
            passphrase: PASS,
            sdkVersion: SDK,
            states: {
                shielded:   'shielded-state-string-1',
                unshielded: 'unshielded-state-string-2',
                dust:       'dust-state-string-3'
            }
        });
        const loaded = await loadSyncState({
            accountId: 'acct-A',
            passphrase: PASS,
            expectedSdkVersion: SDK
        });
        expect(loaded).not.toBeNull();
        expect(loaded!.shielded).toBe('shielded-state-string-1');
        expect(loaded!.unshielded).toBe('unshielded-state-string-2');
        expect(loaded!.dust).toBe('dust-state-string-3');
    });

    test('returns null when no row exists', async () => {
        const loaded = await loadSyncState({
            accountId: 'never-saved',
            passphrase: PASS,
            expectedSdkVersion: SDK
        });
        expect(loaded).toBeNull();
    });

    test('returns null when sdkVersion does not match', async () => {
        await saveSyncState({
            accountId: 'acct-B',
            passphrase: PASS,
            sdkVersion: 'wallet-sdk-facade@1.0.0',
            states: { shielded: 'sh-1' }
        });
        const loaded = await loadSyncState({
            accountId: 'acct-B',
            passphrase: PASS,
            expectedSdkVersion: 'wallet-sdk-facade@2.0.0'
        });
        expect(loaded).toBeNull();
    });

    test('refuses restore when the stored networkId differs (cold start)', async () => {
        await saveSyncState({
            accountId: 'acct-net', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-1' }, networkId: 'preview'
        });
        expect(await loadSyncState({
            accountId: 'acct-net', passphrase: PASS, expectedSdkVersion: SDK,
            expectedNetworkId: 'preprod'
        })).toBeNull();
        expect(await loadSyncState({
            accountId: 'acct-net', passphrase: PASS, expectedSdkVersion: SDK,
            expectedNetworkId: 'preview'
        })).not.toBeNull();
    });

    test('refuses restore when the stored seedFingerprint differs', async () => {
        await saveSyncState({
            accountId: 'acct-seed', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-2' }, seedFingerprint: 'fp-wallet-A'
        });
        expect(await loadSyncState({
            accountId: 'acct-seed', passphrase: PASS, expectedSdkVersion: SDK,
            expectedSeedFingerprint: 'fp-wallet-B'
        })).toBeNull();
        expect(await loadSyncState({
            accountId: 'acct-seed', passphrase: PASS, expectedSdkVersion: SDK,
            expectedSeedFingerprint: 'fp-wallet-A'
        })).not.toBeNull();
    });

    test('legacy rows (no networkId/seedFingerprint) still restore with guards requested', async () => {
        await saveSyncState({
            accountId: 'acct-legacy', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-3' }
        });
        expect(await loadSyncState({
            accountId: 'acct-legacy', passphrase: PASS, expectedSdkVersion: SDK,
            expectedNetworkId: 'preview', expectedSeedFingerprint: 'fp-any'
        })).not.toBeNull();
    });

    test('returns null when passphrase is wrong (decrypt failure)', async () => {
        await saveSyncState({
            accountId: 'acct-C',
            passphrase: PASS,
            sdkVersion: SDK,
            states: { shielded: 'sh-42' }
        });
        const loaded = await loadSyncState({
            accountId: 'acct-C',
            passphrase: 'wrong-passphrase',
            expectedSdkVersion: SDK
        });
        expect(loaded).toBeNull();
    });

    test('omitted sub-state survives across saves (preserves prior blob)', async () => {
        await saveSyncState({
            accountId: 'acct-D',
            passphrase: PASS,
            sdkVersion: SDK,
            states: { shielded: 'sh-first', dust: 'du-9' }
        });
        await saveSyncState({
            accountId: 'acct-D',
            passphrase: PASS,
            sdkVersion: SDK,
            states: { shielded: 'sh-second' }
        });
        const loaded = await loadSyncState({
            accountId: 'acct-D',
            passphrase: PASS,
            expectedSdkVersion: SDK
        });
        expect(loaded).not.toBeNull();
        expect(loaded!.shielded).toBe('sh-second');
        expect(loaded!.dust).toBe('du-9');
        expect(loaded!.unshielded).toBeUndefined();
    });
});

describe('concurrent save serialization', () => {
    test('concurrent saves for the same accountId all complete', async () => {
        const saves = [0, 1, 2, 3, 4].map(i =>
            saveSyncState({
                accountId: 'acct-conc',
                passphrase: PASS,
                sdkVersion: SDK,
                states: { shielded: `sh-${i}` }
            })
        );
        await Promise.all(saves);

        const loaded = await loadSyncState({
            accountId: 'acct-conc',
            passphrase: PASS,
            expectedSdkVersion: SDK
        });
        expect(loaded).not.toBeNull();
        expect(['sh-0', 'sh-1', 'sh-2', 'sh-3', 'sh-4']).toContain(loaded!.shielded);
    });
});

describe('getWalletSdkVersion', () => {
    test('returns a stable, non-empty version string', () => {
        const v1 = getWalletSdkVersion();
        const v2 = getWalletSdkVersion();
        expect(v1).toBe(v2);
        expect(v1).toMatch(/^wallet-sdk-facade@/);
    });
});

describe('encryption format', () => {
    test('persisted blob has the SDK encryption header (version byte first)', async () => {
        await saveSyncState({
            accountId: 'acct-F',
            passphrase: PASS,
            sdkVersion: SDK,
            states: { shielded: 'sh-encr' }
        });
        const row = store.get('acct-F');
        expect(row).toBeDefined();
        const raw = Buffer.from(row.shieldedStateBlob, 'base64');
        expect(raw[0]).toBe(CURRENT_ENCRYPTION_VERSION);
    });
});

describe('memoized key derivation', () => {
    const saltOf = (blobB64: string) =>
        extractEncryptedComponents(Buffer.from(blobB64, 'base64')).salt;

    test('repeated saves for the same account reuse the derived key (stable salt)', async () => {
        await saveSyncState({
            accountId: 'acct-memo', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-1' }
        });
        const salt1 = saltOf(store.get('acct-memo').dustStateBlob);
        await saveSyncState({
            accountId: 'acct-memo', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-2' }
        });
        const salt2 = saltOf(store.get('acct-memo').dustStateBlob);
        expect(salt1.equals(salt2)).toBe(true);
        // And the blob still loads through the salt-in-header path.
        const loaded = await loadSyncState({
            accountId: 'acct-memo', passphrase: PASS, expectedSdkVersion: SDK
        });
        expect(loaded!.dust).toBe('du-2');
    });

    test('different accounts derive different salts (and keys) from the same passphrase', async () => {
        await saveSyncState({
            accountId: 'acct-memo-A', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-A' }
        });
        await saveSyncState({
            accountId: 'acct-memo-B', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-B' }
        });
        const saltA = saltOf(store.get('acct-memo-A').dustStateBlob);
        const saltB = saltOf(store.get('acct-memo-B').dustStateBlob);
        expect(saltA.equals(saltB)).toBe(false);
    });
});

describe('key eviction', () => {
    test('evictEncryptionKey drops the memoized key; the next save re-derives and round-trips', async () => {
        await saveSyncState({
            accountId: 'acct-evict', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-before' }
        });
        expect(__getEncryptionCacheSizeForTests()).toBe(1);

        await evictEncryptionKey('acct-evict');
        expect(__getEncryptionCacheSizeForTests()).toBe(0);

        await saveSyncState({
            accountId: 'acct-evict', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-after' }
        });
        const loaded = await loadSyncState({
            accountId: 'acct-evict', passphrase: PASS, expectedSdkVersion: SDK
        });
        expect(loaded!.dust).toBe('du-after');
    });

    test('evictEncryptionKey waits for the in-flight save (no blob garbled mid-encrypt)', async () => {
        // Kick off the save and evict IMMEDIATELY: the save is still deriving
        // its key. Eviction must wait, or the zeroed key would encrypt the
        // blob into garbage that silently cold-starts the next restore.
        const inFlight = saveSyncState({
            accountId: 'acct-evict-race', passphrase: PASS, sdkVersion: SDK,
            states: { dust: 'du-racing' }
        });
        await evictEncryptionKey('acct-evict-race');
        await inFlight;

        const loaded = await loadSyncState({
            accountId: 'acct-evict-race', passphrase: PASS, expectedSdkVersion: SDK
        });
        expect(loaded).not.toBeNull();
        expect(loaded!.dust).toBe('du-racing');
    });

    test('evictEncryptionKey is a no-op for unknown accounts', async () => {
        await expect(evictEncryptionKey('never-connected')).resolves.toBeUndefined();
    });

    test('clearAllEncryptionKeys empties the cache across accounts', async () => {
        await saveSyncState({
            accountId: 'acct-all-1', passphrase: PASS, sdkVersion: SDK, states: { dust: 'd1' }
        });
        await saveSyncState({
            accountId: 'acct-all-2', passphrase: PASS, sdkVersion: SDK, states: { dust: 'd2' }
        });
        expect(__getEncryptionCacheSizeForTests()).toBe(2);

        await clearAllEncryptionKeys();
        expect(__getEncryptionCacheSizeForTests()).toBe(0);
    });
});

describe('validation', () => {
    test('saveSyncState throws on missing accountId', async () => {
        await expect(saveSyncState({
            accountId: '',
            passphrase: PASS,
            sdkVersion: SDK,
            states: {}
        })).rejects.toThrow(/accountId/);
    });
    test('saveSyncState throws on missing passphrase', async () => {
        await expect(saveSyncState({
            accountId: 'x',
            passphrase: '',
            sdkVersion: SDK,
            states: {}
        })).rejects.toThrow(/passphrase/);
    });
    test('loadSyncState throws on missing expectedSdkVersion', async () => {
        await expect(loadSyncState({
            accountId: 'x',
            passphrase: PASS,
            expectedSdkVersion: ''
        })).rejects.toThrow(/expectedSdkVersion/);
    });
});
