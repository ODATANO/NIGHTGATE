import { inspect } from 'node:util';
import { errorMessage } from './errors';

export function errorName(err: unknown): string {
    const name = (err as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' ? name : 'Error';
}

/** Renders an error in full depth and never throws.
 *  Custom inspectors run first, because they print the nested causes. If they throw, it retries without them. */
export function safeDeepInspect(err: unknown, maxStringLength = 2048): string {
    const opts = { depth: 8, maxStringLength, breakLength: Infinity } as const;
    try { return inspect(err, opts); }
    catch {
        try { return inspect(err, { ...opts, customInspect: false }); }
        catch { return errorMessage(err); }
    }
}

/** Error text for matching node reject codes. Stack frames and `:line:col` are removed,
 *  so that `wallet.js:1010:27` is not mistaken for reject code 1010. */
export function classificationHaystack(err: unknown): string {
    return safeDeepInspect(err)
        .replace(/^\s*at .*$/gm, '')
        .replace(/:\d+:\d+\b/g, ':L:C');
}

/** Like `errorMessage`, but appends up to six nested causes, where the node's reject reason often sits.
 *  Some SDK errors have no `cause` property, so the rendered text is searched instead. */
export function formatErrWithCauses(err: unknown): string {
    const head = errorMessage(err);
    const parts: string[] = [];
    const push = (msg: string) => {
        const m = msg.trim();
        if (m && m !== head && !parts.includes(m) && parts.length < 6) parts.push(m);
    };
    const seen = new Set<unknown>([err]);
    let cur: unknown = (err as { cause?: unknown } | null | undefined)?.cause;
    for (let depth = 0; cur != null && depth < 6 && !seen.has(cur); depth++) {
        seen.add(cur);
        push(errorMessage(cur));
        cur = (cur as { cause?: unknown })?.cause;
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

/** The ledger error number in a node's 1010 reject (`Custom error: N`), or null. */
export function ledgerErrorCode(haystack: string): string | null {
    return /custom error:?\s*(\d+)/i.exec(haystack)?.[1] ?? null;
}
