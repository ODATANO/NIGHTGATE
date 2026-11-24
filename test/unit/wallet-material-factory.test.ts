/**
 * Tests for srv/submission/wallet-material-factory.ts.
 *
 * Verifies:
 *   - Deterministic accountId + password derivation across reconnects
 *   - Session lookup error paths
 *   - Encryption / decryption boundary
 *   - Wallet adapter shape, all four signing methods throw a recognizable
 *     error so the SubmitTx classifier can map them to a stable code
 */

import crypto from 'crypto';
import { openDekByViewingKey, privateStatePasswordFromDek, clearAllAccountDeks } from '../../srv/submission/account-keys';
import { accountDekBinding, walletSessionSeedBinding, walletSessionViewingKeyBinding } from '../../srv/utils/envelope-bindings';

// Mock loadLedger, ledger-v9 is ESM-only and cannot be loaded from this
// unit suite (repo rule: never the real SDK). Tests verify wiring/shape; real crypto derivation is
// exercised by scripts/integration-test-wallet-keys.mjs.
vi.mock('../../srv/midnight/sdk-loader', async () => {
    const actual = await vi.importActual('../../srv/midnight/sdk-loader');
    return {
        ...actual,
        loadLedger: vi.fn(async () => ({
            ZswapSecretKeys: {
                fromSeed: (seed: Uint8Array) => {
                    // Deterministic stub: hash the seed to produce stable pubkeys.
                    const h = crypto.createHash('sha256').update(Buffer.from(seed)).digest('hex');
                    return {
                        coinPublicKey: 'coin_' + h.slice(0, 32),
                        encryptionPublicKey: 'enc_' + h.slice(32, 64),
                        coinSecretKey: 'sk_coin_' + h,
                        encryptionSecretKey: 'sk_enc_' + h,
                        clear: () => {}
                    };
                }
            },
            DustSecretKey: {
                fromSeed: (seed: Uint8Array) => {
                    const h = crypto.createHash('sha256').update(Buffer.from(seed)).update('dust').digest('hex');
                    return { _stub: 'dust', hash: h };
                }
            }
        }))
    };
});

// Mock the ESM-only HD derivation lib. deriveRoleSeeds is deterministic per
// input BIP39 seed so determinism / different-seed assertions hold.
vi.mock('../../srv/utils/wallet-hd', async () => {
    const c = require('crypto');
    const role = (seed: Uint8Array, label: string) =>
        new Uint8Array(c.createHash('sha256').update(Buffer.from(seed)).update(label).digest());
    return {
        deriveRoleSeeds: vi.fn(async (bip39Seed: Uint8Array) => ({
            zswap: role(bip39Seed, 'zswap'),
            dust:  role(bip39Seed, 'dust'),
            night: role(bip39Seed, 'night')
        })),
        mnemonicToBip39SeedHex: vi.fn((m: string) =>
            c.createHash('sha512').update(m).digest('hex'))
    };
});

const getOrBuildWalletFacadeMock = vi.hoisted(() => vi.fn(async () => ({ facade: {} })));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    getOrBuildWalletFacade: getOrBuildWalletFacadeMock
}));

import {
    buildWalletMaterialForSession,
    deriveAccountId,
    deriveStoragePassword,
    SessionNotFoundError,
    WalletSigningNotAvailable
} from '../../srv/submission/wallet-material-factory';
import { encrypt, KeyRing, decrypt } from '../../srv/utils/crypto';
import { HEX64_RE } from '../../srv/utils/hex-patterns';

// ---- Fake DB --------------------------------------------------------------

function makeDbWithSession(row: Record<string, any> | null) {
    return {
        run: vi.fn(async (q: any) => {
            const from = q?.SELECT?.from;
            const entity = typeof from === 'string' ? from : from?.ref?.[0];
            if (entity === 'midnight.AccountKeys') return null;   // no account key yet
            if (q?.INSERT || q?.UPDATE) return 1;
            return row;
        })
    };
}

