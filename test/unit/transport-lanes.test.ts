/**
 * NIGHTGATE's two transport lanes (`srv/utils/transport-lanes.ts`) inside the
 * package's middleware with a stub delegate: the agent-token lane admits a
 * token on the Nightgate service under the marker principal (the grant hook
 * authenticates), the public verify lane admits `/api/v1/verify` when enabled.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { createTransportAuth, __resetTransportLanesForTests, type AuthMiddleware } from '@odatano/cap-auth';
import { registerNightgateTransportLanes } from '../../srv/utils/transport-lanes';
import { AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER } from '../../srv/utils/agent-token-transport';
import { __resetConfigForTests } from '../../srv/utils/config';

const USERS = { nightgate: { password: 'op-secret', roles: ['admin'] } };
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

let delegate: ReturnType<typeof vi.fn>;
let auth: AuthMiddleware;

async function run(headers: Record<string, string>, path = '/api/v1/nightgate/sponsorFinalizedTransaction', method = 'GET') {
    const req: any = { headers, baseUrl: path, originalUrl: path, ip: '10.0.0.1', method };
    const res: any = { statusCode: 200, set: vi.fn(), setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), send: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    await auth(req, res, next);
    return { req, res, next };
}

beforeEach(() => {
    __resetTransportLanesForTests();
    delete process.env.NIGHTGATE_PUBLIC_VERIFY;
    __resetConfigForTests();
    registerNightgateTransportLanes();
    delegate = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
    auth = createTransportAuth({ kind: 'basic', users: USERS, realm: 'nightgate' }, delegate as unknown as AuthMiddleware);
});

describe('transport lanes', () => {
    test('lane order: basic, agent-token, public-verify', () => {
        expect((auth as unknown as { lanes: readonly string[] }).lanes).toEqual(['basic', 'agent-token', 'public-verify']);
    });

    test('an agent token passes transport auth for the Nightgate service only, under the marker principal', async () => {
        const ok = await run({ 'x-agent-token': 'ngat_abc' });
        expect(ok.next).toHaveBeenCalled();
        expect(ok.req.user.id).toBe(AGENT_TOKEN_TRANSPORT_USER);
        expect(ok.req.user.is('admin')).toBe(false);
        expect(delegate).not.toHaveBeenCalled();
        // every other service is the delegate's: no grant hook there
        for (const path of ['/api/v1/admin/anything', '/api/v1/analytics/x', '/api/v1/indexer/getHealth()']) {
            const other = await run({ 'x-agent-token': 'ngat_abc' }, path);
            expect(other.req.user, path).toBeUndefined();
        }
        expect(delegate).toHaveBeenCalledTimes(3);
    });

    test('$batch and the query form are admitted under the marker; the grant hook authenticates every part', async () => {
        for (const path of ['/api/v1/nightgate/$batch', '/api/v1/nightgate/$batch?x=1', '/api/v1/nightgate', '/api/v1/nightgate?x=1']) {
            const { req, next } = await run({ 'x-agent-token': 'ngat_abc' }, path);
            expect(next, path).toHaveBeenCalled();
            expect(req.user.id).toBe(AGENT_TOKEN_TRANSPORT_USER);
        }
    });

    test('an empty token header and lookalike prefixes do not open the lane', async () => {
        for (const [headers, path] of [
            [{ 'x-agent-token': '' }, '/api/v1/nightgate/x'],
            [{ 'x-agent-token': 'ngat_abc' }, '/api/v1/nightgate-admin/x'],
            [{ 'x-agent-token': 'ngat_abc' }, '/api/v1/nightgateevil/sponsorFinalizedTransaction'],
            [{ 'x-agent-token': 'ngat_abc' }, '/api/v1/admin/../nightgate-lookalike']
        ] as const) {
            const { req } = await run(headers as Record<string, string>, path);
            expect(req.user, path).toBeUndefined();
        }
        expect(delegate).toHaveBeenCalledTimes(4);
    });

    test('wrong basic credentials never fall through to the token lane', async () => {
        const { res, next } = await run({ authorization: basic('nightgate', 'wrong'), 'x-agent-token': 'ngat_abc' });
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Basic realm="nightgate"');
        const op = await run({ authorization: basic('nightgate', 'op-secret'), 'x-agent-token': 'ngat_abc' });
        expect(op.req.user.id).toBe('nightgate');
        expect(op.req.user.is('admin')).toBe(true);
    });

    test('the public verify lane stays closed while NIGHTGATE_PUBLIC_VERIFY is unset', async () => {
        const { req, res } = await run({}, "/api/v1/verify/verifyAttestationState(contractAddress='c',payloadHash='p')");
        expect(req.user).toBeUndefined();
        expect(delegate).toHaveBeenCalledTimes(1);
        expect(res.set).not.toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });

    test('enabled: the verify path passes under the public marker with CORS headers; lookalikes stay closed', async () => {
        process.env.NIGHTGATE_PUBLIC_VERIFY = 'true';
        __resetConfigForTests();
        for (const path of ['/api/v1/verify', "/api/v1/verify/verifyPredicateState(contractAddress='c',payloadHash='p',predicate='setMembership')", '/api/v1/verify?x=1']) {
            const { req, res, next } = await run({}, path);
            expect(next, path).toHaveBeenCalled();
            expect(req.user.id).toBe(PUBLIC_VERIFY_TRANSPORT_USER);
            expect(res.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
        }
        for (const path of ['/api/v1/verifyx/a', '/api/v1/verify-admin', '/api/v1/nightgate/verifyAttestationState()', '/api/v1/admin/x']) {
            const { req } = await run({}, path);
            expect(req.user, path).toBeUndefined();
        }
        const op = await run({ authorization: basic('nightgate', 'op-secret') }, '/api/v1/verify/x');
        expect(op.req.user.id).toBe('nightgate');
    });

    test('the lane answers the CORS preflight itself', async () => {
        process.env.NIGHTGATE_PUBLIC_VERIFY = 'true';
        __resetConfigForTests();
        const { res, next } = await run({ origin: 'https://example.org' }, '/api/v1/verify/verifyAttestationState()', 'OPTIONS');
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(204);
        expect(res.end).toHaveBeenCalled();
        expect(res.set).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, OPTIONS');
        const other = await run({}, '/api/v1/nightgate/x', 'OPTIONS');
        expect(other.req.user).toBeUndefined();
        expect(delegate).toHaveBeenCalledTimes(1);
    });

    test('registering after the middleware was built logs instead of throwing (a plugin must not take the host down)', () => {
        const spy = vi.spyOn(cds.log('nightgate'), 'error').mockImplementation(() => undefined as never);
        registerNightgateTransportLanes(); // the registry froze in createTransportAuth
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('transport lanes not registered'));
        spy.mockRestore();
    });
});
