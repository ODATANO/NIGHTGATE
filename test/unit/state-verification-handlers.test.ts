/**
 * Tests for the crawler-free state-verification handlers in
 * srv/submission/handlers.ts:
 *   - verifyAttestationState
 *   - reindexDisclosures
 *   - verifyDocument / verifyPredicateAttestation state fallbacks
 *
 * Drives registerSubmissionHandlers against a stub service, injecting the state
 * readers via options so no SDK/chain is touched. nightgate-config is mocked so
 * `liveProviderConfigured()` can be toggled per-test (clean negative when no
 * live provider).
 */

// Toggle the runtime config the handlers see. `mock`-prefixed so the mock factory may reference it
// inside the (hoisted) factory. Set in beforeEach.
let mockRuntimeCfg: any;
vi.mock('../../srv/utils/nightgate-config', async () => {
    const actual = await vi.importActual('../../srv/utils/nightgate-config');
    return {
        ...actual,
        getNightgatePluginConfig: () => ({}),
        resolveNightgateRuntimeConfig: () => mockRuntimeCfg
    };
});

// startJob is not exercised by these read handlers, but handlers.ts imports it.
vi.mock('../../srv/submission/background-jobs', async () => ({
    startJob: vi.fn(async (args: any) => ({ jobId: 'job-test', status: 'pending' })),
    registerBackgroundJobProcessor: vi.fn(),
    registerBackgroundJobReconciliationFinalizer: vi.fn()
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';

const WITH_PROVIDER = {
    network: 'preprod',
    nodeUrl: 'ws://node',
    submissionEndpoints: {
        indexerHttpUrl: 'http://idx', indexerWsUrl: 'ws://idx', proofServerUrl: 'http://proof'
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
const ATTESTER = '1'.repeat(64);
const ROOT = 'd'.repeat(64);

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
function makeDbWithSequence(rows: any[]) {
    const queue = [...rows];
    return { run: vi.fn().mockImplementation(async () => queue.shift()) };
}

beforeEach(() => { mockRuntimeCfg = WITH_PROVIDER; });

// ---- verifyAttestationState ----------------------------------------------

describe('verifyAttestationState', () => {
    function setup(opts: any = {}, db: any = { run: vi.fn() }) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            ...opts
        });
        return srv;
    }

    test('rejects missing contractAddress', async () => {
        const srv = setup();
        const req = makeReq({ payloadHash: PAYLOAD });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('rejects a request that names no record (attesterId + payloadHash, or documentId)', async () => {
        const srv = setup();
        for (const data of [{ contractAddress: VAULT }, { contractAddress: VAULT, payloadHash: PAYLOAD }, { contractAddress: VAULT, attesterId: ATTESTER }]) {
            const req = makeReq(data);
            await srv.handlers['verifyAttestationState'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/attesterId and payloadHash.*or documentId/));
        }
    });

    test('rejects non-hex payloadHash, attesterId and documentId', async () => {
        const srv = setup();
        for (const data of [
            { contractAddress: VAULT, attesterId: ATTESTER, payloadHash: 'nope' },
            { contractAddress: VAULT, attesterId: 'nope', payloadHash: PAYLOAD },
            { contractAddress: VAULT, documentId: 'nope' }
        ]) {
            const req = makeReq(data);
            await srv.handlers['verifyAttestationState'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex/));
        }
    });

    test('a document id alone selects the record; the reader gets it lowercased', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'abc', payloadHash: PAYLOAD, recordKey: 'rk', documentId: 'f'.repeat(64) }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, documentId: 'F'.repeat(64) });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toMatchObject({ verified: true, attesterId: 'abc', payloadHash: PAYLOAD, recordKey: 'rk', documentId: 'f'.repeat(64) });
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'f'.repeat(64), attesterId: undefined, payloadHash: undefined }));
    });

    test('rejects non-hex contentRoot', async () => {
        const srv = setup();
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, contentRoot: 'nope' });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contentRoot/));
    });

    test('attested, no contentRoot → verified true', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: true, attested: true, contentRootOk: false, schemaOk: false, attesterId: 'abc' });
    });

    test('not attested → verified false', async () => {
        const reader = vi.fn(async () => ({ attested: false, contentRootOk: false, schemaOk: false, attesterId: '' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(false);
        expect(r.attested).toBe(false);
    });

    test('contentRoot supplied and matches → verified true', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: true, schemaOk: false, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, contentRoot: ROOT });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(true);
    });

    test('contentRoot supplied but mismatch → verified false even though attested', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, contentRoot: ROOT });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(false);
        expect(r.attested).toBe(true);
    });

    test('reader returns null (unknown contract) → clean negative', async () => {
        const reader = vi.fn(async () => null);
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: false, attested: false, contentRootOk: false, schemaOk: false, bindingRegistered: false, attesterId: '', payloadHash: '', recordKey: '', documentId: '' });
    });

    test('no live provider → clean negative, reader not called', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: true, schemaOk: false, attesterId: 'x' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: false, attested: false, contentRootOk: false, schemaOk: false, bindingRegistered: false, attesterId: '', payloadHash: '', recordKey: '', documentId: '' });
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- verifyPredicateState --------------------------------------------------

