import { inspect } from 'node:util';

/** Error to log string; plain objects without `.message` (Effect, some SDK errors) go through JSON.stringify. */
export function formatErr(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err == null) return String(err);
    if (typeof err === 'string') return err;
    try { return JSON.stringify(err); }
    catch { return String(err); }
}

/**
 * Deep inspect that never throws, since classifying an error must not raise a new one.
 * Custom inspectors stay on first (reject classification reads Effect's cause chain
 * rendering); only if they throw retry without them, then formatErr.
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
 * `safeDeepInspect` for reject classification: stack frames and `:line:col` are
 * stripped so `wallet.js:1010:27` never reads as a Substrate reject code.
 */
export function classificationHaystack(err: unknown): string {
    return safeDeepInspect(err)
        .replace(/^\s*at .*$/gm, '')
        .replace(/:\d+:\d+\b/g, ':L:C');
}

/**
 * `formatErr` plus the bounded cause chain, for errors crossing a string-only boundary:
 * the node's reject sits in the innermost cause. Effect's FiberFailure has no `cause`
 * property, so rendered `[cause]:` lines, then a bare `10xx:` line, are fallbacks.
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
