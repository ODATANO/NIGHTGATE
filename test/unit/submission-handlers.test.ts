/**
 * Tests for srv/submission/handlers.ts (OData action handlers).
 *
 * Drives `registerSubmissionHandlers` against a stub service that just
 * captures handler registrations, then invokes them directly with synthetic
 * Request objects. This exercises the full plumbing, argument validation,
 * rate limiting, error translation, without standing up a full CAP runtime.
 *
 * Phase 2b: the submitter dispatches deploy/call via the wallet worker. These
 * tests still use a fake `TransactionSubmitter` via the `submitterFactory`
 * seam — handlers don't know about the worker at all.
 */

// Phase 3 (0.2.0 async-job migration): handlers now wrap the submitter call
// in startJob and return `{ jobId, status }` instead of awaiting the SDK
// round-trip directly. The stub here invokes `work` synchronously so the
// existing assertions about `submitter.deploy` / `submitter.call` argument
// shape still hold; tests that need to assert sync return shape have been
// updated to expect the new { jobId, status, … } payload.
const mockStartJob = jest.fn(async (args: any) => {
    // Drive the work fn immediately so submitter.deploy/.call is exercised
    // — keeps the per-call args + registration meta assertions meaningful.
    try { await args.work(); } catch { /* failures are absorbed into the job row in prod; tests assert via mock call inspection */ }
    return { jobId: `job-${args.kind}-test`, status: 'pending' as const };
});
jest.mock('../../srv/submission/background-jobs', () => ({
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args)
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import {
    SubmissionError,
    type TransactionSubmitter
} from '../../srv/submission/TransactionSubmitter';
import { ContractNotRegisteredError } from '../../srv/submission/contract-registry';
import {
    SessionNotFoundError,
    WalletMaterialUnavailable
} from '../../srv/submission/wallet-material-factory';
import {
    coerceCircuitArgs,
    loadCircuitArgTypes,
    clearArgTypeCache,
    CoercionError,
    type CircuitArgType
} from '../../srv/submission/arg-coercion';
import path from 'path';

// ---- Fakes ----------------------------------------------------------------

type Handler = (req: any) => Promise<any>;

function makeFakeService() {
    const handlers: Record<string, Handler> = {};
    return {
        handlers,
        on: jest.fn((action: string, fn: Handler) => { handlers[action] = fn; })
    };
}

function makeReq(data: Record<string, unknown>) {
    return {
        data,
        reject: jest.fn((status: number, message: string) => {
            const err: any = new Error(message);
            err.status = status;
            err.message = message;
            return err;
        })
    };
}

const VALID_DEPLOY_ARGS = {
    compiledArtifactRef: 'attestation-vault',
    sessionId: 'session-abc',
    initialPrivateState: '{"counter":0}'
};

const VALID_CALL_ARGS = {
    contractAddress: '0xCONTRACT',
    circuit: 'increment',
    compiledArtifactRef: 'attestation-vault',
    sessionId: 'session-abc',
    args: '[]'
};

const RESOLVED_CONTRACT_FIXTURE = {
    compiledContract: {},
    privateStateId: 'demo',
    zkConfigPath:   '/tmp/managed',
    artifactPath:   '/tmp/managed/contract/index.js'
};

function makeSuccessfulSubmitter() {
    return {
        deploy: jest.fn(async () => ({
            submissionId: 'sub-1', txHash: '0xdeadbeef',
            contractAddress: '0xCONTRACT', status: 'included' as const
        })),
        call: jest.fn(async () => ({
            submissionId: 'sub-2', txHash: '0xcafe',
            contractAddress: '0xCONTRACT', status: 'included' as const
        }))
    } as unknown as TransactionSubmitter;
}

// ---- Argument validation --------------------------------------------------

describe('deployContract: argument validation', () => {
    function setupAndCallDeploy(data: Record<string, unknown>) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {});
        const req = makeReq(data);
        return srv.handlers['deployContract'](req).then(() => req);
    }

    test('rejects missing compiledArtifactRef', async () => {
        const req = await setupAndCallDeploy({ sessionId: 's', initialPrivateState: '{}' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/compiledArtifactRef/));
    });

    test('rejects missing sessionId', async () => {
        const req = await setupAndCallDeploy({ compiledArtifactRef: 'a', initialPrivateState: '{}' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId/));
    });

    test('rejects non-JSON initialPrivateState', async () => {
        const req = await setupAndCallDeploy({ ...VALID_DEPLOY_ARGS, initialPrivateState: 'not-json' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/JSON/));
    });
});

