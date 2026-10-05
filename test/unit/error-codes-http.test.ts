/**
 * Error codes in HTTP responses of a booted server: plain rejects, thrown NightgateErrors,
 * $batch parts, the verify service and 5xx in production mode.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';
import { NightgateError } from '../../srv/utils/errors';

const cap = cds.test(__dirname + '/../..') as any;
const P = '/api/v1/nightgate';

async function errorOf(p: Promise<any>): Promise<{ status: number; error: any }> {
    try {
        const r = await p;
        throw new Error(`expected an error, got ${r.status}`);
    } catch (e: any) {
        if (!e.response) throw e;
        return { status: e.response.status, error: e.response.data?.error };
    }
}

beforeAll(() => {
    const srv = cds.services.NightgateService as any;
    // A test-only failure mode for one function, ahead of its real handler.
    srv.prepend(() => srv.before('deriveTokenType', (req: any) => {
        const a = req.data?.contractAddress;
        if (a === 'throw-coded') throw new NightgateError('WALLET_NOT_SYNCED', 'wallet not at tip');
        if (a === 'throw-503') throw Object.assign(new Error('upstream secret'), { status: 503 });
        if (a === 'throw-502-extras') {
            throw Object.assign(new Error('upstream secret'), { status: 502, reason: 'SECRET_REASON', innererror: { secret: 'INNER' }, details: [{ message: 'DETAIL' }] });
        }
    }));
});

const env = process.env.NODE_ENV;
afterEach(() => { if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; });

describe('error codes over HTTP', () => {
    it('a plain 400 reject answers 400 INVALID_ARGUMENT with its message', async () => {
        const { status, error } = await errorOf(cap.POST(`${P}/anchorDocument`, {}));
        expect(status).toBe(400);
        expect(error.code).toBe('INVALID_ARGUMENT');
        expect(error.message).toBeTruthy();
    });

    it('a thrown NightgateError answers with its own status and code', async () => {
        const { status, error } = await errorOf(cap.GET(`${P}/deriveTokenType(contractAddress='throw-coded')`));
        expect([status, error.code, error.message]).toEqual([503, 'WALLET_NOT_SYNCED', 'wallet not at tip']);
    });

    it('codes each $batch part', async () => {
        const { data } = await cap.POST(`${P}/$batch`, {
            requests: [
                { id: '1', method: 'POST', url: '/anchorDocument', headers: { 'content-type': 'application/json' }, body: {} },
                { id: '2', method: 'GET', url: "/deriveTokenType(contractAddress='throw-coded')" }
            ]
        });
        const byId = Object.fromEntries(data.responses.map((r: any) => [r.id, r]));
        expect([byId['1'].status, byId['1'].body.error.code]).toEqual([400, 'INVALID_ARGUMENT']);
        expect([byId['2'].status, byId['2'].body.error.code]).toEqual([503, 'WALLET_NOT_SYNCED']);
    });

    it('keeps an existing specific code (verify service)', async () => {
        const { error } = await errorOf(cap.GET(`/api/v1/verify/verifyAttestationState(contractAddress='x',payloadHash='${'a'.repeat(64)}',attesterId='${'b'.repeat(64)}')`));
        expect(error.code).toBe('PUBLIC_VERIFY_DISABLED');
    });

    it('in production a 5xx keeps its code and loses its message', async () => {
        process.env.NODE_ENV = 'production';
        const { status, error } = await errorOf(cap.GET(`${P}/deriveTokenType(contractAddress='throw-503')`));
        expect([status, error.code, error.message]).toEqual([503, 'UNAVAILABLE', 'Service Unavailable']);
    });

    it('in production a sanitized 5xx carries nothing of the original error but its code', async () => {
        process.env.NODE_ENV = 'production';
        const { status, error } = await errorOf(cap.GET(`${P}/deriveTokenType(contractAddress='throw-502-extras')`));
        expect(status).toBe(502);
        expect(Object.keys(error).filter(k => !k.startsWith('@')).sort()).toEqual(['code', 'message']);
        expect(error).toMatchObject({ code: 'BAD_GATEWAY', message: 'Bad Gateway' });
        expect(JSON.stringify(error)).not.toMatch(/SECRET|INNER|DETAIL|upstream/);
    });

    it('in production a 4xx keeps code and message', async () => {
        process.env.NODE_ENV = 'production';
        const { status, error } = await errorOf(cap.POST(`${P}/anchorDocument`, {}));
        expect([status, error.code]).toEqual([400, 'INVALID_ARGUMENT']);
        expect(error.message).not.toBe('Internal Server Error');
    });
});
