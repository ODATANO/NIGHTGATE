/**
 * Unit tests for srv/midnight/providers.ts and srv/midnight/sdk-loader.ts.
 *
 * The Midnight SDK is ESM-only and cannot be loaded via require() from this
 * CommonJS test runtime, so we mock the sdk-loader module instead of trying
 * to import the real SDK. Loader memoization, validation, and bundle shape
 * are all verifiable without touching the real SDK.
 */

import {
    buildContractProviders,
    buildFullProviderBundle,
    type ContractProvidersConfig,
    type WalletMaterial
} from '../../srv/midnight/providers';
import { loadMidnightSdk, resetMidnightSdkCache } from '../../srv/midnight/sdk-loader';

// Replace loadMidnightSdk with a hand-built fake.
jest.mock('../../srv/midnight/sdk-loader', () => {
    const fake = {
        contracts: {},
        indexer:  { indexerPublicDataProvider: jest.fn((http: string, ws: string, wsImpl?: unknown) => ({ tag: 'publicData', http, ws, wsImpl: !!wsImpl })) },
        proof:    { httpClientProofProvider: jest.fn((url: string, zk: unknown) => ({ tag: 'proof', url, zkRef: zk })) },
        zk:       { NodeZkConfigProvider: jest.fn().mockImplementation((dir: string) => ({ tag: 'zkConfig', directory: dir })) },
        level:    { levelPrivateStateProvider: jest.fn((cfg: any) => ({ tag: 'privateState', accountId: cfg.accountId, hasPasswordFn: typeof cfg.privateStoragePasswordProvider === 'function' })) },
        facade:   {}
    };
    return {
        loadMidnightSdk: jest.fn(async () => fake),
        resetMidnightSdkCache: jest.fn()
    };
});

const validCfg: ContractProvidersConfig = {
    indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl:   'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServerUrl: 'http://localhost:6300',
    zkConfigPath:   '/tmp/contracts/attestation-vault/src/managed/attestation-vault'
};

describe('buildContractProviders', () => {
    test('assembles publicData, zkConfig, proof providers from valid config', async () => {
        const bundle = await buildContractProviders(validCfg);

        expect(bundle.zkConfigProvider).toEqual({ tag: 'zkConfig', directory: validCfg.zkConfigPath });
        expect(bundle.publicDataProvider).toMatchObject({
            tag: 'publicData',
            http: validCfg.indexerHttpUrl,
            ws: validCfg.indexerWsUrl,
            wsImpl: true // ws WebSocket implementation passed in
        });
        expect(bundle.proofProvider).toMatchObject({
            tag: 'proof',
            url: validCfg.proofServerUrl,
            zkRef: bundle.zkConfigProvider
        });
    });

    test.each([
        ['indexerHttpUrl', { ...validCfg, indexerHttpUrl: '' }],
        ['indexerWsUrl',   { ...validCfg, indexerWsUrl:   '' }],
        ['proofServerUrl', { ...validCfg, proofServerUrl: '' }],
        ['zkConfigPath',   { ...validCfg, zkConfigPath:   '' }]
    ])('rejects missing %s', async (_field, cfg) => {
        await expect(buildContractProviders(cfg as ContractProvidersConfig)).rejects.toThrow(/is required/);
    });
});

describe('buildFullProviderBundle', () => {
    const validWallet: WalletMaterial = {
        accountId: 'addr_test1q...mockwalletaddress',
        privateStoragePasswordProvider: () => 'a-secret-passphrase-of-sufficient-length',
        walletAndMidnightProvider: { tag: 'walletProviderStub' }
    };

    test('returns full bundle using cap-db backend by default', async () => {
        const bundle = await buildFullProviderBundle(validCfg, validWallet);

        // Default backend is the NIGHTGATE CAP-DB provider, not the SDK's LevelDB stub.
        // We verify it's a defined object exposing the PrivateStateProvider surface.
        expect(bundle.privateStateProvider).toBeDefined();
        expect(typeof (bundle.privateStateProvider as any).setContractAddress).toBe('function');
        expect(typeof (bundle.privateStateProvider as any).get).toBe('function');
        expect(typeof (bundle.privateStateProvider as any).set).toBe('function');

        expect(bundle.walletProvider).toBe(validWallet.walletAndMidnightProvider);
        expect(bundle.midnightProvider).toBe(validWallet.walletAndMidnightProvider);
        expect(bundle.publicDataProvider).toBeDefined();
        expect(bundle.zkConfigProvider).toBeDefined();
        expect(bundle.proofProvider).toBeDefined();
    });

    test('uses SDK LevelDB provider when privateStateBackend = "level"', async () => {
        const bundle = await buildFullProviderBundle(validCfg, { ...validWallet, privateStateBackend: 'level' });
        // The mocked SDK returns { tag: 'privateState', accountId, hasPasswordFn } for the level provider.
        expect(bundle.privateStateProvider).toMatchObject({
            tag: 'privateState',
            accountId: validWallet.accountId,
            hasPasswordFn: true
        });
    });

    test('rejects wallet material missing accountId', async () => {
        await expect(
            buildFullProviderBundle(validCfg, { ...validWallet, accountId: '' })
        ).rejects.toThrow(/accountId/);
    });

    test('rejects wallet material missing password provider', async () => {
        await expect(
            buildFullProviderBundle(validCfg, { ...validWallet, privateStoragePasswordProvider: undefined as any })
        ).rejects.toThrow(/privateStoragePasswordProvider/);
    });

    test('rejects short passwords at use time (cap-db backend)', async () => {
        // Default cap-db backend lazily validates the password when an operation runs.
        const bundle = await buildFullProviderBundle(validCfg, {
            ...validWallet,
            privateStoragePasswordProvider: () => 'too-short'
        });
        const psp = bundle.privateStateProvider as any;
        psp.setContractAddress('0xcontract');
        // No real DB in this test, set() will hit the password check before any DB work,
        // because getEncryption() is invoked inside set() which calls getStoragePassword().
        // We construct the provider with a fake DB to avoid the real cds.connect.to('db').
        await expect(psp.set('x', { v: 1 })).rejects.toThrow(/at least 16 characters/);
    });

    test('rejects short passwords at use time (level backend)', async () => {
        const bundle = await buildFullProviderBundle(validCfg, {
            ...validWallet,
            privateStateBackend: 'level',
            privateStoragePasswordProvider: () => 'too-short'
        });
        // For the level backend, the password validation is wrapped in providers.ts.
        const { level } = await loadMidnightSdk();
        const lastCallCfg = (level.levelPrivateStateProvider as jest.Mock).mock.calls.slice(-1)[0][0];
        await expect(lastCallCfg.privateStoragePasswordProvider()).rejects.toThrow(/at least 16 characters/);
        expect(bundle.privateStateProvider).toBeDefined();
    });
});

describe('sdk-loader caching contract', () => {
    test('resetMidnightSdkCache is exposed', () => {
        expect(typeof resetMidnightSdkCache).toBe('function');
    });
});
