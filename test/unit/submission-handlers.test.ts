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
 * seam; handlers don't know about the worker at all.
 */

import type { Mock } from 'vitest';
// Async-job migration: handlers now wrap the submitter call
// in startJob and return `{ jobId, status }` instead of awaiting the SDK
// round-trip directly. The stub here invokes `work` synchronously so the
// existing assertions about `submitter.deploy` / `submitter.call` argument
// shape still hold; tests that need to assert sync return shape have been
// updated to expect the new { jobId, status, … } payload.
const mockStartJob = vi.hoisted(() => (vi.fn(async (args: any) => {
    // Drive the work fn immediately so submitter.deploy/.call is exercised;
    // keeps the per-call args + registration meta assertions meaningful.
    try {
        if (args.command) {
            const processor = registeredProcessors.get(`${args.kind}\0${args.commandVersion}`);
            await processor?.(args.command, {
                ID: 'job-test', kind: args.kind, sessionId: args.sessionId,
                requestedBy: args.requestedBy, commandVersion: args.commandVersion,
                command: JSON.stringify(args.command)
            });
        } else {
            await args.work();
        }
    } catch { /* failures are absorbed into the job row in prod; tests assert via mock call inspection */ }
    return { jobId: `job-${args.kind}-test`, status: 'pending' as const };
})));
const registeredProcessors = vi.hoisted(() => new Map<string, (command: unknown, row: any) => Promise<unknown>>());
const registeredFinalizers = vi.hoisted(() => new Map<string, (command: unknown, row: any, evidence: any) => Promise<unknown>>());
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args),
    runChildCommand: async (args: any) => {
        const processor = registeredProcessors.get(`${args.kind}\0${args.commandVersion}`);
        if (!processor) throw new Error(`missing child processor ${args.kind}`);
        return processor(args.command, {
            ID: `child-${args.step}`, kind: args.kind, sessionId: args.parent.sessionId,
            requestedBy: args.parent.requestedBy, commandVersion: args.commandVersion,
            command: JSON.stringify(args.command), parentJobId: args.parent.ID, workflowStep: args.step
        });
    },
    registerBackgroundJobProcessor: (kind: string, version: number, processor: (command: unknown, row: any) => Promise<unknown>) => registeredProcessors.set(`${kind}\0${version}`, processor),
    registerBackgroundJobReconciliationFinalizer: (kind: string, version: number, finalizer: (command: unknown, row: any, evidence: any) => Promise<unknown>) => registeredFinalizers.set(`${kind}\0${version}`, finalizer)
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
        on: vi.fn((action: string, fn: Handler) => { handlers[action] = fn; })
    };
}

function makeReq(data: Record<string, unknown>) {
    return {
        data,
        user: { id: 'test-user' },
        reject: vi.fn((status: number, message: string) => {
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
    zkConfigPath: '/tmp/managed',
    artifactPath: '/tmp/managed/contract/index.js'
};

function makeSuccessfulSubmitter() {
    return {
        deploy: vi.fn(async () => ({
            submissionId: 'sub-1', txHash: '0xdeadbeef',
            contractAddress: '0xCONTRACT', status: 'included' as const
        })),
        call: vi.fn(async () => ({
            submissionId: 'sub-2', txHash: '0xcafe',
            contractAddress: '0xCONTRACT', status: 'included' as const
        })),
        callBatch: vi.fn(async (args: any) => ({
            submissionId: 'sub-3', txHash: '0xbatch',
            contractAddress: '0xCONTRACT', status: 'included' as const,
            circuits: (args?.calls ?? []).map((c: any) => c.circuit)
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

    test('rejects non-JSON initialPrivateState (multi-caller seeding)', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, initialPrivateState: '{broken' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/initialPrivateState must be valid JSON/));
    });
});

describe('submitContractCallBatch: argument validation', () => {
    const VALID_BATCH_ARGS = {
        contractAddress: '0xCONTRACT',
        calls: JSON.stringify([{ circuit: 'attest', args: [] }, { circuit: 'bindPassport', args: [] }]),
        compiledArtifactRef: 'attestation-vault',
        sessionId: 'session-batch-validation'
    };

    function setupAndCallBatch(data: Record<string, unknown>) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {});
        const req = makeReq(data);
        return srv.handlers['submitContractCallBatch'](req).then(() => req);
    }

    test('rejects missing contractAddress', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, contractAddress: undefined });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));
    });

    test('rejects missing calls', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: undefined });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/calls/));
    });

    test('rejects non-array calls', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: '{"notArray":true}' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/non-empty JSON array/));
    });

    test('rejects empty calls array', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: '[]' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/non-empty/));
    });

    test('rejects more than 8 calls', async () => {
        const nine = JSON.stringify(Array.from({ length: 9 }, () => ({ circuit: 'attest', args: [] })));
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: nine });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 8/));
    });

    test('rejects an entry without circuit', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: '[{"args":[]}]' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/calls\[0\]\.circuit/));
    });

    test('rejects an entry with non-array args', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, calls: '[{"circuit":"attest","args":{"x":1}}]' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/calls\[0\]\.args must be an array/));
    });

    test('rejects non-JSON initialPrivateState', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, initialPrivateState: '{broken' });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/initialPrivateState must be valid JSON/));
    });
});

