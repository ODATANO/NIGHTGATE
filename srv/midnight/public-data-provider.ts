/**
 * The indexer's public data provider on its own, for code that only reads contract state.
 * One provider per indexer, kept for the life of the thread.
 * This module does not import `@sap/cds`, because the decode worker loads it too.
 */

import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';

export interface IndexerEndpoints {
    indexerHttpUrl: string;
    indexerWsUrl: string;
}

/** The part of the SDK's `PublicDataProvider` the readers use. */
export interface ContractStateReader {
    queryContractState(contractAddress: string, at?: { type: 'blockHeight'; blockHeight: number }): Promise<ContractStateLike | null>;
}

/** The SDK hands the ledger state back either bare or wrapped in `data`. */
export type ContractStateLike = { data?: unknown } & object;

const providers = new Map<string, Promise<ContractStateReader>>();

export function buildPublicDataProvider(endpoints: IndexerEndpoints): Promise<ContractStateReader> {
    if (!endpoints.indexerHttpUrl || !endpoints.indexerWsUrl) {
        throw new Error('indexerHttpUrl and indexerWsUrl are required');
    }
    const key = `${endpoints.indexerHttpUrl}|${endpoints.indexerWsUrl}`;
    let pending = providers.get(key);
    if (!pending) {
        pending = (async () => {
            const sdk = await loadMidnightSdk();
            // Node has no built-in WebSocket; pass `ws` explicitly.
            return sdk.indexer.indexerPublicDataProvider(
                endpoints.indexerHttpUrl,
                endpoints.indexerWsUrl,
                WebSocket as unknown as typeof import('isomorphic-ws').WebSocket
            ) as ContractStateReader;
        })();
        providers.set(key, pending);
        pending.catch(() => providers.delete(key));
    }
    return pending;
}

export function __resetPublicDataProvidersForTests(): void {
    providers.clear();
}
