/**
 * Transport auth of the standalone image (`srv/utils/agent-token-auth.ts`):
 * basic auth exactly as before, plus the narrow agent-token lane into the
 * Nightgate service where the grant hook takes over.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import cds from '@sap/cds';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentTokenAuth = require('../../srv/utils/agent-token-auth');

const USERS = { nightgate: { password: 'op-secret' } };
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

function run(headers: Record<string, string>, path = '/api/v1/nightgate/sponsorFinalizedTransaction') {
    const req: any = { headers, baseUrl: path, originalUrl: path };
    const res: any = { set: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    const next = vi.fn();
    agentTokenAuth(req, res, next);
    return { req, res, next };
}

beforeEach(() => {
    (cds as any).env.requires = (cds as any).env.requires ?? {};
    (cds as any).env.requires.auth = { impl: 'x', users: USERS };
});

describe('agent-token-auth', () => {
    test('valid basic credentials authenticate as the operator', () => {
        const { req, res, next } = run({ authorization: basic('nightgate', 'op-secret') }, '/api/v1/admin/whatever');
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(req.user.id).toBe('nightgate');
    });

    test('wrong basic credentials 401 and NEVER fall through to the token lane', () => {
        const { res, next } = run({
            authorization: basic('nightgate', 'wrong'),
            'x-agent-token': 'ngat_abc'
        });
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('Basic'));
    });

    test('unknown user and malformed basic header 401', () => {
        expect(run({ authorization: basic('ghost', 'op-secret') }).res.status).toHaveBeenCalledWith(401);
        expect(run({ authorization: 'Basic not-base64:::' }).res.status).toHaveBeenCalledWith(401);
        expect(run({}).res.status).toHaveBeenCalledWith(401);
    });

    test('an agent token passes transport auth for the Nightgate service only', () => {
        const ok = run({ 'x-agent-token': 'ngat_abc' });
        expect(ok.next).toHaveBeenCalled();
        // marker principal owns nothing; the grant hook swaps in the operator
        expect(ok.req.user.id).toBe(agentTokenAuth.AGENT_TOKEN_TRANSPORT_USER);

        // every other service keeps requiring basic auth: no enforcement hook there
        for (const path of ['/api/v1/admin/anything', '/api/v1/analytics/x', '/api/v1/indexer/getHealth()']) {
            const blocked = run({ 'x-agent-token': 'ngat_abc' }, path);
            expect(blocked.next).not.toHaveBeenCalled();
            expect(blocked.res.status).toHaveBeenCalledWith(401);
        }
    });

    test('an empty token header does not open the lane', () => {
        const { res, next } = run({ 'x-agent-token': '' });
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
    });

    test('lookalike prefixes stay closed; the exact service root stays open', () => {
        // startsWith alone would open the lane for these
        for (const path of [
            '/api/v1/nightgate-admin/x',
            '/api/v1/nightgateevil/sponsorFinalizedTransaction',
            '/api/v1/admin/../nightgate-lookalike'
        ]) {
            const { res, next } = run({ 'x-agent-token': 'ngat_abc' }, path);
            expect(next, path).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(401);
        }
        // exact root, subpath and query form remain in the lane
        for (const path of [
            '/api/v1/nightgate',
            "/api/v1/nightgate/verifyAttestationState(contractAddress='c',payloadHash='p')",
            '/api/v1/nightgate?x=1'
        ]) {
            const { next } = run({ 'x-agent-token': 'ngat_abc' }, path);
            expect(next, path).toHaveBeenCalled();
        }
    });
});
