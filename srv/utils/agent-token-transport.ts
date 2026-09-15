/**
 * Shared by the transport auth (`agent-token-auth.ts`) and the grant hook
 * (`sessions/agent-grants.ts`), so neither side can drift.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Request header carrying an `ngat_` agent grant token. */
export const AGENT_TOKEN_HEADER = 'x-agent-token';

/**
 * Marker principal of a token request between transport auth and the grant
 * hook. Owns nothing; a handler reached under this id is NOT authenticated.
 */
export const AGENT_TOKEN_TRANSPORT_USER = 'agent-token-transport';

/** Marker principal of an anonymous public-verify request; owns nothing, refused elsewhere. */
export const PUBLIC_VERIFY_TRANSPORT_USER = 'public-verify-transport';

/** Service path of the public verify lane. */
export const PUBLIC_VERIFY_LANE_PREFIX = '/api/v1/verify';

/** Principal ids that identify no one; a rate limit keys them by client address. */
export const MARKER_PRINCIPALS: ReadonlySet<string> = new Set([
    AGENT_TOKEN_TRANSPORT_USER,
    PUBLIC_VERIFY_TRANSPORT_USER,
    'anonymous'
]);
