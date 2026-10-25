// A midnight-js PublicDataProvider that reads the chain through the NIGHTGATE API, for a builder that never submits itself.
// SPDX-License-Identifier: Apache-2.0

import { connect } from '../sdk/client.mjs';

/** The client behind `api`: a connected `connect()` client, or the options to create one. */
export function apiClientFor(api) {
    if (api && typeof api.contractStateAt === 'function' && typeof api.transactionByIdentifier === 'function') return api;
    if (api && typeof api === 'object' && api.baseUrl) return connect(api);
    throw new Error('api must be the options for connect() ({ baseUrl, agentToken, ... }) or a connected client');
}

/** The wallet facade's submission service for a builder that never submits. Nothing is dialed. */
export function buildOnlySubmissionService() {
    return () => ({
        submitTransaction: async () => { throw new Error('this builder never submits: hand the built transaction to a sponsor'); },
        close: async () => undefined
    });
}

// The SDK's status names for the server's result status.
const TX_STATUS = { SUCCESS: 'SucceedEntirely', PARTIAL_SUCCESS: 'FailFallible', FAILURE: 'FailEntirely' };

const toBytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

function heightOf(config) {
    if (config == null) return null;
    if (config.type === 'blockHeight') return Number(config.blockHeight);
    throw new Error(`the NIGHTGATE API serves contract state by block height, not by ${String(config.type)}`);
}

const notInBuildOnly = (method) => () => {
    throw new Error(`${method} is not available: this builder reads the chain through the NIGHTGATE API and never submits itself`);
};

// `runtime` (compact-runtime) deserializes the contract state: circuits run on its ContractState class, and ledger-v8's
// class of the same name is refused. `ledger` deserializes the zswap state and the ledger parameters.
// `maxLagBlocks`: a state further behind the chain is refused; a server's states trail it by some ten blocks normally.
export function apiPublicDataProvider({ client, ledger, runtime, pollMs = 2_000, watchTimeoutMs = 120_000, maxLagBlocks = 60 }) {
    if (!client) throw new Error('apiPublicDataProvider: client is required');
    if (!ledger?.ZswapChainState?.deserialize || !ledger?.LedgerParameters?.deserialize) throw new Error('apiPublicDataProvider: ledger module is required');
    if (!runtime?.ContractState?.deserialize) throw new Error('apiPublicDataProvider: runtime module (compact-runtime) is required');
    if (!(Number.isInteger(maxLagBlocks) && maxLagBlocks >= 0)) throw new Error('apiPublicDataProvider: maxLagBlocks must be a non-negative integer');

    async function snapshotAt(address, height) {
        const snapshot = await client.contractStateAt({ address, height });
        if (snapshot?.coveredHeight != null && snapshot.chainHeight != null) {
            const lag = Number(snapshot.chainHeight) - Number(snapshot.coveredHeight);
            if (lag > maxLagBlocks) {
                throw new Error(`the NIGHTGATE server's contract states end at block ${snapshot.coveredHeight}, the chain is at ${snapshot.chainHeight} (${lag} blocks behind, allowed ${maxLagBlocks}); a build on this state could fail on chain, retry later or raise maxLagBlocks`);
            }
        }
        return snapshot;
    }

    const need = (snapshot, field, address) => {
        if (snapshot[field] == null) {
            throw new Error(`the NIGHTGATE server knows no ${field} for contract ${address} at height ${snapshot.height}; it needs crawler.indexerSupplement or a reachable indexer`);
        }
        return snapshot[field];
    };

    async function waitFor(what, read) {
        const deadline = Date.now() + watchTimeoutMs;
        for (;;) {
            const found = await read();
            if (found) return found;
            if (Date.now() >= deadline) throw new Error(`${what} not indexed by the NIGHTGATE server within ${watchTimeoutMs}ms`);
            await new Promise(r => setTimeout(r, pollMs));
        }
    }

    const contractState = async (address, config) => {
        const snapshot = await snapshotAt(address, heightOf(config));
        return snapshot?.state ? runtime.ContractState.deserialize(toBytes(snapshot.state)) : null;
    };

    return {
        queryContractState: contractState,

        async queryZSwapAndContractState(address, config) {
            const snapshot = await snapshotAt(address, heightOf(config));
            if (!snapshot?.state) return null;
            return [
                ledger.ZswapChainState.deserialize(toBytes(need(snapshot, 'zswapState', address))),
                runtime.ContractState.deserialize(toBytes(snapshot.state)),
                ledger.LedgerParameters.deserialize(toBytes(need(snapshot, 'ledgerParameters', address)))
            ];
        },

        async queryDeployContractState(address) {
            const deploy = await client.contractDeploy(address);
            if (!deploy) return null;
            return contractState(address, { type: 'blockHeight', blockHeight: deploy.blockHeight });
        },

        async watchForDeployTxData(address) {
            const deploy = await waitFor(`the deploy of contract ${address}`, () => client.contractDeploy(address));
            return {
                status: TX_STATUS[deploy.status] ?? deploy.status ?? undefined,
                txId: deploy.txId,
                identifiers: deploy.identifiers,
                txHash: deploy.ledgerTxHash ?? deploy.txHash,
                blockHeight: deploy.blockHeight,
                blockHash: deploy.blockHash,
                segmentStatusMap: undefined,
                unshielded: { created: [], spent: [] }
            };
        },

        watchForContractState: (address) => waitFor(`the state of contract ${address}`, () => contractState(address)),

        watchForTxData: notInBuildOnly('watchForTxData'),
        queryUnshieldedBalances: notInBuildOnly('queryUnshieldedBalances'),
        watchForUnshieldedBalances: notInBuildOnly('watchForUnshieldedBalances'),
        contractStateObservable: notInBuildOnly('contractStateObservable'),
        unshieldedBalancesObservable: notInBuildOnly('unshieldedBalancesObservable')
    };
}
