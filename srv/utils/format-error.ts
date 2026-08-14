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
