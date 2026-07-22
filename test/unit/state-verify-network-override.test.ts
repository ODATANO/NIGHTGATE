/**
 * Tests for the optional `network` override on the crawler-free state-verify
 * surface:
 *   - verifyAttestationState(..., network)
 *   - verifyPredicateState(..., network)
 *
 * Acceptance criteria under test:
 *   1. Override to another network reads via that network's indexer endpoints
 *      without touching the configured submission/wallet state.
 *   2. Omitted (or equal to the configured network) keeps today's behavior
 *      bit-for-bit; env/config overrides for the configured network win.
 *   3. Invalid network → 400, never a silent fallback.
 *   4. Same for verifyPredicateState.
 *   5. No wallet / proof-server / crawler involvement on the override path
 *      (readers only ever get the contract-only provider config).
 *
 * Same stub-service pattern as state-verification-handlers.test.ts, but the
 * plugin config is mockable too so the `networks` escape hatch can be tested.
 */

let mockRuntimeCfg: any;
let mockPluginCfg: any;
vi.mock('../../srv/utils/nightgate-config', async () => {
    const actual = await vi.importActual('../../srv/utils/nightgate-config');
    return {
        ...actual,
        getNightgatePluginConfig: () => mockPluginCfg,
        resolveNightgateRuntimeConfig: () => mockRuntimeCfg
    };
});

// startJob is not exercised by these read handlers, but handlers.ts imports it.
vi.mock('../../srv/submission/background-jobs', async () => ({
    startJob: vi.fn(async () => ({ jobId: 'job-test', status: 'pending' })),
    registerBackgroundJobProcessor: vi.fn(),
    registerBackgroundJobReconciliationFinalizer: vi.fn()
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import { DEFAULT_INDEXER_URLS } from '../../srv/utils/nightgate-config';

const CONFIGURED = {
    network: 'preprod',
    nodeUrl: 'ws://node',
    submissionEndpoints: {
        indexerHttpUrl: 'http://configured-idx', indexerWsUrl: 'ws://configured-idx', proofServerUrl: 'http://proof'
    }
};
const NO_PROVIDER = {
    network: 'preprod',
    nodeUrl: '',
    submissionEndpoints: { indexerHttpUrl: '', indexerWsUrl: '', proofServerUrl: '' }
};

const RESOLVED = { compiledContract: {}, privateStateId: 'd', zkConfigPath: '/tmp/m', artifactPath: '/tmp/m/contract/index.js' };
const VAULT = '0xVaultAddr';
const PAYLOAD = 'a'.repeat(64);

function makeFakeService() {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    return { handlers, on: vi.fn((a: string, fn: any) => { handlers[a] = fn; }) };
}
function makeReq(data: Record<string, unknown>) {
    return {
        data,
        reject: vi.fn((status: number, message: string) => {
            const err: any = new Error(message); err.status = status; return err;
        })
    };
}
function setup(opts: any = {}) {
    const srv = makeFakeService();
    registerSubmissionHandlers(srv as any, { run: vi.fn() } as any, {
        resolveContractImpl: vi.fn(async () => RESOLVED as any),
        ...opts
    });
    return srv;
}

beforeEach(() => {
    mockRuntimeCfg = CONFIGURED;
    mockPluginCfg = {};
});

// ---- verifyAttestationState ------------------------------------------------

describe('verifyAttestationState network override', () => {
    const POSITIVE = { attested: true, contentRootOk: false, attesterId: 'abc' };

    test('omitted network → configured endpoints, exactly as before', async () => {
        const reader = vi.fn(async () => POSITIVE);
        const srv = setup({ attestationStateReader: reader });
        await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: 'http://configured-idx',
                indexerWsUrl: 'ws://configured-idx'
            })
        }));
    });

    test('network equal to the configured one → configured endpoints (env/config overrides keep winning)', async () => {
        const reader = vi.fn(async () => POSITIVE);
        const srv = setup({ attestationStateReader: reader });
        await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, network: 'preprod' }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: 'http://configured-idx',
                indexerWsUrl: 'ws://configured-idx'
            })
        }));
    });

    test('override to another network → that network\'s default public indexer, proof server unchanged', async () => {
        const reader = vi.fn(async () => POSITIVE);
        const srv = setup({ attestationStateReader: reader });
        const r = await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, network: 'preview' }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: DEFAULT_INDEXER_URLS.preview.http,
                indexerWsUrl: DEFAULT_INDEXER_URLS.preview.ws,
                proofServerUrl: 'http://proof',
                zkConfigPath: RESOLVED.zkConfigPath
            })
        }));
        expect(r.verified).toBe(true);
    });

    test('override honours the cds.requires.nightgate.networks escape hatch', async () => {
        mockPluginCfg = {
            networks: { preview: { indexerHttpUrl: 'http://own-preview-idx', indexerWsUrl: 'ws://own-preview-idx' } }
        };
        const reader = vi.fn(async () => POSITIVE);
        const srv = setup({ attestationStateReader: reader });
        await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, network: 'preview' }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: 'http://own-preview-idx',
                indexerWsUrl: 'ws://own-preview-idx'
            })
        }));
    });

    test('invalid network → 400 listing valid networks, reader never called', async () => {
        const reader = vi.fn();
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, network: 'devnet' });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/network must be one of: .*preview.*preprod/));
        expect(reader).not.toHaveBeenCalled();
    });

    test('no live provider for the CONFIGURED network but a valid override → override endpoints are used', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn(async () => POSITIVE);
        const srv = setup({ attestationStateReader: reader });
        const r = await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, network: 'preview' }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: DEFAULT_INDEXER_URLS.preview.http
            })
        }));
        expect(r.verified).toBe(true);
    });

    test('no live provider and no override → clean negative, unchanged', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn();
        const srv = setup({ attestationStateReader: reader });
        const r = await srv.handlers['verifyAttestationState'](makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD }));
        expect(r).toEqual({ verified: false, attested: false, contentRootOk: false, attesterId: '' });
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- verifyPredicateState ----------------------------------------------------

describe('verifyPredicateState network override', () => {
    const ARGS = { contractAddress: VAULT, payloadHash: PAYLOAD, predicate: 'greaterOrEqual', threshold: 42 };

    test('override to another network → that network\'s default public indexer', async () => {
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const r = await srv.handlers['verifyPredicateState'](makeReq({ ...ARGS, network: 'preview' }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: DEFAULT_INDEXER_URLS.preview.http,
                indexerWsUrl: DEFAULT_INDEXER_URLS.preview.ws,
                proofServerUrl: 'http://proof'
            })
        }));
        expect(r).toEqual({ verified: true, proven: true });
    });

    test('omitted network → configured endpoints, exactly as before', async () => {
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        await srv.handlers['verifyPredicateState'](makeReq({ ...ARGS }));
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractProvidersConfig: expect.objectContaining({
                indexerHttpUrl: 'http://configured-idx'
            })
        }));
    });

    test('invalid network → 400, reader never called', async () => {
        const reader = vi.fn();
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...ARGS, network: 'PREVIEW' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/network must be one of/));
        expect(reader).not.toHaveBeenCalled();
    });
});
