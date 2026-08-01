import type { MockInstance } from 'vitest';
import { validateViewingKey } from '../../srv/utils/validation';
import { RateLimiter } from '../../srv/utils/rate-limiter';

describe('validation utilities', () => {
    it('validates viewing keys as 32-byte hex strings', () => {
        expect(validateViewingKey(undefined)).toBe('viewingKey is required');
        expect(validateViewingKey('not-hex')).toBe('viewingKey must be hex-encoded');
        expect(validateViewingKey('a'.repeat(62))).toBe('viewingKey must be 64 hex characters (32 bytes), got 62');
        expect(validateViewingKey('a'.repeat(64))).toBeUndefined();
    });
});

describe('RateLimiter', () => {
    let nowSpy: MockInstance<() => number>;

    beforeEach(() => {
        nowSpy = vi.spyOn(Date, 'now');
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    it('counts and stores the first request in the active window', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        nowSpy.mockReturnValue(1000);
        expect(limiter.check('client-1')).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('client-1')).toEqual([1000]);
    });

    it('returns retryAfter when the active window is already full', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        (limiter as any).hits.set('client-1', [1000]);
        nowSpy.mockReturnValue(1500);
        expect(limiter.check('client-1')).toEqual({ allowed: false, retryAfterMs: 500 });
    });

    it('sorts multiple in-window timestamps before calculating retryAfter', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });

        (limiter as any).hits.set('client-1', [1500, 1000]);
        nowSpy.mockReturnValue(1600);
        expect(limiter.check('client-1')).toEqual({ allowed: false, retryAfterMs: 400 });
        expect((limiter as any).hits.get('client-1')).toEqual([1000, 1500]);
    });

    it('appends a new hit when the window already has room left', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });

        (limiter as any).hits.set('client-3', [1000, 1500]);
        nowSpy.mockReturnValue(1700);
        expect(limiter.check('client-3')).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('client-3')).toEqual([1000, 1500, 1700]);
    });

    it('drops stale hits once the sliding window has moved on', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });

        nowSpy.mockReturnValue(1000);
        expect(limiter.check('client-2')).toEqual({ allowed: true, retryAfterMs: 0 });

        nowSpy.mockReturnValue(2200);
        expect(limiter.check('client-2')).toEqual({ allowed: true, retryAfterMs: 0 });
    });
});

describe('RateLimiter.checkMany (all-or-nothing batch consume)', () => {
    let nowSpy: MockInstance<() => number>;

    beforeEach(() => {
        nowSpy = vi.spyOn(Date, 'now');
    });

    afterEach(() => {
        nowSpy.mockRestore();
    });

    it('consumes N slots atomically when they fit', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });
        nowSpy.mockReturnValue(1000);
        expect(limiter.checkMany('k', 8)).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('k')).toHaveLength(8);
    });

    it('rejects WITHOUT consuming when N does not fit (follow-up within budget still passes)', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });
        nowSpy.mockReturnValue(1000);
        expect(limiter.checkMany('k', 8).allowed).toBe(true);

        // 3 > 2 remaining: rejected, and the 8 recorded hits stay 8.
        const rejected = limiter.checkMany('k', 3);
        expect(rejected.allowed).toBe(false);
        expect(rejected.retryAfterMs).toBe(1000);
        expect((limiter as any).hits.get('k')).toHaveLength(8);

        // The 2 remaining slots were NOT eaten by the rejected batch.
        expect(limiter.checkMany('k', 2).allowed).toBe(true);
        expect((limiter as any).hits.get('k')).toHaveLength(10);
    });

    it('a count larger than the whole budget reports a full window, never 0', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5 });
        nowSpy.mockReturnValue(1000);
        const r = limiter.checkMany('fresh', 6);
        expect(r.allowed).toBe(false);
        expect(r.retryAfterMs).toBe(1000);
    });

    it('count <= 0 is a no-op success', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
        expect(limiter.checkMany('k', 0)).toEqual({ allowed: true, retryAfterMs: 0 });
        expect((limiter as any).hits.get('k')).toBeUndefined();
    });

    it('check() delegates to checkMany(key, 1) with identical single-slot semantics', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
        nowSpy.mockReturnValue(1000);
        expect(limiter.check('k')).toEqual({ allowed: true, retryAfterMs: 0 });
        nowSpy.mockReturnValue(1500);
        expect(limiter.check('k')).toEqual({ allowed: false, retryAfterMs: 500 });
    });
});

describe('RateLimiter capacity + sweep + destroy', () => {
    it('rejects NEW keys once the key map is at capacity (memory DoS guard)', () => {
        const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 5, maxKeys: 2 });
        try {
            expect(limiter.check('a').allowed).toBe(true);
            expect(limiter.check('b').allowed).toBe(true);
            // Third DISTINCT key is rejected; existing keys keep working.
            const overflow = limiter.check('c');
            expect(overflow.allowed).toBe(false);
            expect(overflow.retryAfterMs).toBe(60_000);
            expect(limiter.check('a').allowed).toBe(true);
        } finally {
            limiter.destroy();
        }
    });

    it('sweeps stale keys on the interval and destroy() stops the timer', () => {
        vi.useFakeTimers();
        const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 5, sweepIntervalMs: 500 });
        try {
            limiter.check('stale-key');
            expect((limiter as any).hits.size).toBe(1);

            // Past the window: the next sweep tick drops the key.
            vi.advanceTimersByTime(1600);
            expect((limiter as any).hits.size).toBe(0);

            // After destroy() the sweep no longer runs.
            limiter.check('after-destroy');
            limiter.destroy();
            vi.advanceTimersByTime(10_000);
            expect((limiter as any).hits.size).toBe(1);
        } finally {
            limiter.destroy();
            vi.useRealTimers();
        }
    });
});
