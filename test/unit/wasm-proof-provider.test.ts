/**
 * Tests for srv/midnight/wasm-proof-provider.ts: the in-process replacement
 * for midnight-js's httpClientProofProvider under NIGHTGATE_PROVING_MODE=wasm.
 * The ESM SDK modules are stubbed at the import seam (same policy as every
 * other suite); the real zkir/ledger path is exercised by the live e2e
 * (npm run wasm-contract:e2e with a dead proof-server URL).
 */

const provingProvider = vi.hoisted(() => (vi.fn((..._args: any[]) => ({ marker: 'proving-provider' }))));
vi.mock('@midnight-ntwrk/zkir-v2', () => ({
    provingProvider
}));

const initialCostModel = vi.hoisted(() => (vi.fn(() => ({ marker: 'cost-model' }))));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({
    CostModel: { initialCostModel }
}));

const zkConfigToProvingKeyMaterial = vi.hoisted(() => (vi.fn((cfg: any) => ({ converted: cfg }))));
vi.mock('@midnight-ntwrk/midnight-js-types', () => ({
    zkConfigToProvingKeyMaterial
}));

const fallbackLookupKey = vi.hoisted(() => (vi.fn(async () => ({ fallback: true }))));
const fallbackGetParams = vi.hoisted(() => (vi.fn(async () => new Uint8Array([9]))));
vi.mock('@midnightntwrk/wallet-sdk-prover-client/effect', () => ({
    WasmProver: {
        makeDefaultKeyMaterialProvider: () => ({
            lookupKey: fallbackLookupKey,
            getParams: fallbackGetParams
        })
    }
}));

import { isWasmProvingMode, buildWasmProofProvider } from '../../srv/midnight/wasm-proof-provider';

beforeEach(() => {
    provingProvider.mockClear();
    initialCostModel.mockClear();
    zkConfigToProvingKeyMaterial.mockClear();
    fallbackLookupKey.mockClear();
    fallbackGetParams.mockClear();
    delete process.env.NIGHTGATE_PROVING_MODE;
});

describe('isWasmProvingMode', () => {
    it('is false by default and for server', () => {
        expect(isWasmProvingMode()).toBe(false);
        process.env.NIGHTGATE_PROVING_MODE = 'server';
        expect(isWasmProvingMode()).toBe(false);
    });

    it('is true for wasm (case/whitespace tolerant)', () => {
        process.env.NIGHTGATE_PROVING_MODE = ' WASM ';
        expect(isWasmProvingMode()).toBe(true);
    });
});

describe('buildWasmProofProvider', () => {
    it('resolves contract circuits via the zkConfigProvider and converts the material', async () => {
        const zkConfigProvider = { get: vi.fn(async (loc: string) => ({ circuit: loc })) };
        await buildWasmProofProvider(zkConfigProvider);

        const km = provingProvider.mock.calls[0][0];
        const material = await km.lookupKey('mint');
        expect(zkConfigProvider.get).toHaveBeenCalledWith('mint');
        expect(zkConfigToProvingKeyMaterial).toHaveBeenCalledWith({ circuit: 'mint' });
        expect(material).toEqual({ converted: { circuit: 'mint' } });
        expect(fallbackLookupKey).not.toHaveBeenCalled();
    });

    it('falls back to the wallet key provider for non-contract circuits', async () => {
        const zkConfigProvider = { get: vi.fn(async () => { throw new Error('no such circuit'); }) };
        await buildWasmProofProvider(zkConfigProvider);

        const km = provingProvider.mock.calls[0][0];
        const material = await km.lookupKey('midnight/zswap/spend');
        expect(fallbackLookupKey).toHaveBeenCalledWith('midnight/zswap/spend');
        expect(material).toEqual({ fallback: true });
    });

    it('delegates getParams to the wallet key provider', async () => {
        await buildWasmProofProvider({ get: vi.fn() });
        const km = provingProvider.mock.calls[0][0];
        await km.getParams(13);
        expect(fallbackGetParams).toHaveBeenCalledWith(13);
    });

    it('proveTx runs unprovenTx.prove with the zkir proving provider and the initial cost model', async () => {
        const provider = await buildWasmProofProvider({ get: vi.fn() });
        const unprovenTx = { prove: vi.fn(async () => ({ proven: true })) };

        const result = await provider.proveTx(unprovenTx);

        expect(unprovenTx.prove).toHaveBeenCalledWith({ marker: 'proving-provider' }, { marker: 'cost-model' });
        expect(result).toEqual({ proven: true });
    });
});
