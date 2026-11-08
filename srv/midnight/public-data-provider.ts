// The indexer's public data provider alone, for code that only reads contract state.
// Does not import `@sap/cds`, because the decode worker loads it too.

import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';
import type { ContractState } from '@midnight-ntwrk/compact-runtime';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

export interface IndexerEndpoints {
    indexerHttpUrl: string;
    indexerWsUrl: string;
}

/** The part of the SDK's `PublicDataProvider` the readers use. */
export type ContractStateReader = Pick<PublicDataProvider, 'queryContractState'>;

type ContractStateRead = NonNullable<Awaited<ReturnType<ContractStateReader['queryContractState']>>>;

/** The decoded contract state, for a compiled contract's `ledger`. That function runs on compact-runtime and refuses ledger-v9's class of the same name.
 *  A state written by ledger 8 cannot be decoded here. */
export async function contractStateOf(read: ContractStateRead): Promise<ContractState> {
    const serialized = read.contractState;
    if (serialized.era !== 'v9') throw new Error(`contract state written by ledger ${String(serialized.era)}: this server reads ledger 9 states only`);
    const runtime = await import('@midnight-ntwrk/compact-runtime');
    return serialized.deserialize({ v9: runtime.ContractState });
}

const providers = new Map<string, Promise<ContractStateReader>>();

/** Reads a contract state and narrows it to ledger 9. Null when the contract has no state. */
export async function queryLedger9ContractState(reader: ContractStateReader, contractAddress: string, at?: { type: 'blockHeight'; blockHeight: number }): Promise<ContractState | null> {
    const read = await reader.queryContractState(contractAddress, at);
    return read && contractStateOf(read);
}

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
                WebSocket
            );
        })();
        providers.set(key, pending);
        pending.catch(() => providers.delete(key));
    }
    return pending;
}

export function __resetPublicDataProvidersForTests(): void {
    providers.clear();
}
