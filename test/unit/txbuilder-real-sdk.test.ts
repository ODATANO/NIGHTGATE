/**
 * The txbuilder's providers against the real midnight-js and the real ledger, on the published counter contract.
 * Only the server client and the proof step are stubs: a build ends where the unproven transaction reaches the prover.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

const counterDir = join(process.cwd(), 'node_modules/@odatano/contract-counter/managed/counter');
const NETWORK = 'preview';
const LEDGER_9_SPEC = 2_001_000;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

let ledger: any, contracts: any, mjTypes: any, mjUtils: any, mjProtocol: any, compiled: any, zkConfigProvider: any;
let apiPublicDataProvider: any, InMemoryPrivateStateProvider: any, applyGasHeadroom: any;
let contractAddress: string, stateBytes: Uint8Array;

class Reached extends Error {}

function wrappedProviders(publicDataProvider: any) {
    const seen: any[] = [];
    return {
        seen,
        providers: {
            publicDataProvider,
            zkConfigProvider,
            privateStateProvider: new InMemoryPrivateStateProvider(),
            proofProvider: { supportedEras: ['v9'], proveTx: async (tx: any) => { seen.push(tx); throw new Reached('reached the prover'); } },
            walletProvider: { supportedEras: ['v9'], getCoinPublicKey: () => '00'.repeat(32), getEncryptionPublicKey: () => '00'.repeat(32) },
            midnightProvider: { supportedEras: ['v9'] },
            config: { networkId: NETWORK, ttlSeconds: 600 }
        }
    };
}

function apiProvider() {
    const client = {
        contractStateAt: async () => ({
            height: 5,
            state: b64(stateBytes),
            zswapState: b64(new ledger.ZswapChainState().serialize()),
            ledgerParameters: b64(ledger.LedgerParameters.initialParameters().serialize())
        }),
        contractDeploy: async () => ({ txHash: '0xdeploy', blockHeight: 5, blockHash: 'b5', blockTimestamp: 1, protocolVersion: LEDGER_9_SPEC, status: 'SUCCESS', identifiers: ['id0'], txId: 'id0' }),
        ledgerTransaction: async () => b64(ledger.Transaction.fromParts(NETWORK).mockProve().serialize()),
        transactionByIdentifier: async () => null,
        callFunction: async () => ({ hash: `0x${'ab'.repeat(32)}`, height: 5, protocolVersion: LEDGER_9_SPEC })
    };
    return apiPublicDataProvider({ client, mjTypes, mjUtils, mjProtocol, protocolVersion: 2_000_000 });
}

beforeAll(async () => {
    ledger = await import('@midnightntwrk/ledger-v9');
    contracts = await import('@midnight-ntwrk/midnight-js-contracts');
    mjTypes = await import('@midnight-ntwrk/midnight-js-types');
    mjUtils = await import('@midnight-ntwrk/midnight-js-utils');
    mjProtocol = await import('@midnight-ntwrk/midnight-js-protocol');
    const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
    const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
    ({ InMemoryPrivateStateProvider } = await import('@odatano/contract-kit' as string));
    ({ apiPublicDataProvider } = await import('../../src/txbuilder/api-provider.mjs' as string));
    ({ applyGasHeadroom } = await import('../../src/txbuilder/index.mjs' as string));
    const counter = await import('@odatano/contract-counter' as string);
    compiled = (CompiledContract as any).make('counter', counter.Contract).pipe(
        (CompiledContract as any).withVacantWitnesses,
        (CompiledContract as any).withCompiledFileAssets(counterDir)
    );
    zkConfigProvider = new NodeZkConfigProvider(counterDir);

    const deploy = await contracts.createUnprovenDeployTx(
        { ...wrappedProviders(null).providers, publicDataProvider: undefined },
        { compiledContract: compiled, signingKey: ledger.sampleSigningKey() }
    );
    contractAddress = deploy.public.contractAddress;
    stateBytes = deploy.public.initialContractState.serialize();
}, 120_000);

describe('txbuilder providers on the real SDK', () => {
    it('a deploy through the API provider reaches the prover', async () => {
        const { providers, seen } = wrappedProviders(apiProvider());
        await expect(contracts.deployContract(providers, { compiledContract: compiled, privateStateId: 'ps', initialPrivateState: {} })).rejects.toThrow();
        expect(seen).toHaveLength(1);
        expect(seen[0].stage).toBe('Unproven');
    }, 60_000);

    it('attaching and calling through the API provider and the kit provider reaches the prover', async () => {
        const { providers, seen } = wrappedProviders(apiProvider());
        const found = await contracts.findDeployedContract(providers, { contractAddress, compiledContract: compiled, privateStateId: 'ps', initialPrivateState: {} });
        await expect(found.callTx.increment()).rejects.toThrow();
        expect(seen).toHaveLength(1);
        expect(await providers.privateStateProvider.forContract(contractAddress).get('ps')).toEqual({});
    }, 60_000);

    it('the protocol version read leaves the pinned block alone', async () => {
        const provider = apiProvider();
        const pinned = await provider.queryBlock();
        expect(pinned).toEqual({ hash: 'ab'.repeat(32), height: 5, protocolVersion: LEDGER_9_SPEC });
        expect(await provider.queryLatestProtocolVersion()).toBe(LEDGER_9_SPEC);
        const read = await provider.queryZSwapAndContractState(contractAddress, { type: 'blockHash', blockHash: pinned.hash });
        expect(read.protocolVersion).toBe(LEDGER_9_SPEC);
        expect(read.contractState.era).toBe('v9');
    });

    it('gasHeadroom opens the sealed call, scales its gas and seals it for the prover', async () => {
        const publicDataProvider = apiProvider();
        const { providers, seen } = wrappedProviders(publicDataProvider);
        const options = contracts.createCallTxOptions(compiled, 'increment', contractAddress, 'ps', undefined, []);
        await providers.privateStateProvider.forContract(contractAddress).set('ps', {});
        const data = await contracts.createUnprovenCallTx(providers, options);
        const gasOf = (tx: any) => [...tx.intents.values()][0].actions[0].guaranteedTranscript.gas;
        const before = gasOf(data.private.unprovenTx.deserialize({ v9: ledger.Transaction }));

        const contractState = await publicDataProvider.queryContractState(contractAddress);
        const { unprovenTx, declared } = applyGasHeadroom({ ledger, mjTypes }, data, 2, { contractAddress, circuitId: 'increment', contractState });
        expect(declared.guaranteed.computeTime).toBe(String(before.computeTime));

        await expect(contracts.submitTx(providers, { unprovenTx, circuitId: 'increment' })).rejects.toThrow();
        expect(seen).toHaveLength(1);
        const after = gasOf(seen[0].deserialize({ v9: ledger.Transaction }));
        expect(after.computeTime).toBe(before.computeTime * 2n);
        expect(after.bytesDeleted).toBe(before.bytesDeleted);
    }, 60_000);

    it('gasHeadroom is lowered to what the ledger\'s time to dismiss leaves, with the limits read from the real parameters', async () => {
        const { timeToDismissLimits } = await import('../../src/txbuilder/index.mjs' as string);
        expect(timeToDismissLimits(ledger.LedgerParameters.initialParameters())).toEqual({ perByte: 2e6, min: 15e9 });

        const publicDataProvider = apiProvider();
        const { providers } = wrappedProviders(publicDataProvider);
        const options = contracts.createCallTxOptions(compiled, 'increment', contractAddress, 'ps', undefined, []);
        await providers.privateStateProvider.forContract(contractAddress).set('ps', {});
        // One read gives the builder the verifier key and the chain's limits.
        const read = await publicDataProvider.queryZSwapAndContractState(contractAddress);
        const ledgerParameters = read.ledgerParameters.deserialize({ v9: ledger.LedgerParameters });
        const at = { contractAddress, circuitId: 'increment', contractState: read };
        const costOf = (sealed: any) => () => sealed.deserialize({ v9: ledger.Transaction }).cost(ledgerParameters, true);

        const capped = applyGasHeadroom({ ledger, mjTypes }, await contracts.createUnprovenCallTx(providers, options), 10, { ...at, ledgerParameters });
        expect(capped.factor).toBeGreaterThan(1.5);
        expect(capped.factor).toBeLessThan(10);
        expect(costOf(capped.unprovenTx)).not.toThrow();

        // Without the parameters the factor stays as asked, and the ledger refuses that transaction.
        const asAsked = applyGasHeadroom({ ledger, mjTypes }, await contracts.createUnprovenCallTx(providers, options), 10, at);
        expect(asAsked.factor).toBe(10);
        expect(costOf(asAsked.unprovenTx)).toThrow(/time to dismiss/);
    }, 60_000);

    it('a state decoded for the readers works in the compiled contract\'s ledger function', async () => {
        const { contractStateOf } = await import('../../srv/midnight/public-data-provider' as string);
        const counter = await import('@odatano/contract-counter' as string);
        const read = await apiProvider().queryContractState(contractAddress);
        const state: any = await contractStateOf(read);
        expect(counter.ledger(state.data).round).toBe(0n);
    });

    it('reads the bytes of a contract from before the fork under ledger 8', async () => {
        const ledger8: any = await import('@midnightntwrk/ledger-v8' as string);
        const client = {
            contractStateAt: async () => ({ height: 5, state: b64(new ledger8.ContractState().serialize()), ledgerParameters: b64(ledger8.LedgerParameters.initialParameters().serialize()) }),
            contractDeploy: async () => ({ txHash: '0xdeploy', blockHeight: 5, blockHash: 'b5', protocolVersion: 1_000_300, status: 'SUCCESS', identifiers: ['id0'], txId: 'id0' }),
            ledgerTransaction: async () => b64(ledger8.Transaction.fromParts(NETWORK).mockProve().serialize()),
            transactionByIdentifier: async () => null
        };
        const provider = apiPublicDataProvider({ client, mjTypes, mjUtils, mjProtocol, protocolVersion: 2_000_000 });
        const deploy = await provider.watchForDeployTxData(contractAddress);
        expect(deploy.era).toBe('v8');
        expect(deploy.tx.era).toBe('v8');
        const state = await provider.queryDeployContractState(contractAddress);
        expect(state.contractState.era).toBe('v8');
        expect(state.ledgerParameters.era).toBe('v8');
        expect(state.protocolVersion).toBe(1_000_300);
    });

    it('a state of another kind is refused, not passed on', async () => {
        const client = { contractStateAt: async () => ({ height: 5, state: b64(new TextEncoder().encode('not a state')) }), callFunction: async () => null, contractDeploy: async () => null, transactionByIdentifier: async () => null };
        const provider = apiPublicDataProvider({ client, mjTypes, mjUtils, mjProtocol, protocolVersion: 2_000_000 });
        await expect(provider.queryContractState(contractAddress)).rejects.toThrow();
    });
});
