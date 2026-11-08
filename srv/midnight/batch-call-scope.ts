import {
    type BatchOrderOptions,
    type UnprovenTxCodec,
    unprovenTxCodec,
    withObservedBatchSegments,
    withOrderedBatchSegments
} from './batch-segment-order';
import type { ProofProvider, PublicDataProvider, UnprovenTx } from '@midnight-ntwrk/midnight-js-types';
import { checkBatchGas } from './batch-gas-preflight';
import { runtimeConfigEnum } from './runtime-config';

export interface BatchCall {
    circuit: string;
    args: unknown[];
    before?: () => void;
}

/** What the SDK reports about a landed transaction. */
export interface LandedTx { txHash?: unknown; status?: unknown; blockHeight?: unknown }

// The circuits come from a dynamically imported contract artifact, so the scope API and the
// found contract are used through these shapes. Method syntax lets the SDK's generic
// signatures fit them.
export interface ScopedContracts {
    withContractScopedTransaction?(
        providers: unknown,
        fn: (txCtx: unknown) => Promise<void>,
        options?: { scopeName?: string; additionalCoinEncPublicKeyMappings?: ReadonlyMap<string, string> }
    ): Promise<{ public?: LandedTx } | undefined>;
}
export interface FoundBatchContract {
    callTx?: Partial<Record<string, (txCtx: unknown, ...args: unknown[]) => Promise<unknown>>>;
}
/** The providers a batch reads: the proof provider it wraps, and the state reader and network of the gas check. */
interface BatchProviders {
    proofProvider?: Pick<ProofProvider, 'proveTx'>;
    publicDataProvider?: Partial<Pick<PublicDataProvider, 'queryZSwapAndContractState'>>;
    config?: { networkId?: string };
}

/** The block height a finalized tx landed in, or null when the SDK reported none. */
export function landedHeight(pub: LandedTx | undefined): number | null {
    const h = Number(pub?.blockHeight);
    return Number.isInteger(h) && h >= 0 ? h : null;
}

export interface BatchScopeResult {
    txHash: string;
    onChainStatus: string;
    /** Indexer block height of the inclusion, when the SDK reported one. */
    blockHeight: number | null;
    circuits: string[];
}

/** The segment id of the call the scope built last, or NaN when it has not exactly one. */
export function lastCallSegmentId(txCtx: unknown, codec: UnprovenTxCodec): number {
    try {
        const ctx = txCtx as { getLastUnsubmittedCallTxDataToTransact?(): Array<{ private?: { unprovenTx?: UnprovenTx } }> | undefined } | undefined;
        const handle = ctx?.getLastUnsubmittedCallTxDataToTransact?.()?.[0]?.private?.unprovenTx;
        const intents = handle ? codec.open(handle).intents : undefined;
        const ids = intents && typeof intents.keys === 'function' ? Array.from(intents.keys()) : [];
        return ids.length === 1 ? Number(ids[0]) : NaN;
    } catch {
        return NaN;
    }
}

/** Runs several circuit calls on one contract as one transaction, in call order unless `orderOpts.independentCalls` is set. */
export async function runBatchInScope(
    contracts: ScopedContracts,
    providers: unknown,
    found: FoundBatchContract,
    calls: BatchCall[],
    contractAddress: string,
    orderOpts: BatchOrderOptions = {},
    /** Passed to the SDK's scope: recipient keys for coins a call creates for another wallet. */
    scopeOpts: { additionalCoinEncPublicKeyMappings?: ReadonlyMap<string, string> } = {}
): Promise<BatchScopeResult> {
    if (!Array.isArray(calls) || calls.length === 0) {
        throw new Error('submitContractCallBatch: calls must be a non-empty array');
    }
    const scoped = contracts?.withContractScopedTransaction?.bind(contracts);
    if (typeof scoped !== 'function') {
        throw new Error(
            'submitContractCallBatch: withContractScopedTransaction not found in ' +
            '@midnight-ntwrk/midnight-js-contracts; the installed SDK does not support batched call transactions'
        );
    }
    for (const c of calls) {
        if (typeof found?.callTx?.[c.circuit] !== 'function') {
            throw new Error(`Circuit '${c.circuit}' not found on contract at ${contractAddress}`);
        }
    }

    const circuits = calls.map(c => c.circuit);
    // Each call gets a random segment id from the SDK, and the ledger applies calls by
    // ascending id. The wrapper renumbers them into call order before proving.
    // In `observe` mode it only logs the ids, so the apply order stays random.
    const providersAny = providers as BatchProviders | undefined;
    const mode = runtimeConfigEnum<'observe' | 'rewrite'>('NIGHTGATE_BATCH_SEGMENT_MODE') ?? 'rewrite';
    const wrapSegments = mode === 'observe' ? withObservedBatchSegments : withOrderedBatchSegments;
    // Filled while the calls are built. The wrapper reads it at proving time.
    const segmentIds: number[] = [];
    const networkId = providersAny?.config?.networkId;
    const reader = providersAny?.publicDataProvider;
    const preflight = networkId && reader && typeof reader.queryZSwapAndContractState === 'function'
        ? (tx: Parameters<typeof checkBatchGas>[0]) => checkBatchGas(tx, reader, networkId, contractAddress, circuits)
        : undefined;
    const proofProvider = providersAny?.proofProvider;
    const scopedProviders = proofProvider && typeof proofProvider.proveTx === 'function'
        ? { ...providersAny, proofProvider: wrapSegments(proofProvider, circuits, { ...orderOpts, segmentIds }, preflight) }
        : providers;
    const codec = await unprovenTxCodec();

    const finalized = await scoped(
        scopedProviders,
        async (txCtx: unknown) => {
            for (const c of calls) {
                c.before?.();
                await found.callTx![c.circuit]!(txCtx, ...(c.args ?? []));
                segmentIds.push(lastCallSegmentId(txCtx, codec));
            }
        },
        { scopeName: `batch:${circuits.join('+')}`, ...scopeOpts }
    );
    const pub = finalized?.public;
    return {
        txHash: String(pub?.txHash ?? ''),
        onChainStatus: String(pub?.status ?? ''),
        blockHeight: landedHeight(pub),
        circuits
    };
}