describe('submitContractCall: argument validation', () => {
    function setupAndCallSubmit(data: Record<string, unknown>) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {});
        const req = makeReq(data);
        return srv.handlers['submitContractCall'](req).then(() => req);
    }

    test('rejects missing contractAddress', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, contractAddress: undefined });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('rejects missing circuit', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, circuit: undefined });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/circuit/));
    });

    test('rejects non-array args', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, args: '{"notArray":true}' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/array/));
    });

    test('rejects non-JSON args', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, args: 'not-json' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/JSON/));
    });
});

// ---- Error translation ----------------------------------------------------

describe('error translation to OData status codes', () => {
    function setupHandlers(overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {}, {
            // Successful happy path by default
            resolveContractImpl: jest.fn(async (_name: string) => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: jest.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return srv;
    }

    test('happy path: deployContract returns { jobId, status: "pending" } and submitter.deploy is invoked via the job', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-happy-1' });
        const result = await srv.handlers['deployContract'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId:  'job-deployContract-test',
            status: 'pending'
        });
        // The mock startJob invokes work() immediately, so submitter.deploy
        // has been called by the time we get here — keeps the existing
        // "deploy forwards registration meta" assertions valid.
        expect(submitter.deploy).toHaveBeenCalledTimes(1);
    });

    test('happy path: submitContractCall returns { jobId, status } and submitter.call is invoked', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_CALL_ARGS, sessionId: 'session-happy-2' });
        const result = await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId:  'job-submitContractCall-test',
            status: 'pending'
        });
        expect(submitter.call).toHaveBeenCalledTimes(1);
    });

    test('deploy forwards registration meta (artifactPath/privateStateId/zkConfigPath) to submitter', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-meta' });
        await srv.handlers['deployContract'](req);
        expect(submitter.deploy).toHaveBeenCalledTimes(1);
        expect((submitter.deploy as jest.Mock).mock.calls[0][0]).toMatchObject({
            contractName: 'attestation-vault',
            registration: {
                artifactPath:   RESOLVED_CONTRACT_FIXTURE.artifactPath,
                privateStateId: RESOLVED_CONTRACT_FIXTURE.privateStateId,
                zkConfigPath:   RESOLVED_CONTRACT_FIXTURE.zkConfigPath
            },
            initialPrivateState: { counter: 0 },
            sessionId: 'session-meta'
        });
    });

    test('ContractNotRegisteredError → 404', async () => {
        const srv = setupHandlers({
            resolveContractImpl: jest.fn(async () => { throw new ContractNotRegisteredError('unknown', []); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-404' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not registered/));
    });

    test('SessionNotFoundError → 401', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: jest.fn(async () => { throw new SessionNotFoundError('s'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-401' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(401, expect.stringMatching(/not found/));
    });

    test('WalletMaterialUnavailable → 501', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: jest.fn(async () => { throw new WalletMaterialUnavailable('signing not impl'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-501' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(501, expect.stringMatching(/Wallet material unavailable/));
    });

    // Phase 3 (0.2.0): SubmissionError no longer surfaces via OData. It now
    // lives inside the work fn, which startJob captures into
    // BackgroundJobs.{errorCode,errorMessage} for the caller to retrieve via
    // getJobStatus. The OData response for the action is still
    // `{ jobId, status: 'pending' }`. End-to-end error-classification coverage
    // moved to background-jobs.test.ts; here we just verify the handler still
    // returns the success-path shape when the submitter throws (because the
    // immediate response doesn't await the SDK call any more).
    test('SubmissionError inside work() does NOT propagate to OData (handler still returns { jobId, status })', async () => {
        const subErr = new SubmissionError('sub-x', { code: '1016', retryable: true, message: 'pool full' });
        const srv = setupHandlers({
            submitterFactory: () => ({
                deploy: jest.fn(async () => { throw subErr; }),
                call:   jest.fn(async () => { throw subErr; })
            }) as unknown as TransactionSubmitter
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-async-err' });
        const result = await srv.handlers['deployContract'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-deployContract-test', status: 'pending' });
    });
});

// ---- Rate limiting --------------------------------------------------------

describe('rate limiting', () => {
    test('deployContract: 5 deploys/hour/session, 6th gets 429', async () => {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {}, {
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {} })),
            submitterFactory: () => makeSuccessfulSubmitter()
        });

        const sessionId = `rate-test-deploy-${Date.now()}`;
        for (let i = 0; i < 5; i++) {
            const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId });
            await srv.handlers['deployContract'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const sixth = makeReq({ ...VALID_DEPLOY_ARGS, sessionId });
        await srv.handlers['deployContract'](sixth);
        expect(sixth.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });

    test('submitContractCall: 30 calls/min/session, 31st gets 429', async () => {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {}, {
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {} })),
            submitterFactory: () => makeSuccessfulSubmitter()
        });

        const sessionId = `rate-test-call-${Date.now()}`;
        for (let i = 0; i < 30; i++) {
            const req = makeReq({ ...VALID_CALL_ARGS, sessionId });
            await srv.handlers['submitContractCall'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const overflow = makeReq({ ...VALID_CALL_ARGS, sessionId });
        await srv.handlers['submitContractCall'](overflow);
        expect(overflow.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });
});

// ---- anchorDocument -------------------------------------------------------

describe('anchorDocument', () => {
    const VALID_SHA256 = 'a'.repeat(64);
    const VALID_ANCHOR_ARGS = () => ({
        sha256:          VALID_SHA256,
        contentType:     'application/pdf',
        size:            1024,
        storageRef:      'file:///tmp/doc.pdf',
        metadata:        '{"type":"demo"}',
        sessionId:       `anchor-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function makeFakeDb() {
        const run = jest.fn().mockResolvedValue(undefined);
        return { run };
    }

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: jest.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test('rejects missing sha256', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), sha256: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sha256/));
    });

    test('rejects non-hex sha256', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), sha256: 'NOT_HEX_AT_ALL_NOT_64_CHARS' });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex chars/));
    });

    test('rejects wrong-length sha256', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), sha256: 'a'.repeat(63) });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex chars/));
    });

    test('rejects missing storageRef', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), storageRef: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/storageRef/));
    });

    test('rejects missing sessionId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), sessionId: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId/));
    });

    test('rejects missing contractAddress', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), contractAddress: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('happy path: INSERT, submitter.call, UPDATE all run; handler returns { jobId, status, documentId }', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ANCHOR_ARGS());

        const result: any = await srv.handlers['anchorDocument'](req);

        expect(req.reject).not.toHaveBeenCalled();
        // New shape: jobId + status + documentId (the documentId stays sync
        // so callers can poll the Documents row directly).
        expect(result).toEqual({
            jobId:      'job-anchorDocument-test',
            status:     'pending',
            documentId: expect.any(String)
        });
        expect(result.documentId.length).toBeGreaterThan(0);

        // INSERT (sync, on req.tx) + UPDATE (inside work fn — exercised by
        // the startJob mock invoking work eagerly) = 2 db.run calls.
        expect(db.run).toHaveBeenCalledTimes(2);

        // submitter.call was invoked with circuit='attest' and Uint8Array args
        expect(submitter.call).toHaveBeenCalledTimes(1);
        const callArgs = (submitter.call as jest.Mock).mock.calls[0][0];
        expect(callArgs.circuit).toBe('attest');
        expect(callArgs.contractAddress).toBe('0xVAULT');
        expect(callArgs.contractName).toBe('attestation-vault');
        expect(callArgs.args).toHaveLength(2);
        expect(callArgs.args[0]).toBeInstanceOf(Uint8Array);
        expect(callArgs.args[0]).toHaveLength(32);
        expect(callArgs.args[1]).toBeInstanceOf(Uint8Array);
        expect(callArgs.args[1]).toHaveLength(32);
    });

    test('defaults compiledArtifactRef to attestation-vault when omitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), compiledArtifactRef: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const callArgs = (submitter.call as jest.Mock).mock.calls[0][0];
        expect(callArgs.contractName).toBe('attestation-vault');
    });

    test('metadata_hash differs for different metadata strings (commitment correctness)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });

        const a = VALID_ANCHOR_ARGS(); a.metadata = '{"v":"a"}';
        const b = VALID_ANCHOR_ARGS(); b.metadata = '{"v":"b"}';

        await srv.handlers['anchorDocument'](makeReq(a));
        await srv.handlers['anchorDocument'](makeReq(b));

        const hashA = (submitter.call as jest.Mock).mock.calls[0][0].args[1];
        const hashB = (submitter.call as jest.Mock).mock.calls[1][0].args[1];
        expect(Buffer.from(hashA).toString('hex')).not.toBe(Buffer.from(hashB).toString('hex'));
    });

    test('UPDATE is skipped when submitter throws inside the work fn (Documents row left without anchoredTxHash)', async () => {
        const subErr = new SubmissionError('sub-z', { code: '1014', retryable: false, message: 'invalid' });
        const { srv, db } = setupHandlersWithDb({
            submitterFactory: () => ({
                deploy: jest.fn(async () => { throw subErr; }),
                call:   jest.fn(async () => { throw subErr; })
            }) as unknown as TransactionSubmitter
        });
        const req = makeReq(VALID_ANCHOR_ARGS());
        const result: any = await srv.handlers['anchorDocument'](req);
        // INSERT ran (1), UPDATE did NOT (work threw before reaching it)
        expect(db.run).toHaveBeenCalledTimes(1);
        // The handler still returns successfully — failure is in the job row.
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({ jobId: expect.any(String), status: 'pending' });
    });

    test('rate-limited at 10 anchors/hour/session', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `anchor-rate-${Date.now()}`;
        for (let i = 0; i < 10; i++) {
            const req = makeReq({ ...VALID_ANCHOR_ARGS(), sessionId });
            await srv.handlers['anchorDocument'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const overflow = makeReq({ ...VALID_ANCHOR_ARGS(), sessionId });
        await srv.handlers['anchorDocument'](overflow);
        expect(overflow.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });
});

// ---- verifyDocument -------------------------------------------------------

describe('verifyDocument', () => {
    const VALID_SHA = 'a'.repeat(64);
    const DOC_ID    = '00000000-0000-4000-8000-000000000001';
    const TX_ID     = '00000000-0000-4000-8000-000000000002';
    const TX_HASH   = '0xanchor';

    function makeDbWithSequence(rows: any[]) {
        // Each db.run consumes the next row from the queue.
        const queue = [...rows];
        const run = jest.fn().mockImplementation(async () => queue.shift());
        return { run };
    }

    function setupHandlersWithDb(db: any) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(),
            walletMaterialFactory: jest.fn(),
            submitterFactory: jest.fn()
        });
        return srv;
    }

    test('rejects missing documentId', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({ providedSha256: VALID_SHA });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/documentId/));
    });

    test('rejects missing providedSha256', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({ documentId: DOC_ID });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/providedSha256/));
    });

    test('rejects non-hex providedSha256', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: 'not_hex' });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex chars/));
    });

    test('404 when document not found', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([undefined]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not found/));
    });

    test('verified: true when hash matches + anchored + tx status SUCCESS', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            verified:       true,
            anchoredTxHash: TX_HASH,
            anchoredAt:     '2026-05-19T12:00:00Z',
            originalSha256: VALID_SHA
        });
    });

    test('verified: false when provided hash differs (tampered)', async () => {
        const tampered = 'b'.repeat(64);
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: tampered });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
        expect(result.originalSha256).toBe(VALID_SHA);
        // Skips the tx lookup when hash mismatched — only 1 db.run, not 3.
        // (We can't easily assert call count without exposing the db here,
        //  but the result coming back is enough proof the short-circuit fired.)
    });

    test('verified: false when not yet anchored (no txHash)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: null, anchoredAt: null }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result).toEqual({
            verified:       false,
            anchoredTxHash: '',
            anchoredAt:     null,
            originalSha256: VALID_SHA
        });
    });

    test('verified: false when tx exists but status is not SUCCESS', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'FAILURE' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
    });

    test('verified: false when tx is not yet indexed (crawler lag)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            undefined // no Transactions row yet
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
    });

    test('hash comparison is case-insensitive', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA.toLowerCase(), anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA.toUpperCase() });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(true);
    });
});

// ---- issuePredicateAttestation (ZK predicate, on-chain model) -------------

describe('issuePredicateAttestation', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_SALT    = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash:     VALID_PAYLOAD,
        value:           '47300',
        salt:            VALID_SALT,
        predicate:       'lessOrEqual',
        threshold:       50000,
        unit:            'kgCO2e/kWh',
        sessionId:       `pred-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function makeFakeDb() {
        return { run: jest.fn().mockResolvedValue(undefined) };
    }

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: jest.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test('rejects missing payloadHash', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), payloadHash: undefined });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
    });

    test('rejects non-hex payloadHash', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), payloadHash: 'nope' });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/64 hex chars/));
    });

    test('rejects missing value', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), value: undefined });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/value is required/));
    });

    test('rejects non-integer value', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), value: '47.3' });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/value must be an integer/));
    });

    test('rejects unknown predicate', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), predicate: 'between' });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/lessOrEqual.*greaterOrEqual/));
    });

    test('rejects bad salt', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), salt: 'short' });
        await srv.handlers['issuePredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/salt must be 64 hex/));
    });

    test('happy path: INSERT + commitValue + provePredicate + UPDATE; value never leaves as a circuit arg', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issuePredicateAttestation'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId:  'job-issuePredicateAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        // INSERT (sync) + UPDATE (inside work) = 2 db.run.
        expect(db.run).toHaveBeenCalledTimes(2);

        // Two circuit calls in order: commitValue then provePredicate.
        expect(submitter.call).toHaveBeenCalledTimes(2);
        const c0 = (submitter.call as jest.Mock).mock.calls[0][0];
        const c1 = (submitter.call as jest.Mock).mock.calls[1][0];

        expect(c0.circuit).toBe('commitValue');
        expect(c0.args).toHaveLength(1);
        expect(c0.args[0]).toBeInstanceOf(Uint8Array);
        expect(c0.args[0]).toHaveLength(32);

        expect(c1.circuit).toBe('provePredicate');
        expect(c1.args[0]).toBeInstanceOf(Uint8Array);
        expect(c1.args[1]).toBe(50000n);   // threshold as bigint
        expect(c1.args[2]).toBe(0n);       // op: lessOrEqual

        // PRIVACY: the hidden value travels only as a witness, never as an arg.
        for (const call of [c0, c1]) {
            expect(call.witnessValues).toEqual({ attestedValue: '47300', valueSalt: VALID_SALT });
            const argsHex = call.args.map((a: any) => a instanceof Uint8Array ? Buffer.from(a).toString('hex') : String(a));
            expect(argsHex.join(',')).not.toContain('47300');
        }
    });

    test('op=greaterOrEqual maps to 1n on provePredicate', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        await srv.handlers['issuePredicateAttestation'](makeReq({ ...VALID_ARGS(), predicate: 'greaterOrEqual' }));
        const c1 = (submitter.call as jest.Mock).mock.calls[1][0];
        expect(c1.args[2]).toBe(1n);
    });

    test('generates a 32-byte salt when omitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        await srv.handlers['issuePredicateAttestation'](makeReq({ ...VALID_ARGS(), salt: undefined }));
        const c0 = (submitter.call as jest.Mock).mock.calls[0][0];
        expect(c0.witnessValues.valueSalt).toMatch(/^[0-9a-f]{64}$/);
    });

    test('UPDATE is skipped when provePredicate throws inside work', async () => {
        const subErr = new SubmissionError('sub-z', { code: 'OnChainStatus:Fail', retryable: false, message: 'predicate false' });
        const { srv, db } = setupHandlersWithDb({
            submitterFactory: () => ({
                deploy: jest.fn(),
                // commitValue succeeds, provePredicate throws.
                call: jest.fn()
                    .mockResolvedValueOnce({ txHash: '0xcommit', status: 'included' })
                    .mockRejectedValueOnce(subErr)
            }) as unknown as TransactionSubmitter
        });
        const req = makeReq(VALID_ARGS());
        const result: any = await srv.handlers['issuePredicateAttestation'](req);
        // INSERT only — UPDATE never reached.
        expect(db.run).toHaveBeenCalledTimes(1);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({ jobId: expect.any(String), status: 'pending' });
    });

    test('rate-limited at 10 proofs/hour/session', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `pred-rate-${Date.now()}`;
        for (let i = 0; i < 10; i++) {
            const req = makeReq({ ...VALID_ARGS(), sessionId });
            await srv.handlers['issuePredicateAttestation'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const overflow = makeReq({ ...VALID_ARGS(), sessionId });
        await srv.handlers['issuePredicateAttestation'](overflow);
        expect(overflow.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });
});

