/**
 * Tests for the crawler-free state-verification handlers in
 * srv/submission/handlers.ts (onchain-state-verification-crawlerless FR):
 *   - verifyAttestationState (proposal #2)
 *   - reindexDisclosures     (proposal #1)
 *   - verifyDocument / verifyPredicateAttestation state fallbacks (proposal #3)
 *
 * Drives registerSubmissionHandlers against a stub service, injecting the state
 * readers via options so no SDK/chain is touched. nightgate-config is mocked so
 * `liveProviderConfigured()` can be toggled per-test (the whole point of
 * criterion 5: clean negative when no live provider).
 */

// Toggle the runtime config the handlers see. `mock`-prefixed so jest allows it
// inside the (hoisted) factory. Set in beforeEach.
let mockRuntimeCfg: any;
jest.mock('../../srv/utils/nightgate-config', () => {
    const actual = jest.requireActual('../../srv/utils/nightgate-config');
    return {
        ...actual,
        getNightgatePluginConfig: () => ({}),
        resolveNightgateRuntimeConfig: () => mockRuntimeCfg
    };
});

// startJob is not exercised by these read handlers, but handlers.ts imports it.
jest.mock('../../srv/submission/background-jobs', () => ({
    startJob: jest.fn(async (args: any) => ({ jobId: 'job-test', status: 'pending' }))
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
const ROOT = 'd'.repeat(64);

function makeFakeService() {
    const handlers: Record<string, (req: any) => Promise<any>> = {};
    return { handlers, on: jest.fn((a: string, fn: any) => { handlers[a] = fn; }) };
}
function makeReq(data: Record<string, unknown>) {
    return {
        data,
        reject: jest.fn((status: number, message: string) => {
            const err: any = new Error(message); err.status = status; return err;
        })
    };
}
function makeDbWithSequence(rows: any[]) {
    const queue = [...rows];
    return { run: jest.fn().mockImplementation(async () => queue.shift()) };
}

beforeEach(() => { mockRuntimeCfg = WITH_PROVIDER; });

// ---- verifyAttestationState ----------------------------------------------

describe('verifyAttestationState', () => {
    function setup(opts: any = {}, db: any = { run: jest.fn() }) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(async () => RESOLVED as any),
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

    test('rejects missing payloadHash', async () => {
        const srv = setup();
        const req = makeReq({ contractAddress: VAULT });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
    });

    test('rejects non-hex payloadHash', async () => {
        const srv = setup();
        const req = makeReq({ contractAddress: VAULT, payloadHash: 'nope' });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex/));
    });

    test('rejects non-hex contentRoot', async () => {
        const srv = setup();
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, contentRoot: 'nope' });
        await srv.handlers['verifyAttestationState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contentRoot/));
    });

    test('attested, no contentRoot → verified true', async () => {
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: false, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: true, attested: true, contentRootOk: false, attesterId: 'abc' });
    });

    test('not attested → verified false', async () => {
        const reader = jest.fn(async () => ({ attested: false, contentRootOk: false, attesterId: '' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(false);
        expect(r.attested).toBe(false);
    });

    test('contentRoot supplied and matches → verified true', async () => {
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: true, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, contentRoot: ROOT });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(true);
    });

    test('contentRoot supplied but mismatch → verified false even though attested', async () => {
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: false, attesterId: 'abc' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD, contentRoot: ROOT });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r.verified).toBe(false);
        expect(r.attested).toBe(true);
    });

    test('reader returns null (unknown contract) → clean negative', async () => {
        const reader = jest.fn(async () => null);
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: false, attested: false, contentRootOk: false, attesterId: '' });
    });

    test('no live provider → clean negative, reader not called (criterion 5)', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: true, attesterId: 'x' }));
        const srv = setup({ attestationStateReader: reader });
        const req = makeReq({ contractAddress: VAULT, payloadHash: PAYLOAD });
        const r = await srv.handlers['verifyAttestationState'](req);
        expect(r).toEqual({ verified: false, attested: false, contentRootOk: false, attesterId: '' });
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- verifyPredicateState (expose-predicate-state-verify FR) ---------------

describe('verifyPredicateState', () => {
    const FIELD_KEY = 'e'.repeat(64);

    function setup(opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, { run: jest.fn() }, {
            resolveContractImpl: jest.fn(async () => RESOLVED as any),
            ...opts
        });
        return srv;
    }
    const VALID = {
        contractAddress: VAULT, payloadHash: PAYLOAD, fieldKey: '',
        predicate: 'lessOrEqual', threshold: 1370
    };

    test('rejects missing contractAddress', async () => {
        const srv = setup();
        const req = makeReq({ ...VALID, contractAddress: undefined });
        await srv.handlers['verifyPredicateState'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
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

    test('plain proven on-chain → verified true; empty fieldKey passed as undefined', async () => {
        const reader = jest.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: true, proven: true });
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: VAULT, payloadHash: PAYLOAD,
            fieldKey: undefined, threshold: 1370n, op: 0
        }));
    });

    test('greaterOrEqual maps to op 1', async () => {
        const reader = jest.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID, predicate: 'greaterOrEqual' });
        await srv.handlers['verifyPredicateState'](req);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ op: 1 }));
    });

    test('field-bound: fieldKey passed through lowercased', async () => {
        const reader = jest.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID, fieldKey: FIELD_KEY.toUpperCase() });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: FIELD_KEY }));
    });

    test('no true result recorded → verified false, not an error (criterion 3)', async () => {
        const reader = jest.fn(async () => false);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
    });

    test('reader returns null (unknown contract) → clean negative (criterion 4)', async () => {
        const reader = jest.fn(async () => null);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
    });

    test('no live provider → clean negative, reader not called (criterion 4)', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = jest.fn(async () => true);
        const srv = setup({ predicateStateReader: reader });
        const req = makeReq({ ...VALID });
        const r = await srv.handlers['verifyPredicateState'](req);
        expect(r).toEqual({ verified: false, proven: false });
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- reindexDisclosures ---------------------------------------------------

describe('reindexDisclosures', () => {
    function setup(opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, { run: jest.fn() }, {
            resolveContractImpl: jest.fn(async () => RESOLVED as any),
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
        const reindexer = jest.fn(async () => ({ indexed: 3, deactivated: 1 }));
        const srv = setup({ disclosureReindexer: reindexer });
        const req = makeReq({ contractAddress: '0xMixedCaseVault' });
        const r = await srv.handlers['reindexDisclosures'](req);
        expect(r).toMatchObject({ contractAddress: '0xmixedcasevault', active: 3, deactivated: 1 });
        expect(typeof r.reconciledAt).toBe('string');
        expect(reindexer).toHaveBeenCalledTimes(1);
    });

    test('no live provider → clean zero, reindexer not called (criterion 5)', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reindexer = jest.fn(async () => ({ indexed: 3, deactivated: 0 }));
        const srv = setup({ disclosureReindexer: reindexer });
        const req = makeReq({ contractAddress: '0xzz' });
        const r = await srv.handlers['reindexDisclosures'](req);
        expect(r).toMatchObject({ contractAddress: '0xzz', active: 0, deactivated: 0 });
        expect(reindexer).not.toHaveBeenCalled();
    });
});

