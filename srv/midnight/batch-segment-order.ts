/**
 * The SDK randomizes each call intent's segment id; the ledger applies by ascending id.
 * The proof provider gets the tx unbound and unproven, the only time `Transaction.intents`
 * is writable, so the wrapper reassigns the existing ids in call order before proving.
 */

const utf8 = new TextDecoder();

function entryPointName(ep: unknown): string {
    if (typeof ep === 'string') return ep;
    if (ep instanceof Uint8Array) return utf8.decode(ep);
    return String(ep ?? '');
}

// Stages: `g` guaranteed, `f` fallible. The SDK splits by gas cost, so the same
// circuit moves from `g` to `g+f` as contract state grows.
function gasOf(transcript: any): string {
    const compute = transcript?.gas?.computeTime;
    if (typeof compute !== 'bigint' && typeof compute !== 'number') return '';
    return `:${(Number(compute) / 1e9).toFixed(2)}G`;
}

function transcriptStages(action: any): string {
    try {
        const g = action?.guaranteedTranscript;
        const f = action?.fallibleTranscript;
        const stages = `${g ? `g${gasOf(g)}` : ''}${g && f ? '+' : ''}${f ? `f${gasOf(f)}` : ''}`;
        return stages || '-';
    } catch {
        return '?';
    }
}

/** Contract calls in apply order; fee/dust intents without an entry point are skipped. */
function orderedCalls(tx: any): Array<{ name: string; segId: number; guaranteed: boolean; fallible: boolean }> {
    const intents: Map<number, any> | undefined = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') return [];
    const calls: Array<{ name: string; segId: number; guaranteed: boolean; fallible: boolean }> = [];
    for (const [segId, intent] of Array.from(intents.entries())) {
        const action = intent?.actions?.[0];
        const name = entryPointName(action?.entryPoint);
        if (!name) continue;
        calls.push({
            name,
            segId,
            guaranteed: Boolean(action?.guaranteedTranscript),
            fallible: Boolean(action?.fallibleTranscript)
        });
    }
    return calls.sort((a, b) => a.segId - b.segId);
}

/** Ledger causality: a fallible call must not precede a guaranteed one. Reason, or null. */
export function findCausalityViolation(tx: any): string | null {
    const calls = orderedCalls(tx);
    for (let i = 0; i < calls.length; i++) {
        if (!calls[i].fallible) continue;
        const later = calls.slice(i + 1).find(c => c.guaranteed);
        if (!later) continue;
        return (
            `'${calls[i].name}' (segment ${calls[i].segId}) carries a FALLIBLE transcript while ` +
            `'${later.name}' (segment ${later.segId}) behind it carries a GUARANTEED one. The ledger ` +
            'applies every guaranteed stage before any fallible stage, so the later call would run ' +
            'against state the earlier one has not written yet, and the node rejects the transaction ' +
            'as 1010/188. Which stage a call lands in is decided by its gas cost and therefore MOVES ' +
            'as the contract state grows. Submit the fallible call as its own transaction and batch ' +
            'the rest'
        );
    }
    return null;
}

/** One call of a batch with its apply position and execution stages, for a structured error. */
export interface BatchCallStage {
    name: string;
    segId: number;
    /** `g`, `f`, `g+f` (with gas figures when the SDK exposes them), `-` when the SDK exposes no transcripts. */
    stages: string;
}

/** The batch's contract calls in APPLY order with their stages; `[]` without an intents map. */
export function batchCallStages(tx: any): BatchCallStage[] {
    return orderedCalls(tx).map(c => ({
        name: c.name,
        segId: c.segId,
        stages: transcriptStages(tx.intents.get(c.segId)?.actions?.[0])
    }));
}

/**
 * `calls` lets a consumer split the batch without parsing. The message repeats the list
 * because the SDK's scope wrapper may keep only the message.
 */