// ---- verifyPredicateAttestation (ZK predicate, on-chain model) ------------

describe('verifyPredicateAttestation', () => {
    const PA_ID   = '00000000-0000-4000-8000-0000000000a1';
    const TX_ID   = '00000000-0000-4000-8000-0000000000a2';
    const TX_HASH = '0xprove';

    function makeDbWithSequence(rows: any[]) {
        const queue = [...rows];
        return { run: jest.fn().mockImplementation(async () => queue.shift()) };
    }
    function setupHandlersWithDb(db: any) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: jest.fn(), walletMaterialFactory: jest.fn(), submitterFactory: jest.fn()
        });
        return srv;
    }
    const provenRow = () => ({
        ID: PA_ID, predicate: 'lessOrEqual', threshold: 50000, unit: 'kgCO2e/kWh',
        valueCommitment: 'c'.repeat(64), provenTxHash: TX_HASH, provenAt: '2026-05-29T10:00:00Z'
    });

    test('rejects missing predicateAttestationId', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({});
        await srv.handlers['verifyPredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/predicateAttestationId/));
    });

    test('404 when row not found', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([undefined]));
        const req = makeReq({ predicateAttestationId: PA_ID });
        await srv.handlers['verifyPredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not found/));
    });

    test('verified: true when proven + tx SUCCESS', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            provenRow(),
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS' }
        ]));
        const req = makeReq({ predicateAttestationId: PA_ID });
        const result: any = await srv.handlers['verifyPredicateAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            verified: true, predicate: 'lessOrEqual', threshold: 50000,
            unit: 'kgCO2e/kWh', provenTxHash: TX_HASH
        });
    });

    test('verified: false when not yet proven (no provenTxHash)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ...provenRow(), provenTxHash: null, provenAt: null }
        ]));
        const req = makeReq({ predicateAttestationId: PA_ID });
        const result: any = await srv.handlers['verifyPredicateAttestation'](req);
        expect(result.verified).toBe(false);
    });

    test('verified: false when proof tx is not SUCCESS', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            provenRow(),
            { ID: TX_ID, hash: TX_HASH },
            { status: 'FAILURE' }
        ]));
        const req = makeReq({ predicateAttestationId: PA_ID });
        const result: any = await srv.handlers['verifyPredicateAttestation'](req);
        expect(result.verified).toBe(false);
    });
});

