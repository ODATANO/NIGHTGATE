/**
 * Simple in-memory sliding window rate limiter.
 */

interface RateLimiterOptions {
    windowMs: number;
    maxRequests: number;
    maxKeys?: number;           // Max tracked keys (default: 10000)
    sweepIntervalMs?: number;   // Stale key sweep interval (default: 60000)
}

interface RateCheckResult {
    allowed: boolean;
    retryAfterMs: number;
}

export class RateLimiter {
    private windowMs: number;
    private maxRequests: number;
    private maxKeys: number;
    private hits: Map<string, number[]> = new Map();
    private sweepTimer: ReturnType<typeof setInterval>;

    constructor(opts: RateLimiterOptions) {
        this.windowMs = opts.windowMs;
        this.maxRequests = opts.maxRequests;
        this.maxKeys = opts.maxKeys || 10000;

        // Periodic sweep to remove stale keys
        const sweepInterval = opts.sweepIntervalMs || 60000;
        this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
        if (typeof this.sweepTimer.unref === 'function') {
            this.sweepTimer.unref();
        }
    }

    check(key: string): RateCheckResult {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // Reject new keys if map is at capacity (prevent memory DoS)
        if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
            return { allowed: false, retryAfterMs: this.windowMs };
        }

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

    /** Remove keys with no hits within the current window */
    private sweep(): void {
        const windowStart = Date.now() - this.windowMs;
        for (const [key, timestamps] of this.hits) {
            const active = timestamps.filter(t => t > windowStart);
            if (active.length === 0) {
                this.hits.delete(key);
            }
        }
    }

    /** Stop the background sweep timer */
    destroy(): void {
        clearInterval(this.sweepTimer);
    }
}