const TEST_KEY = crypto.createHash('sha256').update('test-encryption-key').digest();

function buildEncryptedSession(viewingKey: string, overrides: Record<string, any> = {}) {
    const enc = encrypt(viewingKey, TEST_KEY, walletSessionViewingKeyBinding('sess-1'));
    return {
        sessionId: 'sess-1',
        isActive: true,
        encryptedViewingKey: enc,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

// ---- Determinism ----------------------------------------------------------

describe('deriveAccountId / deriveStoragePassword', () => {
    test('different viewing keys → different accountIds', () => {
        expect(deriveAccountId('vk-A')).not.toBe(deriveAccountId('vk-B'));
    });

    test('accountId is 64-char hex', () => {
        const a = deriveAccountId('any-input');
        expect(a).toMatch(HEX64_RE);
    });

    test('storage password is 64-char hex', () => {
        const p = deriveStoragePassword('any-input');
        expect(p).toMatch(HEX64_RE);
    });

    test('accountId and storage password use distinct domain separation', () => {
        const vk = 'vk-X';
        expect(deriveAccountId(vk)).not.toBe(deriveStoragePassword(vk));
    });

    test('a viewing key gives the account id and storage password it always gave', () => {
        // Stored rows are found under these values. A change here moves every account.
        const vk = 'mn_shield-vk_reconnect-test';
        expect(deriveAccountId(vk)).toBe('315382a9839b5c25a06d3b50621699a150b56394665a8e85eaef1e922b33d14c');
        expect(deriveStoragePassword(vk)).toBe('827a6ec40f828f9bfdf10fd3bb7eab08bd83dfc1e24e742669de611321b5c0a3');
    });
});

// ---- buildWalletMaterialForSession ----------------------------------------

describe('buildWalletMaterialForSession', () => {
    beforeEach(() => { clearAllAccountDeks(); });

    test('returns a WalletMaterial with deterministic accountId and storage password', async () => {
        const viewingKey = 'mn_shield-vk_alice';
        const db = makeDbWithSession(buildEncryptedSession(viewingKey));

        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });

        expect(material.accountId).toBe(deriveAccountId(viewingKey));
        const pw = await material.privateStoragePasswordProvider();
        // Derived from the account DEK the factory created on first use, sealed under the ring (TEST_KEY as key 1) and the viewing key.
        const ring = KeyRing.fromKek(TEST_KEY);
        const insert = db.run.mock.calls.map(c => c[0]).find((q: any) => q?.INSERT?.into === 'midnight.AccountKeys' || q?.INSERT?.into?.ref?.[0] === 'midnight.AccountKeys');
        expect(insert).toBeDefined();
        const entry = (insert as any).INSERT.entries[0];
        expect(entry.accountId).toBe(material.accountId);
        // Both seals are ring envelopes bound to the account; the viewing-key seal needs the ring too.
        expect(entry.wrappedDekByViewingKey).toMatch(/^v3:/);
        const dek = Buffer.from(decrypt(entry.wrappedDek, ring, accountDekBinding(entry.accountId)), 'hex');
        expect(dek).toHaveLength(32);
        expect(openDekByViewingKey(entry.wrappedDekByViewingKey, deriveStoragePassword(viewingKey), ring, entry.accountId).equals(dek)).toBe(true);
        expect(pw).toBe(privateStatePasswordFromDek(dek, material.accountId));
        expect(pw).not.toBe(deriveStoragePassword(viewingKey));
        expect(pw.length).toBeGreaterThanOrEqual(16);
        expect(material.walletAndMidnightProvider).toBeDefined();
    });

    test('exposes ensureFacade for seed+facadeConfig sessions and inits the worker facade', async () => {
        const viewingKey = 'mn_shield-vk_ensure';
        const seedHex = 'ab'.repeat(64);
        const db = makeDbWithSession(buildEncryptedSession(viewingKey, {
            encryptedSeedKey: encrypt(seedHex, TEST_KEY, walletSessionSeedBinding('sess-1'))
        }));
        const facadeConfig = {
            networkId: 'preview' as const,
            indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i',
            proofServerUrl: 'http://p', relayUrl: 'ws://r'
        };
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig
        });
        expect(typeof material.ensureFacade).toBe('function');
        getOrBuildWalletFacadeMock.mockClear();
        await material.ensureFacade!();
        expect(getOrBuildWalletFacadeMock).toHaveBeenCalledWith(
            deriveAccountId(viewingKey),
            expect.objectContaining({
                seedHex,
                syncStatePassphrase: deriveStoragePassword(viewingKey),
                networkId: 'preview'
            })
        );
    });

    test('ensureFacade is absent without signing material or without a facade config', async () => {
        const viewingKey = 'mn_shield-vk_noensure';
        // Viewing-key-only session.
        const dbViewOnly = makeDbWithSession(buildEncryptedSession(viewingKey));
        const viewOnly = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db: dbViewOnly, encryptionKey: TEST_KEY
        });
        expect(viewOnly.ensureFacade).toBeUndefined();
        // Seed present but no facadeConfig.
        const dbSeed = makeDbWithSession(buildEncryptedSession(viewingKey, {
            encryptedSeedKey: encrypt('cd'.repeat(64), TEST_KEY, walletSessionSeedBinding('sess-1'))
        }));
        const seedNoCfg = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db: dbSeed, encryptionKey: TEST_KEY
        });
        expect(seedNoCfg.ensureFacade).toBeUndefined();
    });

    test('throws SessionNotFoundError when session is missing', async () => {
        const db = makeDbWithSession(null);
        await expect(buildWalletMaterialForSession({
            sessionId: 'missing', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('scopes the session load to expectedUserId', async () => {
        // Capture the query so we can confirm the WHERE is user-scoped; return
        // null so a foreign/absent match surfaces as SessionNotFoundError.
        let captured: any;
        const db = { run: vi.fn(async (q: any) => { captured = q; return null; }) };
        await expect(buildWalletMaterialForSession({
            sessionId: 's1', expectedUserId: 'owner-1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
        const serialized = JSON.stringify(captured);
        expect(serialized).toContain('userId');
        expect(serialized).toContain('owner-1');
    });

    test('omits the userId filter when expectedUserId is not provided', async () => {
        let captured: any;
        const db = { run: vi.fn(async (q: any) => { captured = q; return null; }) };
        await expect(buildWalletMaterialForSession({
            sessionId: 's1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
        expect(JSON.stringify(captured)).not.toContain('userId');
    });

    test('throws SessionNotFoundError when expiresAt is in the past', async () => {
        const session = buildEncryptedSession('vk', {
            expiresAt: new Date(Date.now() - 60_000).toISOString()
        });
        const db = makeDbWithSession(session);
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('throws SessionNotFoundError when encryptedViewingKey is absent (logged-out session)', async () => {
        const session = buildEncryptedSession('vk', { encryptedViewingKey: null });
        const db = makeDbWithSession(session);
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('treats decryption failure as SessionNotFoundError (avoid oracle)', async () => {
        // Session encrypted with a DIFFERENT key.
        const otherKey = crypto.createHash('sha256').update('other-key').digest();
        const session = {
            sessionId: 'sess-1',
            isActive: true,
            encryptedViewingKey: encrypt('vk-victim', otherKey, walletSessionViewingKeyBinding('sess-1')),
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
        const db = makeDbWithSession(session);
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY  // wrong key for this ciphertext
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });
});

// ---- Wallet adapter shape -------------------------------------------------

describe('walletAndMidnightProvider adapter (read-only material only)', () => {
    let material: any;

    beforeAll(async () => {
        const db = makeDbWithSession(buildEncryptedSession('vk-adapter-test'));
        material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
    });

    test('getCoinPublicKey throws WalletSigningNotAvailable', () => {
        expect(() => material.walletAndMidnightProvider.getCoinPublicKey())
            .toThrow(WalletSigningNotAvailable);
    });

    test('getEncryptionPublicKey throws WalletSigningNotAvailable', () => {
        expect(() => material.walletAndMidnightProvider.getEncryptionPublicKey())
            .toThrow(WalletSigningNotAvailable);
    });

    test('balanceTx throws WalletSigningNotAvailable', async () => {
        await expect(material.walletAndMidnightProvider.balanceTx({}, new Date()))
            .rejects.toBeInstanceOf(WalletSigningNotAvailable);
    });

    test('submitTx throws WalletSigningNotAvailable', async () => {
        await expect(material.walletAndMidnightProvider.submitTx({}))
            .rejects.toBeInstanceOf(WalletSigningNotAvailable);
    });

    test('error message names the failing method and the missing material', () => {
        try { material.walletAndMidnightProvider.getCoinPublicKey(); }
        catch (e) {
            const err = e as WalletSigningNotAvailable;
            expect(err.message).toMatch(/getCoinPublicKey/);
            expect(err.message).toMatch(/viewing key only/);
            expect(err.message).toMatch(/encryptedSeedKey/);
        }
    });
});

// ---- Signing-capable adapter (seed present, no facade) --------------------

describe('signing-capable wallet adapter (session with encryptedSeedKey)', () => {
    const VALID_SEED = 'a'.repeat(128); // 64-byte BIP39 seed

    test('returns real coinPublicKey and encryptionPublicKey from derived ZswapSecretKeys', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'));
        const db = makeDbWithSession(buildEncryptedSession('vk-signing', { encryptedSeedKey: encSeed }));

        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });

        const w = material.walletAndMidnightProvider;
        const coinPk = w.getCoinPublicKey();
        const encPk  = w.getEncryptionPublicKey();

        expect(typeof coinPk).toBe('string');
        expect(coinPk.length).toBeGreaterThan(0);
        expect(typeof encPk).toBe('string');
        expect(encPk.length).toBeGreaterThan(0);
        expect(coinPk).not.toBe(encPk);
    });

    test('derived public keys are deterministic across reconnects (same seed → same pubkeys)', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'));
        const db1 = makeDbWithSession(buildEncryptedSession('vk1', { encryptedSeedKey: encSeed }));
        const db2 = makeDbWithSession(buildEncryptedSession('vk2', { encryptedSeedKey: encSeed }));

        const m1 = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: db1, encryptionKey: TEST_KEY });
        const m2 = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: db2, encryptionKey: TEST_KEY });

        expect(m1.walletAndMidnightProvider.getCoinPublicKey())
            .toBe(m2.walletAndMidnightProvider.getCoinPublicKey());
        expect(m1.walletAndMidnightProvider.getEncryptionPublicKey())
            .toBe(m2.walletAndMidnightProvider.getEncryptionPublicKey());
    });

    test('different seeds → different public keys', async () => {
        const seedA = 'a'.repeat(128);
        const seedB = 'b'.repeat(128);
        const dbA = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encrypt(seedA, TEST_KEY, walletSessionSeedBinding('sess-1')) }));
        const dbB = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encrypt(seedB, TEST_KEY, walletSessionSeedBinding('sess-1')) }));

        const mA = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: dbA, encryptionKey: TEST_KEY });
        const mB = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: dbB, encryptionKey: TEST_KEY });

        expect(mA.walletAndMidnightProvider.getCoinPublicKey())
            .not.toBe(mB.walletAndMidnightProvider.getCoinPublicKey());
    });

    test('balanceTx still throws when no facade is configured', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'));
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        await expect(material.walletAndMidnightProvider.balanceTx({}, new Date()))
            .rejects.toThrow(/no WalletFacade configured/);
    });

    test('submitTx still throws when no facade is configured', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'));
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        await expect(material.walletAndMidnightProvider.submitTx({}))
            .rejects.toThrow(/no WalletFacade configured/);
    });

    test('invalid encryptedSeedKey ciphertext is mapped to SessionNotFoundError', async () => {
        // Encrypted with a different key.
        const otherKey = crypto.createHash('sha256').update('other').digest();
        const db = makeDbWithSession(buildEncryptedSession('vk', {
            encryptedSeedKey: encrypt(VALID_SEED, otherKey, walletSessionSeedBinding('sess-1'))
        }));
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('exposes _internal handles for a facade-backed adapter to reuse', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'));
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        const internal = material.walletAndMidnightProvider._internal;
        expect(internal).toBeDefined();
        expect(internal?.zswapKeys).toBeDefined();
        expect(internal?.dustKey).toBeDefined();
    });
});

