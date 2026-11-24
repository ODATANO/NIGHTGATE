// The indexer's public data provider alone, for code that only reads contract state.
// Does not import `@sap/cds`, because the decode worker loads it too.

import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';
import { configNumber } from '../utils/config';
import { NightgateError, messageWithoutUrls } from '../utils/errors';
import { indexerQuery } from '../utils/indexer-graphql';
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
    if (serialized.era !== 'v9') throw new NightgateError('CONFLICT', `contract state written by ledger ${String(serialized.era)}: this server reads ledger 9 states only`);
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
 *  Calls for the same contract and height that overlap share one indexer request. Callers must not change the returned state.
 *  `current` keeps the decoded state for later reads. It is true for a read of the latest state or at the indexer's newest block. */
export function queryLedger9ContractState(reader: ContractStateReader, contractAddress: string, at?: { type: 'blockHeight'; blockHeight: number }, current: boolean = at === undefined): Promise<ContractState | null> {
    let pending = inFlight.get(reader);
    if (!pending) inFlight.set(reader, pending = new Map());
    const key = `${contractAddress.toLowerCase()}@${at ? at.blockHeight : 'latest'}`;
    const running = pending.get(key);
    if (running) return running;
    const started = (async () => {
        const read = await reader.queryContractState(contractAddress, at).catch((err: unknown) => {
            throw new NightgateError('BAD_GATEWAY', `indexer could not serve the state of contract ${contractAddress.toLowerCase()}: ${messageWithoutUrls(err, '<indexer>')}`, { cause: err });
        });
        return read ? decodedStateOf(contractAddress.toLowerCase(), read, current) : null;
    })().finally(() => pending.delete(key));
    pending.set(key, started);
    return started;
}

/** The state at `tipHeight`, a height `indexerTipHeight` named. Without a height, the latest state. */
export function queryLedger9ContractStateAtTip(reader: ContractStateReader, contractAddress: string, tipHeight?: number): Promise<ContractState | null> {
    return tipHeight === undefined
        ? queryLedger9ContractState(reader, contractAddress)
        : queryLedger9ContractState(reader, contractAddress, { type: 'blockHeight', blockHeight: tipHeight }, true);
}

// One read of the newest block serves a burst of checks. A slightly older height is still exact, because the state is read at it.
const TIP_REUSE_MS = 2_000;
const tips = new Map<string, { height: number; at: number }>();
const tipReads = new Map<string, Promise<number>>();

/** The height of the indexer's newest block. */
export function indexerTipHeight(indexerHttpUrl: string): Promise<number> {
    const kept = tips.get(indexerHttpUrl);
    if (kept && Date.now() - kept.at < TIP_REUSE_MS) return Promise.resolve(kept.height);
    const running = tipReads.get(indexerHttpUrl);
    if (running) return running;
    const started = (async () => {
        const data = await indexerQuery<{ block?: { height?: unknown } | null }>(indexerHttpUrl, '{ block { height } }');
        const height = Number(data?.block?.height);
        if (!Number.isSafeInteger(height) || height < 0) throw new Error('the answer names no block');
        tips.set(indexerHttpUrl, { height, at: Date.now() });
        return height;
    })().catch((err: unknown) => {
        throw new NightgateError('BAD_GATEWAY', `indexer could not name its newest block: ${messageWithoutUrls(err, '<indexer>')}`, { cause: err });
    }).finally(() => tipReads.delete(indexerHttpUrl));
    tipReads.set(indexerHttpUrl, started);
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
    tips.clear();
    decoded.clear();
    decodedBytes = 0;
}