describe('verifyPredicateState', () => {
    const FIELD_KEY = 'e'.repeat(64);

    function setup(opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, { run: vi.fn() }, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            ...opts
        });
        return srv;
    }
    const VALID = {
        contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY,
        predicate: 'lessOrEqual', threshold: 1370
    };

    test('rejects missing contractAddress', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, contractAddress: undefined });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('rejects a missing attesterId', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, attesterId: '' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/attesterId is required/));
    });

    test('rejects missing payloadHash', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, payloadHash: undefined });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
    });

    test('rejects non-hex payloadHash', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, payloadHash: 'nope' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex/));
    });

    test('rejects non-hex fieldKey', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, fieldKey: 'nope' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/fieldKey/));
    });

    test('rejects unknown predicate string', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, predicate: 'equals' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/lessOrEqual/));
    });

    test('rejects missing threshold', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, threshold: undefined });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/threshold/));
    });

    test('rejects negative threshold', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, threshold: -1 });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/non-negative/));
    });

    test('numeric claims are field-bound: missing fieldKey is a 400', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, fieldKey: '' });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/fieldKey is required/));
    });

    test('proven on-chain → verified true; coordinates reach the reader', async () => {
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: true, proven: true });
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD,
            fieldKey: FIELD_KEY, threshold: 1370n, op: 0
        }));
    });

    test('greaterOrEqual maps to op 1', async () => {
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID, predicate: 'greaterOrEqual' });
        await srv.handlers['verifyPredicateState'](req);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ op: 1 }));
    });

    test('field-bound: fieldKey passed through lowercased', async () => {
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID, fieldKey: FIELD_KEY.toUpperCase() });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: FIELD_KEY }));
    });

    test('no true result recorded → verified false, not an error', async () => {
        const reader = vi.fn(async () => false);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
    });

    test('reader returns null (unknown contract) → clean negative', async () => {
        const reader = vi.fn(async () => null);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
    });

    test('no live provider → clean negative, reader not called', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
        expect(reader).not.toHaveBeenCalled();
    });

    describe('bytes claim kinds', () => {
        const EXPECTED = 'c'.repeat(64);
        const SET_ROOT = 'd'.repeat(64);

        test.each([
            [{ predicate: 'bytesEquality', fieldKey: '', expectedDigest: EXPECTED }, /fieldKey is required for predicate 'bytesEquality'/],
            [{ predicate: 'bytesEquality', fieldKey: FIELD_KEY }, /expectedDigest .*required/],
            [{ predicate: 'bytesEquality', fieldKey: FIELD_KEY, expectedDigest: 'zz' }, /expectedDigest/],
            [{ predicate: 'setMembership', fieldKey: '', setRoot: SET_ROOT }, /fieldKey is required for predicate 'setMembership'/],
            [{ predicate: 'setMembership', fieldKey: FIELD_KEY }, /setRoot .*required/],
            [{ predicate: 'setMembership', fieldKey: FIELD_KEY, setRoot: 'zz' }, /setRoot/]
        ])('rejects %o', async (patch, msg) => {
            const srv = setup();
            const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, ...patch });
            await srv.handlers['verifyPredicateState'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
        });

        test('bytesEquality: no threshold needed; expectedDigest lowercased into the reader', async () => {
            const reader = vi.fn(async () => true);
            const srv = setup({ predicateStateReader: reader });
            const req = makeReq({
                contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY,
                predicate: 'bytesEquality', expectedDigest: EXPECTED.toUpperCase()
            });
            const r = await srv.handlers['verifyPredicateState'](req);
            expect(r).toEqual({ verified: true, proven: true });
            expect(reader).toHaveBeenCalledWith(expect.objectContaining({
                fieldKey: FIELD_KEY, expectedDigest: EXPECTED,
                setRoot: undefined, threshold: undefined, op: undefined
            }));
        });

        test('setMembership: setRoot passed through, no numeric coordinates', async () => {
            const reader = vi.fn(async () => true);
            const srv = setup({ predicateStateReader: reader });
            const req = makeReq({
                contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: FIELD_KEY,
                predicate: 'setMembership', setRoot: SET_ROOT
            });
            const r = await srv.handlers['verifyPredicateState'](req);
            expect(r).toEqual({ verified: true, proven: true });
            expect(reader).toHaveBeenCalledWith(expect.objectContaining({
                fieldKey: FIELD_KEY, setRoot: SET_ROOT,
                expectedDigest: undefined, threshold: undefined, op: undefined
            }));
        });
    });

    describe('cross-root claim kinds', () => {
        const PAYLOAD_B = 'b'.repeat(64);

        test.each([
            [{ predicate: 'documentIntegrity', allowedMask: 5 }, /payloadHashB .*required/],
            [{ predicate: 'documentIntegrity', payloadHashB: 'zz', allowedMask: 5 }, /payloadHashB/],
            [{ predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B }, /allowedMask .*required/],
            [{ predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B, allowedMask: 65536 }, /allowedMask/],
            [{ predicate: 'documentDiff', k: 2 }, /payloadHashB .*required/],
            [{ predicate: 'documentDiff', payloadHashB: PAYLOAD_B }, /k .*required/],
            [{ predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 0 }, /k /],
            [{ predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 17 }, /k /]
        ])('rejects %o', async (patch, msg) => {
            const srv = setup();
            const req = makeReq({ contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: '', ...patch });
            await srv.handlers['verifyPredicateState'](req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
        });

        test('documentIntegrity: payloadHashB + allowedMask reach the reader, no numeric coordinates', async () => {
            const reader = vi.fn(async () => true);
            const srv = setup({ predicateStateReader: reader });
            const req = makeReq({
                contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: '',
                predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B.toUpperCase(), allowedMask: 5
            });
            const r = await srv.handlers['verifyPredicateState'](req);
            expect(r).toEqual({ verified: true, proven: true });
            expect(reader).toHaveBeenCalledWith(expect.objectContaining({
                payloadHash: PAYLOAD, payloadHashB: PAYLOAD_B, allowedMask: 5,
                k: undefined, threshold: undefined, op: undefined, expectedDigest: undefined, setRoot: undefined
            }));
        });

        test('documentDiff: payloadHashB + k reach the reader; mask stays undefined', async () => {
            const reader = vi.fn(async () => true);
            const srv = setup({ predicateStateReader: reader });
            const req = makeReq({
                contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, fieldKey: '',
                predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 3
            });
            const r = await srv.handlers['verifyPredicateState'](req);
            expect(r).toEqual({ verified: true, proven: true });
            expect(reader).toHaveBeenCalledWith(expect.objectContaining({
                payloadHashB: PAYLOAD_B, k: 3, allowedMask: undefined
            }));
        });
    });
});

