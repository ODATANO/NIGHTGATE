/**
 * Tests for srv/midnight/wasm-proof-provider.ts: the in-process replacement
 * for midnight-js's httpClientProofProvider under NIGHTGATE_PROVING_MODE=wasm.
 * The ESM SDK modules are stubbed at the import seam (same policy as every
 * other suite); the real zkir/ledger path is exercised by the live e2e
 * (npm run wasm-contract:e2e with a dead proof-server URL).
 */

const provingProvider = vi.hoisted(() => (vi.fn((..._args: any[]) => ({ check: vi.fn(async () => ['checked']), prove: vi.fn(async () => 'proof') }))));
vi.mock('@midnightntwrk/zkir-v2', () => ({
    provingProvider
}));

const v3Runtime = vi.hoisted(() => ({ check: vi.fn(async () => ['checked-v3']), prove: vi.fn(async () => new Uint8Array([3])) }));
const provingProviderV3 = vi.hoisted(() => vi.fn((..._args: any[]) => v3Runtime));
vi.mock('@midnightntwrk/zkir-v3', () => ({
    provingProvider: provingProviderV3
}));

const zkConfigToProvingKeyMaterial = vi.hoisted(() => (vi.fn((cfg: any) => ({ converted: cfg }))));
const createLedger9ProofProvider = vi.hoisted(() => (vi.fn((pp: any) => ({ proveTx: vi.fn(), from: pp }))));
vi.mock('@midnight-ntwrk/midnight-js-types', () => ({
    zkConfigToProvingKeyMaterial,
    createLedger9ProofProvider
}));

const fallbackLookupKey = vi.hoisted(() => (vi.fn(async () => ({ fallback: true }))));
const fallbackGetParams = vi.hoisted(() => (vi.fn(async () => new Uint8Array([9]))));
vi.mock('@midnightntwrk/wallet-sdk-prover-client/effect', () => ({
    WasmProver: {
        makeV9KeyMaterialProvider: () => ({
            lookupKey: fallbackLookupKey,
            getParams: fallbackGetParams
        })
    }
}));

vi.mock('@midnight-ntwrk/compact-js', () => ({
    parseContractKeyLocation: (loc: string) => {
        const m = /^contract:([0-9a-f]{64})\/(\w+)\?vk=([0-9a-f]{64})$/.exec(loc);
        return m ? { contractAddress: m[1], circuitId: m[2], verifierKeyHash: m[3] } : undefined;
    },
    hashVerifierKey: (vk: Uint8Array) => Buffer.from(vk).toString('hex').padEnd(64, '0')
}));

import { isWasmProvingMode, buildWasmProofProvider } from '../../srv/midnight/wasm-proof-provider';

beforeEach(() => {
    provingProvider.mockClear();
    createLedger9ProofProvider.mockClear();
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
    it('resolves a contract key location to its circuit and checks the deployed verifier key', async () => {
        const vk = new Uint8Array([0xab, 0xcd]);
        const zkConfigProvider: any = { get: vi.fn(async (circuit: string) => ({ circuitId: circuit, verifierKey: vk })) };
        await buildWasmProofProvider(zkConfigProvider);
        const km = provingProvider.mock.calls[0][0];
        const address = '12'.repeat(32);
        const good = `contract:${address}/mint?vk=${'abcd'.padEnd(64, '0')}`;
        expect(await km.lookupKey(good)).toEqual({ converted: { circuitId: 'mint', verifierKey: vk } });
        expect(zkConfigProvider.get).toHaveBeenCalledWith('mint');

        const stale = `contract:${address}/mint?vk=${'ef'.repeat(32)}`;
        await expect(km.lookupKey(stale)).rejects.toThrow(/keys of circuit 'mint' do not match contract/);
        expect(fallbackLookupKey).not.toHaveBeenCalled();
    });

    it('resolves contract circuits via the zkConfigProvider and converts the material', async () => {
        const zkConfigProvider: any = { get: vi.fn(async (loc: string) => ({ circuit: loc })) };
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

    it('wraps the zkir proving provider in a midnight-js proof provider', async () => {
        zkConfigToProvingKeyMaterial.mockReturnValueOnce({ ir: new Uint8Array() } as any).mockReturnValueOnce({ ir: new Uint8Array() } as any);
        const provider = await buildWasmProofProvider({ get: vi.fn() });
        const km = provingProvider.mock.calls[0][0];
        const zkirProvider = provingProvider.mock.results[0].value;
        const [passed] = (createLedger9ProofProvider.mock.calls[0] as any[]);
        expect(passed.lookupKey).toBe(km.lookupKey);
        expect(await passed.check('pre', 'mint')).toEqual(['checked']);
        expect(await passed.prove('pre', 'mint', 7n)).toBe('proof');
        expect(zkirProvider.prove).toHaveBeenCalledWith('pre', 'mint', 7n);
        expect(provider).toBe(createLedger9ProofProvider.mock.results[0].value);
    });
});

describe('buildWasmProofProvider: the zkir runtime follows the circuit file', () => {
    it('sends a zkir v3 circuit to the v3 runtime and every other circuit to the v2 runtime', async () => {
        const ir = (header: string) => new TextEncoder().encode(`${header}:rest`);
        fallbackLookupKey.mockImplementation((async (location: string) => ({ ir: ir(location === 'midnight/contract' ? 'midnight:ir-source[v3-generic]' : 'midnight:ir-source[v2]') })) as any);
        const zkConfigProvider = { get: vi.fn(async () => { throw new Error('not in the zkConfig'); }) };
        await buildWasmProofProvider(zkConfigProvider as any);
        const runtime = createLedger9ProofProvider.mock.calls.at(-1)![0];
        const v2Runtime = provingProvider.mock.results.at(-1)!.value;

        await runtime.check(new Uint8Array(1), 'midnight/contract');
        expect(v3Runtime.check).toHaveBeenCalledTimes(1);
        expect(v2Runtime.check).not.toHaveBeenCalled();

        await runtime.prove(new Uint8Array(1), 'midnight/dust/spend', 1n);
        expect(v2Runtime.prove).toHaveBeenCalledWith(expect.any(Uint8Array), 'midnight/dust/spend', 1n);
        expect(v3Runtime.prove).not.toHaveBeenCalled();
        fallbackLookupKey.mockImplementation((async () => ({ fallback: true })) as any);
    });
});