// ---- Error translation ----------------------------------------------------

describe('error translation to OData status codes', () => {
    function setupHandlers(overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {}, {
            // Successful happy path by default
            resolveContractImpl: vi.fn(async (_name: string) => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
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
            jobId: 'job-deployContract-test',
            status: 'pending'
        });
        // The mock startJob invokes work() immediately, so submitter.deploy
        // has been called by the time we get here; keeps the existing
        // "deploy forwards registration meta" assertions valid.
        expect(submitter.deploy).toHaveBeenCalledTimes(1);
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            requestedBy: 'test-user', commandVersion: 1, encryptCommand: true,
            command: { op: 'deploy', initialPrivateState: { counter: 0 } }
        });
    });

    test('happy path: submitContractCall returns { jobId, status } and submitter.call is invoked', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_CALL_ARGS, sessionId: 'session-happy-2' });
        const result = await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-submitContractCall-test',
            status: 'pending'
        });
        expect(submitter.call).toHaveBeenCalledTimes(1);
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            requestedBy: 'test-user', commandVersion: 1, encryptCommand: true,
            command: { op: 'call', contractAddress: VALID_CALL_ARGS.contractAddress }
        });
    });

    test('happy path: submitContractCallBatch enqueues op callBatch and submitter.callBatch gets the ordered calls', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const calls = [
            { circuit: 'attest', args: [] },
            { circuit: 'bindPassport', args: [] },
            { circuit: 'anchorContentRoot', args: [] }
        ];
        const req = makeReq({
            contractAddress: '0xCONTRACT',
            calls: JSON.stringify(calls),
            compiledArtifactRef: 'attestation-vault',
            sessionId: 'session-happy-batch'
        });
        const result = await srv.handlers['submitContractCallBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-submitContractCallBatch-test',
            status: 'pending'
        });
        expect((submitter as any).callBatch).toHaveBeenCalledTimes(1);
        expect((submitter as any).call).not.toHaveBeenCalled();
        const batchArgs = ((submitter as any).callBatch as Mock).mock.calls[0][0];
        expect(batchArgs).toMatchObject({
            contractAddress: '0xCONTRACT',
            contractName: 'attestation-vault',
            sessionId: 'session-happy-batch'
        });
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual(['attest', 'bindPassport', 'anchorContentRoot']);
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            kind: 'submitContractCallBatch',
            requestedBy: 'test-user', commandVersion: 1, encryptCommand: true,
            command: { op: 'callBatch', contractAddress: '0xCONTRACT' }
        });
    });

    test('reconciliation finalizer rebuilds the batch result incl. circuits from command + evidence', async () => {
        setupHandlers({});
        const finalizer = registeredFinalizers.get(`submitContractCallBatch\0${1}`);
        expect(finalizer).toBeDefined();
        const result: any = await finalizer!(
            {
                op: 'callBatch', contractAddress: '0xCONTRACT', compiledArtifactRef: 'attestation-vault',
                calls: [{ circuit: 'attest', args: [] }, { circuit: 'bindPassport', args: [] }],
                sponsorSessionId: 'sponsor-1'
            },
            { ID: 'job-r', kind: 'submitContractCallBatch', sessionId: 's', requestedBy: 'u', commandVersion: 1 },
            { submissionId: 'sub-9', txHash: '0xrecovered', contractAddress: '0xCONTRACT', finalizedAt: '2026-07-23T00:00:00Z' }
        );
        expect(result).toEqual({
            reconciled: true,
            submissionId: 'sub-9',
            txHash: '0xrecovered',
            contractAddress: '0xCONTRACT',
            circuits: ['attest', 'bindPassport'],
            status: 'finalized',
            feeSponsor: 'sponsor-1'
        });
    });

    test('executor guard: a submitContractCallBatch job rejects a persisted op=call command', async () => {
        setupHandlers({});
        const processor = registeredProcessors.get(`submitContractCallBatch\0${1}`);
        expect(processor).toBeDefined();
        await expect(processor!(
            { op: 'call', contractAddress: '0xC', circuit: 'attest', compiledArtifactRef: 'attestation-vault', args: [] },
            { ID: 'job-x', kind: 'submitContractCallBatch', sessionId: 's', requestedBy: 'u', commandVersion: 1 }
        )).rejects.toThrow(/incompatible with submitContractCallBatch/);
    });

    test('deploy forwards registration meta (artifactPath/privateStateId/zkConfigPath) to submitter', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-meta' });
        await srv.handlers['deployContract'](req);
        expect(submitter.deploy).toHaveBeenCalledTimes(1);
        expect((submitter.deploy as Mock).mock.calls[0][0]).toMatchObject({
            contractName: 'attestation-vault',
            registration: {
                artifactPath: RESOLVED_CONTRACT_FIXTURE.artifactPath,
                privateStateId: RESOLVED_CONTRACT_FIXTURE.privateStateId,
                zkConfigPath: RESOLVED_CONTRACT_FIXTURE.zkConfigPath
            },
            initialPrivateState: { counter: 0 },
            sessionId: 'session-meta'
        });
    });

    test('ContractNotRegisteredError → 404', async () => {
        const srv = setupHandlers({
            resolveContractImpl: vi.fn(async () => { throw new ContractNotRegisteredError('unknown', []); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-404' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not registered/));
    });

    test('SessionNotFoundError → 401', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: vi.fn(async () => { throw new SessionNotFoundError('s'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-401' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(401, expect.stringMatching(/not found/));
    });

    test('WalletMaterialUnavailable → 501', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: vi.fn(async () => { throw new WalletMaterialUnavailable('signing not impl'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-501' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(501, expect.stringMatching(/Wallet material unavailable/));
    });

    // SubmissionError no longer surfaces via OData. It now
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
                deploy: vi.fn(async () => { throw subErr; }),
                call: vi.fn(async () => { throw subErr; })
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
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {} })),
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
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {} })),
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
        sha256: VALID_SHA256,
        contentType: 'application/pdf',
        size: 1024,
        storageRef: 'file:///tmp/doc.pdf',
        metadata: '{"type":"demo"}',
        sessionId: `anchor-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function makeFakeDb() {
        const run = vi.fn().mockResolvedValue(undefined);
        return { run };
    }

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
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
            jobId: 'job-anchorDocument-test',
            status: 'pending',
            documentId: expect.any(String)
        });
        expect(result.documentId.length).toBeGreaterThan(0);

        // INSERT (sync, on req.tx) + UPDATE (inside work fn, exercised by
        // the startJob mock invoking work eagerly) = 2 db.run calls.
        expect(db.run).toHaveBeenCalledTimes(2);

        // submitter.call was invoked with circuit='attest' and Uint8Array args
        expect(submitter.call).toHaveBeenCalledTimes(1);
        const callArgs = (submitter.call as Mock).mock.calls[0][0];
        expect(callArgs.circuit).toBe('attest');
        expect(callArgs.contractAddress).toBe('0xVAULT');
        expect(callArgs.contractName).toBe('attestation-vault');
        expect(callArgs.args).toHaveLength(2);
        expect(callArgs.args[0]).toBeInstanceOf(Uint8Array);
        expect(callArgs.args[0]).toHaveLength(32);
        expect(callArgs.args[1]).toBeInstanceOf(Uint8Array);
        expect(callArgs.args[1]).toHaveLength(32);
    });

    test('reconciliation finalizer restores the document projection and typed result without submitting', async () => {
        const { db } = setupHandlersWithDb();
        db.run.mockClear();
        const finalizer = registeredFinalizers.get('anchorDocument\0' + '1')!;
        const result = await finalizer({
            op: 'anchorDocument', documentId: 'doc-reconciled', payloadHash: VALID_SHA256,
            metadataHash: 'b'.repeat(64), contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault'
        }, {}, { txHash: '0xanchor', finalizedAt: '2026-07-22T10:00:00Z' });

        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('doc-reconciled');
        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('0xanchor');
        expect(result).toMatchObject({ reconciled: true, documentId: 'doc-reconciled', txHash: '0xanchor' });
    });

    test('defaults compiledArtifactRef to attestation-vault when omitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), compiledArtifactRef: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const callArgs = (submitter.call as Mock).mock.calls[0][0];
        expect(callArgs.contractName).toBe('attestation-vault');
    });

    test('metadata_hash differs for different metadata strings (commitment correctness)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });

        const a = VALID_ANCHOR_ARGS(); a.metadata = '{"v":"a"}';
        const b = VALID_ANCHOR_ARGS(); b.metadata = '{"v":"b"}';

        await srv.handlers['anchorDocument'](makeReq(a));
        await srv.handlers['anchorDocument'](makeReq(b));

        const hashA = (submitter.call as Mock).mock.calls[0][0].args[1];
        const hashB = (submitter.call as Mock).mock.calls[1][0].args[1];
        expect(Buffer.from(hashA).toString('hex')).not.toBe(Buffer.from(hashB).toString('hex'));
    });

    test('UPDATE is skipped when submitter throws inside the work fn (Documents row left without anchoredTxHash)', async () => {
        const subErr = new SubmissionError('sub-z', { code: '1014', retryable: false, message: 'invalid' });
        const { srv, db } = setupHandlersWithDb({
            submitterFactory: () => ({
                deploy: vi.fn(async () => { throw subErr; }),
                call: vi.fn(async () => { throw subErr; })
            }) as unknown as TransactionSubmitter
        });
        const req = makeReq(VALID_ANCHOR_ARGS());
        const result: any = await srv.handlers['anchorDocument'](req);
        // INSERT ran (1), UPDATE did NOT (work threw before reaching it)
        expect(db.run).toHaveBeenCalledTimes(1);
        // The handler still returns successfully; failure is in the job row.
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
    const DOC_ID = '00000000-0000-4000-8000-000000000001';
    const TX_ID = '00000000-0000-4000-8000-000000000002';
    const TX_HASH = '0xanchor';

    function makeDbWithSequence(rows: any[]) {
        // Each db.run consumes the next row from the queue.
        const queue = [...rows];
        const run = vi.fn().mockImplementation(async () => queue.shift());
        return { run };
    }

    function setupHandlersWithDb(db: any) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(),
            walletMaterialFactory: vi.fn(),
            submitterFactory: vi.fn()
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
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            verified: true,
            anchoredTxHash: TX_HASH,
            anchoredAt: '2026-05-19T12:00:00Z',
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
        // Skips the tx lookup when hash mismatched: only 1 db.run, not 3.
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
            verified: false,
            anchoredTxHash: '',
            anchoredAt: null,
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
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA.toUpperCase() });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(true);
    });
});

// ---- issuePredicateAttestation (ZK predicate, on-chain model) -------------

describe('issuePredicateAttestation', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_SALT = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        value: '47300',
        salt: VALID_SALT,
        predicate: 'lessOrEqual',
        threshold: 50000,
        unit: 'kgCO2e/kWh',
        sessionId: `pred-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function makeFakeDb() {
        return { run: vi.fn().mockResolvedValue(undefined) };
    }

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
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
            jobId: 'job-issuePredicateAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        // INSERT (sync) + UPDATE (inside work) = 2 db.run.
        expect(db.run).toHaveBeenCalledTimes(2);

        // Two circuit calls in order: commitValue then provePredicate.
        expect(submitter.call).toHaveBeenCalledTimes(2);
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        const c1 = (submitter.call as Mock).mock.calls[1][0];

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
        const c1 = (submitter.call as Mock).mock.calls[1][0];
        expect(c1.args[2]).toBe(1n);
    });

    test('generates a 32-byte salt when omitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        await srv.handlers['issuePredicateAttestation'](makeReq({ ...VALID_ARGS(), salt: undefined }));
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        expect(c0.witnessValues.valueSalt).toMatch(/^[0-9a-f]{64}$/);
    });

    test('UPDATE is skipped when provePredicate throws inside work', async () => {
        const subErr = new SubmissionError('sub-z', { code: 'OnChainStatus:Fail', retryable: false, message: 'predicate false' });
        const failingSubmitter = {
            deploy: vi.fn(),
            // commitValue succeeds, provePredicate throws.
            call: vi.fn()
                .mockResolvedValueOnce({ txHash: '0xcommit', status: 'included' })
                .mockRejectedValueOnce(subErr)
        } as unknown as TransactionSubmitter;
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => failingSubmitter });
        const req = makeReq(VALID_ARGS());
        const result: any = await srv.handlers['issuePredicateAttestation'](req);
        // The parent workflow must not persist a proof result when the proof
        // child failed (processor revalidation may perform additional DB I/O).
        expect((db.run as Mock).mock.calls.some(([q]) => Boolean(q?.UPDATE)
            && JSON.stringify(q).includes('provenTxHash'))).toBe(false);
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
    const PA_ID = '00000000-0000-4000-8000-0000000000a1';
    const TX_ID = '00000000-0000-4000-8000-0000000000a2';
    const TX_HASH = '0xprove';

    function makeDbWithSequence(rows: any[]) {
        const queue = [...rows];
        return { run: vi.fn().mockImplementation(async () => queue.shift()) };
    }
    function setupHandlersWithDb(db: any) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(), walletMaterialFactory: vi.fn(), submitterFactory: vi.fn()
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
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
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

