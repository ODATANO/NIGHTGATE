/**
 * Tests for the browser providers (src/browser/providers.mjs): the proving modality and the zk config wiring.
 *
 * The property that matters most here is a SECURITY one, not a plumbing one: asking for
 * wallet-delegated proving and silently getting a remote proof server would move the transaction
 * preimage off the user's machine without the caller ever knowing. So `proving:'wallet'` must
 * throw rather than degrade, and the assembled modality is reported back for logging.
 *
 * The midnight-js imports are stubbed at the seam (same policy as wasm-proof-provider.test.ts); the real
 * prove loop is exercised by the live wallet-proving lane.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const dappConnectorProofProvider = vi.hoisted(() => vi.fn(async (connector: unknown, zk: unknown, costModel: unknown) => ({ marker: 'wallet-proof-provider', connector, zk, costModel })));
vi.mock('@midnight-ntwrk/midnight-js-dapp-connector-proof-provider', () => ({ dappConnectorProofProvider }));
vi.mock('@midnight-ntwrk/midnight-js-protocol/v9', () => ({ CostModel: { initialCostModel: () => 'initial-cost-model' } }));
vi.mock('@midnight-ntwrk/midnight-js-indexer-public-data-provider', () => ({ indexerPublicDataProvider: () => ({ marker: 'public-data' }) }));
vi.mock('@midnight-ntwrk/midnight-js-http-client-proof-provider', () => ({ httpClientProofProvider: (uri: string) => ({ marker: 'http-provider', uri }) }));

// Loaded in beforeAll, not at module scope: this file compiles as CommonJS under the repo's
// tsconfig, where a top-level await is an error. Types come from providers.d.mts.
type ProvidersModule = typeof import('../../src/browser/providers.mjs');
let buildProofProvider: ProvidersModule['buildProofProvider'];
let createNightgateConnectorProviders: ProvidersModule['createNightgateConnectorProviders'];
beforeAll(async () => {
    ({ buildProofProvider, createNightgateConnectorProviders } = await import('../../src/browser/providers.mjs'));
});

/** Minimal stand-ins; buildProofProvider only ever passes these through. */
const zkConfigProvider = { marker: 'zk-config' } as any;
const proofMod = {
    httpClientProofProvider: vi.fn((uri: string) => ({ marker: 'http-provider', uri }))
} as any;

describe('buildProofProvider', () => {
    // The stand-ins above are module-level, so call history has to be cleared per test.
    beforeEach(() => vi.clearAllMocks());

    it("defaults to the proof server", async () => {
        const res = await buildProofProvider({
            connector: {}, zkConfigProvider, proofServerUrl: 'http://localhost:6300', proofMod
        });
        expect(res.provingModality).toBe('server');
        expect((res.proofProvider as any).uri).toBe('http://localhost:6300');
    });

    it("delegates to the wallet when asked, through the connector proof provider of midnight-js", async () => {
        const connector = { getProvingProvider: vi.fn() };
        const res = await buildProofProvider({ proving: 'wallet', connector, zkConfigProvider, proofMod });
        expect(res.provingModality).toBe('wallet');
        expect(proofMod.httpClientProofProvider).not.toHaveBeenCalled(); // no server touched at all

        // midnight-js hands the wallet the contract's key material and proves with the initial cost model.
        expect(dappConnectorProofProvider).toHaveBeenCalledWith(connector, zkConfigProvider, 'initial-cost-model');
        expect(res.proofProvider).toEqual({ marker: 'wallet-proof-provider', connector, zk: zkConfigProvider, costModel: 'initial-cost-model' });
    });

    it("THROWS for proving:'wallet' against a wallet that cannot prove - never a silent downgrade", async () => {
        await expect(
            buildProofProvider({
                proving: 'wallet',
                connector: {}, // no getProvingProvider
                zkConfigProvider,
                proofServerUrl: 'http://localhost:6300',
                proofMod
            })
        ).rejects.toThrow(/does not implement getProvingProvider/);
    });

    it("'auto' prefers the wallet, and falls back to the server without it", async () => {
        const withWallet = await buildProofProvider({
            proving: 'auto',
            // A stand-in for the wallet's prover: the test only checks which path was taken.
            connector: { getProvingProvider: async () => ({ marker: 'wallet-prover' }) } as never,
            zkConfigProvider,
            proofServerUrl: 'http://localhost:6300',
            proofMod
        });
        expect(withWallet.provingModality).toBe('wallet');

        const withoutWallet = await buildProofProvider({
            proving: 'auto', connector: {}, zkConfigProvider, proofServerUrl: 'http://localhost:6300', proofMod
        });
        expect(withoutWallet.provingModality).toBe('server');
    });

    it("'auto' goes on to the proof server when the wallet has the method and refuses; 'wallet' fails with the wallet's reason", async () => {
        // The SDK asks the wallet for its prover while it builds the provider, and passes a refusal on.
        const refusing = { getProvingProvider: async () => { throw new Error('the user declined to prove'); } };
        const asking = async (connector: any) => { await connector.getProvingProvider(); return { marker: 'wallet-proof-provider' } as any; };
        dappConnectorProofProvider.mockImplementationOnce(asking).mockImplementationOnce(asking).mockImplementationOnce(asking);
        const auto = await buildProofProvider({ proving: 'auto', connector: refusing, zkConfigProvider, proofServerUrl: 'http://localhost:6300', proofMod });
        expect(auto.provingModality).toBe('server');
        await expect(buildProofProvider({ proving: 'wallet', connector: refusing, zkConfigProvider, proofServerUrl: 'http://localhost:6300', proofMod }))
            .rejects.toThrow('the user declined to prove');
        // Without a proof server either, nothing can prove.
        expect((await buildProofProvider({ proving: 'auto', connector: refusing, zkConfigProvider, proofMod })).provingModality).toBe('none');
    });

    it("reports 'none' when neither modality is available, instead of throwing at assembly time", async () => {
        const res = await buildProofProvider({ connector: {}, zkConfigProvider, proofMod });
        expect(res.provingModality).toBe('none');
        expect(res.proofProvider).toBeUndefined();
    });

    it('rejects an unknown modality by name', async () => {
        await expect(
            buildProofProvider({ proving: 'magic' as any, connector: {}, zkConfigProvider, proofMod })
        ).rejects.toThrow(/unknown proving modality 'magic'/);
    });
});

