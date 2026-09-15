/**
 * The one wallet-session expiry predicate; configured platform sponsors never
 * expire. Imports only config: it sits below fee-sponsor and
 * wallet-material-factory, which import each other.
 */

import { getNightgatePluginConfig } from './nightgate-config';
import { configList } from './config';

/**
 * Session ids any authenticated caller may use as fee sponsor.
 * Env NIGHTGATE_FEE_SPONSOR_SESSION wins over cds config `feeSponsorSessions`.
 */
export function getConfiguredFeeSponsorSessions(config?: Record<string, any>): string[] {
    const fromEnv = configList('NIGHTGATE_FEE_SPONSOR_SESSION');
    if (fromEnv.length) return fromEnv;
    const raw = Array.isArray(config?.feeSponsorSessions)
        ? config!.feeSponsorSessions.join(',')
        : config?.feeSponsorSessions;
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** Is this session id listed as platform fee-sponsor infrastructure? */
export function isConfiguredPlatformSponsor(sessionId: string | undefined | null, config?: Record<string, any>): boolean {
    if (!sessionId) return false;
    return getConfiguredFeeSponsorSessions(config ?? getNightgatePluginConfig()).includes(sessionId);
}

/**
 * Expired when `expiresAt` is past, unless the session is a configured sponsor.
 * Pass the PUBLIC `sessionId` (what the config lists), not the row ID.
 */
export function isSessionExpired(
    sessionId: string | undefined | null,
    expiresAt: unknown,
    config?: Record<string, any>
): boolean {
    if (!expiresAt) return false;
    if (isConfiguredPlatformSponsor(sessionId, config)) return false;
    const at = new Date(String(expiresAt)).getTime();
    return Number.isFinite(at) && at < Date.now();
}