export class BatchCausalityError extends Error {
    readonly code = 'BatchCausalityViolation';
    readonly calls: BatchCallStage[];
    constructor(message: string, calls: BatchCallStage[]) {
        super(message);
        this.name = 'BatchCausalityError';
        this.calls = calls;
    }
}

/** `circuit=segId[stages]` per intent, in map order; diagnostic logging only. */
export function describeBatchSegments(tx: any): string {
    try {
        const intents: Map<number, any> | undefined = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') return 'no intents';
        return Array.from(intents.entries())
            .map(([segId, intent]) => {
                const action = intent?.actions?.[0];
                return `${entryPointName(action?.entryPoint) || '?'}=${segId}[${transcriptStages(action)}]`;
            })
            .join(' ');
    } catch (e) {
        return `dump failed: ${(e as Error)?.message ?? e}`;
    }
}

export interface BatchOrderOptions {
    // The calls past `orderedPrefix` are order-free: group them by stage.
    independentCalls?: boolean;
    // Leading calls that keep their position even under `independentCalls`.
    orderedPrefix?: number;
}

/**
 * Reassign the matched intents' existing segment ids in call order. On any mismatch
 * returns false and leaves `tx` untouched.
 */
export function orderBatchSegments(tx: any, circuitsInOrder: string[], opts: BatchOrderOptions = {}): boolean {
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

    let picked: Array<[number, any]> = [];
    for (const circuit of circuitsInOrder) {
        const pool = pools.get(circuit);
        if (!pool || pool.length === 0) return false;
        picked.push(pool.shift()!);
    }

    if (opts.independentCalls) {
        const prefix = Math.max(0, Math.min(Math.floor(opts.orderedPrefix ?? 0), picked.length));
        const rank = (i: number) => {
            if (i < prefix) return 0;
            return picked[i][1]?.actions?.[0]?.fallibleTranscript ? 2 : 1;
        };
        picked = picked
            .map((entry, i) => ({ entry, i, rank: rank(i) }))
            .sort((a, b) => a.rank - b.rank || a.i - b.i)
            .map(x => x.entry);
    }

    const pickedIntents = new Set(picked.map(([, intent]) => intent));
    const pickedIdsAsc = picked.map(([segId]) => segId).sort((a, b) => a - b);

    const next = new Map<number, any>();
    for (const [segId, intent] of entries) {
        if (!pickedIntents.has(intent)) next.set(segId, intent);
    }
    picked.forEach(([, intent], i) => next.set(pickedIdsAsc[i], intent));
    if (next.size !== intents.size) return false;

    tx.intents = next;
    return true;
}

/** Proof provider whose `proveTx` orders segments and checks causality before delegating. */
export function withOrderedBatchSegments(
    proofProvider: any,
    circuitsInOrder: string[],
    opts: BatchOrderOptions = {}
): any {
    const wrapped = Object.create(proofProvider);
    wrapped.proveTx = async (tx: any, ...rest: unknown[]) => {
        if (circuitsInOrder.length >= 2) {
            const before = describeBatchSegments(tx);
            let ordered = false;
            try {
                ordered = orderBatchSegments(tx, circuitsInOrder, opts);
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
            console.log(`[nightgate:batch-segments] rewrite${opts.independentCalls ? ' (stage-grouped)' : ''}: ${before} -> ${describeBatchSegments(tx)}`);
            const violation = findCausalityViolation(tx);
            if (violation) {
                const calls = batchCallStages(tx);
                throw new BatchCausalityError(
                    `batch [${circuitsInOrder.join('+')}] violates the ledger's causality constraint: ${violation}. ` +
                    'Aborted before proving; nothing was submitted. ' +
                    `Stages in apply order: ${calls.map(c => `${c.name}=${c.segId}[${c.stages}]`).join(' ')}`,
                    calls
                );
            }
        }
        return proofProvider.proveTx(tx, ...rest);
    };
    return wrapped;
}

/** Diagnostic wrapper: logs segment ids without rewriting. */
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
