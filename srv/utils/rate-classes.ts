// One limiter per rate class, built on first use, and the one 429 answer for every limit.
// The count of a class comes from the override source (the sponsor policy file), else its config key.
import { RateLimiter, principalRateKey, grantRateKey, type RateCheckResult } from './rate-limiter';
import { RATE_CLASSES, RATE_CLASS_NAMES, describeWindow, type RateClass } from './rate-class-table';
import { configNumber } from './config';

export { RATE_CLASSES, RATE_CLASS_NAMES, type RateClass } from './rate-class-table';

/** Names of the limits that are not a class: the grant budgets and the shared indexer read budget. */
export const BUDGET_LIMIT_NAMES = ['grant-hour', 'grant-day', 'indexer-budget'] as const;

interface RejectingRequest {
    reject?: (status: number, message: string) => unknown;
    http?: { res?: { set?: (name: string, value: string) => unknown; get?: (name: string) => string | undefined } };
}

/** A limit as it stands for one caller after a check. */
export interface RateLimitState {
    name: string;
    limit: number;
    remaining: number;
    windowSeconds: number;
    resetSeconds: number;
}

type RateLimitOverrides = Partial<Record<RateClass, number>>;
let overrideSource: (() => RateLimitOverrides) | undefined;

/** Counts that replace the config keys; the sponsor policy module registers its file here. */
export function setRateLimitOverrideSource(source: (() => RateLimitOverrides) | undefined): void {
    overrideSource = source;
}

const limiters = new Map<RateClass, RateLimiter>();
const rateLimitedCounts = new Map<string, number>(
    [...RATE_CLASS_NAMES, ...BUDGET_LIMIT_NAMES].map(name => [name, 0])
);

export function rateClassLimit(cls: RateClass): number {
    return overrideSource?.()[cls] ?? configNumber(RATE_CLASSES[cls].envKey);
}

export function rateClassLimiter(cls: RateClass): RateLimiter {
    let limiter = limiters.get(cls);
    if (!limiter) {
        const spec = RATE_CLASSES[cls];
        limiter = new RateLimiter({ windowMs: spec.windowMs, maxRequests: () => rateClassLimit(cls), maxKeys: spec.maxKeys });
        limiters.set(cls, limiter);
    }
    return limiter;
}

function stateOf(name: string, windowMs: number, r: RateCheckResult): RateLimitState {
    return {
        name,
        limit: r.limit,
        remaining: r.remaining,
        windowSeconds: Math.round(windowMs / 1000),
        resetSeconds: Math.ceil((r.allowed ? r.resetMs : r.retryAfterMs) / 1000)
    };
}

// Counts `count` calls for the caller and the scope; a refusal rejects with 429 and counts nothing.
// The scope is the session for `prove` and `deploy`, the contract for a reindex, else the class name.
export function checkRateClass(cls: RateClass, scope: string, req: RejectingRequest, count = 1): boolean {
    const spec = RATE_CLASSES[cls];
    const r = rateClassLimiter(cls).checkMany(principalRateKey(req, scope), count);
    const state = stateOf(cls, spec.windowMs, r);
    if (!r.allowed) {
        rejectRateLimited(req, { ...state, retryAfterMs: r.retryAfterMs });
        return false;
    }
    noteRateLimitHeaders(req, state);
    return true;
}

/** The class as it stands for a grant, without counting. */
export function peekRateClassForGrant(cls: RateClass, grantId: string, scope: string): RateLimitState {
    const spec = RATE_CLASSES[cls];
    return stateOf(cls, spec.windowMs, rateClassLimiter(cls).peek(grantRateKey(grantId, scope)));
}

export interface RateLimitRefusal {
    name: string;
    limit: number;
    windowSeconds: number;
    retryAfterMs: number;
    /** Added to the message when the limit is not a plain count, such as a value budget. */
    detail?: string;
}

/** The one 429 answer: message with the limit, `Retry-After`, `RateLimit` headers, the metric. */
export function rejectRateLimited(req: RejectingRequest, refusal: RateLimitRefusal): void {
    const seconds = Math.max(1, Math.ceil(refusal.retryAfterMs / 1000));
    rateLimitedCounts.set(refusal.name, (rateLimitedCounts.get(refusal.name) ?? 0) + 1);
    setHeader(req, 'Retry-After', String(seconds));
    noteRateLimitHeaders(req, { name: refusal.name, limit: refusal.limit, remaining: 0, windowSeconds: refusal.windowSeconds, resetSeconds: seconds });
    const window = describeWindow(refusal.windowSeconds * 1000);
    const what = refusal.detail ?? `${refusal.name}: ${refusal.limit} per ${window}`;
    req.reject?.(429, `Rate limited (${what}). Retry after ${seconds}s`);
}

// `RateLimit-Policy` lists every limit the request passed as `"name";q=<limit>;w=<window s>`,
// `RateLimit` shows the tightest as `"name";r=<remaining>;t=<reset s>` (IETF httpapi draft).
export function noteRateLimitHeaders(req: RejectingRequest, state: RateLimitState): void {
    const res = req?.http?.res;
    if (!res?.set || !res?.get) return;
    try {
        const policy = `"${state.name}";q=${state.limit};w=${state.windowSeconds}`;
        const previous = res.get('RateLimit-Policy');
        res.set('RateLimit-Policy', previous ? `${previous}, ${policy}` : policy);
        const current = res.get('RateLimit');
        const shown = current ? /;r=(\d+)/.exec(current) : null;
        if (!shown || Number(shown[1]) > state.remaining) {
            res.set('RateLimit', `"${state.name}";r=${state.remaining};t=${state.resetSeconds}`);
        }
    } catch { /* headers are a courtesy */ }
}

function setHeader(req: RejectingRequest, name: string, value: string): void {
    try { req?.http?.res?.set?.(name, value); } catch { /* headers are a courtesy */ }
}

/** 429 answers since process start, by limit name. Every known name is present. */
export function rateLimitedTotals(): ReadonlyMap<string, number> {
    return rateLimitedCounts;
}

export function __resetRateLimitersForTests(): void {
    for (const limiter of limiters.values()) limiter.destroy();
    limiters.clear();
    for (const name of rateLimitedCounts.keys()) rateLimitedCounts.set(name, 0);
}
