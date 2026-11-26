/**
 * Tests for connectContract (src/browser/contract.mjs): one call, a batch and a deploy on any contract
 * through a connected wallet. The midnight-js packages are stubbed at the import seam.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { __unprovenTxCodecForTests } from '../../src/shared/batch-segment-order.mjs';

const sdk = vi.hoisted(() => ({
    findDeployedContract: vi.fn(),
    deployContract: vi.fn(),
    withContractScopedTransaction: vi.fn()
}));
const wallet = vi.hoisted(() => ({
    dappConnectorNetwork: vi.fn(async () => ({ networkId: 'preprod', indexer: { queryURL: 'http://idx', subscriptionURL: 'ws://idx' } })),
    dappConnectorWalletProviders: vi.fn(async () => ({ walletProvider: { marker: 'wallet' }, midnightProvider: { marker: 'midnight' } })),
    dappConnectorProofProvider: vi.fn(async () => ({ marker: 'wallet-proof-provider' }))
}));
vi.mock('@midnightntwrk/midnight-js-contracts', () => sdk);
vi.mock('@midnightntwrk/midnight-js-dapp-connector-proof-provider', () => wallet);
vi.mock('@midnight-ntwrk/compact-js', () => ({
    CompiledContract: {
        make: (name: string, ctor: unknown) => ({ name, ctor, pipe(step: (c: unknown) => unknown) { return step(this); } }),
        withWitnesses: (witnesses: unknown) => (c: object) => ({ ...c, witnesses }),
        withVacantWitnesses: (c: object) => ({ ...c, witnesses: 'vacant' })
    }
}));
vi.mock('@midnightntwrk/midnight-js-protocol/v9', () => ({ CostModel: { initialCostModel: () => 'initial-cost-model' } }));
vi.mock('@midnightntwrk/midnight-js-indexer-public-data-provider', () => ({ indexerPublicDataProvider: () => ({ marker: 'public-data' }) }));
vi.mock('@midnightntwrk/midnight-js-http-client-proof-provider', () => ({ httpClientProofProvider: (uri: string) => ({ marker: 'http-provider', uri }) }));

type ContractModule = typeof import('../../src/browser/contract.mjs');
let connectContract: ContractModule['connectContract'];
beforeAll(async () => {
    ({ connectContract } = await import('../../src/browser/contract.mjs'));
    // A fake handle carries the transaction itself, so the batch path needs no ledger.
    __unprovenTxCodecForTests.set({ open: (h: any) => h.tx, seal: (tx: any) => ({ era: 'v9', tx }) } as any);
});
afterAll(() => __unprovenTxCodecForTests.set(undefined));
beforeEach(() => vi.clearAllMocks());

class Counter { }
const MANIFEST = { contracts: [{ name: 'counter', zkConfigBaseUrl: 'http://api/zk-config/counter', circuits: ['increment', 'reset'] }] };
const ADDRESS = 'aa'.repeat(32);
const LANDED = { txId: 'id-1', txHash: '0xhash', blockHeight: 12, status: 'SucceedEntirely' };
const RESULT = { txId: 'id-1', txHash: '0xhash', blockHeight: 12 };

function connector(extra: Record<string, unknown> = {}): any {
    return {
        getConfiguration: async () => ({ indexerUri: 'http://idx', indexerWsUri: 'ws://idx', substrateNodeUri: 'ws://node', networkId: 'preprod', proverServerUri: 'http://wallet-prover' }),
        getShieldedAddresses: async () => ({ shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk', shieldedAddress: 'addr' }),
        ...extra
    };
}

const connect = (opts: Record<string, unknown> = {}) => connectContract({
    connector: connector(), manifest: MANIFEST, contractName: 'counter', contractClass: Counter, contractAddress: ADDRESS, webSocket: class { }, ...opts
} as any);

/** A found contract whose circuits record their arguments and answer `LANDED`. */
function foundWith(...circuits: string[]) {
    const seen: Array<{ circuit: string; args: unknown[] }> = [];
    const callTx = Object.fromEntries(circuits.map(circuit => [circuit, vi.fn(async (...args: unknown[]) => {
        seen.push({ circuit, args });
        return { public: LANDED, private: { result: `${circuit}-result` } };
    })]));
    sdk.findDeployedContract.mockResolvedValue({ callTx });
    return { seen, callTx };
}

