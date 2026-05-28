/**
 * Tests for the facade-backed wallet adapter (T7-extended.b).
 *
 * Mocks:
 *   - sdk-loader.loadLedgerV8: returns a stub ZswapSecretKeys.fromSeed.
 *   - wallet-facade-builder.getOrBuildWalletFacade: returns a stub facade with
 *     spied balanceUnboundTransaction / finalizeRecipe / submitTransaction.
 *
 * Verifies:
 *   - getCoinPublicKey/getEncryptionPublicKey return real (from-seed) values.
 *   - balanceTx routes through facade.balanceUnboundTransaction + finalizeRecipe.
 *   - submitTx routes through facade.submitTransaction.
 *   - The facade is built lazily (no construction until first balance/submit call).
 *   - Secret keys are passed correctly to balanceUnboundTransaction.
 */

import crypto from 'crypto';
import { encrypt, getEncryptionKey } from '../../srv/utils/crypto';
import { buildWalletMaterialForSession } from '../../srv/submission/wallet-material-factory';
import type { WalletFacadeBuildArgs } from '../../srv/submission/wallet-facade-builder';

const TEST_KEY = crypto.createHash('sha256').update('test-encryption-key').digest();
const VALID_SEED_HEX = 'a'.repeat(64);
const STUB_FACADE = {
    balanceUnboundTransaction: jest.fn(),
    finalizeRecipe: jest.fn(),
    submitTransaction: jest.fn()
};
const STUB_KEYS = { zswapKeys: { _stub: 'zswap' }, dustKey: { _stub: 'dust' } };

// Mock the ESM-loaded ledger before any test file imports the factory.
jest.mock('../../srv/midnight/sdk-loader', () => {
    const actual = jest.requireActual('../../srv/midnight/sdk-loader');
    return {
        ...actual,
        loadLedgerV8: jest.fn(async () => ({
            ZswapSecretKeys: {
                fromSeed: (seed: Uint8Array) => {
                    const h = crypto.createHash('sha256').update(Buffer.from(seed)).digest('hex');
                    return {
                        coinPublicKey: 'coin_' + h.slice(0, 32),
                        encryptionPublicKey: 'enc_' + h.slice(32, 64),
                        clear: () => {}
                    };
                }
            },
            DustSecretKey: {
                fromSeed: () => ({ _stub: 'dust' })
            }
        }))
    };
});

// Mock the facade builder, we don't want real WalletFacade.init in unit tests.
jest.mock('../../srv/submission/wallet-facade-builder', () => ({
    getOrBuildWalletFacade: jest.fn(async () => ({
        facade: STUB_FACADE,
        ...STUB_KEYS
    })),
    evictWalletFacade: jest.fn(async () => {}),
    clearAllFacades: jest.fn(),
    getCacheSize: jest.fn(() => 0)
}));

const { getOrBuildWalletFacade } = require('../../srv/submission/wallet-facade-builder');

function makeDbWithSession(row: any) {
    return { run: jest.fn(async () => row) };
}

