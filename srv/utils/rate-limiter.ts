/**
 * Simple in-memory sliding window rate limiter.
 */

interface RateLimiterOptions {
    windowMs: number;
    maxRequests: number;
}

interface RateCheckResult {
    allowed: boolean;
    retryAfterMs: number;
}

export class RateLimiter {
    private windowMs: number;
    private maxRequests: number;
    private hits: Map<string, number[]> = new Map();

    constructor(opts: RateLimiterOptions) {
        this.windowMs = opts.windowMs;
        this.maxRequests = opts.maxRequests;
    }

    check(key: string): RateCheckResult {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        let timestamps = this.hits.get(key) || [];
        timestamps = timestamps.filter(t => t > windowStart);

        // Clean up stale keys to prevent memory growth
        if (timestamps.length === 0) {
            timestamps = [now];
            this.hits.set(key, timestamps);
            return { allowed: true, retryAfterMs: 0 };
        }

        if (timestamps.length >= this.maxRequests) {
            timestamps.sort((a, b) => a - b);
            const oldestInWindow = timestamps[0];
            const retryAfterMs = oldestInWindow + this.windowMs - now;
            this.hits.set(key, timestamps);
            return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
        }

        timestamps.push(now);
        this.hits.set(key, timestamps);
        return { allowed: true, retryAfterMs: 0 };
    }
}
