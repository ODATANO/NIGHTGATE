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

// Two tables share the fake: WalletSyncStates rows in `store`, the account
// keys (account-keys.ts) in `keysStore`, both keyed by accountId.
const keysStore = vi.hoisted(() => new Map<string, any>());
const runMock = vi.hoisted(() => (vi.fn(async (q: any) => {
    if (!q || typeof q !== 'object') return undefined;
    const table = q.entity === 'midnight.AccountKeys' ? keysStore : store;
    if (q.kind === 'selectOne') {
        return table.get(q.where.accountId) ?? null;
    }
    if (q.kind === 'insert') {
        const entry = Array.isArray(q.entry) ? q.entry[0] : q.entry;
        table.set(entry.accountId, { ...entry });
        return undefined;
    }
    if (q.kind === 'update') {
        const existing = table.get(q.where.accountId);
        if (existing) table.set(q.where.accountId, { ...existing, ...q.set });
        return undefined;
    }
    if (q.kind === 'delete') {
        table.delete(q.where.accountId);
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
    __getEncryptionCacheSizeForTests,
    deriveStableSalt,
    syncStatePassphraseCandidates
} from '../../srv/submission/wallet-sync-state-store';
import { extractEncryptedComponents, StorageEncryption, decryptWithPassword } from '../../srv/utils/storage-encryption';
import { getEncryptionKey, __resetKeyRingForTests, inspectCiphertext } from '../../srv/utils/crypto';
import { resolveAccountDek, syncStatePassphraseFromDek, clearAllAccountDeks } from '../../srv/submission/account-keys';
import { SALT_LABEL_DEK } from '../../srv/submission/wallet-sync-state-store';
import nodeCrypto from 'node:crypto';

const PASS = 'a-deterministic-passphrase-32-bytes-or-more-please';
const SDK  = 'wallet-sdk-facade@1.2.3';

beforeEach(() => {
    store.clear();
    keysStore.clear();
    runMock.mockClear();
    __resetDbHandleForTests();
    __resetEncryptionCacheForTests();
    clearAllAccountDeks();
});

/** The account's DEK-derived blob passphrase, as the store derives it. */
async function dekPassphraseOf(accountId: string, passphrase: string): Promise<string> {
    const dek = await resolveAccountDek({ db: { run: runMock }, ring: getEncryptionKey(), accountId, storagePassword: passphrase, create: false });
    if (!dek) throw new Error('no account key');
    return syncStatePassphraseFromDek(dek, accountId);
}

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

describe('account-key binding of the blob passphrase', () => {
    const RING_ENV = ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ACTIVE'] as const;
    let saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        saved = Object.fromEntries(RING_ENV.map(k => [k, process.env[k]]));
        for (const k of RING_ENV) delete process.env[k];
        __resetKeyRingForTests();
    });
    afterEach(() => {
        for (const k of RING_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        __resetKeyRingForTests();
    });
    const legacySalt = (accountId: string) => nodeCrypto.createHash('sha256').update(`${PASS}|${accountId}|nightgate-wallet-sync-salt-v1`).digest();
    const saltOf = (blobB64: string) => extractEncryptedComponents(Buffer.from(blobB64, 'base64')).salt;

    test('a blob is written under the account key, sealed under the ring AND the viewing key; the passphrase alone does not open it', async () => {
        await saveSyncState({ accountId: 'acct-ring', passphrase: PASS, sdkVersion: SDK, states: { dust: 'du-ring' } });
        const row = store.get('acct-ring');
        const key = keysStore.get('acct-ring');
        expect(row.keyScheme).toBe('dek1');
        expect(inspectCiphertext(key.wrappedDek)).toEqual({ version: 3, keyId: getEncryptionKey().activeId });
        // The viewing-key seal is wrapped in the ring envelope, not stored bare.
        expect(inspectCiphertext(key.wrappedDekByViewingKey)).toEqual({ version: 3, keyId: getEncryptionKey().activeId });
        const dekPass = await dekPassphraseOf('acct-ring', PASS);
        expect(saltOf(row.dustStateBlob).equals(deriveStableSalt('acct-ring', dekPass, SALT_LABEL_DEK))).toBe(true);
        expect(saltOf(row.dustStateBlob).equals(legacySalt('acct-ring'))).toBe(false);
        expect(() => decryptWithPassword(row.dustStateBlob, PASS)).toThrow();
        expect(decryptWithPassword(row.dustStateBlob, dekPass)).toBe('du-ring');
    });

    test('a pre-ring blob (passphrase only) still loads; the next save moves EVERY blob under the account key and marks the row', async () => {
        const legacy = new StorageEncryption(PASS, legacySalt('acct-legacy'));
        store.set('acct-legacy', {
            accountId: 'acct-legacy', sdkVersion: SDK, keyScheme: null,
            shieldedStateBlob: legacy.encrypt('sh-legacy'), unshieldedStateBlob: null, dustStateBlob: legacy.encrypt('du-legacy')
        });
        const loaded = await loadSyncState({ accountId: 'acct-legacy', passphrase: PASS, expectedSdkVersion: SDK });
        expect(loaded).toEqual({ savedAt: null, shielded: 'sh-legacy', dust: 'du-legacy' });
        expect(keysStore.has('acct-legacy')).toBe(false); // a load creates no key

        await saveSyncState({ accountId: 'acct-legacy', passphrase: PASS, sdkVersion: SDK, states: { dust: 'du-new' } });
        const row = store.get('acct-legacy');
        const dekPass = await dekPassphraseOf('acct-legacy', PASS);
        expect(row.keyScheme).toBe('dek1');
        expect(saltOf(row.dustStateBlob).equals(deriveStableSalt('acct-legacy', dekPass, SALT_LABEL_DEK))).toBe(true);
        // The blob this save did not touch was carried over under the account key too.
        expect(saltOf(row.shieldedStateBlob).equals(deriveStableSalt('acct-legacy', dekPass, SALT_LABEL_DEK))).toBe(true);
        const again = await loadSyncState({ accountId: 'acct-legacy', passphrase: PASS, expectedSdkVersion: SDK });
        expect(again!.shielded).toBe('sh-legacy');
        expect(again!.dust).toBe('du-new');
    });

    test('a blob under a previous ring key (pre-account-key form) loads while that key is in the ring and is a cold start once it leaves', async () => {
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32) + ',k2=' + 'b'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k1';
        __resetKeyRingForTests();
        const k1 = syncStatePassphraseCandidates(getEncryptionKey(), PASS)[0];
        const k1Enc = new StorageEncryption(k1.passphrase, deriveStableSalt('acct-rot', k1.passphrase));
        store.set('acct-rot', { accountId: 'acct-rot', sdkVersion: SDK, keyScheme: null, shieldedStateBlob: null, unshieldedStateBlob: null, dustStateBlob: k1Enc.encrypt('du-k1') });

        process.env.ENCRYPTION_KEY_ACTIVE = 'k2';
        __resetKeyRingForTests();
        __resetEncryptionCacheForTests();
        const underK2 = await loadSyncState({ accountId: 'acct-rot', passphrase: PASS, expectedSdkVersion: SDK });
        expect(underK2!.dust).toBe('du-k1');

        process.env.ENCRYPTION_KEYS = 'k2=' + 'b'.repeat(32);
        __resetKeyRingForTests();
        __resetEncryptionCacheForTests();
        await expect(loadSyncState({ accountId: 'acct-rot', passphrase: PASS, expectedSdkVersion: SDK })).resolves.toBeNull();
    });

    test('a rotation with the old key still in the ring re-seals the account key under the active key; a key that left without a rewrap is a cold start', async () => {
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k1';
        __resetKeyRingForTests();
        await saveSyncState({ accountId: 'acct-dek', passphrase: PASS, sdkVersion: SDK, states: { dust: 'du-dek' } });
        expect(inspectCiphertext(keysStore.get('acct-dek').wrappedDek).keyId).toBe('k1');
        expect(inspectCiphertext(keysStore.get('acct-dek').wrappedDekByViewingKey).keyId).toBe('k1');

        // Both keys in the ring, k2 active: the load re-seals both seals under k2.
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32) + ',k2=' + 'b'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k2';
        __resetKeyRingForTests();
        __resetEncryptionCacheForTests();
        clearAllAccountDeks();
        const loaded = await loadSyncState({ accountId: 'acct-dek', passphrase: PASS, expectedSdkVersion: SDK });
        expect(loaded!.dust).toBe('du-dek');
        expect(inspectCiphertext(keysStore.get('acct-dek').wrappedDek).keyId).toBe('k2');
        expect(inspectCiphertext(keysStore.get('acct-dek').wrappedDekByViewingKey).keyId).toBe('k2');
        expect(keysStore.get('acct-dek').rotatedAt).toBeTruthy();

        // k2 leaves without a rewrap: the viewing-key seal is wrapped in the ring too, so the passphrase alone
        // opens nothing, a cold start, never a crash.
        process.env.ENCRYPTION_KEYS = 'k3=' + 'c'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k3';
        __resetKeyRingForTests();
        __resetEncryptionCacheForTests();
        clearAllAccountDeks();
        await expect(loadSyncState({ accountId: 'acct-dek', passphrase: PASS, expectedSdkVersion: SDK })).resolves.toBeNull();
        // A damaged bare seal from before the wrapping is no crash either.
        clearAllAccountDeks();
        keysStore.get('acct-dek').wrappedDekByViewingKey = 'vk1:AAAA:BBBB:CCCC';
        await expect(loadSyncState({ accountId: 'acct-dek', passphrase: PASS, expectedSdkVersion: SDK })).resolves.toBeNull();
    });

    test('candidates: active key first, other ring keys, then the pre-ring form', () => {
        process.env.ENCRYPTION_KEYS = 'k1=' + 'a'.repeat(32) + ',k2=' + 'b'.repeat(32);
        process.env.ENCRYPTION_KEY_ACTIVE = 'k2';
        __resetKeyRingForTests();
        const c = syncStatePassphraseCandidates(getEncryptionKey(), PASS);
        expect(c.map(x => x.keyId)).toEqual(['k2', 'k1', null]);
        expect(c[2]).toMatchObject({ passphrase: PASS, legacy: true });
        expect(new Set(c.map(x => x.passphrase)).size).toBe(3);
    });
});