// ---- reindexDisclosures ---------------------------------------------------

describe('reindexDisclosures', () => {
    function setup(opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, { run: vi.fn() }, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            ...opts
        });
        return srv;
    }

    test('rejects missing contractAddress', async () => {
        const srv = setup();
        const req = makeReq({});
        await srv.handlers['reindexDisclosures'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('reconciles and reports active/deactivated counts, lowercased address', async () => {
        const reindexer = vi.fn(async () => ({ indexed: 3, deactivated: 1 }));
        const srv = setup({ disclosureReindexer: reindexer });
        const req = makeReq({ contractAddress: '0xMixedCaseVault' });
        const r = await srv.handlers['reindexDisclosures'](req);
        expect(r).toMatchObject({ contractAddress: '0xmixedcasevault', active: 3, deactivated: 1 });
        expect(typeof r.reconciledAt).toBe('string');
        expect(reindexer).toHaveBeenCalledTimes(1);
    });

    test('no live provider → clean zero, reindexer not called', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reindexer = vi.fn(async () => ({ indexed: 3, deactivated: 0 }));
        const srv = setup({ disclosureReindexer: reindexer });
        const req = makeReq({ contractAddress: '0xzz' });
        const r = await srv.handlers['reindexDisclosures'](req);
        expect(r).toMatchObject({ contractAddress: '0xzz', active: 0, deactivated: 0 });
        expect(reindexer).not.toHaveBeenCalled();
    });
});

