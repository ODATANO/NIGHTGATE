/**
 * When is a wallet session expired?
 *
 * The answer has one exception, and every caller must apply it the same way: a
 * session CONFIGURED as a platform fee sponsor is infrastructure, not a
 * caller's handle, and it does not expire while it is configured. That rule was
 * learned the hard way (2026-08-19: the pool silently died 24 h after it was
 * set up and the cleanup sweep wiped its key material), and `resolveFeeSponsor`
 * has honoured it ever since.
 *
 * The rule used to live only there, while eight other sites carried their own
 * bare `expiresAt < now`. So sponsoring worked while every ordinary read of the
 * same session answered 410, and a status endpoint built on the generic loader
 * reported the whole live pool as expired. One predicate, used everywhere, is
 * the fix; a new call site inherits the exception instead of rediscovering it.
 *
 * This module deliberately has no dependency beyond the plugin config: it sits
 * below both fee-sponsor and wallet-material-factory, which import each other.
 */

import { getNightgatePluginConfig } from './nightgate-config';

/**
 * Session ids any authenticated caller may use as fee sponsor.
 * Env NIGHTGATE_FEE_SPONSOR_SESSION wins over cds config `feeSponsorSessions`
 * (string, comma separated, or array of strings).
 */
export function getConfiguredFeeSponsorSessions(config?: Record<string, any>): string[] {
    const fromEnv = process.env.NIGHTGATE_FEE_SPONSOR_SESSION?.trim();
    const fromConfig = Array.isArray(config?.feeSponsorSessions)
        ? config!.feeSponsorSessions.join(',')
        : config?.feeSponsorSessions;
    const raw = fromEnv || fromConfig;
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** Is this session id listed as platform fee-sponsor infrastructure? */
export function isConfiguredPlatformSponsor(sessionId: string | undefined | null, config?: Record<string, any>): boolean {
    if (!sessionId) return false;
    return getConfiguredFeeSponsorSessions(config ?? getNightgatePluginConfig()).includes(sessionId);
}

/**
 * The single expiry decision. `expiresAt` in the past means expired, UNLESS
 * the session is configured platform infrastructure.
 *
 * Pass the session's PUBLIC `sessionId` (the field the config lists), not the
 * row's ID.
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
