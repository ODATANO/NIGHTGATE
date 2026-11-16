// The indexer's public data provider alone, for code that only reads contract state.
// Does not import `@sap/cds`, because the decode worker loads it too.

import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';
import { configNumber } from '../utils/config';
import type { ContractState } from '@midnight-ntwrk/compact-runtime';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

export interface IndexerEndpoints {
    indexerHttpUrl: string;
    indexerWsUrl: string;
}

/** The part of the SDK's `PublicDataProvider` the readers use. */
export type ContractStateReader = Pick<PublicDataProvider, 'queryContractState'>;

type ContractStateRead = NonNullable<Awaited<ReturnType<ContractStateReader['queryContractState']>>>;

function ledger9State(read: ContractStateRead): ContractStateRead['contractState'] {
    const serialized = read.contractState;
    if (serialized.era !== 'v9') throw new Error(`contract state written by ledger ${String(serialized.era)}: this server reads ledger 9 states only`);
    return serialized;
}

/** The decoded contract state, for a compiled contract's `ledger`. That function runs on compact-runtime and refuses ledger-v9's class of the same name.
 *  A state written by ledger 8 cannot be decoded here. */
export async function contractStateOf(read: ContractStateRead): Promise<ContractState> {
    const serialized = ledger9State(read);
    const runtime = await import('@midnight-ntwrk/compact-runtime');
    return serialized.deserialize({ v9: runtime.ContractState });
}

interface DecodedState {
    hash: string;
    bytes: number;
    state: ContractState;
}

// Decoding takes time in proportion to the state's size, so a contract's latest state is decoded once per change.
// The map keeps insertion order: its first key is the one used longest ago.
const decoded = new Map<string, DecodedState>();
let decodedBytes = 0;

function keepDecoded(address: string, entry: DecodedState): void {
    const budget = configNumber('NIGHTGATE_STATE_DECODE_CACHE_MB') * 1024 * 1024;
    const old = decoded.get(address);
    if (old) { decodedBytes -= old.bytes; decoded.delete(address); }
    if (entry.bytes > budget) return;
    decoded.set(address, entry);
    decodedBytes += entry.bytes;
    for (const [key, value] of decoded) {
        if (decodedBytes <= budget) break;
        decoded.delete(key);
        decodedBytes -= value.bytes;
    }
}

/** The decoded state of `address`. The kept one is reused while the indexer returns the same bytes. */
async function decodedStateOf(address: string, read: ContractStateRead, latest: boolean): Promise<ContractState> {
    const bytes = ledger9State(read).serialize();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const kept = decoded.get(address);
    if (kept?.hash === hash) {
        decoded.delete(address);
        decoded.set(address, kept);
        return kept.state;
    }
    const state = await contractStateOf(read);
    // A read at an older height does not replace the contract's latest state.
    if (latest) keepDecoded(address, { hash, bytes: bytes.length, state });
    return state;
}

const providers = new Map<string, Promise<ContractStateReader>>();
const inFlight = new WeakMap<ContractStateReader, Map<string, Promise<ContractState | null>>>();

/** Reads a contract state and narrows it to ledger 9. Null when the contract has no state.
 *  Calls for the same contract and height that overlap share one indexer request. Callers must not change the returned state. */
export function queryLedger9ContractState(reader: ContractStateReader, contractAddress: string, at?: { type: 'blockHeight'; blockHeight: number }): Promise<ContractState | null> {
    let pending = inFlight.get(reader);
    if (!pending) inFlight.set(reader, pending = new Map());
    const key = `${contractAddress.toLowerCase()}@${at ? at.blockHeight : 'latest'}`;
    const running = pending.get(key);
    if (running) return running;
    const started = (async () => {
        const read = await reader.queryContractState(contractAddress, at);
        return read ? decodedStateOf(contractAddress.toLowerCase(), read, at === undefined) : null;
    })().finally(() => pending.delete(key));
    pending.set(key, started);
    return started;
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
    decoded.clear();
    decodedBytes = 0;
}
