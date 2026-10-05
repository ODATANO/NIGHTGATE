/**
 * Public verification endpoint at `/api/v1/verify`.
 * It serves the same verify handlers as the main service, behind a feature flag and a rate limit.
 */

import cds from '@sap/cds';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { registerVerifyStateHandlers } from './submission/verify-state';
import { RateLimiter, principalRateKey } from './utils/rate-limiter';
import { configFlag, configNumber } from './utils/config';
import { normalizeHttpError } from './utils/http-errors';
import type { Request } from '@sap/cds';

let limiter: RateLimiter | undefined;
function publicVerifyLimiter(): RateLimiter {
    if (!limiter) {
        limiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: configNumber('NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT'), maxKeys: 20000 });
    }
    return limiter;
}

/** Forget the limiter and its windows (tests). */
export function __resetPublicVerifyLimiterForTests(): void {
    limiter = undefined;
}

/**
 * Rejects with 404 while the feature is off and with 429 when the caller is over its rate limit.
 * The 404 matters for hosts that serve this path without the image's auth middleware.
 */
export async function publicVerifyGate(req: Request): Promise<boolean> {
    if (!configFlag('NIGHTGATE_PUBLIC_VERIFY')) {
        req.reject({ status: 404, code: 'PUBLIC_VERIFY_DISABLED', message: 'public verification is not enabled on this server' } as any);
        return false;
    }
    const rate = publicVerifyLimiter().check(principalRateKey(req, 'public-verify'));
    if (!rate.allowed) {
        const seconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
        try { req.http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
        req.reject(429, `Rate limited. Retry after ${seconds}s`);
        return false;
    }
    return true;
}

export default class NightgateVerifyService extends cds.ApplicationService {
    async init(): Promise<void> {
        this.on('error', normalizeHttpError);
        await ensureNightgateModelLoaded();
        registerVerifyStateHandlers(this, { gate: publicVerifyGate });
        await super.init();
    }
}