// ---- verifyDocument state fallback ----------------------------------------

describe('verifyDocument crawler-free fallback', () => {
    const DOC_ID = '00000000-0000-4000-8000-000000000001';
    const SHA = 'a'.repeat(64);
    const TX_HASH = '0xanchor';

    function setup(db: any, opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            walletMaterialFactory: vi.fn(),
            submitterFactory: vi.fn(),
            ...opts
        });
        return srv;
    }

    test('tx not indexed + contractAddress + attested on-chain → verified true', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: '2026-07-06T00:00:00Z' },
            undefined // Transactions lookup: not indexed (crawler off/lag)
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test('tx not indexed + contractAddress + NOT attested on-chain → verified false', async () => {
        const reader = vi.fn(async () => ({ attested: false, contentRootOk: false, schemaOk: false, attesterId: '' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
    });

    test('reader failure is best-effort → verified false, never a 5xx', async () => {
        const reader = vi.fn(async () => { throw new Error('indexer unreachable'); });
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
        expect(req.reject).not.toHaveBeenCalled();
    });

    test('tx not indexed + NO contractAddress → fallback skipped, verified false', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
        expect(reader).not.toHaveBeenCalled();
    });

    test('no live provider → fallback skipped even with contractAddress', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- verifyPredicateAttestation state fallback ----------------------------

describe('verifyPredicateAttestation crawler-free fallback', () => {
    const PA_ID = '00000000-0000-4000-8000-0000000000aa';
    const ROW = {
        ID: PA_ID, payloadHash: PAYLOAD, attesterId: ATTESTER, contractAddress: VAULT,
        predicate: 'lessOrEqual', op: 0, threshold: 100, unit: 'kgCO2e/kWh',
        valueCommitment: 'c'.repeat(64), provenTxHash: '0xproof', provenAt: '2026-07-06T00:00:00Z'
    };

    function setup(db: any, opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            walletMaterialFactory: vi.fn(),
            submitterFactory: vi.fn(),
            ...opts
        });
        return srv;
    }

    test('proof tx not indexed + on-chain result true → verified true', async () => {
        const reader = vi.fn(async () => true);
        const db = makeDbWithSequence([ROW, undefined /* Transactions: not indexed */]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: VAULT, attesterId: ATTESTER, payloadHash: PAYLOAD, threshold: 100n, op: 0
        }));
    });

    test('proof tx not indexed + on-chain result absent → verified false', async () => {
        const reader = vi.fn(async () => false);
        const db = makeDbWithSequence([ROW, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(false);
    });

    test('reader failure is best-effort → verified false, never a 5xx', async () => {
        const reader = vi.fn(async () => { throw new Error('indexer unreachable'); });
        const db = makeDbWithSequence([ROW, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(false);
        expect(req.reject).not.toHaveBeenCalled();
    });

    test('no live provider → fallback skipped, verified false', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = vi.fn(async () => true);
        const db = makeDbWithSequence([ROW, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(false);
        expect(reader).not.toHaveBeenCalled();
    });

    test('field-bound row passes its fieldKey through to the reader', async () => {
        const FIELD_KEY = 'e'.repeat(64);
        const reader = vi.fn(async () => true);
        const fieldRow = { ...ROW, fieldKey: FIELD_KEY };
        const db = makeDbWithSequence([fieldRow, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: FIELD_KEY }));
    });

    test('plain row passes fieldKey undefined (not empty string)', async () => {
        const reader = vi.fn(async () => true);
        const db = makeDbWithSequence([{ ...ROW, fieldKey: null }, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        await srv.handlers['verifyPredicateAttestation'](req);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: undefined }));
    });

    test('bytesEquality row passes expectedDigest, no numeric coordinates', async () => {
        const FIELD_KEY = 'e'.repeat(64);
        const EXPECTED = 'c'.repeat(64);
        const reader = vi.fn(async () => true);
        const row = {
            ...ROW, predicate: 'bytesEquality', op: null, threshold: null,
            fieldKey: FIELD_KEY, expectedDigest: EXPECTED, setRoot: null
        };
        const db = makeDbWithSequence([row, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(r.expectedDigest).toBe(EXPECTED);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            fieldKey: FIELD_KEY, expectedDigest: EXPECTED,
            setRoot: undefined, threshold: undefined, op: undefined
        }));
    });

    test('setMembership row passes setRoot, no numeric coordinates', async () => {
        const FIELD_KEY = 'e'.repeat(64);
        const SET_ROOT = 'd'.repeat(64);
        const reader = vi.fn(async () => true);
        const row = {
            ...ROW, predicate: 'setMembership', op: null, threshold: null,
            fieldKey: FIELD_KEY, setRoot: SET_ROOT, expectedDigest: null
        };
        const db = makeDbWithSequence([row, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(r.setRoot).toBe(SET_ROOT);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            fieldKey: FIELD_KEY, setRoot: SET_ROOT,
            expectedDigest: undefined, threshold: undefined, op: undefined
        }));
    });

    test('documentIntegrity row passes payloadHashB + allowedMask, no numeric coordinates', async () => {
        const PAYLOAD_B = 'b'.repeat(64);
        const reader = vi.fn(async () => true);
        const row = {
            ...ROW, predicate: 'documentIntegrity', op: null, threshold: null,
            fieldKey: null, expectedDigest: null, setRoot: null,
            payloadHashB: PAYLOAD_B, allowedMask: 5
        };
        const db = makeDbWithSequence([row, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(r.payloadHashB).toBe(PAYLOAD_B);
        expect(r.allowedMask).toBe(5);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            payloadHashB: PAYLOAD_B, allowedMask: 5,
            k: undefined, threshold: undefined, op: undefined, expectedDigest: undefined, setRoot: undefined
        }));
    });

    test('documentDiff row passes payloadHashB + k (from the threshold column)', async () => {
        const PAYLOAD_B = 'b'.repeat(64);
        const reader = vi.fn(async () => true);
        const row = {
            ...ROW, predicate: 'documentDiff', op: null, threshold: 3,
            fieldKey: null, expectedDigest: null, setRoot: null,
            payloadHashB: PAYLOAD_B, allowedMask: null
        };
        const db = makeDbWithSequence([row, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(r.payloadHashB).toBe(PAYLOAD_B);
        expect(r.threshold).toBe(3);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            payloadHashB: PAYLOAD_B, k: 3, allowedMask: undefined,
            threshold: undefined, op: undefined
        }));
    });
});

