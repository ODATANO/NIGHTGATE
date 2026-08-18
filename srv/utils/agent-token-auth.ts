/**
 * Transport auth for the standalone image (0.17.1): basic auth PLUS an
 * agent-token lane.
 *
 * Plain CAP basic auth 401s every request without credentials BEFORE any
 * service hook runs, so an external agent holding only an `ngat_` grant token
 * could not reach `sponsorFinalizedTransaction` without ALSO being handed the
 * operator's transport password, which defeats per-agent tokens.
 *
 * This middleware keeps basic auth exactly as before and adds ONE narrow
 * exception: a request carrying `x-agent-token` may pass transport auth for
 * the Nightgate service path ONLY, where `enforceAgentGrant` (before('*'))
 * performs the real authentication and authorization: invalid token 401
 * (non-leaking), event outside the grant 403, principal swapped to the
 * grant's operator on success. Every other path keeps requiring basic auth,
 * because only the Nightgate service carries the enforcement hook.
 *
 * The pre-hook principal is deliberately a marker id that owns nothing; no
 * session, grant or document row can belong to it, so even a handler reached
 * without the hook's principal swap (there is none on this path) could not
 * read foreign state through owner scoping.
 *
 * Wired by docker/entrypoint.sh via `auth: { impl: ..., users: {...} }`.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import cds from '@sap/cds';

const AGENT_TOKEN_HEADER = 'x-agent-token';
const AGENT_LANE_PREFIX = '/api/v1/nightgate';
/** Marker principal for token requests between transport auth and the grant hook. */
const AGENT_TOKEN_TRANSPORT_USER = 'agent-token-transport';

function timingSafeEqualStr(a: string, b: string): boolean {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    // length-equalized compare; the length check itself leaks nothing useful
    if (ab.length !== bb.length) {
        crypto.timingSafeEqual(bb, bb);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

function parseBasic(header: unknown): { user: string; password: string } | null {
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
    try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep < 0) return null;
        return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
    } catch {
        return null;
    }
}

function reject401(res: any): void {
    res.set?.('WWW-Authenticate', 'Basic realm="nightgate"');
    res.status(401).send('Unauthorized');
}

/**
 * Express-style CAP custom auth middleware.
 * Users come from `cds.env.requires.auth.users` (entrypoint-injected).
 * `export =`: CAP requires the module and expects THE FUNCTION as
 * module.exports; a default export would land under `.default`.
 */
function agentTokenAuth(req: any, res: any, next: () => void): void {
    const users: Record<string, { password?: string }> =
        (cds as any).env?.requires?.auth?.users ?? {};

    // Lane 1: valid basic credentials, the operator. Same behavior as before.
    const basic = parseBasic(req.headers?.authorization);
    if (basic) {
        const known = Object.prototype.hasOwnProperty.call(users, basic.user) ? users[basic.user] : undefined;
        if (known && timingSafeEqualStr(basic.password, String(known.password ?? ''))) {
            const UserCtor = (cds as any).User;
            (req as any).user = UserCtor ? new UserCtor({ id: basic.user }) : { id: basic.user };
            return next();
        }
        return reject401(res); // wrong credentials never fall through to the token lane
    }

    // Lane 2: agent token, Nightgate service only. The grant hook authenticates.
    // Exact segment boundary: a bare startsWith would also open the lane for
    // lookalike prefixes (/api/v1/nightgate-admin, /api/v1/nightgateevil),
    // widening the boundary beyond the one service that carries the hook.
    const token = req.headers?.[AGENT_TOKEN_HEADER];
    const path = String(req.baseUrl || req.originalUrl || req.path || '');
    const inLane = path === AGENT_LANE_PREFIX
        || path.startsWith(AGENT_LANE_PREFIX + '/')
        || path.startsWith(AGENT_LANE_PREFIX + '?');
    if (typeof token === 'string' && token.length > 0 && inLane) {
        const UserCtor = (cds as any).User;
        (req as any).user = UserCtor
            ? new UserCtor({ id: AGENT_TOKEN_TRANSPORT_USER })
            : { id: AGENT_TOKEN_TRANSPORT_USER };
        return next();
    }

    return reject401(res);
}

agentTokenAuth.AGENT_TOKEN_TRANSPORT_USER = AGENT_TOKEN_TRANSPORT_USER;
export = agentTokenAuth;
