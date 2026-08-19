import { inspect } from 'node:util';

/**
 * Stringify an arbitrary error value for log output without producing
 * `[object Object]`.
 *
 * The `err?.message ?? String(err)` idiom that used to appear in several
 * places quietly degrades to `[object Object]` when `err` is a plain object
 * without a `.message` property, which Effect.ts and some SDK errors are.
 * `formatErr` falls back to `JSON.stringify` so log output always carries
 * the actual payload.
 */
export function formatErr(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err == null) return String(err);
    if (typeof err === 'string') return err;
    try { return JSON.stringify(err); }
    catch { return String(err); }
}

/**
 * Deep-inspect an arbitrary error structure for pattern matching (reject
 * classification digs the node's Substrate line out of SDK wrappers) without
 * the inspection itself ever throwing: `util.inspect` invokes a value's
 * `[util.inspect.custom]` method by default, and a throwing custom inspector
 * would turn CLASSIFYING an error into a new error (skipping markFailed on
 * the submitter, disarming the worker's dust guard). The default rendering
 * is kept first (Effect.ts wrappers pretty-print their cause chain through
 * custom inspectors, and the live-proven 1010-classification relies on that
 * output); only when it throws do we retry with custom inspectors disabled,
 * then degrade to formatErr.
 */
export function safeDeepInspect(err: unknown, maxStringLength = 2048): string {
    const opts = { depth: 8, maxStringLength, breakLength: Infinity } as const;
    try { return inspect(err, opts); }
    catch {
        try { return inspect(err, { ...opts, customInspect: false }); }
        catch { return formatErr(err); }
    }
}

/**
 * `safeDeepInspect` variant for reject CLASSIFICATION: stack frames and
 * `:line:col` source positions are stripped, so a location like
 * `wallet.js:1010:27` can never be mistaken for a Substrate reject code
 * (1010/1014/1016). Inspect renders an Error's stack both as real multiline
 * text (top level) and as escaped one-line strings (nested `stack`
 * properties), hence both replacements. Keep safeDeepInspect for logging,
 * where the frames are wanted.
 */
export function classificationHaystack(err: unknown): string {
    return safeDeepInspect(err)
        .replace(/^\s*at .*$/gm, '')
        .replace(/:\d+:\d+\b/g, ':L:C');
}

/**
 * `formatErr` plus the messages of the nested cause chain (bounded), for
 * errors that cross a boundary where only a string survives (the wallet
 * worker's RPC reply, a job's errorMessage). The SDK buries the node's reject
 * under generic wrappers: `(FiberFailure) SubmissionError: Transaction
 * submission error` on top, `1010: Invalid Transaction: Custom error: 196` or
 * `TransactionInvalidError: ...` only in the innermost cause. Without this the
 * main-thread classifiers (dust race, retryable failover) never see the node's
 * line. Effect's FiberFailure has NO `cause` property (its Cause is behind a
 * symbol and only rendered by inspect as `[cause]: Name: message` lines), so
 * the walk reads the property chain first and the rendered `[cause]:` lines
 * second; a bare Substrate `10xx:` line is the last resort.
 */
export function formatErrWithCauses(err: unknown): string {
    const head = formatErr(err);
    const parts: string[] = [];
    const push = (msg: string) => {
        const m = msg.trim();
        if (m && m !== head && !parts.includes(m) && parts.length < 6) parts.push(m);
    };
    const seen = new Set<unknown>([err]);
    let cur: any = (err as any)?.cause;
    for (let depth = 0; cur != null && depth < 6 && !seen.has(cur); depth++) {
        seen.add(cur);
        push(formatErr(cur));
        cur = cur?.cause;
    }
    if (parts.length === 0) {
        const rendered = classificationHaystack(err);
        for (const m of rendered.matchAll(/\[cause\]:\s*([^\n{]{1,200})/g)) push(m[1]);
        if (parts.length === 0) {
            const m = rendered.match(/\b10\d\d:\s*[^\n"']{0,120}/);
            if (m && !head.includes(m[0])) push(m[0]);
        }
    }
    return parts.length ? `${head} <- ${parts.join(' <- ')}` : head;
}
