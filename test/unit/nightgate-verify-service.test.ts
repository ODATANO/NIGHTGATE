/**
 * The public verify lane (srv/nightgate-verify-service.ts): the gate in front
 * of the shared state-verification handlers (feature flag, per-address rate
 * limit), the marker-to-address rate key, and the proof that both services
 * run the SAME handler code (srv/submission/verify-state.ts) over the same
 * injected readers.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../srv/submission/contract-registry', () => ({
    resolveContract: vi.fn(async () => ({ artifactPath: '/a', zkConfigPath: '/z' })),
    ContractNotRegisteredError: class extends Error {},
    getContractRegistration: () => ({ slotWidth: 16 }),
    slotWidthOf: () => 16
}));
vi.mock('../../srv/utils/nightgate-config', async () => {
    const actual: any = await vi.importActual('../../srv/utils/nightgate-config');
    return {
        ...actual,
        getNightgatePluginConfig: () => ({ network: 'preprod' })
    };
});

import { publicVerifyGate, __resetPublicVerifyLimiterForTests } from '../../srv/nightgate-verify-service';
import { registerVerifyStateHandlers } from '../../srv/submission/verify-state';
import { principalRateKey } from '../../srv/utils/rate-limiter';
import { __resetConfigForTests } from '../../srv/utils/config';
import { PUBLIC_VERIFY_TRANSPORT_USER, AGENT_TOKEN_TRANSPORT_USER } from '../../srv/utils/agent-token-transport';

function makeReq(data: Record<string, unknown> = {}, ip = '203.0.113.7', user: any = { id: PUBLIC_VERIFY_TRANSPORT_USER }) {
    const res = { set: vi.fn() };
    return {
        data,
        user,
        event: 'verifyAttestationState',
        reject: vi.fn((a: any, b?: any) => ({ __rejected: true, a, b })),
        _: { req: { ip } },
        http: { res }
    } as any;
}

function stubService() {
    const handlers: Record<string, Function> = {};
    return { srv: { on: (e: string, h: Function) => { handlers[e] = h; } } as any, handlers };
}

beforeEach(() => {
    delete process.env.NIGHTGATE_PUBLIC_VERIFY;
    delete process.env.NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT;
    __resetConfigForTests();
    __resetPublicVerifyLimiterForTests();
});
afterEach(() => {
    delete process.env.NIGHTGATE_PUBLIC_VERIFY;
    delete process.env.NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT;
    __resetConfigForTests();
});

describe('publicVerifyGate', () => {
    test('answers 404 PUBLIC_VERIFY_DISABLED while the lane is off', async () => {
        const req = makeReq();
        expect(await publicVerifyGate(req)).toBe(false);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 404, code: 'PUBLIC_VERIFY_DISABLED' }));
    });

    test('passes while enabled and rate-limits per client address with Retry-After', async () => {
        process.env.NIGHTGATE_PUBLIC_VERIFY = 'true';
        process.env.NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT = '3';
        __resetConfigForTests();
        for (let i = 0; i < 3; i++) expect(await publicVerifyGate(makeReq({}, '198.51.100.1'))).toBe(true);
        const over = makeReq({}, '198.51.100.1');
        expect(await publicVerifyGate(over)).toBe(false);
        expect(over.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
        expect(over.http.res.set).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
        // another address has its own budget
        expect(await publicVerifyGate(makeReq({}, '198.51.100.2'))).toBe(true);
    });
});

describe('principalRateKey: marker principals fall through to the address', () => {
    test.each([PUBLIC_VERIFY_TRANSPORT_USER, AGENT_TOKEN_TRANSPORT_USER, 'anonymous'])('%s keys by address', id => {
        expect(principalRateKey({ user: { id }, _: { req: { ip: '10.1.1.1' } } }, 'scope')).toBe('ip=10.1.1.1:scope');
    });
    test('a real user still keys by id, a grant by its id', () => {
        expect(principalRateKey({ user: { id: 'nightgate' }, _: { req: { ip: '10.1.1.1' } } }, 'scope')).toBe('user=nightgate:scope');
        expect(principalRateKey({ agentGrant: { ID: 'g1' }, user: { id: 'nightgate' } }, 'scope')).toBe('grant=g1:scope');
    });
});

describe('registerVerifyStateHandlers: one implementation behind both services', () => {
    const attestationStateReader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'att' }));
    const contractResolver = vi.fn(async () => ({ artifactPath: '/a', zkConfigPath: '/z' })) as any;
    const args = { contractAddress: 'c'.repeat(64), attesterId: 'b'.repeat(64), payloadHash: 'a'.repeat(64) };

    beforeEach(() => { attestationStateReader.mockClear(); });

    test('a gate that refuses stops the handler before any state read', async () => {
        const { srv, handlers } = stubService();
        registerVerifyStateHandlers(srv, { attestationStateReader: attestationStateReader as any, contractResolver, gate: async (req: any) => { req.reject(404, 'off'); return false; } });
        const req = makeReq(args);
        expect(await handlers.verifyAttestationState(req)).toBeUndefined();
        expect(req.reject).toHaveBeenCalledWith(404, 'off');
        expect(attestationStateReader).not.toHaveBeenCalled();
    });

    test('with the gate open the public service returns exactly what the authenticated service returns', async () => {
        process.env.NIGHTGATE_INDEXER_HTTP_URL = 'http://indexer.local/api/v1/graphql';
        __resetConfigForTests();
        try {
            const gated = stubService();
            const plain = stubService();
            registerVerifyStateHandlers(gated.srv, { attestationStateReader: attestationStateReader as any, contractResolver, gate: async () => true });
            registerVerifyStateHandlers(plain.srv, { attestationStateReader: attestationStateReader as any, contractResolver });
            const a = await gated.handlers.verifyAttestationState(makeReq(args));
            const b = await plain.handlers.verifyAttestationState(makeReq(args, '10.0.0.1', { id: 'nightgate' }));
            expect(a).toEqual(b);
            expect(a).toEqual({ verified: true, attested: true, contentRootOk: false, schemaOk: false, attesterId: 'att' });
            expect(attestationStateReader).toHaveBeenCalledTimes(2);
        } finally {
            delete process.env.NIGHTGATE_INDEXER_HTTP_URL;
            __resetConfigForTests();
        }
    });

    test('input validation is shared too: a malformed payloadHash is 400 on both', async () => {
        const { srv, handlers } = stubService();
        registerVerifyStateHandlers(srv, { attestationStateReader: attestationStateReader as any, contractResolver, gate: async () => true });
        const req = makeReq({ contractAddress: 'c', attesterId: 'b'.repeat(64), payloadHash: 'nope' });
        await handlers.verifyAttestationState(req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('payloadHash'));
        expect(attestationStateReader).not.toHaveBeenCalled();
    });
});