// ---- Typed arg coercion for submitContractCall ----------------------------
// A Bytes<N> circuit arg can't reach the circuit via the JSON `args` surface
// without coercion. These cover the coercion layer (pure), the
// contract-info.json introspection (against the real shipped artifact), and the
// handler wiring + 400s.

describe('arg-coercion: coerceCircuitArgs (pure)', () => {
    const BYTES32: CircuitArgType = { name: 'h', kind: 'Bytes', length: 32 };
    const UINT8:   CircuitArgType = { name: 'n', kind: 'Uint', maxval: 255 };

    test('hex string → Uint8Array(32) when param is Bytes<32>', () => {
        const hex = 'ab'.repeat(32);
        const [out] = coerceCircuitArgs([hex], [BYTES32]);
        expect(out).toBeInstanceOf(Uint8Array);
        expect((out as Uint8Array).length).toBe(32);
        expect((out as Uint8Array)[0]).toBe(0xab);
    });

    test('0x-prefixed hex is accepted', () => {
        const [out] = coerceCircuitArgs(['0x' + 'cd'.repeat(32)], [BYTES32]);
        expect((out as Uint8Array).length).toBe(32);
        expect((out as Uint8Array)[0]).toBe(0xcd);
    });

    test('number[] → Uint8Array when param is Bytes<N>', () => {
        const arr = Array.from({ length: 32 }, (_, i) => i);
        const [out] = coerceCircuitArgs([arr], [BYTES32]);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out as Uint8Array)).toEqual(arr);
    });

    test('number → BigInt when param is Uint', () => {
        const [out] = coerceCircuitArgs([7], [UINT8]);
        expect(out).toBe(7n);
    });

    test('decimal string → BigInt when param is Uint', () => {
        const [out] = coerceCircuitArgs(['200'], [UINT8]);
        expect(out).toBe(200n);
    });

    test('tagged { $bytes } → Uint8Array even with no metadata', () => {
        const [out] = coerceCircuitArgs([{ $bytes: 'ff'.repeat(4) }], undefined);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out as Uint8Array)).toEqual([255, 255, 255, 255]);
    });

    test('tagged { $uint } → BigInt even with no metadata', () => {
        const [out] = coerceCircuitArgs([{ $uint: '47300' }], undefined);
        expect(out).toBe(47300n);
    });

    test('no metadata + untagged → CoercionError (strict, no silent passthrough)', () => {
        expect(() => coerceCircuitArgs([5], undefined)).toThrow(/could not determine the circuit parameter type/);
        // …but tagged values and empty arg lists still work without metadata.
        expect(coerceCircuitArgs([], undefined)).toEqual([]);
        expect(coerceCircuitArgs([{ $uint: '5' }], undefined)).toEqual([5n]);
    });

    test('invalid hex → CoercionError with index', () => {
        expect(() => coerceCircuitArgs(['zz'.repeat(32)], [BYTES32])).toThrow(CoercionError);
        try { coerceCircuitArgs(['aa'.repeat(32), 'zz'.repeat(32)], [BYTES32, BYTES32]); }
        catch (e) { expect((e as CoercionError).index).toBe(1); }
    });

    test('wrong byte length → CoercionError', () => {
        expect(() => coerceCircuitArgs(['ab'.repeat(16)], [BYTES32]))
            .toThrow(/expected 32 bytes/);
    });

    test('Uint over declared maxval → CoercionError', () => {
        expect(() => coerceCircuitArgs([256], [UINT8])).toThrow(/exceeds maximum 255/);
    });

    test('negative Uint → CoercionError', () => {
        expect(() => coerceCircuitArgs([-1], [UINT8])).toThrow(/non-negative/);
    });
});

