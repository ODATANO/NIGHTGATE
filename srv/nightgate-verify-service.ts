/**
 * The public verify lane (`/api/v1/verify`): the Nightgate service's
 * state-verification handlers behind a feature flag and a per-address rate limit.
 */

import cds, { Request } from '@sap/cds';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { registerVerifyStateHandlers } from './submission/verify-state';
import { RateLimiter, principalRateKey } from './utils/rate-limiter';
import { configFlag, configNumber } from './utils/config';

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
 * 404 while the lane is off (a host without the image's transport middleware
 * still serves the path), 429 over the per-address budget.
 */
export async function publicVerifyGate(req: Request): Promise<boolean> {
    if (!configFlag('NIGHTGATE_PUBLIC_VERIFY')) {
        req.reject({ status: 404, code: 'PUBLIC_VERIFY_DISABLED', message: 'public verification is not enabled on this server' } as any);
        return false;
    }
    const rate = publicVerifyLimiter().check(principalRateKey(req, 'public-verify'));
    if (!rate.allowed) {
        const seconds = Math.max(1, Math.ceil(rate.retryAfterMs / 1000));
        try { (req as any).http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
        req.reject(429, `Rate limited. Retry after ${seconds}s`);
        return false;
    }
    return true;
}

export default class NightgateVerifyService extends cds.ApplicationService {
    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        registerVerifyStateHandlers(this, { gate: publicVerifyGate });
        await super.init();
    }
}