describe('createNightgateConnectorProviders: zk config', () => {
    const BASE = 'https://api.example/zk-config/attestation-vault';
    const VERIFIER = new Uint8Array([1, 2, 3, 4]);
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const MANIFEST = JSON.stringify({
        'manifest-version': '1',
        'runtime-version': '0.21.0',
        keys: { type: 'directory', 'attest.verifier': { type: 'file', size: VERIFIER.length, hash: sha256(VERIFIER) } }
    });

    /** Serves the manifest and one verifier key the way the server's /zk-config route does. */
    function fakeFetch(files: Record<string, Uint8Array | string>) {
        return vi.fn(async (url: unknown) => {
            const body = files[String(url).slice(BASE.length + 1)];
            const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
            return {
                ok: bytes !== undefined, status: bytes ? 200 : 404, statusText: bytes ? 'OK' : 'Not Found',
                headers: { get: () => (typeof body === 'string' ? 'application/json' : 'application/octet-stream') },
                arrayBuffer: async () => bytes!.buffer.slice(bytes!.byteOffset, bytes!.byteOffset + bytes!.byteLength)
            };
        }) as unknown as typeof fetch;
    }
    const connector = {
        getConfiguration: async () => ({ indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws', substrateNodeUri: 'wss://node.example', networkId: 'preprod', proofServerUrl: 'http://localhost:6300' }),
        getShieldedAddresses: async () => ({ shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk', shieldedAddress: 'addr' })
    };
    const assemble = (files: Record<string, Uint8Array | string>, extra: Record<string, unknown> = {}) => createNightgateConnectorProviders({
        connector: connector as never, contractName: 'attestation-vault', webSocket: class {} as never,
        manifest: { contracts: [{ name: 'attestation-vault', zkConfigBaseUrl: BASE, circuits: ['attest'] }] },
        fetchFn: fakeFetch(files), ...extra
    });
    const served = { 'compiler/contract-manifest.json': MANIFEST, 'keys/attest.verifier': VERIFIER };

    it('names the runtime version the artifacts were compiled against, from the served manifest', async () => {
        const providers = await assemble(served);
        await expect(providers.zkConfigProvider.getArtifactRuntimeVersion()).resolves.toBe('0.21.0');
    });

    it('checks a served file against the manifest', async () => {
        const good = await assemble(served);
        expect(Array.from(await good.zkConfigProvider.getVerifierKey('attest'))).toEqual([1, 2, 3, 4]);
        const tampered = await assemble({ ...served, 'keys/attest.verifier': new Uint8Array([9, 9, 9, 9]) });
        await expect(tampered.zkConfigProvider.getVerifierKey('attest')).rejects.toThrow(/integrity/);
    });

    it('refuses a manifest other than the pinned one', async () => {
        const pinned = await assemble(served, { expectedManifestHash: sha256(new TextEncoder().encode(MANIFEST)) });
        await expect(pinned.zkConfigProvider.getArtifactRuntimeVersion()).resolves.toBe('0.21.0');
        const other = await assemble(served, { expectedManifestHash: '00'.repeat(32) });
        await expect(other.zkConfigProvider.getArtifactRuntimeVersion()).rejects.toThrow(/integrity/);
    });

    it('hands out the key file provider of midnight-js and no helper of its own for wallet proving', async () => {
        const { FetchZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-fetch-zk-config-provider');
        const browser = await import('../../src/browser/index.mjs' as string);
        expect(browser.FetchZkConfigProvider).toBe(FetchZkConfigProvider);
        const providers = await assemble(served);
        expect(providers.zkConfigProvider).toBeInstanceOf(FetchZkConfigProvider);
        expect(providers).not.toHaveProperty('keyMaterialProvider');
    });
});
