/**
 * Tests for srv/submission/wallet-material-factory.ts (T7).
 *
 * Verifies:
 *   - Deterministic accountId + password derivation across reconnects
 *   - Session lookup error paths
 *   - Encryption / decryption boundary
 *   - Wallet adapter shape, all four signing methods throw a recognizable
 *     error so the SubmitTx classifier can map them to a stable code
 */

import crypto from 'crypto';

// Mock loadLedgerV8, ledger-v8 is ESM-only and cannot be loaded from this
// Jest CommonJS runtime. Tests verify wiring/shape; real crypto derivation is
// exercised by scripts/integration-test-wallet-keys.mjs.
jest.mock('../../srv/midnight/sdk-loader', () => {
    const actual = jest.requireActual('../../srv/midnight/sdk-loader');
    return {
        ...actual,
        loadLedgerV8: jest.fn(async () => ({
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

import {
    buildWalletMaterialForSession,
    deriveAccountId,
    deriveStoragePassword,
    SessionNotFoundError,
    WalletSigningNotAvailable
} from '../../srv/submission/wallet-material-factory';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';

// ---- Fake DB --------------------------------------------------------------

function makeDbWithSession(row: Record<string, any> | null) {
    return {
        run: jest.fn(async (_q: any) => row)
    };
}

const TEST_KEY = crypto.createHash('sha256').update('test-encryption-key').digest();

function buildEncryptedSession(viewingKey: string, overrides: Record<string, any> = {}) {
    const enc = encrypt(viewingKey, TEST_KEY);
    return {
        ID: 'sess-uuid',
        sessionId: 'sess-1',
        isActive: true,
        encryptedViewingKey: enc,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

// ---- Determinism ----------------------------------------------------------

describe('deriveAccountId / deriveStoragePassword', () => {
    test('same viewing key → same accountId', () => {
        const vk = 'mn_shield-vk_test1...example';
        expect(deriveAccountId(vk)).toBe(deriveAccountId(vk));
    });

    test('different viewing keys → different accountIds', () => {
        expect(deriveAccountId('vk-A')).not.toBe(deriveAccountId('vk-B'));
    });

    test('accountId is 64-char hex', () => {
        const a = deriveAccountId('any-input');
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    test('storage password is 64-char hex, ≥16 chars', () => {
        const p = deriveStoragePassword('any-input');
        expect(p).toMatch(/^[0-9a-f]{64}$/);
        expect(p.length).toBeGreaterThanOrEqual(16);
    });

    test('accountId and storage password use distinct domain separation', () => {
        const vk = 'vk-X';
        expect(deriveAccountId(vk)).not.toBe(deriveStoragePassword(vk));
    });

    test('determinism survives across separate calls (simulates reconnect)', () => {
        const vk = 'mn_shield-vk_reconnect-test';
        const first = { id: deriveAccountId(vk), pw: deriveStoragePassword(vk) };
        // Imagine the process restarted here.
        const second = { id: deriveAccountId(vk), pw: deriveStoragePassword(vk) };
        expect(second).toEqual(first);
    });
});

// ---- buildWalletMaterialForSession ----------------------------------------

describe('buildWalletMaterialForSession', () => {
    test('returns a WalletMaterial with deterministic accountId and storage password', async () => {
        const viewingKey = 'mn_shield-vk_alice';
        const db = makeDbWithSession(buildEncryptedSession(viewingKey));

        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });

        expect(material.accountId).toBe(deriveAccountId(viewingKey));
        const pw = await material.privateStoragePasswordProvider();
        expect(pw).toBe(deriveStoragePassword(viewingKey));
        expect(pw.length).toBeGreaterThanOrEqual(16);
        expect(material.walletAndMidnightProvider).toBeDefined();
    });

    test('throws SessionNotFoundError when session is missing', async () => {
        const db = makeDbWithSession(null);
        await expect(buildWalletMaterialForSession({
            sessionId: 'missing', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
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
            encryptedViewingKey: encrypt('vk-victim', otherKey),
            expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
        const db = makeDbWithSession(session);
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY  // wrong key for this ciphertext
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('propagates privateStateBackend opt to the returned material', async () => {
        const db = makeDbWithSession(buildEncryptedSession('vk'));
        const m = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, privateStateBackend: 'level'
        });
        expect(m.privateStateBackend).toBe('level');
    });

    test('defaults privateStateBackend to undefined (provider layer fills cap-db default)', async () => {
        const db = makeDbWithSession(buildEncryptedSession('vk'));
        const m = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        expect(m.privateStateBackend).toBeUndefined();
    });
});

// ---- Wallet adapter shape -------------------------------------------------

describe('walletAndMidnightProvider adapter (T7, read-only material only)', () => {
    let material: any;

    beforeAll(async () => {
        const db = makeDbWithSession(buildEncryptedSession('vk-adapter-test'));
        material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
    });

    test('exposes the four interface methods', () => {
        const w = material.walletAndMidnightProvider;
        expect(typeof w.getCoinPublicKey).toBe('function');
        expect(typeof w.getEncryptionPublicKey).toBe('function');
        expect(typeof w.balanceTx).toBe('function');
        expect(typeof w.submitTx).toBe('function');
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

    test('error message names the failing method and points at T7-extended', () => {
        try { material.walletAndMidnightProvider.getCoinPublicKey(); }
        catch (e) {
            const err = e as WalletSigningNotAvailable;
            expect(err.message).toMatch(/getCoinPublicKey/);
            expect(err.message).toMatch(/T7-extended/);
            expect(err.message).toMatch(/encryptedSeedKey/);
        }
    });
});

// ---- Signing-capable adapter (T7-extended.a) ------------------------------

describe('signing-capable wallet adapter (session with encryptedSeedKey)', () => {
    const VALID_SEED = 'a'.repeat(64);

    test('returns real coinPublicKey and encryptionPublicKey from derived ZswapSecretKeys', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY);
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
        const encSeed = encrypt(VALID_SEED, TEST_KEY);
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
        const seedA = 'a'.repeat(64);
        const seedB = 'b'.repeat(64);
        const dbA = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encrypt(seedA, TEST_KEY) }));
        const dbB = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encrypt(seedB, TEST_KEY) }));

        const mA = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: dbA, encryptionKey: TEST_KEY });
        const mB = await buildWalletMaterialForSession({ sessionId: 'sess-1', db: dbB, encryptionKey: TEST_KEY });

        expect(mA.walletAndMidnightProvider.getCoinPublicKey())
            .not.toBe(mB.walletAndMidnightProvider.getCoinPublicKey());
    });

    test('balanceTx still throws but with T7-extended.b hint', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY);
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        await expect(material.walletAndMidnightProvider.balanceTx({}, new Date()))
            .rejects.toThrow(/T7-extended\.b/);
    });

    test('submitTx still throws but with T7-extended.b hint', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY);
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        await expect(material.walletAndMidnightProvider.submitTx({}))
            .rejects.toThrow(/T7-extended\.b/);
    });

    test('invalid encryptedSeedKey ciphertext is mapped to SessionNotFoundError', async () => {
        // Encrypted with a different key.
        const otherKey = crypto.createHash('sha256').update('other').digest();
        const db = makeDbWithSession(buildEncryptedSession('vk', {
            encryptedSeedKey: encrypt(VALID_SEED, otherKey)
        }));
        await expect(buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        })).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    test('exposes _internal handles for T7-extended.b WalletFacade adapter', async () => {
        const encSeed = encrypt(VALID_SEED, TEST_KEY);
        const db = makeDbWithSession(buildEncryptedSession('vk', { encryptedSeedKey: encSeed }));
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        const internal = material.walletAndMidnightProvider._internal;
        expect(internal).toBeDefined();
        expect(internal.zswapKeys).toBeDefined();
        expect(internal.dustKey).toBeDefined();
    });
});

// ---- Classifier integration -----------------------------------------------

describe('classifySubmissionError recognizes WalletSigningNotAvailable', () => {
    const { classifySubmissionError } = require('../../srv/submission/TransactionSubmitter');

    test('maps WalletSigningNotAvailable to stable code with non-retryable + T7 hint', () => {
        const err = new WalletSigningNotAvailable('balanceTx()');
        const c = classifySubmissionError(err, 'preprod');
        expect(c.code).toBe('WalletSigningNotAvailable');
        expect(c.retryable).toBe(false);
        expect(c.message).toMatch(/T7-extended/);
    });
});
