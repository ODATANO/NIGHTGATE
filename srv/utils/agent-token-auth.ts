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
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER } from './agent-token-transport';
import { RateLimiter } from './rate-limiter';

const AGENT_LANE_PREFIX = '/api/v1/nightgate';

// Failed basic-auth attempts per client address. The image has one operator
// account with a static password, so an unthrottled 401 is an offline-speed
// guessing oracle. After the budget a client gets 429 for the rest of the
// window, correct password or not.
const BASIC_AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const BASIC_AUTH_MAX_FAILURES = 20;
const basicFailures = new RateLimiter({ windowMs: BASIC_AUTH_FAILURE_WINDOW_MS, maxRequests: BASIC_AUTH_MAX_FAILURES, maxKeys: 10000 });

function clientFailureKey(req: any): string {
    const ip = req?.ip ?? req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? 'unknown';
    return `${String(ip)}:basic-auth`;
}

function reject429(res: any, retryAfterMs: number): void {
    res.set?.('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    res.status?.(429);
    res.send?.('Too many failed authentication attempts');
}

function __resetBasicAuthThrottleForTests(): void {
    basicFailures.reset();
}

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
    const users: Record<string, { password?: string; roles?: string[] }> =
        (cds as any).env?.requires?.auth?.users ?? {};

    // Lane 1: valid basic credentials, the operator. Same behavior as before.
    const basic = parseBasic(req.headers?.authorization);
    if (basic) {
        const failureKey = clientFailureKey(req);
        const locked = basicFailures.peek(failureKey);
        if (!locked.allowed) return reject429(res, locked.retryAfterMs);
        const known = Object.prototype.hasOwnProperty.call(users, basic.user) ? users[basic.user] : undefined;
        if (known && timingSafeEqualStr(basic.password, String(known.password ?? ''))) {
            const UserCtor = (cds as any).User;
            // Carry the configured roles. Dropping them made `user.is('admin')`
            // false for everyone, so the whole admin service answered 403 to
            // the operator the deployment was built around.
            const roles = Array.isArray(known.roles) ? known.roles : [];
            (req as any).user = UserCtor
                ? new UserCtor({ id: basic.user, roles })
                : { id: basic.user, roles };
            return next();
        }
        const failed = basicFailures.check(failureKey);
        if (!failed.allowed) return reject429(res, failed.retryAfterMs);
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
    // $batch: every part runs as its own request under the envelope's principal
    // (the marker set below); the grant hook authenticates each part from the
    // envelope token CAP merges into the part's `req.headers`, and rejects a
    // part that reaches it under the marker principal without a token.
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
agentTokenAuth.BASIC_AUTH_FAILURE_WINDOW_MS = BASIC_AUTH_FAILURE_WINDOW_MS;
agentTokenAuth.BASIC_AUTH_MAX_FAILURES = BASIC_AUTH_MAX_FAILURES;
agentTokenAuth.__resetBasicAuthThrottleForTests = __resetBasicAuthThrottleForTests;
export = agentTokenAuth;
