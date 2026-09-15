/**
 * Standalone-image transport auth: basic auth, plus an agent-token lane on the
 * Nightgate path (the grant hook authenticates) and the optional public verify
 * lane. Both pass under marker principals that own nothing.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import cds from '@sap/cds';
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER, PUBLIC_VERIFY_LANE_PREFIX } from './agent-token-transport';
import { RateLimiter } from './rate-limiter';
import { configFlag } from './config';

const AGENT_LANE_PREFIX = '/api/v1/nightgate';

/** Exact segment boundary: the service root, a sub-path or a query on it. */
function inLaneOf(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

/** Any-origin CORS, only on the public verify lane. */
function setPublicVerifyCors(res: any): void {
    res.set?.('Access-Control-Allow-Origin', '*');
    res.set?.('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set?.('Access-Control-Allow-Headers', 'accept, content-type');
    res.set?.('Access-Control-Max-Age', '600');
}

// Failed basic-auth attempts per client address: one static operator password
// makes an unthrottled 401 a guessing oracle. Over budget = 429 for the window,
// correct password or not.
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
 * CAP custom auth middleware; users from `cds.env.requires.auth.users`.
 * `export =` because CAP expects the function itself as module.exports.
 */
function agentTokenAuth(req: any, res: any, next: () => void): void {
    const users: Record<string, { password?: string; roles?: string[] }> =
        (cds as any).env?.requires?.auth?.users ?? {};

    // Lane 1: valid basic credentials, the operator.
    const basic = parseBasic(req.headers?.authorization);
    if (basic) {
        const failureKey = clientFailureKey(req);
        const locked = basicFailures.peek(failureKey);
        if (!locked.allowed) return reject429(res, locked.retryAfterMs);
        const known = Object.prototype.hasOwnProperty.call(users, basic.user) ? users[basic.user] : undefined;
        if (known && timingSafeEqualStr(basic.password, String(known.password ?? ''))) {
            const UserCtor = (cds as any).User;
            // Without the roles `user.is('admin')` is false for the operator.
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

    // Lane 2: agent token, Nightgate service only; the grant hook authenticates
    // (also each $batch part). Exact segment match: a bare startsWith would
    // open lookalike paths such as /api/v1/nightgate-admin.
    const token = req.headers?.[AGENT_TOKEN_HEADER];
    const path = String(req.baseUrl || req.originalUrl || req.path || '');
    const inLane = inLaneOf(path, AGENT_LANE_PREFIX);
    if (typeof token === 'string' && token.length > 0 && inLane) {
        const UserCtor = (cds as any).User;
        (req as any).user = UserCtor
            ? new UserCtor({ id: AGENT_TOKEN_TRANSPORT_USER })
            : { id: AGENT_TOKEN_TRANSPORT_USER };
        return next();
    }

    // Lane 3: public verify, no credential; the verify service rate-limits by address.
    if (configFlag('NIGHTGATE_PUBLIC_VERIFY') && inLaneOf(path, PUBLIC_VERIFY_LANE_PREFIX)) {
        setPublicVerifyCors(res);
        if (String(req.method).toUpperCase() === 'OPTIONS') {
            res.status?.(204);
            res.end?.() ?? res.send?.();
            return;
        }
        const UserCtor = (cds as any).User;
        (req as any).user = UserCtor
            ? new UserCtor({ id: PUBLIC_VERIFY_TRANSPORT_USER })
            : { id: PUBLIC_VERIFY_TRANSPORT_USER };
        return next();
    }

    return reject401(res);
}

agentTokenAuth.AGENT_TOKEN_TRANSPORT_USER = AGENT_TOKEN_TRANSPORT_USER;
agentTokenAuth.PUBLIC_VERIFY_TRANSPORT_USER = PUBLIC_VERIFY_TRANSPORT_USER;
agentTokenAuth.BASIC_AUTH_FAILURE_WINDOW_MS = BASIC_AUTH_FAILURE_WINDOW_MS;
agentTokenAuth.BASIC_AUTH_MAX_FAILURES = BASIC_AUTH_MAX_FAILURES;
agentTokenAuth.__resetBasicAuthThrottleForTests = __resetBasicAuthThrottleForTests;
export = agentTokenAuth;