// ---- grantDisclosure / revokeDisclosure (on-chain disclosure ACL) ---------

describe('grantDisclosure', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_GRANTEE = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        grantee: VALID_GRANTEE,
        level: 1,
        sessionId: `disc-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function makeFakeDb() {
        return { run: vi.fn().mockResolvedValue(undefined) };
    }
    let reindexer: Mock;
    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        reindexer = vi.fn().mockResolvedValue({ indexed: 1, deactivated: 0 });
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            disclosureReindexer: reindexer,
            ...overrides
        });
        return { srv, db };
    }

    test('rejects missing payloadHash', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), payloadHash: undefined });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
    });

    test('rejects non-hex payloadHash', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), payloadHash: 'nope' });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash must be 64 hex/));
    });

    test('rejects missing grantee', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), grantee: undefined });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/grantee is required/));
    });

    test('rejects non-hex grantee', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), grantee: 'short' });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/grantee must be 64 hex/));
    });

    test('rejects missing level', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), level: undefined });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/level is required/));
    });

    test('rejects out-of-range level (3)', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), level: 3 });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/level must be 0/));
    });

    test('rejects negative level', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), level: -1 });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/level must be 0/));
    });

    test('rejects missing contractAddress', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), contractAddress: undefined });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress is required/));
    });

    test('happy path: SELECT + INSERT up-front + single grantDisclosure call + UPDATE grantedTxHash', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['grantDisclosure'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-grantDisclosure-test',
            status: 'pending',
            disclosureGrantId: expect.any(String)
        });

        // SELECT.one existing (sync) + INSERT (sync) + UPDATE (inside work) = 3 db.run.
        expect(db.run).toHaveBeenCalledTimes(3);

        // Exactly one circuit call: grantDisclosure(payload, grantee, level).
        expect(submitter.call).toHaveBeenCalledTimes(1);
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        expect(c0.circuit).toBe('grantDisclosure');
        expect(c0.args).toHaveLength(3);
        expect(c0.args[0]).toBeInstanceOf(Uint8Array);
        expect(c0.args[0]).toHaveLength(32);
        expect(c0.args[1]).toBeInstanceOf(Uint8Array);
        expect(c0.args[1]).toHaveLength(32);
        expect(c0.args[2]).toBe(1n);          // level as bigint
        expect(c0.witnessValues).toBeUndefined(); // no private witnesses
    });

    test('defaults compiledArtifactRef to attestation-vault', async () => {
        const resolveContractImpl = vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE }));
        const { srv } = setupHandlersWithDb({ resolveContractImpl });
        await srv.handlers['grantDisclosure'](makeReq({ ...VALID_ARGS(), compiledArtifactRef: undefined }));
        expect(resolveContractImpl).toHaveBeenCalledWith('attestation-vault');
    });

    test('reindexes on-chain state after a successful grant', async () => {
        const { srv } = setupHandlersWithDb();
        await srv.handlers['grantDisclosure'](makeReq(VALID_ARGS()));
        expect(reindexer).toHaveBeenCalledTimes(1);
        expect(reindexer).toHaveBeenCalledWith(expect.objectContaining({
            contractAddress: '0xvault',
            artifactPath: RESOLVED_CONTRACT_FIXTURE.artifactPath
        }));
    });

    test('reconciliation finalizer restores grantedTxHash, reindexes and returns normal grant fields', async () => {
        const { db } = setupHandlersWithDb();
        db.run.mockClear();
        reindexer.mockClear();
        const result = await registeredFinalizers.get('grantDisclosure\0' + '1')!({
            op: 'grantDisclosure', disclosureGrantId: 'grant-reconciled', payloadHash: VALID_PAYLOAD,
            grantee: VALID_GRANTEE, level: 2, contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault'
        }, {}, { txHash: '0xgrant', finalizedAt: null });

        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('0xgrant');
        expect(reindexer).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ reconciled: true, disclosureGrantId: 'grant-reconciled', level: 2, txHash: '0xgrant' });
    });

    test('reuses an existing grant row instead of inserting a duplicate', async () => {
        const srv = makeFakeService();
        // First db.run = SELECT.one existing → return a row; all later calls → undefined.
        const run = vi.fn()
            .mockResolvedValueOnce({ ID: 'existing-grant-row' })
            .mockResolvedValue(undefined);
        const db = { run };
        reindexer = vi.fn().mockResolvedValue({ indexed: 1, deactivated: 0 });
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            disclosureReindexer: reindexer
        });

        const req = makeReq(VALID_ARGS());
        const result: any = await srv.handlers['grantDisclosure'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result.disclosureGrantId).toBe('existing-grant-row');

        const queries = run.mock.calls.map(c => c[0]);
        expect(queries.some(q => q.INSERT)).toBe(false);
        // Up-front re-grant UPDATE re-affirms level and clears any stale revoke.
        const updates = queries.filter(q => q.UPDATE);
        expect(updates.length).toBeGreaterThanOrEqual(1);
        const upFront = JSON.stringify(updates[0].UPDATE.data ?? updates[0].UPDATE.with);
        expect(upFront).toContain('"level":1');
        expect(upFront).toContain('"revokedTxHash":null');
    });

    test('a reindex failure does not fail the grant', async () => {
        const { srv } = setupHandlersWithDb({
            disclosureReindexer: vi.fn().mockRejectedValue(new Error('indexer down'))
        });
        const req = makeReq(VALID_ARGS());
        const result: any = await srv.handlers['grantDisclosure'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({ jobId: expect.any(String), status: 'pending' });
    });

    test('forwards idempotencyKey to startJob', async () => {
        const { srv } = setupHandlersWithDb();
        await srv.handlers['grantDisclosure'](makeReq({ ...VALID_ARGS(), idempotencyKey: 'idem-1' }));
        expect(mockStartJob).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'grantDisclosure', idempotencyKey: 'idem-1'
        }));
    });

    test('rate-limited at 30 ops/hour/session', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `disc-rate-${Date.now()}`;
        for (let i = 0; i < 30; i++) {
            const req = makeReq({ ...VALID_ARGS(), sessionId });
            await srv.handlers['grantDisclosure'](req);
            expect(req.reject).not.toHaveBeenCalled();
        }
        const overflow = makeReq({ ...VALID_ARGS(), sessionId });
        await srv.handlers['grantDisclosure'](overflow);
        expect(overflow.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));
    });
});

describe('revokeDisclosure', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_GRANTEE = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        grantee: VALID_GRANTEE,
        sessionId: `revk-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            disclosureReindexer: vi.fn().mockResolvedValue({ indexed: 0, deactivated: 1 }),
            ...overrides
        });
        return { srv, db };
    }

    test('reconciliation finalizer fail-closes the local grant and reindexes', async () => {
        const reindexer = vi.fn().mockResolvedValue({ indexed: 0, deactivated: 1 });
        const { db } = setupHandlersWithDb({ disclosureReindexer: reindexer });
        db.run.mockClear();
        const result = await registeredFinalizers.get('revokeDisclosure\0' + '1')!({
            op: 'revokeDisclosure', payloadHash: VALID_PAYLOAD, grantee: VALID_GRANTEE,
            contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault'
        }, {}, { txHash: '0xrevoke', finalizedAt: null });

        const update = JSON.stringify(db.run.mock.calls[0][0]);
        expect(update).toContain('0xrevoke');
        expect(update).toContain('false');
        expect(reindexer).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ reconciled: true, payloadHash: VALID_PAYLOAD, grantee: VALID_GRANTEE, txHash: '0xrevoke' });
    });

    test('rejects non-hex grantee', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), grantee: 'short' });
        await srv.handlers['revokeDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/grantee must be 64 hex/));
    });

    test('rejects missing sessionId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), sessionId: undefined });
        await srv.handlers['revokeDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId is required/));
    });

    test('happy path: single revokeDisclosure call + UPDATE active=false; returns { jobId, status }', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['revokeDisclosure'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-revokeDisclosure-test', status: 'pending' });

        // No up-front INSERT; only the UPDATE inside work = 1 db.run.
        expect(db.run).toHaveBeenCalledTimes(1);

        expect(submitter.call).toHaveBeenCalledTimes(1);
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        expect(c0.circuit).toBe('revokeDisclosure');
        expect(c0.args).toHaveLength(2);
        expect(c0.args[0]).toBeInstanceOf(Uint8Array);
        expect(c0.args[1]).toBeInstanceOf(Uint8Array);
    });
});