describe('connectContract', () => {
    it('names what is missing', async () => {
        await expect(connectContract({} as any)).rejects.toThrow(/connector is required/);
        await expect(connectContract({ connector: connector() } as any)).rejects.toThrow(/contractName is required/);
        await expect(connectContract({ connector: connector(), contractName: 'counter' } as any)).rejects.toThrow(/contractClass is required/);
        await expect(connect({ manifest: undefined })).rejects.toThrow(/manifest or manifestUrl is required/);
        await expect(connect({ ttlMinutes: 0 })).rejects.toThrow('connectContract: ttlMinutes must be a positive number (got 0)');
        await expect(connect({ ttlMinutes: 'soon' })).rejects.toThrow('connectContract: ttlMinutes must be a positive number (got soon)');
    });

    it('refuses at once when nothing can prove, and names both ways out', async () => {
        // No proof server named, and a wallet that reports none and does not prove itself.
        const mute = connector({ getConfiguration: async () => ({ indexerUri: 'http://idx', indexerWsUri: 'ws://idx', substrateNodeUri: 'ws://node', networkId: 'preprod' }) });
        await expect(connect({ connector: mute })).rejects.toThrow(/nothing can prove for this contract\. Pass proofServerUrl, or proving: 'wallet'/);
        expect(sdk.findDeployedContract).not.toHaveBeenCalled();
    });

    it('fetches the manifest from manifestUrl and reports network and proving', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => MANIFEST }));
        const counter = await connect({ manifest: undefined, manifestUrl: 'http://api/contract-manifest', fetchFn });
        expect(fetchFn).toHaveBeenCalledWith('http://api/contract-manifest');
        expect(counter.networkId).toBe('preprod');
        expect(counter.provingModality).toBe('server');
        expect(counter.contractAddress).toBe(ADDRESS);
    });

    it('fails when the manifest route answers with an error', async () => {
        const fetchFn = vi.fn(async () => ({ ok: false, status: 503 }));
        await expect(connect({ manifest: undefined, manifestUrl: 'http://api/contract-manifest', fetchFn })).rejects.toThrow(/answered 503/);
    });
});

describe('call', () => {
    it('runs the circuit with the wallet providers and returns the landed transaction and the circuit result', async () => {
        const { seen } = foundWith('increment');
        const counter = await connect({ ttlMinutes: 10 });
        const before = vi.fn();

        const out = await counter.call({ circuitId: 'increment', args: [1n, 2n], before });

        expect(out).toEqual({ ...RESULT, result: 'increment-result' });
        expect(before).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([{ circuit: 'increment', args: [1n, 2n] }]);
        const [providers, options] = sdk.findDeployedContract.mock.calls[0];
        expect(providers).toMatchObject({
            publicDataProvider: { marker: 'public-data' },
            proofProvider: { marker: 'http-provider', uri: 'http://wallet-prover' },
            walletProvider: { marker: 'wallet' },
            midnightProvider: { marker: 'midnight' },
            config: { networkId: 'preprod', ttlSeconds: 600 }
        });
        expect(options).toMatchObject({
            contractAddress: ADDRESS,
            compiledContract: { name: 'counter', ctor: Counter, witnesses: 'vacant' },
            privateStateId: 'counterPrivateState',
            initialPrivateState: {}
        });
    });

    it("binds the call's witnesses, else the ones given at connect", async () => {
        foundWith('increment');
        const connected = { marker: 'connected' };
        const own = { marker: 'own' };
        const counter = await connect({ witnesses: connected });

        await counter.call({ circuitId: 'increment' });
        await counter.call({ circuitId: 'increment', witnesses: own });

        expect(sdk.findDeployedContract.mock.calls[0][1].compiledContract.witnesses).toBe(connected);
        expect(sdk.findDeployedContract.mock.calls[1][1].compiledContract.witnesses).toBe(own);
    });

    it('proves on the proof server the app names instead of the one the wallet reports', async () => {
        foundWith('increment');
        const counter = await connect({ proofServerUrl: 'http://localhost:6300' });
        await counter.call({ circuitId: 'increment' });
        expect(sdk.findDeployedContract.mock.calls[0][0].proofProvider).toEqual({ marker: 'http-provider', uri: 'http://localhost:6300' });
    });

    it('refuses a call without an address, without a circuit id and on an unknown circuit', async () => {
        foundWith('increment');
        const fresh = await connect({ contractAddress: undefined });
        await expect(fresh.call({ circuitId: 'increment' })).rejects.toThrow(/no contractAddress; pass one or deploy first/);
        const counter = await connect();
        await expect(counter.call({} as any)).rejects.toThrow(/needs a call with a circuitId/);
        await expect(counter.call({ circuitId: 'missing' })).rejects.toThrow(/circuit 'missing' is not on the contract/);
    });
});

