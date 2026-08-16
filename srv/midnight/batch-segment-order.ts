/**
 * Deterministic segment ordering for batched contract calls.
 *
 * midnight-js-contracts builds each circuit call via
 * `Transaction.fromPartsRandomized`, which RANDOMIZES the intent's segment id,
 * and the ledger applies merged intents in ascending segment order (ledger-v8
 * `SegmentSpecifier`: `{ tag: 'first' }` is an alias for segment 1). A batch
 * of dependent calls therefore only landed when the dice happened to fall in
 * call order.
 *
 * The fix window: `submitTxCore` hands the merged transaction to the proof
 * provider FIRST, still unbound and unproven, and ledger-v8 documents
 * `Transaction.intents` as writable exactly then ("writing to this
 * re-computes binding information if and only if this transaction is unbound
 * and unproven"). So before delegating to the real `proveTx` we reassign the
 * EXISTING segment ids, sorted ascending, to the batch's intents in call
 * order: apply order == call order, deterministically.
 */

const utf8 = new TextDecoder();

function entryPointName(ep: unknown): string {
    if (typeof ep === 'string') return ep;
    if (ep instanceof Uint8Array) return utf8.decode(ep);
    return String(ep ?? '');
}

/** `circuit=segId` per intent, in map order; diagnostic logging only. */
export function describeBatchSegments(tx: any): string {
    try {
        const intents: Map<number, any> | undefined = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') return 'no intents';
        return Array.from(intents.entries())
            .map(([segId, intent]) => `${entryPointName(intent?.actions?.[0]?.entryPoint) || '?'}=${segId}`)
            .join(' ');
    } catch (e) {
        return `dump failed: ${(e as Error)?.message ?? e}`;
    }
}

/**
 * Rewrite `tx.intents` so the intents matching `circuitsInOrder` (via their
 * first action's `entryPoint`) carry ascending segment ids in call order.
 * Only the matched intents' own ids are permuted; unmatched intents keep
 * theirs, so nothing can collide with segments added later (fee/dust
 * balancing). Duplicate circuit names are consumed in map-encounter order,
 * which is NOT guaranteed to be call order - batch distinct circuits when
 * relative order among same-named calls matters.
 *
 * Returns true when a rewrite happened. On ANY mismatch (missing intent for a
 * circuit, leftover unmatched call, no intents map) the transaction is left
 * untouched and false is returned; the batch wrapper below treats that as
 * fatal for multi-call batches.
 */
export function orderBatchSegments(tx: any, circuitsInOrder: string[]): boolean {
    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') return false;
    if (circuitsInOrder.length < 2 || intents.size < 2) return false;

    const entries = Array.from(intents.entries());
    const pools = new Map<string, Array<[number, any]>>();
    for (const [segId, intent] of entries) {
        const name = entryPointName(intent?.actions?.[0]?.entryPoint);
        const pool = pools.get(name);
        if (pool) pool.push([segId, intent]);
        else pools.set(name, [[segId, intent]]);
    }

    const picked: Array<[number, any]> = [];
    for (const circuit of circuitsInOrder) {
        const pool = pools.get(circuit);
        if (!pool || pool.length === 0) return false;
        picked.push(pool.shift()!);
    }

    const pickedIntents = new Set(picked.map(([, intent]) => intent));
    const pickedIdsAsc = picked.map(([segId]) => segId).sort((a, b) => a - b);

    const next = new Map<number, any>();
    for (const [segId, intent] of entries) {
        if (!pickedIntents.has(intent)) next.set(segId, intent);
    }
    picked.forEach(([, intent], i) => next.set(pickedIdsAsc[i], intent));
    if (next.size !== intents.size) return false;

    tx.intents = next; // ledger-v8 re-computes binding (unbound + unproven only)
    return true;
}

/**
 * Wrap a proof provider so `proveTx` first rewrites the batch's segment ids
 * into call order, then delegates. Prototype-preserving (`Object.create`), so
 * any extra provider surface stays reachable.
 *
 * FAIL-CLOSED for multi-call batches: dependent batches are supported on the
 * strength of the deterministic apply order, so if the ordering cannot be
 * established (intents don't match the call list, or the WASM intents
 * surface throws) the wrapper THROWS before proving. That is an
 * error-before-submission: the scope is discarded and nothing reaches the
 * chain, instead of silently proving in randomized order and risking
 * PARTIAL_SUCCESS with partial on-chain effects. Single-call batches skip
 * ordering (trivially ordered).
 */
export function withOrderedBatchSegments(
    proofProvider: any,
    circuitsInOrder: string[]
): any {
    const wrapped = Object.create(proofProvider);
    wrapped.proveTx = async (tx: any, ...rest: unknown[]) => {
        if (circuitsInOrder.length >= 2) {
            const before = describeBatchSegments(tx);
            let ordered = false;
            try {
                ordered = orderBatchSegments(tx, circuitsInOrder);
            } catch (err) {
                throw new Error(
                    `batch segment ordering failed for [${circuitsInOrder.join('+')}]: ${(err as Error)?.message ?? err}; ` +
                    'aborting before proving (nothing submitted) because the deterministic apply order cannot be guaranteed'
                );
            }
            if (!ordered) {
                throw new Error(
                    `batch segment ordering could not match the transaction intents to the call list [${circuitsInOrder.join('+')}]; ` +
                    'aborting before proving (nothing submitted) because the deterministic apply order cannot be guaranteed'
                );
            }
            // Worker-thread console lands in the server log; one line per
            // multi-call batch, and the id mapping is the load-bearing
            // datum in any sequencing-reject diagnosis (ledger 1010/188).
            console.log(`[nightgate:batch-segments] rewrite: ${before} -> ${describeBatchSegments(tx)}`);
        }
        return proofProvider.proveTx(tx, ...rest);
    };
    return wrapped;
}

/**
 * DIAGNOSTIC (NIGHTGATE_BATCH_SEGMENT_MODE=observe): do NOT rewrite; log the
 * randomized segment ids and prove as-is. Apply order is then whatever the
 * dice say, so dependent batches may fail ON-CHAIN with partial effects; use
 * only to decide whether a pre-mempool sequencing reject (1010/188) also
 * occurs when the rewrite touched nothing. See
 * docs/feature-requests/rebind-batch-invalid-on-populated-state.md.
 */
export function withObservedBatchSegments(
    proofProvider: any,
    circuitsInOrder: string[]
): any {
    const wrapped = Object.create(proofProvider);
    wrapped.proveTx = async (tx: any, ...rest: unknown[]) => {
        console.log(`[nightgate:batch-segments] OBSERVE (no rewrite) for [${circuitsInOrder.join('+')}]: ${describeBatchSegments(tx)}`);
        return proofProvider.proveTx(tx, ...rest);
    };
    return wrapped;
}
