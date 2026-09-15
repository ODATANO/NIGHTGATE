import {
    type BatchOrderOptions,
    withObservedBatchSegments,
    withOrderedBatchSegments
} from './batch-segment-order';
import { runtimeConfigEnum } from './runtime-config';

export interface BatchCall {
    circuit: string;
    args: unknown[];
    before?: () => void;
}

/** The block height a finalized tx landed in, or null when the SDK reported none. */
export function landedHeight(pub: any): number | null {
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

/**
 * Run `calls` in one `withContractScopedTransaction` scope on `found`; the ledger
 * applies them in call order (or stage-grouped with `orderOpts.independentCalls`).
 */
export async function runBatchInScope(
    contracts: any,
    providers: unknown,
    found: any,
    calls: BatchCall[],
    contractAddress: string,
    orderOpts: BatchOrderOptions = {}
): Promise<BatchScopeResult> {
    if (!Array.isArray(calls) || calls.length === 0) {
        throw new Error('submitContractCallBatch: calls must be a non-empty array');
    }
    if (typeof contracts?.withContractScopedTransaction !== 'function') {
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
    // The ledger applies merged intents by ascending segment id, which the SDK
    // randomizes; the wrapper permutes them into call order before proving.
    // `observe` mode only logs them, so dependent batches apply in random order.
    const providersAny = providers as any;
    const mode = runtimeConfigEnum<'observe' | 'rewrite'>('NIGHTGATE_BATCH_SEGMENT_MODE') ?? 'rewrite';
    const wrapSegments = mode === 'observe' ? withObservedBatchSegments : withOrderedBatchSegments;
    const scopedProviders = typeof providersAny?.proofProvider?.proveTx === 'function'
        ? { ...providersAny, proofProvider: wrapSegments(providersAny.proofProvider, circuits, orderOpts) }
        : providers;

    const finalized = await contracts.withContractScopedTransaction(
        scopedProviders,
        async (txCtx: unknown) => {
            for (const c of calls) {
                c.before?.();
                await found.callTx[c.circuit](txCtx, ...(c.args ?? []));
            }
        },
        { scopeName: `batch:${circuits.join('+')}` }
    );
    const pub = finalized?.public;
    return {
        txHash: String(pub?.txHash ?? ''),
        onChainStatus: String(pub?.status ?? ''),
        blockHeight: landedHeight(pub),
        circuits
    };
}