describe('deploy', () => {
    it('deploys with constructor arguments and sends later calls to the new address', async () => {
        const NEW = 'bb'.repeat(32);
        sdk.deployContract.mockResolvedValue({ deployTxData: { public: { ...LANDED, contractAddress: NEW } } });
        foundWith('increment');
        const witnesses = { marker: 'constructor' };
        const counter = await connect({ contractAddress: undefined });

        const out = await counter.deploy({ args: ['registrar', 'recovery'], witnesses });

        expect(out).toEqual({ ...RESULT, contractAddress: NEW });
        expect(sdk.deployContract.mock.calls[0][1]).toMatchObject({
            compiledContract: { name: 'counter', witnesses },
            privateStateId: 'counterPrivateState',
            initialPrivateState: {},
            args: ['registrar', 'recovery']
        });
        expect(counter.contractAddress).toBe(NEW);
        await counter.call({ circuitId: 'increment' });
        expect(sdk.findDeployedContract.mock.calls[0][1].contractAddress).toBe(NEW);
    });

    it('passes no args for a contract without constructor arguments', async () => {
        sdk.deployContract.mockResolvedValue({ deployTxData: { public: { ...LANDED, contractAddress: ADDRESS } } });
        const counter = await connect({ contractAddress: undefined });
        await counter.deploy();
        expect(sdk.deployContract.mock.calls[0][1]).not.toHaveProperty('args');
        expect(sdk.deployContract.mock.calls[0][1].compiledContract.witnesses).toBe('vacant');
    });
});

describe('batch', () => {
    function scopeLands() {
        sdk.withContractScopedTransaction.mockImplementation(async (_providers: unknown, fn: (ctx: unknown) => Promise<void>) => {
            await fn({ marker: 'ctx' });
            return { public: LANDED };
        });
    }

    it('runs the calls in array order in one scope, each after its before hook', async () => {
        scopeLands();
        const { seen } = foundWith('increment', 'reset');
        const order: string[] = [];
        const counter = await connect();

        const out = await counter.batch([
            { circuitId: 'increment', args: [1n], before: () => order.push('before increment') },
            { circuitId: 'reset', before: () => order.push('before reset') }
        ]);

        expect(out).toEqual(RESULT);
        expect(sdk.withContractScopedTransaction).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['before increment', 'before reset']);
        expect(seen).toEqual([
            { circuit: 'increment', args: [{ marker: 'ctx' }, 1n] },
            { circuit: 'reset', args: [{ marker: 'ctx' }] }
        ]);
    });

    it('binds one witnesses object for all calls', async () => {
        scopeLands();
        foundWith('increment', 'reset');
        const shared = { marker: 'shared' };
        const given = { marker: 'given' };
        const counter = await connect();

        await counter.batch([{ circuitId: 'increment', witnesses: shared }, { circuitId: 'reset', witnesses: shared }]);
        await counter.batch([{ circuitId: 'increment', witnesses: { a: 1 } }, { circuitId: 'reset', witnesses: { b: 2 } }], { witnesses: given });

        expect(sdk.findDeployedContract.mock.calls[0][1].compiledContract.witnesses).toBe(shared);
        expect(sdk.findDeployedContract.mock.calls[1][1].compiledContract.witnesses).toBe(given);
        await expect(counter.batch([{ circuitId: 'increment', witnesses: { a: 1 } }, { circuitId: 'reset', witnesses: { b: 2 } }]))
            .rejects.toThrow(/a batch needs ONE witnesses object/);
    });

    it('refuses an empty list, more than 8 calls and a call without a circuit id', async () => {
        const counter = await connect();
        await expect(counter.batch([])).rejects.toThrow(/non-empty array of calls/);
        await expect(counter.batch(Array.from({ length: 9 }, () => ({ circuitId: 'increment' })))).rejects.toThrow(/at most 8 calls/);
        await expect(counter.batch([{ circuitId: 'increment' }, {} as any])).rejects.toThrow(/needs a call with a circuitId/);
        expect(sdk.findDeployedContract).not.toHaveBeenCalled();
    });

    it('names an order the ledger would reject, with the calls read back from the message', async () => {
        foundWith('increment', 'reset');
        sdk.withContractScopedTransaction.mockRejectedValue(new Error(
            "batch [increment+reset] violates the ledger's causality constraint: split it. " +
            'Aborted before proving; nothing was submitted. Stages in apply order: increment=3[f] reset=7[g]'
        ));
        const counter = await connect();

        await expect(counter.batch([{ circuitId: 'increment' }, { circuitId: 'reset' }])).rejects.toMatchObject({
            code: 'BATCH_CAUSALITY_VIOLATION',
            calls: [{ name: 'increment', segId: 3, stages: 'f' }, { name: 'reset', segId: 7, stages: 'g' }]
        });
    });

    it('names a batch that runs out of gas', async () => {
        foundWith('increment', 'reset');
        sdk.withContractScopedTransaction.mockRejectedValue(new Error('batch [increment+reset] runs out of gas on the ledger: OutOfGas'));
        const counter = await connect();
        await expect(counter.batch([{ circuitId: 'increment' }, { circuitId: 'reset' }])).rejects.toMatchObject({ code: 'BATCH_GAS_BUDGET_EXCEEDED' });
    });
});
