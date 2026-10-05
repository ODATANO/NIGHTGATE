/**
 * Decides when a wallet session has expired. Sessions configured as platform fee sponsors never expire.
 * This module imports only config code, so modules that import each other can both use it.
 */

import { getNightgatePluginConfig, type NightgatePluginConfig } from './nightgate-config';
import { configList } from './config';

/**
 * Session ids any authenticated caller may use as fee sponsor.
 * Env NIGHTGATE_FEE_SPONSOR_SESSION wins over cds config `feeSponsorSessions`.
 */
export function getConfiguredFeeSponsorSessions(config?: NightgatePluginConfig): string[] {
    const fromEnv = configList('NIGHTGATE_FEE_SPONSOR_SESSION');
    if (fromEnv.length) return fromEnv;
    const raw = Array.isArray(config?.feeSponsorSessions)
        ? config!.feeSponsorSessions.join(',')
        : config?.feeSponsorSessions;
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function isConfiguredPlatformSponsor(sessionId: string | undefined | null, config?: NightgatePluginConfig): boolean {
    if (!sessionId) return false;
    return getConfiguredFeeSponsorSessions(config ?? getNightgatePluginConfig()).includes(sessionId);
}

/**
 * Expired when `expiresAt` is in the past, unless the session is a configured sponsor.
 * Pass the public `sessionId` that the config lists, not the database row ID.
 */
export function isSessionExpired(
    sessionId: string | undefined | null,
    expiresAt: unknown,
    config?: NightgatePluginConfig
): boolean {
    if (!expiresAt) return false;
    if (isConfiguredPlatformSponsor(sessionId, config)) return false;
    const at = new Date(String(expiresAt)).getTime();
    return Number.isFinite(at) && at < Date.now();
}
