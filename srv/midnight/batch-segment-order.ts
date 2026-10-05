/**
 * Each contract call in a transaction sits in a numbered segment. The SDK picks the
 * numbers at random, and the ledger applies calls by ascending number.
 * The proof provider is the last point where the numbers can still be changed,
 * so the wrapper renumbers the calls into call order there.
 */
import { errorMessage } from '../utils/errors';

const utf8 = new TextDecoder();

function entryPointName(ep: unknown): string {
    if (typeof ep === 'string') return ep;
    if (ep instanceof Uint8Array) return utf8.decode(ep);
    return String(ep ?? '');
}

// Each call runs in a guaranteed part (`g`), a fallible part (`f`), or both.
// The SDK splits by gas cost, so a circuit can move from `g` to `g+f` as the contract state grows.
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

/** Contract calls in apply order. Fee and dust parts without a circuit name are skipped. */
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

/** Call names per segment of a batch (two or more calls); undefined for a single call. */
export function callSegments(tx: any): Array<{ segment: number; calls: string[] }> | undefined {
    const calls = orderedCalls(tx);
    if (calls.length < 2) return undefined;
    const bySegment = new Map<number, string[]>();
    for (const c of calls) bySegment.set(c.segId, [...(bySegment.get(c.segId) ?? []), c.name]);
    return [...bySegment.entries()].map(([segment, names]) => ({ segment, calls: names }));
}

/** Returns why the ledger would reject the order, or null. A fallible call must not come before a guaranteed one. */
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
    /** `g`, `f` or `g+f`, with gas figures when known. `-` when the SDK shows no parts. */
    stages: string;
}

/** The batch's contract calls in apply order with their stages. Empty when the tx has no intents. */
export function batchCallStages(tx: any): BatchCallStage[] {
    return orderedCalls(tx).map(c => ({
        name: c.name,
        segId: c.segId,
        stages: transcriptStages(tx.intents.get(c.segId)?.actions?.[0])
    }));
}

/**
 * `calls` lets a caller split the batch without parsing the message.
 * The message repeats the list because the SDK may pass on only the message.
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

/** `circuit=segId[stages]` for each call, for logging only. */
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
        return `dump failed: ${errorMessage(e)}`;
    }
}

export interface BatchOrderOptions {
    // Calls after `orderedPrefix` do not depend on each other, so they may be grouped by stage.
    independentCalls?: boolean;
    // Number of leading calls that keep their position even with `independentCalls`.
    orderedPrefix?: number;
}

/**
 * Give the calls the existing segment ids in call order.
 * Returns false and leaves `tx` unchanged when the calls do not match the list.
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

/** Wraps a proof provider so it puts the calls in order and checks the order before proving. */
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
                    `batch segment ordering failed for [${circuitsInOrder.join('+')}]: ${errorMessage(err)}; ` +
                    'aborting before proving (nothing submitted) because the deterministic apply order cannot be guaranteed'
                );
            }
            if (!ordered) {
                throw new Error(
                    `batch segment ordering could not match the transaction intents to the call list [${circuitsInOrder.join('+')}]; ` +
                    'aborting before proving (nothing submitted) because the deterministic apply order cannot be guaranteed'
                );
            }
            // eslint-disable-next-line no-console -- shipped in the slim txbuilder, which has no logger
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

/** Wraps a proof provider so it only logs the segment ids and changes nothing. */
export function withObservedBatchSegments(
    proofProvider: any,
    circuitsInOrder: string[]
): any {
    const wrapped = Object.create(proofProvider);
    wrapped.proveTx = async (tx: any, ...rest: unknown[]) => {
        // eslint-disable-next-line no-console -- shipped in the slim txbuilder, which has no logger
        console.log(`[nightgate:batch-segments] OBSERVE (no rewrite) for [${circuitsInOrder.join('+')}]: ${describeBatchSegments(tx)}`);
        return proofProvider.proveTx(tx, ...rest);
    };
    return wrapped;
}