// ---- verifyDocument state fallback (proposal #3) --------------------------

describe('verifyDocument crawler-free fallback', () => {
    const DOC_ID = '00000000-0000-4000-8000-000000000001';
    const SHA = 'a'.repeat(64);
    const TX_HASH = '0xanchor';

    function setup(db: any, opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(async () => RESOLVED as any),
            walletMaterialFactory: jest.fn(),
            submitterFactory: jest.fn(),
            ...opts
        });
        return srv;
    }

    test('tx not indexed + contractAddress + attested on-chain → verified true', async () => {
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-07-06T00:00:00Z' },
            undefined // Transactions lookup: not indexed (crawler off/lag)
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledTimes(1);
    });

    test('tx not indexed + contractAddress + NOT attested on-chain → verified false', async () => {
        const reader = jest.fn(async () => ({ attested: false, contentRootOk: false, attesterId: '' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
    });

    test('tx not indexed + NO contractAddress → fallback skipped, verified false', async () => {
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, anchoredTxHash: TX_HASH, anchoredAt: null },
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
        const reader = jest.fn(async () => ({ attested: true, contentRootOk: false, attesterId: 'x' }));
        const db = makeDbWithSequence([
            { ID: DOC_ID, sha256: SHA, anchoredTxHash: TX_HASH, anchoredAt: null },
            undefined
        ]);
        const srv = setup(db, { attestationStateReader: reader });
        const req = makeReq({ documentId: DOC_ID, providedSha256: SHA, contractAddress: VAULT });
        const r = await srv.handlers['verifyDocument'](req);
        expect(r.verified).toBe(false);
        expect(reader).not.toHaveBeenCalled();
    });
});

// ---- verifyPredicateAttestation state fallback (proposal #3) --------------

describe('verifyPredicateAttestation crawler-free fallback', () => {
    const PA_ID = '00000000-0000-4000-8000-0000000000aa';
    const ROW = {
        ID: PA_ID, payloadHash: PAYLOAD, contractAddress: VAULT,
        predicate: 'lessOrEqual', op: 0, threshold: 100, unit: 'kgCO2e/kWh',
        valueCommitment: 'c'.repeat(64), provenTxHash: '0xproof', provenAt: '2026-07-06T00:00:00Z'
    };

    function setup(db: any, opts: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(async () => RESOLVED as any),
            walletMaterialFactory: jest.fn(),
            submitterFactory: jest.fn(),
            ...opts
        });
        return srv;
    }

    test('proof tx not indexed + on-chain result true → verified true', async () => {
        const reader = jest.fn(async () => true);
        const db = makeDbWithSequence([ROW, undefined /* Transactions: not indexed */]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: VAULT, payloadHash: PAYLOAD, threshold: 100n, op: 0
        }));
    });

    test('proof tx not indexed + on-chain result absent → verified false', async () => {
        const reader = jest.fn(async () => false);
        const db = makeDbWithSequence([ROW, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(false);
    });

    test('no live provider → fallback skipped, verified false', async () => {
        mockRuntimeCfg = NO_PROVIDER;
        const reader = jest.fn(async () => true);
        const db = makeDbWithSequence([ROW, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(false);
        expect(reader).not.toHaveBeenCalled();
    });

    test('field-bound row passes its fieldKey through to the reader', async () => {
        const FIELD_KEY = 'e'.repeat(64);
        const reader = jest.fn(async () => true);
        const fieldRow = { ...ROW, fieldKey: FIELD_KEY };
        const db = makeDbWithSequence([fieldRow, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        const r = await srv.handlers['verifyPredicateAttestation'](req);
        expect(r.verified).toBe(true);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: FIELD_KEY }));
    });

    test('plain row passes fieldKey undefined (not empty string)', async () => {
        const reader = jest.fn(async () => true);
        const db = makeDbWithSequence([{ ...ROW, fieldKey: null }, undefined]);
        const srv = setup(db, { predicateStateReader: reader });
        const req = makeReq({ predicateAttestationId: PA_ID });
        await srv.handlers['verifyPredicateAttestation'](req);
        expect(reader).toHaveBeenCalledWith(expect.objectContaining({ fieldKey: undefined }));
    });
});
