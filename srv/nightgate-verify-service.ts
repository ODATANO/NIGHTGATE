// Public verification endpoint at `/odata/v4/midnight-verify`.
// It serves the same verify handlers as the main service, behind a feature flag and a rate limit.

import cds from '@sap/cds';
import { ensureNightgateModelLoaded } from './utils/cds-model';
import { registerVerifyStateHandlers } from './submission/verify-state';
import { checkRateClass } from './utils/rate-classes';
import { configFlag } from './utils/config';
import { normalizeHttpError } from './utils/http-errors';
import type { Request } from '@sap/cds';

/** Rejects with 404 while the feature is off and with 429 when the caller is over its rate limit.
 * The 404 matters for hosts that serve this path without the image's auth middleware. */
export async function publicVerifyGate(req: Request): Promise<boolean> {
    if (!configFlag('NIGHTGATE_PUBLIC_VERIFY')) {
        req.reject({ status: 404, code: 'PUBLIC_VERIFY_DISABLED', message: 'public verification is not enabled on this server' } as any);
        return false;
    }
    return checkRateClass('public-verify', 'public-verify', req);
}

export default class NightgateVerifyService extends cds.ApplicationService {
    async init(): Promise<void> {
        this.on('error', normalizeHttpError);
        await ensureNightgateModelLoaded();
        registerVerifyStateHandlers(this, { gate: publicVerifyGate });
        await super.init();
    }
}
