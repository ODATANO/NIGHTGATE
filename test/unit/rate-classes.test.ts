/**
 * The rate classes (`srv/utils/rate-classes.ts`): one limiter per class built on first use,
 * the count read on every check (env, else the override source), the one 429 answer with
 * `Retry-After` and the `RateLimit` headers, the metric, and the peek a grant's usage reads.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    checkRateClass, rateClassLimit, setRateLimitOverrideSource, rejectRateLimited, peekRateClassForGrant,
    rateLimitedTotals, __resetRateLimitersForTests, RATE_CLASSES, RATE_CLASS_NAMES, BUDGET_LIMIT_NAMES
} from '../../srv/utils/rate-classes';
import { CONFIG_TABLE } from '../../srv/utils/config-table';

function makeReq(user = 'alice', grantId?: string) {
    const headers: Record<string, string> = {};
    return {
        user: { id: user },
        agentGrant: grantId ? { ID: grantId } : undefined,
        reject: vi.fn(),
        http: { res: { set: vi.fn((k: string, v: string) => { headers[k] = v; }), get: vi.fn((k: string) => headers[k]) } },
        headers
    };
}

describe('rate classes', () => {
    afterEach(() => {
        setRateLimitOverrideSource(undefined);
        for (const cls of RATE_CLASS_NAMES) delete process.env[RATE_CLASSES[cls].envKey];
        __resetRateLimitersForTests();
    });

    it('every class has an int config row with a default and a floor of 1', () => {
        for (const cls of RATE_CLASS_NAMES) {
            const row = CONFIG_TABLE.find(r => r.key === RATE_CLASSES[cls].envKey);
            expect(row, cls).toBeDefined();
            expect(row?.kind).toBe('int');
            expect(row?.min).toBe(1);
            expect(typeof row?.default).toBe('number');
            expect(rateClassLimit(cls)).toBe(row?.default);
        }
    });

    it('reads the env count on every check, so a change applies without a restart', () => {
        const req = makeReq();
        expect(checkRateClass('prove', 's1', req)).toBe(true);
        process.env.NIGHTGATE_PROVE_RATE_LIMIT = '2';
        expect(checkRateClass('prove', 's1', req)).toBe(true);
        expect(checkRateClass('prove', 's1', req)).toBe(false);
        expect(req.reject).toHaveBeenCalledWith(429, expect.stringMatching(/^Rate limited \(prove: 2 per hour\)\. Retry after \d+s$/));
        expect(req.headers['Retry-After']).toMatch(/^\d+$/);
        expect(req.headers['RateLimit']).toMatch(/^"prove";r=0;t=\d+$/);
        expect(rateLimitedTotals().get('prove')).toBe(1);
    });

    it('the override source wins over the env', () => {
        process.env.NIGHTGATE_READ_RATE_LIMIT = '50';
        setRateLimitOverrideSource(() => ({ read: 1 }));
        expect(rateClassLimit('read')).toBe(1);
        expect(rateClassLimit('prove')).toBe(60);
        const req = makeReq();
        expect(checkRateClass('read', 'read', req)).toBe(true);
        expect(checkRateClass('read', 'read', req)).toBe(false);
        expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('read: 1 per minute'));
    });

    it('an allowed call carries the policy and the tightest remaining', () => {
        process.env.NIGHTGATE_PROVE_RATE_LIMIT = '3';
        const req = makeReq();
        expect(checkRateClass('prove', 's1', req)).toBe(true);
        expect(req.headers['RateLimit-Policy']).toBe('"prove";q=3;w=3600');
        expect(req.headers['RateLimit']).toMatch(/^"prove";r=2;t=\d+$/);
        rejectRateLimited(req, { name: 'grant-hour', limit: 20, windowSeconds: 3600, retryAfterMs: 1_800_000 });
        expect(req.headers['RateLimit-Policy']).toBe('"prove";q=3;w=3600, "grant-hour";q=20;w=3600');
        expect(req.headers['RateLimit']).toBe('"grant-hour";r=0;t=1800');
        expect(req.headers['Retry-After']).toBe('1800');
        expect(req.reject).toHaveBeenCalledWith(429, 'Rate limited (grant-hour: 20 per hour). Retry after 1800s');
        expect(rateLimitedTotals().get('grant-hour')).toBe(1);
    });

    it('counts per caller and scope; a batch takes all its slots or none', () => {
        process.env.NIGHTGATE_PROVE_RATE_LIMIT = '3';
        const alice = makeReq('alice');
        expect(checkRateClass('prove', 's1', alice, 2)).toBe(true);
        expect(checkRateClass('prove', 's1', alice, 2)).toBe(false);
        expect(checkRateClass('prove', 's1', alice, 1)).toBe(true);
        expect(checkRateClass('prove', 's2', alice)).toBe(true);
        expect(checkRateClass('prove', 's1', makeReq('bob'))).toBe(true);
    });

    it('peeks what a grant has left without counting', () => {
        process.env.NIGHTGATE_SPONSOR_RATE_LIMIT = '4';
        const req = makeReq('issuer', 'grant-7');
        expect(checkRateClass('sponsor', 'sponsor', req)).toBe(true);
        const state = peekRateClassForGrant('sponsor', 'grant-7', 'sponsor');
        expect(state).toMatchObject({ name: 'sponsor', limit: 4, remaining: 3, windowSeconds: 3600 });
        expect(peekRateClassForGrant('sponsor', 'grant-7', 'sponsor').remaining).toBe(3);
        expect(peekRateClassForGrant('sponsor', 'grant-8', 'sponsor').remaining).toBe(4);
    });

    it('the metric knows every class and budget name from the start', () => {
        for (const name of [...RATE_CLASS_NAMES, ...BUDGET_LIMIT_NAMES]) expect(rateLimitedTotals().get(name)).toBe(0);
    });
});
