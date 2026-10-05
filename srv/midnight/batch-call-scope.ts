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
 * Run several circuit calls on one contract as a single transaction.
 * The ledger applies them in call order unless `orderOpts.independentCalls` is set.
 */
export async function runBatchInScope(
    contracts: any,
    providers: unknown,
    found: any,
    calls: BatchCall[],
    contractAddress: string,
    orderOpts: BatchOrderOptions = {},
    /** Passed to the SDK's scope: recipient keys for coins a call creates for another wallet. */
    scopeOpts: { additionalCoinEncPublicKeyMappings?: ReadonlyMap<string, string> } = {}
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
    // Each call gets a random segment id from the SDK, and the ledger applies calls by
    // ascending id. The wrapper renumbers them into call order before proving.
    // In `observe` mode it only logs the ids, so the apply order stays random.
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
