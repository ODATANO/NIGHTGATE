/**
 * Constants shared between the standalone image's transport auth
 * (`agent-token-auth.ts`, admits a token request under a marker principal)
 * and the Nightgate service's grant hook (`sessions/agent-grants.ts`, which
 * authenticates that token). One module so neither side can drift.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Request header carrying an `ngat_` agent grant token. */
export const AGENT_TOKEN_HEADER = 'x-agent-token';

/**
 * Marker principal a token request runs under between transport auth and
 * the grant hook. It owns nothing; the hook either swaps in the grant's
 * operator or rejects. A request that reaches a handler under this id has
 * NOT been authenticated.
 */
export const AGENT_TOKEN_TRANSPORT_USER = 'agent-token-transport';