// ---- registerPassport (registrar passport pre-registration) ---------------

describe('registerPassport', () => {
    const VALID_PASSPORT = 'c'.repeat(64);
    const VALID_OWNER = 'd'.repeat(64);
    const VALID_ARGS = () => ({
        passportId: VALID_PASSPORT,
        ownerId: VALID_OWNER,
        sessionId: `regp-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test('rejects non-hex passportId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), passportId: 'short' });
        await srv.handlers['registerPassport'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/passportId must be 64 hex/));
    });

    test('rejects missing ownerId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ownerId: undefined });
        await srv.handlers['registerPassport'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/ownerId is required/));
    });

    test('rejects missing sessionId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), sessionId: undefined });
        await srv.handlers['registerPassport'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId is required/));
    });

    test('happy path: single registerPassport call, no projection writes; returns { jobId, status }', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['registerPassport'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-registerPassport-test', status: 'pending' });

        // No DB projection for passport ownership; the chain is the source of truth.
        expect(db.run).not.toHaveBeenCalled();

        expect(submitter.call).toHaveBeenCalledTimes(1);
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        expect(c0.circuit).toBe('registerPassport');
        expect(c0.args).toHaveLength(2);
        expect(c0.args[0]).toBeInstanceOf(Uint8Array);
        expect(c0.args[1]).toBeInstanceOf(Uint8Array);
    });

    test('reconciliation finalizer rebuilds the documented result from evidence', async () => {
        setupHandlersWithDb();
        const result = await registeredFinalizers.get('registerPassport\0' + '1')!({
            op: 'registerPassport', passportId: VALID_PASSPORT, ownerId: VALID_OWNER,
            contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault'
        }, {}, { txHash: '0xregister', finalizedAt: null });

        expect(result).toEqual({
            reconciled: true, passportId: VALID_PASSPORT, ownerId: VALID_OWNER,
            contractAddress: '0xVAULT', txHash: '0xregister'
        });
    });
});

// ---- registerGranteeIdentity (Phase 0 grantee binding) --------------------

describe('registerGranteeIdentity', () => {
    // No nightgate config in tests → binding defaults to 'wallet' (input = hex).
    const PUBKEY = '11'.repeat(32);

    // Self-service registration defaults OFF (secure default). Opt in for the
    // cases that exercise the registration path; the "403 disabled" case sets
    // 'false' explicitly.
    beforeEach(() => { process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION = 'true'; });
    afterEach(() => { delete process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION; });

    function setup(dbRun?: Mock) {
        const srv = makeFakeService();
        const db = { run: dbRun ?? vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(), walletMaterialFactory: vi.fn(), submitterFactory: vi.fn()
        });
        return { srv, db };
    }
    function reqWithUser(userId: string | undefined, data: Record<string, unknown>) {
        return {
            data,
            user: userId ? { id: userId } : undefined,
            reject: vi.fn((status: number, message: string) => {
                const err: any = new Error(message); err.status = status; return err;
            })
        };
    }

    test('401 when unauthenticated', async () => {
        const { srv } = setup();
        const req = reqWithUser(undefined, { bindingInput: PUBKEY });
        await srv.handlers['registerGranteeIdentity'](req);
        expect(req.reject).toHaveBeenCalledWith(401, expect.stringMatching(/authentication/));
    });

    test('403 when self-service registration is disabled', async () => {
        process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION = 'false';
        try {
            const { srv } = setup();
            const req = reqWithUser('u1', { bindingInput: PUBKEY });
            await srv.handlers['registerGranteeIdentity'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/disabled/));
        } finally {
            delete process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION;
        }
    });

    test('400 when bindingInput missing', async () => {
        const { srv } = setup();
        const req = reqWithUser('u1', {});
        await srv.handlers['registerGranteeIdentity'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/bindingInput/));
    });

    test('400 when bindingInput invalid for the binding kind', async () => {
        const { srv } = setup();
        const req = reqWithUser('u1', { bindingInput: 'not-hex' });
        await srv.handlers['registerGranteeIdentity'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/hex/));
    });

    test('inserts a new identity and returns the derived granteeId', async () => {
        // SELECT.one existing → undefined, then INSERT.
        const run = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(undefined);
        const { srv } = setup(run);
        const req = reqWithUser('u1', { bindingInput: PUBKEY });
        const result: any = await srv.handlers['registerGranteeIdentity'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result.bindingKind).toBe('wallet');
        expect(result.granteeId).toMatch(/^[0-9a-f]{64}$/);
        expect(result.ID).toEqual(expect.any(String));

        const insert = run.mock.calls.map(c => c[0]).find(q => q.INSERT);
        expect(insert.INSERT.entries[0]).toMatchObject({
            userId: 'u1', granteeId: result.granteeId, bindingKind: 'wallet', scope: null
        });
    });

    test('idempotent: updates the existing (userId, scope) row instead of inserting', async () => {
        // SELECT.one existing → a row, then UPDATE.
        const run = vi.fn().mockResolvedValueOnce({ ID: 'existing-1' }).mockResolvedValue(undefined);
        const { srv } = setup(run);
        const req = reqWithUser('u1', { bindingInput: PUBKEY });
        const result: any = await srv.handlers['registerGranteeIdentity'](req);

        expect(result.ID).toBe('existing-1');
        const queries = run.mock.calls.map(c => c[0]);
        expect(queries.some(q => q.UPDATE)).toBe(true);
        expect(queries.some(q => q.INSERT)).toBe(false);
    });
});

// ---- Typed arg coercion for submitContractCall ----------------------------
// A Bytes<N> circuit arg can't reach the circuit via the JSON `args` surface
// without coercion. These cover the coercion layer (pure), the
// contract-info.json introspection (against the real shipped artifact), and the
// handler wiring + 400s.

describe('arg-coercion: coerceCircuitArgs (pure)', () => {
    const BYTES32: CircuitArgType = { name: 'h', kind: 'Bytes', length: 32 };
    const UINT8: CircuitArgType = { name: 'n', kind: 'Uint', maxval: 255 };

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
            { name: 'payload_hash', kind: 'Bytes', length: 32 },
            { name: 'metadata_hash', kind: 'Bytes', length: 32 }
        ]);
    });

    test('grantDisclosure → Bytes<32>, Bytes<32>, Uint', () => {
        const types = loadCircuitArgTypes(VAULT_ZK, 'grantDisclosure');
        expect(types?.map((t) => t.kind)).toEqual(['Bytes', 'Bytes', 'Uint']);
        expect(types?.[2].maxval).toBe(255);
    });

    test('unknown circuit → undefined', () => {
        expect(loadCircuitArgTypes(VAULT_ZK, 'noSuchCircuit')).toBeUndefined();
    });

    test('missing contract-info.json → undefined (no throw)', () => {
        expect(loadCircuitArgTypes('/tmp/does-not-exist', 'attest')).toBeUndefined();
    });
});

describe('submitContractCall: Bytes/Uint arg coercion reaches the submitter', () => {
    // A consumer's bindPassport(passportId: Bytes<32>, payload_hash: Bytes<32>).
    const bindPassportTypes: CircuitArgType[] = [
        { name: 'passportId', kind: 'Bytes', length: 32 },
        { name: 'payload_hash', kind: 'Bytes', length: 32 }
    ];

    function setup(overrides: any = {}) {
        const srv = makeFakeService();
        const submitter = makeSuccessfulSubmitter();
        registerSubmissionHandlers(srv as any, {}, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: () => submitter,
            circuitArgTypesLoader: () => bindPassportTypes,
            ...overrides
        });
        return { srv, submitter };
    }

    function callArgsOf(submitter: any) {
        return (submitter.call as Mock).mock.calls[0][0].args as unknown[];
    }

    test('AC1: Bytes<32> hex args reach the circuit as Uint8Array(32) (bindPassport)', async () => {
        const { srv, submitter } = setup();
        const passportId = '11'.repeat(32);
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
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE, zkConfigPath: VAULT_ZK }))
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

// ---- issueFieldPredicateAttestation (field-bound ZK predicate) -------------

describe('issueFieldPredicateAttestation', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_FIELD_KEY = 'f'.repeat(64);
    const VALID_ROOT = 'd'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        fieldKey: VALID_FIELD_KEY,
        value: '47300',
        contentRoot: VALID_ROOT,
        siblingsJson: JSON.stringify(SIBLINGS),
        dirsJson: JSON.stringify([true, false, true, false]),
        predicate: 'lessOrEqual',
        threshold: 50000,
        unit: 'kgCO2e/kWh',
        sessionId: `fieldpred-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHash: undefined }, /payloadHash is required/],
        [{ payloadHash: 'nope' }, /payloadHash must be 64 hex/],
        [{ fieldKey: undefined }, /fieldKey is required/],
        [{ fieldKey: 'zz' }, /fieldKey must be 64 hex/],
        [{ value: undefined }, /value is required/],
        [{ value: '' }, /value is required/],
        [{ value: '47.3' }, /value must be an integer/],
        [{ value: '-5' }, /value must be a non-negative integer/],
        [{ threshold: undefined }, /threshold is required/],
        [{ threshold: 'abc' }, /threshold must be an integer/],
        [{ predicate: 'between' }, /lessOrEqual.*greaterOrEqual/],
        [{ siblingsJson: 'not-json' }, /siblingsJson must be a JSON array/],
        [{ dirsJson: 'not-json' }, /dirsJson must be a JSON array/],
        [{ siblingsJson: JSON.stringify(SIBLINGS.slice(0, 2)) }, /array of 4 hashes/],
        [{ dirsJson: JSON.stringify([true]) }, /array of 4 booleans/],
        [{ siblingsJson: JSON.stringify([...SIBLINGS.slice(0, 3), 'short']) }, /each sibling must be 64 hex/],
        [{ contentRoot: 'oops' }, /contentRoot must be 64 hex/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['issueFieldPredicateAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['issueFieldPredicateAttestation'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        } finally {
            if (prev === undefined) delete process.env.NIGHTGATE_NETWORK;
            else process.env.NIGHTGATE_NETWORK = prev;
        }
    });

    test('happy path with contentRoot: INSERT + anchorContentRoot + proveFieldPredicate + UPDATE; value travels only as witness', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueFieldPredicateAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueFieldPredicateAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        // INSERT (row up-front) + UPDATE (inside work) = 2 db.run.
        expect(db.run).toHaveBeenCalledTimes(2);

        expect(submitter.call).toHaveBeenCalledTimes(2);
        const anchor = (submitter.call as Mock).mock.calls[0][0];
        const prove = (submitter.call as Mock).mock.calls[1][0];

        expect(anchor.circuit).toBe('anchorContentRoot');
        expect(anchor.args).toHaveLength(2); // payloadHash + contentRoot bytes
        expect(anchor.merkleProof).toBeUndefined();

        expect(prove.circuit).toBe('proveFieldPredicate');
        // args: payloadHash, fieldKey, threshold, op. NEVER the field value.
        expect(prove.args).toHaveLength(4);
        expect(prove.args[2]).toBe(50000n);
        expect(prove.args[3]).toBe(0n);
        // The value + inclusion path travel as witnesses only.
        expect(prove.merkleProof).toEqual({
            fieldValue: '47300',
            siblings: SIBLINGS,
            dirs: [true, false, true, false]
        });
        const flatArgs = JSON.stringify(prove.args, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        expect(flatArgs).not.toContain('47300');
    });

    test('without contentRoot only proveFieldPredicate is submitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ARGS(), contentRoot: undefined });

        await srv.handlers['issueFieldPredicateAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(submitter.call).toHaveBeenCalledTimes(1);
        expect((submitter.call as Mock).mock.calls[0][0].circuit).toBe('proveFieldPredicate');
    });

    test('persists the fieldKey (lowercased) so the crawler-free fallback can recompute the claim key', async () => {
        const { srv, db } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), fieldKey: VALID_FIELD_KEY.toUpperCase() });
        await srv.handlers['issueFieldPredicateAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const inserted = (db.run as Mock).mock.calls[0][0];
        expect(JSON.stringify(inserted)).toContain(VALID_FIELD_KEY);
    });
});
