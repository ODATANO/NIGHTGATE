// A midnight-js PublicDataProvider that reads the chain through the NIGHTGATE API, for a builder that never submits itself.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { connect } from '../sdk/client.mjs';

const require = createRequire(import.meta.url);
const { deriveIndexerWsUrl } = require('../../srv/utils/indexer-url.js');

/** The client behind `api`: a connected `connect()` client, or the options to create one. */
export function apiClientFor(api) {
    if (api && typeof api.contractStateAt === 'function' && typeof api.transactionByIdentifier === 'function') return api;
    if (api && typeof api === 'object' && api.baseUrl) return connect(api);
    throw new Error('api must be the options for connect() ({ baseUrl, agentToken, ... }) or a connected client');
}

const GATEWAY_KEY = /^oda_[0-9a-f]{40}$/i;

/** The gateway's indexer lane for `connect()` options with a gateway key (`oda_…`), the key in the query string; null otherwise. */
export function gatewayIndexerUrls(api) {
    const baseUrl = api?.baseUrl;
    const token = api?.token;
    if (typeof baseUrl !== 'string' || typeof token !== 'string' || !GATEWAY_KEY.test(token)) return null;
    const http = new URL(`${baseUrl.replace(/\/+$/, '')}/indexer/api/v4/graphql`);
    http.searchParams.set('key', token);
    return { indexerHttpUrl: http.toString(), indexerWsUrl: deriveIndexerWsUrl(http.toString()) };
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

const bareHash = (hash) => String(hash).replace(/^0x/i, '').toLowerCase();

const toBytes = (base64) => new Uint8Array(Buffer.from(base64, 'base64'));

function heightOf(config) {
    if (config == null) return null;
    if (config.type === 'blockHeight') return Number(config.blockHeight);
    throw new Error(`the NIGHTGATE API serves contract state by block height, not by ${String(config.type)}`);
}

const notInBuildOnly = (method) => () => {
    throw new Error(`${method} is not available: this builder reads the chain through the NIGHTGATE API and never submits itself`);
};

// `mjTypes` (midnight-js-types) wraps the served bytes in the SDK's sealed record types. The SDK decodes them itself.
// `protocolVersion` dates a read when the server names no block: the version at which ledger 9 starts on the chain.
// `maxLagBlocks`: a state further behind the chain is refused. `stateRetryMs`: how long a 503 or 429 of stateAt is retried.
export function apiPublicDataProvider({ client, mjTypes, protocolVersion, pollMs = 2_000, watchTimeoutMs = 120_000, maxLagBlocks = 60, stateRetryMs = 30_000 }) {
    if (!client) throw new Error('apiPublicDataProvider: client is required');
    if (!mjTypes?.SerializedContractState?.fromBytes || !mjTypes?.LedgerTransaction?.fromBytes) throw new Error('apiPublicDataProvider: mjTypes module (midnight-js-types) is required');
    if (!(Number.isInteger(protocolVersion) && protocolVersion > 0)) throw new Error('apiPublicDataProvider: protocolVersion must be a positive integer');
    if (!(Number.isInteger(maxLagBlocks) && maxLagBlocks >= 0)) throw new Error('apiPublicDataProvider: maxLagBlocks must be a non-negative integer');

    // 503: the server's indexer has not reached the newest action yet. 429: its indexer budget is used up.
    async function stateWithRetry(address, height, retryMs = stateRetryMs) {
        const deadline = Date.now() + retryMs;
        for (;;) {
            try {
                return await client.contractStateAt({ address, height });
            } catch (err) {
                const status = Number(err?.status);
                if ((status !== 503 && status !== 429) || Date.now() >= deadline) throw err;
                const waitMs = Number(err?.retryAfterSeconds) > 0 ? Number(err.retryAfterSeconds) * 1000 : pollMs;
                await new Promise(r => setTimeout(r, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
            }
        }
    }

    async function snapshotAt(address, height, retryMs) {
        const snapshot = await stateWithRetry(address, height, retryMs);
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
            const found = await read(Math.max(0, deadline - Date.now()));
            if (found) return found;
            if (Date.now() >= deadline) throw new Error(`${what} not indexed by the NIGHTGATE server within ${watchTimeoutMs}ms`);
            await new Promise(r => setTimeout(r, pollMs));
        }
    }

    // midnight-js pins the newest block first and then reads states by its hash, so the provider keeps hash -> height.
    // The newest pin reads the server's current state, which needs no indexer and is the state at that block.
    const blockHeights = new Map();
    let latestPin = null;
    const noBlockYet = () => new Error('apiPublicDataProvider: the NIGHTGATE server has no indexed block yet; building through { api } needs a server whose crawler runs');
    async function readBlock(height) {
        if (typeof client.callFunction !== 'function') throw new Error('apiPublicDataProvider: the client cannot read blocks (no callFunction)');
        try {
            const block = height == null ? await client.callFunction('Blocks/latest') : await client.callFunction('Blocks/byHeight', { height });
            return block?.hash ? block : null;
        } catch (err) {
            if (Number(err?.status) === 404) return null;
            throw err;
        }
    }
    async function blockAt(height) {
        const block = await readBlock(height);
        if (!block) return null;
        // midnight-js passes the hash on as the circuit's parent block hash: 64 hex characters, no prefix.
        const info = { hash: bareHash(block.hash), height: Number(block.height), protocolVersion: Number(block.protocolVersion ?? protocolVersion) };
        blockHeights.set(info.hash, info);
        if (height == null) latestPin = info.hash;
        return info;
    }
    const heightAt = (config) => {
        if (config?.type !== 'blockHash') return heightOf(config);
        const hash = bareHash(config.blockHash);
        if (hash === latestPin) return null;
        const known = blockHeights.get(hash);
        if (known === undefined) throw new Error(`the NIGHTGATE API reads by height; block ${config.blockHash} was not handed out by queryBlock`);
        return known.height;
    };

    // A read is dated by the block it was pinned to, when one was handed out. The bytes carry the era that wrote them.
    const datedBy = (config) => (config?.type === 'blockHash' ? blockHeights.get(bareHash(config.blockHash))?.protocolVersion : undefined) ?? protocolVersion;

    const contractState = async (address, config, retryMs) => {
        const snapshot = await snapshotAt(address, heightAt(config), retryMs);
        if (!snapshot?.state) return null;
        return {
            protocolVersion: datedBy(config),
            contractState: mjTypes.SerializedContractState.fromBytes('v9', toBytes(snapshot.state)),
            // The SDK refuses a call without them and names the reason, so a read that needs none stays possible.
            ...(snapshot.ledgerParameters ? { ledgerParameters: mjTypes.SerializedLedgerParameters.fromBytes('v9', toBytes(snapshot.ledgerParameters)) } : {})
        };
    };

    return {
        queryContractState: contractState,

        async queryLatestProtocolVersion() {
            // Reads without pinning: a pin moved here would send the next read by hash to a block the operation did not choose.
            const block = await readBlock(null);
            if (!block) throw noBlockYet();
            return Number(block.protocolVersion ?? protocolVersion);
        },

        async queryBlock(config) {
            if (config?.type === 'blockHash') {
                heightAt(config);
                const hash = bareHash(config.blockHash);
                return { hash, ...blockHeights.get(hash) };
            }
            const height = heightOf(config);
            const block = await blockAt(height);
            if (!block && height == null) throw noBlockYet();
            return block;
        },

        async queryZSwapAndContractState(address, config) {
            const snapshot = await snapshotAt(address, heightAt(config));
            if (!snapshot?.state) return null;
            return {
                protocolVersion: datedBy(config),
                contractState: mjTypes.SerializedContractState.fromBytes('v9', toBytes(snapshot.state)),
                zswapChainState: mjTypes.SerializedZswapChainState.fromBytes('v9', toBytes(need(snapshot, 'zswapState', address))),
                ledgerParameters: mjTypes.SerializedLedgerParameters.fromBytes('v9', toBytes(need(snapshot, 'ledgerParameters', address)))
            };
        },

        async queryDeployContractState(address) {
            const deploy = await client.contractDeploy(address);
            if (!deploy) return null;
            return contractState(address, { type: 'blockHeight', blockHeight: deploy.blockHeight });
        },

        async watchForDeployTxData(address) {
            const deploy = await waitFor(`the deploy of contract ${address}`, () => client.contractDeploy(address));
            const tx = await client.ledgerTransaction(deploy.txHash);
            if (!tx) throw new Error(`the NIGHTGATE server holds no ledger transaction for the deploy of contract ${address}`);
            return {
                era: 'v9',
                tx: mjTypes.LedgerTransaction.fromBytes('v9', 'Finalized', toBytes(tx)),
                status: TX_STATUS[deploy.status] ?? deploy.status ?? undefined,
                txId: deploy.txId,
                identifiers: deploy.identifiers,
                txHash: deploy.ledgerTxHash ?? deploy.txHash,
                blockHeight: deploy.blockHeight,
                blockHash: deploy.blockHash,
                blockTimestamp: deploy.blockTimestamp,
                blockAuthor: null,
                indexerId: 0,
                protocolVersion: Number.isInteger(deploy.protocolVersion) ? deploy.protocolVersion : protocolVersion,
                segmentStatusMap: undefined,
                unshielded: { created: [], spent: [] }
            };
        },

        // A watch retries a 503 or 429 for its whole timeout, not only for stateRetryMs.
        watchForContractState: (address) => waitFor(`the state of contract ${address}`, (left) => contractState(address, undefined, left)),

        queryContractEvents: notInBuildOnly('queryContractEvents'),
        rawContractStateObservable: notInBuildOnly('rawContractStateObservable'),
        watchForTxData: notInBuildOnly('watchForTxData'),
        queryUnshieldedBalances: notInBuildOnly('queryUnshieldedBalances'),
        watchForUnshieldedBalances: notInBuildOnly('watchForUnshieldedBalances'),
        contractStateObservable: notInBuildOnly('contractStateObservable'),
        unshieldedBalancesObservable: notInBuildOnly('unshieldedBalancesObservable')
    };
}
