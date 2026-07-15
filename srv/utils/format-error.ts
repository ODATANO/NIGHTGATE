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
