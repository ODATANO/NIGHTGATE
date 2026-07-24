/**
 * Core of the worker's `submitContractCallBatch`: run an ordered list of
 * circuit calls inside ONE SDK transaction scope and map the finalized result.
 *
 * Lives outside wallet-worker.ts so it is unit-testable: the worker module
 * itself refuses to load without a worker_threads parentPort, which keeps its
 * op bodies out of reach for tests. The worker op does the facade/provider
 * assembly and delegates the scope mechanics here.
 */

import { withOrderedBatchSegments } from './batch-segment-order';

export interface BatchCall {
    circuit: string;
    args: unknown[];
}

export interface BatchScopeResult {
    txHash: string;
    onChainStatus: string;
    circuits: string[];
}

/**
 * Execute `calls` inside a single `withContractScopedTransaction` scope on
 * `found` (a findDeployedContract result). Calls are invoked in array order,
 * and the wrapped proof provider rewrites the merged intents' segment ids
 * into call order before proving (batch-segment-order.ts), so the ledger
 * also APPLIES them in call order — dependent calls may be batched. With
 * duplicate circuit names in one batch the relative order among same-named
 * calls is not guaranteed (intents are indistinguishable by entryPoint);
 * batch distinct circuits when that matters. Validates every circuit BEFORE
 * opening the scope, so a bad name is a clean error rather than a half-built
 * transaction context. Uses the circuit-call interface's `(txCtx, ...args)`
 * overload; the SDK batches the calls and submits ONCE.
 */
export async function runBatchInScope(
    contracts: any,
    providers: unknown,
    found: any,
    calls: BatchCall[],
    contractAddress: string
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
    // Deterministic apply order: wrap the proof provider so segment ids are
    // rewritten into call order before proving (see batch-segment-order.ts).
    // Skipped when the bundle has no proveTx-capable proof provider (tests).
    const providersAny = providers as any;
    const scopedProviders = typeof providersAny?.proofProvider?.proveTx === 'function'
        ? { ...providersAny, proofProvider: withOrderedBatchSegments(providersAny.proofProvider, circuits) }
        : providers;
    const finalized = await contracts.withContractScopedTransaction(
        scopedProviders,
        async (txCtx: unknown) => {
            for (const c of calls) {
                await found.callTx[c.circuit](txCtx, ...(c.args ?? []));
            }
        },
        { scopeName: `batch:${circuits.join('+')}` }
    );
    const pub = finalized?.public;
    return {
        txHash: String(pub?.txHash ?? ''),
        onChainStatus: String(pub?.status ?? ''),
        circuits
    };
}