function buildSession() {
    return {
        ID: 'sess-uuid',
        sessionId: 'sess-1',
        isActive: true,
        encryptedViewingKey: encrypt('mn_shield-vk_alice', TEST_KEY),
        encryptedSeedKey: encrypt(VALID_SEED_HEX, TEST_KEY),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
}

const FACADE_CONFIG: Omit<WalletFacadeBuildArgs, 'seedHex'> = {
    networkId: 'preprod',
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServerUrl: 'http://localhost:6300',
    relayUrl:       'wss://rpc.preprod.midnight.network/'
};

beforeEach(() => {
    (STUB_FACADE.balanceUnboundTransaction as jest.Mock).mockReset();
    (STUB_FACADE.finalizeRecipe as jest.Mock).mockReset();
    (STUB_FACADE.submitTransaction as jest.Mock).mockReset();
    (getOrBuildWalletFacade as jest.Mock).mockClear();
});

describe('facade-backed wallet adapter: happy path', () => {
    test('getCoinPublicKey returns real-derived pubkey synchronously', async () => {
        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        const w: any = material.walletAndMidnightProvider;
        const coin = w.getCoinPublicKey();
        expect(typeof coin).toBe('string');
        expect(coin).toMatch(/^coin_/);
    });

    test('getEncryptionPublicKey returns real-derived pubkey synchronously', async () => {
        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        const w: any = material.walletAndMidnightProvider;
        const enc = w.getEncryptionPublicKey();
        expect(enc).toMatch(/^enc_/);
    });

    test('facade build is lazy, not triggered until first balance/submit call', async () => {
        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        // pubkeys don't trigger facade build
        (material.walletAndMidnightProvider as any).getCoinPublicKey();
        expect(getOrBuildWalletFacade).not.toHaveBeenCalled();
    });

    test('balanceTx routes through balanceUnboundTransaction then finalizeRecipe', async () => {
        STUB_FACADE.balanceUnboundTransaction.mockResolvedValue({ recipe: 'unbound' });
        STUB_FACADE.finalizeRecipe.mockResolvedValue({ tag: 'finalized-tx' });

        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });

        const fakeTx = { tag: 'unbound-input-tx' };
        const result = await (material.walletAndMidnightProvider as any).balanceTx(fakeTx);

        expect(STUB_FACADE.balanceUnboundTransaction).toHaveBeenCalledTimes(1);
        const [tx, keys, opts] = STUB_FACADE.balanceUnboundTransaction.mock.calls[0];
        expect(tx).toBe(fakeTx);
        expect(keys.shieldedSecretKeys).toBe(STUB_KEYS.zswapKeys);
        expect(keys.dustSecretKey).toBe(STUB_KEYS.dustKey);
        expect(opts.ttl).toBeInstanceOf(Date);

        expect(STUB_FACADE.finalizeRecipe).toHaveBeenCalledWith({ recipe: 'unbound' });
        expect(result).toEqual({ tag: 'finalized-tx' });
    });

    test('balanceTx accepts an explicit TTL', async () => {
        STUB_FACADE.balanceUnboundTransaction.mockResolvedValue({ recipe: 'x' });
        STUB_FACADE.finalizeRecipe.mockResolvedValue({});

        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });

        const explicitTtl = new Date(Date.now() + 120_000);
        await (material.walletAndMidnightProvider as any).balanceTx({}, explicitTtl);
        const opts = STUB_FACADE.balanceUnboundTransaction.mock.calls[0][2];
        expect(opts.ttl).toBe(explicitTtl);
    });

    test('submitTx routes directly to facade.submitTransaction and returns its result', async () => {
        STUB_FACADE.submitTransaction.mockResolvedValue('tx-id-123');
        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        const finalizedTx = { _finalized: true };
        const id = await (material.walletAndMidnightProvider as any).submitTx(finalizedTx);
        expect(STUB_FACADE.submitTransaction).toHaveBeenCalledWith(finalizedTx);
        expect(id).toBe('tx-id-123');
    });

    test('facade is built once across multiple balance/submit calls', async () => {
        STUB_FACADE.balanceUnboundTransaction.mockResolvedValue({});
        STUB_FACADE.finalizeRecipe.mockResolvedValue({});
        STUB_FACADE.submitTransaction.mockResolvedValue('id');

        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });

        const w: any = material.walletAndMidnightProvider;
        await w.balanceTx({});
        await w.submitTx({});
        await w.balanceTx({});

        expect(getOrBuildWalletFacade).toHaveBeenCalledTimes(1);
    });

    test('facade build is keyed on accountId (deterministic from viewing key)', async () => {
        const db = makeDbWithSession(buildSession());
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY, facadeConfig: FACADE_CONFIG
        });
        STUB_FACADE.submitTransaction.mockResolvedValue('id');
        await (material.walletAndMidnightProvider as any).submitTx({});

        const [cacheKey, _args] = (getOrBuildWalletFacade as jest.Mock).mock.calls[0];
        // accountId is HMAC-SHA256(viewingKey, label).hex, 64-char hex
        expect(typeof cacheKey).toBe('string');
        expect(cacheKey).toMatch(/^[0-9a-f]{64}$/);
        expect(cacheKey).toBe(material.accountId);
    });
});

describe('facade-backed wallet adapter: config requirement', () => {
    test('without facadeConfig, balanceTx still throws WalletSigningNotAvailable', async () => {
        const db = makeDbWithSession(buildSession());
        // No facadeConfig, should fall back to the T7-extended.a adapter
        const material = await buildWalletMaterialForSession({
            sessionId: 'sess-1', db, encryptionKey: TEST_KEY
        });
        await expect((material.walletAndMidnightProvider as any).balanceTx({})).rejects.toThrow(/T7-extended\.b/);
    });
});
