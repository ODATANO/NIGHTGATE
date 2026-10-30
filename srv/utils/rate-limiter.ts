/** In-memory sliding window rate limiter. */

interface RateLimiterOptions {
    windowMs: number;
    /** A function is read on every check, so a changed setting applies without a restart. */
    maxRequests: number | (() => number);
    maxKeys?: number;           // Max tracked keys (default: 10000)
    sweepIntervalMs?: number;   // How often unused keys are removed (default: 60000)
    /** Max keys per caller (default 64). The caller is the part of the key before the first ':'.
     *  This stops one caller from pushing every other caller out of the table. */
    maxKeysPerGroup?: number;
}

export interface RateCheckResult {
    allowed: boolean;
    retryAfterMs: number;
    /** The limit in force for this check. */
    limit: number;
    /** Requests still allowed in the current window after this check. */
    remaining: number;
    /** Until the oldest counted request leaves the window; 0 when nothing is counted. */
    resetMs: number;
}

function groupOf(key: string): string {
    const i = key.indexOf(':');
    return i < 0 ? key : key.slice(0, i);
}

import { MARKER_PRINCIPALS } from './agent-token-transport';

/** Rate-limit key `caller:scope`. The caller is the agent grant, else the real user, else the client IP address.
 *  The IP address is unreliable behind proxies. The caller part never contains ':'. */
export function principalRateKey(req: any, scope: string): string {
    const grant = req?.agentGrant?.ID;
    const rawUser = req?.user?.id;
    const user = typeof rawUser === 'string' && !MARKER_PRINCIPALS.has(rawUser) ? rawUser : undefined;
    const ip = req?.http?.req?.ip ?? req?.ip;
    const principal = grant ? `grant=${String(grant)}`
        : user ? `user=${String(user)}`
        : ip ? `ip=${String(ip).replace(/:/g, '.')}`
        : 'anonymous';
    return `${principal}:${scope}`;
}

/** The key `principalRateKey` builds for a request under the grant. */
export function grantRateKey(grantId: string, scope: string): string {
    return `grant=${grantId}:${scope}`;
}

export class RateLimiter {
    readonly windowMs: number;
    private readonly maxRequestsOption: number | (() => number);
    private maxKeys: number;
    private maxKeysPerGroup: number;
    private groupCounts: Map<string, number> = new Map();
    private hits: Map<string, number[]> = new Map();
    private sweepTimer: ReturnType<typeof setInterval>;

    constructor(opts: RateLimiterOptions) {
        this.windowMs = opts.windowMs;
        this.maxRequestsOption = opts.maxRequests;
        this.maxKeys = opts.maxKeys || 10000;
        this.maxKeysPerGroup = opts.maxKeysPerGroup || 64;

        const sweepInterval = opts.sweepIntervalMs || 60000;
        this.sweepTimer = setInterval(() => this.sweep(), sweepInterval);
        if (typeof this.sweepTimer.unref === 'function') {
            this.sweepTimer.unref();
        }
    }

    get maxRequests(): number {
        const v = this.maxRequestsOption;
        return typeof v === 'function' ? v() : v;
    }

    check(key: string): RateCheckResult {
        return this.checkMany(key, 1);
    }

    /** Would one more request fit? Records nothing. */
    peek(key: string): RateCheckResult {
        const now = Date.now();
        const limit = this.maxRequests;
        const inWindow = (this.hits.get(key) ?? []).filter(t => t > now - this.windowMs);
        const oldest = inWindow.length ? Math.min(...inWindow) : undefined;
        const resetMs = oldest === undefined ? 0 : Math.max(oldest + this.windowMs - now, 0);
        if (inWindow.length < limit) return { allowed: true, retryAfterMs: 0, limit, remaining: limit - inWindow.length, resetMs };
        return { allowed: false, retryAfterMs: resetMs, limit, remaining: 0, resetMs };
    }

    reset(): void {
        this.hits.clear();
        this.groupCounts.clear();
    }

    /** Records `count` requests at once. Either all fit and are recorded, or none are. */
    checkMany(key: string, count: number): RateCheckResult {
        const limit = this.maxRequests;
        if (count <= 0) return { allowed: true, retryAfterMs: 0, limit, remaining: limit, resetMs: 0 };
        const now = Date.now();
        const windowStart = now - this.windowMs;

        const isNew = !this.hits.has(key);
        if (isNew) {
            const group = groupOf(key);
            if ((this.groupCounts.get(group) ?? 0) >= this.maxKeysPerGroup) {
                return { allowed: false, retryAfterMs: this.windowMs, limit, remaining: 0, resetMs: this.windowMs };
            }
            // When full, drop the least recently used key.
            // Refusing new keys instead would let one caller lock everyone else out.
            if (this.hits.size >= this.maxKeys) {
                const oldest = this.hits.keys().next().value;
                if (oldest !== undefined) this.dropKey(oldest);
            }
            this.groupCounts.set(group, (this.groupCounts.get(group) ?? 0) + 1);
        }

        let timestamps = this.hits.get(key) || [];
        timestamps = timestamps.filter(t => t > windowStart);
        this.hits.delete(key); // re-inserted below, which marks it as most recently used

        if (timestamps.length + count > limit) {
            timestamps.sort((a, b) => a - b);
            const oldestInWindow = timestamps[0];
            // A count larger than the whole limit never fits, so report a full window instead of 0.
            const retryAfterMs = oldestInWindow === undefined
                ? this.windowMs
                : Math.max(oldestInWindow + this.windowMs - now, 0);
            this.hits.set(key, timestamps);
            return { allowed: false, retryAfterMs, limit, remaining: Math.max(limit - timestamps.length, 0), resetMs: retryAfterMs };
        }

        const oldest = timestamps.length ? Math.min(...timestamps) : now;
        for (let i = 0; i < count; i++) timestamps.push(now);
        this.hits.set(key, timestamps);
        return { allowed: true, retryAfterMs: 0, limit, remaining: limit - timestamps.length, resetMs: Math.max(oldest + this.windowMs - now, 0) };
    }

    private dropKey(key: string): void {
        if (!this.hits.delete(key)) return;
        const group = groupOf(key);
        const n = (this.groupCounts.get(group) ?? 1) - 1;
        if (n <= 0) this.groupCounts.delete(group); else this.groupCounts.set(group, n);
    }

    private sweep(): void {
        const windowStart = Date.now() - this.windowMs;
        for (const [key, timestamps] of this.hits) {
            const active = timestamps.filter(t => t > windowStart);
            if (active.length === 0) {
                this.dropKey(key);
            }
        }
    }

    destroy(): void {
        clearInterval(this.sweepTimer);
    }
}
