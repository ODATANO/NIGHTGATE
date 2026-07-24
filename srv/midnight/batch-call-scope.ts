/**
 * Core of the worker's `submitContractCallBatch`: run an ordered list of
 * circuit calls inside ONE SDK transaction scope and map the finalized result.
 *
 * Lives outside wallet-worker.ts so it is unit-testable: the worker module
 * itself refuses to load without a worker_threads parentPort, which keeps its
 * op bodies out of reach for tests. The worker op does the facade/provider
 * assembly and delegates the scope mechanics here.
 */

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
 * Execute `calls` in order inside a single `withContractScopedTransaction`
 * scope on `found` (a findDeployedContract result). Validates every circuit
 * BEFORE opening the scope, so a bad name is a clean error rather than a
 * half-built transaction context. Uses the circuit-call interface's
 * `(txCtx, ...args)` overload; the SDK batches the calls and submits ONCE.
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
    const finalized = await contracts.withContractScopedTransaction(
        providers,
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