describe('verified follows the CURRENT state, the indexed inclusion is reported separately', () => {
    const VAULT = '0x' + 'ab'.repeat(20);
    const DOC_ID = '00000000-0000-4000-8000-000000000002';
    const PRED_ID = '00000000-0000-4000-8000-000000000003';
    const SHA = 'b'.repeat(64);
    const TX_HASH = '0xproof';
    const RESOLVED = {
        artifactPath: 'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js',
        privateStateId: 'attestationVaultPrivateState',
        zkConfigPath: 'contracts/attestation-vault/src/managed/attestation-vault',
        artifactDigest: undefined
    };
    const indexedSuccess = [
        { ID: 'tx-row', hash: TX_HASH },
        { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
    ];

    function setup(db: any, opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => RESOLVED as any),
            walletMaterialFactory: vi.fn(),
            submitterFactory: vi.fn(),
            ...opts
        });
        return srv;
    }

    test('verifyDocument: indexed SUCCESS but the attestation was retracted → verified false, included true', async () => {
        const reader = vi.fn(async () => ({ attested: false, contentRootOk: false, schemaOk: false, attesterId: '' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: '2026-07-06T00:00:00Z', contractAddress: VAULT },
            ...indexedSuccess
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const r = await srv.handlers['verifyDocument'](makeReq({ documentId: DOC_ID, providedSha256: SHA }));
        expect(r).toMatchObject({ verified: false, included: true, stateChecked: true });
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test('verifyDocument: indexed SUCCESS and the attestation stands → verified true', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, attesterId: ATTESTER, anchoredTxHash: TX_HASH, anchoredAt: '2026-07-06T00:00:00Z', contractAddress: VAULT },
            ...indexedSuccess
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const r = await srv.handlers['verifyDocument'](makeReq({ documentId: DOC_ID, providedSha256: SHA }));
        expect(r).toMatchObject({ verified: true, included: true, stateChecked: true });
    });

    test('verifyPredicateAttestation: indexed SUCCESS but the claim expired or lost its anchor → verified false, included true', async () => {
        const reader = vi.fn(async () => false);
        const db = makeDbWithSequence([
            { ID: PRED_ID, provenTxHash: TX_HASH, contractAddress: VAULT, attesterId: ATTESTER, payloadHash: SHA, predicate: 'greaterOrEqual', threshold: 5, op: 1, fieldKey: 'c'.repeat(64), compiledArtifactRef: 'attestation-vault' },
            ...indexedSuccess
        ]);
        const srv = setup(db, { predicateStateReader: reader });
        const r = await srv.handlers['verifyPredicateAttestation'](makeReq({ predicateAttestationId: PRED_ID }));
        expect(r).toMatchObject({ verified: false, included: true, stateChecked: true });
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test('verifyPredicateAttestation: indexed SUCCESS and the claim stands → verified true', async () => {
        const reader = vi.fn(async () => true);
        const db = makeDbWithSequence([
            { ID: PRED_ID, provenTxHash: TX_HASH, contractAddress: VAULT, attesterId: ATTESTER, payloadHash: SHA, predicate: 'greaterOrEqual', threshold: 5, op: 1, fieldKey: 'c'.repeat(64), compiledArtifactRef: 'attestation-vault' },
            ...indexedSuccess
        ]);
        const srv = setup(db, { predicateStateReader: reader });
        const r = await srv.handlers['verifyPredicateAttestation'](makeReq({ predicateAttestationId: PRED_ID }));
        expect(r).toMatchObject({ verified: true, included: true, stateChecked: true });
    });
});