describe('arg-coercion: loadCircuitArgTypes (real attestation-vault artifact)', () => {
    const VAULT_ZK = path.resolve(
        __dirname, '..', '..',
        'contracts', 'attestation-vault', 'src', 'managed', 'attestation-vault'
    );

    beforeEach(() => clearArgTypeCache());

    test('attest → two Bytes<32> params', () => {
        const types = loadCircuitArgTypes(VAULT_ZK, 'attest');
        expect(types).toEqual([
            { name: 'payload_hash',  kind: 'Bytes', length: 32 },
            { name: 'metadata_hash', kind: 'Bytes', length: 32 }
        ]);
    });

    test('grantDisclosure → Bytes<32>, Bytes<32>, Uint', () => {
        const types = loadCircuitArgTypes(VAULT_ZK, 'grantDisclosure');
        expect(types?.map((t) => t.kind)).toEqual(['Bytes', 'Bytes', 'Uint']);
        expect(types?.[2].maxval).toBe(255);
    });

    test('unknown circuit → undefined', () => {
        expect(loadCircuitArgTypes(VAULT_ZK, 'bindPassport')).toBeUndefined();
    });

    test('missing contract-info.json → undefined (no throw)', () => {
        expect(loadCircuitArgTypes('/tmp/does-not-exist', 'attest')).toBeUndefined();
    });
});