// ---- accountIndex threading (session row → HD derivation → facade) --------

describe('accountIndex threading', () => {
    const VALID_SEED = 'a'.repeat(128);
    const FACADE_CONFIG = {
        networkId: 'preview' as const,
        indexerHttpUrl: 'http://i', indexerWsUrl: 'ws://i',
        proofServerUrl: 'http://p', relayUrl: 'ws://r'
    };

    test('session accountIndex reaches deriveRoleSeeds (signing-capable adapter)', async () => {
        const { deriveRoleSeeds } = await import('../../srv/utils/wallet-hd.js');
        vi.mocked(deriveRoleSeeds).mockClear();
        const db = makeDbWithSession(buildEncryptedSession('vk-acct1', {
            encryptedSeedKey: encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1')),
            accountIndex: 1
        }));
        await buildWalletMaterialForSession({ sessionId: 'sess-1', db, encryptionKey: TEST_KEY });
        expect(vi.mocked(deriveRoleSeeds)).toHaveBeenCalledWith(expect.any(Uint8Array), 1);
    });

    test('missing accountIndex column (pre-upgrade row) falls back to account 0', async () => {
        const { deriveRoleSeeds } = await import('../../srv/utils/wallet-hd.js');
        vi.mocked(deriveRoleSeeds).mockClear();
        const db = makeDbWithSession(buildEncryptedSession('vk-legacy', {
            encryptedSeedKey: encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1'))
        }));
        await buildWalletMaterialForSession({ sessionId: 'sess-1', db, encryptionKey: TEST_KEY });
        expect(vi.mocked(deriveRoleSeeds)).toHaveBeenCalledWith(expect.any(Uint8Array), 0);
    });

    test('facade-backed adapter derives with the session accountIndex and forwards it to the worker init', async () => {
        const { deriveRoleSeeds } = await import('../../srv/utils/wallet-hd.js');
        vi.mocked(deriveRoleSeeds).mockClear();
        getOrBuildWalletFacadeMock.mockClear();
        const db = makeDbWithSession(buildEncryptedSession('vk-facade-acct2', {
            encryptedSeedKey: encrypt(VALID_SEED, TEST_KEY, walletSessionSeedBinding('sess-1')),
            accountIndex: 2
        }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        expect(vi.mocked(deriveRoleSeeds)).toHaveBeenCalledWith(expect.any(Uint8Array), 2);
        await material.ensureFacade!();
        expect(getOrBuildWalletFacadeMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ accountIndex: 2 })
        );
    });
});

// ---- Classifier integration -----------------------------------------------

describe('classifySubmissionError recognizes WalletSigningNotAvailable', () => {
    test('maps WalletSigningNotAvailable to stable code, non-retryable, with seed hint', async () => {
        const { classifySubmissionError } = await import('../../srv/submission/TransactionSubmitter.js');
        const err = new WalletSigningNotAvailable('balanceTx()');
        const c = classifySubmissionError(err, 'preprod');
        expect(c.code).toBe('WALLET_SIGNING_NOT_AVAILABLE');
        expect(c.retryable).toBe(false);
        expect(c.message).toMatch(/encryptedSeedKey/);
    });
});
