// Calls, batches and deploys on one contract through a connected wallet.
// The wallet balances, pays and submits every transaction.

import { createNightgateConnectorProviders } from './providers.mjs';

const MAX_BATCH_CALLS = 8;

async function loadManifest(manifestUrl, fetchFn) {
    if (!manifestUrl) throw new Error('connectContract: manifest or manifestUrl is required');
    const doFetch = fetchFn ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('connectContract: no fetch available; pass fetchFn');
    const res = await doFetch(manifestUrl);
    if (!res.ok) throw new Error(`connectContract: the manifest at ${manifestUrl} answered ${res.status}`);
    return res.json();
}

function assertCall(call, where) {
    if (!call || typeof call.circuitId !== 'string' || !call.circuitId) {
        throw new Error(`connectContract: ${where} needs a call with a circuitId, as the prepare helpers return it`);
    }
}

/** A contract instance takes its witnesses once, so the calls of a batch share one object. */
function batchWitnesses(calls, given, connected) {
    if (given) return given;
    const perCall = calls.map(c => c.witnesses).filter(w => w !== undefined);
    if (perCall.length === 0) return connected;
    if (perCall.length === calls.length && perCall.every(w => w === perCall[0])) return perCall[0];
    throw new Error(
        'connectContract: a batch needs ONE witnesses object for all calls. Pass `witnesses` to batch() ' +
        "and set what differs per call in each call's `before` hook, or give every call the same `witnesses`."
    );
}

// midnight-js calls the ledger identifier `txId` and the hash explorers show `txHash`.
const landed = (pub) => ({ txId: pub.txId, txHash: pub.txHash, blockHeight: pub.blockHeight });

/** Connects to one contract of the server's manifest. Returns `call`, `batch` and `deploy` for it. */
export async function connectContract(opts = {}) {
    const {
        connector, contractName, contractClass, manifestUrl, fetchFn, webSocket, expectedManifestHash,
        proving = 'server', proofServerUrl, witnesses: connectedWitnesses, initialPrivateState, ttlMinutes = 30
    } = opts;
    if (!connector) throw new Error('connectContract: connector is required (the connected wallet)');
    if (!contractName) throw new Error('connectContract: contractName is required (the name in the manifest)');
    if (typeof contractClass !== 'function') throw new Error('connectContract: contractClass is required (the compiled Contract)');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error(`connectContract: ttlMinutes must be a positive number (got ${String(ttlMinutes)})`);
    const privateStateId = opts.privateStateId ?? `${contractName}PrivateState`;
    let contractAddress = opts.contractAddress;

    const manifest = opts.manifest ?? await loadManifest(manifestUrl, fetchFn);
    const [assembled, contracts, { CompiledContract }, walletMod] = await Promise.all([
        createNightgateConnectorProviders({ connector, manifest, manifestUrl, contractName, fetchFn, webSocket, proving, proofServerUrl, expectedManifestHash }),
        import('@midnightntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/compact-js'),
        import('@midnightntwrk/midnight-js-dapp-connector-proof-provider')
    ]);
    if (assembled.provingModality === 'none') {
        throw new Error("connectContract: nothing can prove for this contract. Pass proofServerUrl, or proving: 'wallet' for a wallet that proves itself");
    }
    const [network, walletProviders] = await Promise.all([
        walletMod.dappConnectorNetwork(connector),
        walletMod.dappConnectorWalletProviders(connector)
    ]);
    const providers = {
        publicDataProvider: assembled.publicDataProvider,
        zkConfigProvider: assembled.zkConfigProvider,
        proofProvider: assembled.proofProvider,
        privateStateProvider: assembled.privateStateProvider,
        ...walletProviders,
        config: { networkId: network.networkId, ttlSeconds: ttlMinutes * 60 }
    };

    const compiledWith = (witnesses) => CompiledContract.make(contractName, contractClass).pipe(
        witnesses ? CompiledContract.withWitnesses(witnesses) : CompiledContract.withVacantWitnesses
    );
    const find = (witnesses) => {
        if (!contractAddress) throw new Error('connectContract: no contractAddress; pass one or deploy first');
        return contracts.findDeployedContract(providers, {
            contractAddress,
            compiledContract: compiledWith(witnesses),
            privateStateId,
            initialPrivateState: initialPrivateState ?? {}
        });
    };

    return {
        get contractAddress() { return contractAddress; },
        networkId: network.networkId,
        provingModality: assembled.provingModality,

        /** Runs one circuit call as one transaction. */
        async call(call) {
            assertCall(call, 'call()');
            const found = await find(call.witnesses ?? connectedWitnesses);
            const run = found.callTx?.[call.circuitId];
            if (typeof run !== 'function') throw new Error(`connectContract: circuit '${call.circuitId}' is not on the contract at ${contractAddress}`);
            if (typeof call.before === 'function') call.before();
            const data = await run(...(call.args ?? []));
            return { ...landed(data.public), result: data.private?.result };
        },

        /** Runs up to 8 calls as one transaction, in array order. Fails before proving when the ledger would reject it. */
        async batch(calls, { witnesses, independentCalls = false, orderedPrefix = 0 } = {}) {
            if (!Array.isArray(calls) || calls.length === 0) throw new Error('connectContract: batch() needs a non-empty array of calls');
            if (calls.length > MAX_BATCH_CALLS) throw new Error(`connectContract: batch() takes at most ${MAX_BATCH_CALLS} calls`);
            for (const c of calls) assertCall(c, 'batch()');
            const found = await find(batchWitnesses(calls, witnesses, connectedWitnesses));
            const { runBatchInScope, tagBatchError } = await import('../shared/batch-call-scope.mjs');
            const scopeCalls = calls.map(c => ({ circuit: c.circuitId, args: c.args ?? [], ...(typeof c.before === 'function' ? { before: c.before } : {}) }));
            try {
                const out = await runBatchInScope(contracts, providers, found, scopeCalls, contractAddress,
                    { independentCalls: independentCalls === true, orderedPrefix: Number(orderedPrefix) || 0 });
                return landed(out);
            } catch (e) {
                throw tagBatchError(e);
            }
        },

        /** Deploys the contract. Later calls of this object go to the new address. */
        async deploy({ args, witnesses, initialPrivateState: deployState } = {}) {
            const deployed = await contracts.deployContract(providers, {
                compiledContract: compiledWith(witnesses ?? connectedWitnesses),
                privateStateId,
                initialPrivateState: deployState ?? initialPrivateState ?? {},
                ...(Array.isArray(args) && args.length > 0 ? { args } : {})
            });
            const pub = deployed.deployTxData.public;
            contractAddress = pub.contractAddress;
            return { ...landed(pub), contractAddress };
        }
    };
}