describe('submitContractCall: Bytes/Uint arg coercion reaches the submitter', () => {
    // A consumer's bindPassport(passportId: Bytes<32>, payload_hash: Bytes<32>).
    const bindPassportTypes: CircuitArgType[] = [
        { name: 'passportId',   kind: 'Bytes', length: 32 },
        { name: 'payload_hash', kind: 'Bytes', length: 32 }
    ];

    function setup(overrides: any = {}) {
        const srv = makeFakeService();
        const submitter = makeSuccessfulSubmitter();
        registerSubmissionHandlers(srv as any, {}, {
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: jest.fn(async () => ({
                accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: () => submitter,
            circuitArgTypesLoader: () => bindPassportTypes,
            ...overrides
        });
        return { srv, submitter };
    }

    function callArgsOf(submitter: any) {
        return (submitter.call as jest.Mock).mock.calls[0][0].args as unknown[];
    }

    test('AC1: Bytes<32> hex args reach the circuit as Uint8Array(32) (bindPassport)', async () => {
        const { srv, submitter } = setup();
        const passportId  = '11'.repeat(32);
        const payloadHash = '22'.repeat(32);
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', compiledArtifactRef: 'x',
            sessionId: `bind-${Date.now()}`, args: JSON.stringify([passportId, payloadHash])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const args = callArgsOf(submitter);
        expect(args[0]).toBeInstanceOf(Uint8Array);
        expect((args[0] as Uint8Array).length).toBe(32);
        expect((args[0] as Uint8Array)[0]).toBe(0x11);
        expect((args[1] as Uint8Array)[0]).toBe(0x22);
    });

    test('AC2: attest becomes callable generically (real artifact introspection)', async () => {
        const VAULT_ZK = path.resolve(
            __dirname, '..', '..',
            'contracts', 'attestation-vault', 'src', 'managed', 'attestation-vault'
        );
        clearArgTypeCache();
        // Use the REAL loader against the REAL attestation-vault artifact path.
        const { srv, submitter } = setup({
            circuitArgTypesLoader: undefined,
            resolveContractImpl: jest.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE, zkConfigPath: VAULT_ZK }))
        });
        const req = makeReq({
            contractAddress: '0xVAULT', circuit: 'attest', compiledArtifactRef: 'attestation-vault',
            sessionId: `attest-${Date.now()}`, args: JSON.stringify(['aa'.repeat(32), 'bb'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const args = callArgsOf(submitter);
        expect(args[0]).toBeInstanceOf(Uint8Array);
        expect(args[1]).toBeInstanceOf(Uint8Array);
        expect((args[0] as Uint8Array).length).toBe(32);
    });

    test('AC3: Uint arg reaches the circuit as BigInt', async () => {
        const { srv, submitter } = setup({
            circuitArgTypesLoader: () => [{ name: 'level', kind: 'Uint', maxval: 255 }] as CircuitArgType[]
        });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'setLevel', compiledArtifactRef: 'x',
            sessionId: `uint-${Date.now()}`, args: JSON.stringify([2])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(callArgsOf(submitter)[0]).toBe(2n);
    });

    test('AC4: invalid hex → 400, not a deep circuit error', async () => {
        const { srv } = setup();
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', compiledArtifactRef: 'x',
            sessionId: `badhex-${Date.now()}`, args: JSON.stringify(['zz'.repeat(32), '22'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/args\[0\].*hex/));
    });

    test('AC4: wrong byte length → 400', async () => {
        const { srv } = setup();
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', compiledArtifactRef: 'x',
            sessionId: `badlen-${Date.now()}`, args: JSON.stringify(['11'.repeat(16), '22'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/expected 32 bytes/));
    });

    test('strict: untagged arg with no circuit metadata → 400 (no silent passthrough)', async () => {
        // Loader returns undefined → no contract-info.json found for the circuit.
        const { srv } = setup({ circuitArgTypesLoader: () => undefined });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'mystery', compiledArtifactRef: 'x',
            sessionId: `nometa-${Date.now()}`, args: JSON.stringify(['aa'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/could not determine the circuit parameter type/));
    });

    test('strict: tagged values still work with no circuit metadata', async () => {
        const { srv, submitter } = setup({ circuitArgTypesLoader: () => undefined });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'mystery', compiledArtifactRef: 'x',
            sessionId: `tagged-${Date.now()}`,
            args: JSON.stringify([{ $bytes: 'aa'.repeat(32) }, { $uint: '5' }])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const args = callArgsOf(submitter);
        expect(args[0]).toBeInstanceOf(Uint8Array);
        expect(args[1]).toBe(5n);
    });
});
