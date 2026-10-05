/**
 * Constants shared by the transport authentication and the agent grant check, so both use the same values.
 * SPDX-License-Identifier: Apache-2.0
 */

export const AGENT_TOKEN_HEADER = 'x-agent-token';

/**
 * Placeholder user for a request with an agent token, until the grant check has verified the token.
 * It owns nothing. A handler that sees this id is not authenticated.
 */
export const AGENT_TOKEN_TRANSPORT_USER = 'agent-token-transport';

/** Placeholder user for an anonymous request to the public verify service. It owns nothing and is refused elsewhere. */
export const PUBLIC_VERIFY_TRANSPORT_USER = 'public-verify-transport';

export const PUBLIC_VERIFY_LANE_PREFIX = '/api/v1/verify';

/** User ids that identify no real user. Rate limits count these by client address instead. */
export const MARKER_PRINCIPALS: ReadonlySet<string> = new Set([
    AGENT_TOKEN_TRANSPORT_USER,
    PUBLIC_VERIFY_TRANSPORT_USER,
    'anonymous'
]);
