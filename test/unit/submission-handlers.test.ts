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
    // Like the REAL startJob, stamp the artifact-generation digest before
    // execution (the executor's provenance gate is fail-closed on it); the
    // registry aliases are registered in beforeAll below.
    try {
        if (args.command) {
            let command = args.command;
            if (command && typeof command === 'object'
                && typeof command.compiledArtifactRef === 'string'
                && command.artifactDigest === undefined) {
                command = { ...command, artifactDigest: getArtifactGenerationDigest(command.compiledArtifactRef) };
            }
            const processor = registeredProcessors.get(`${args.kind}\0${args.commandVersion}`);
            await processor?.(command, {
                ID: 'job-test', kind: args.kind, sessionId: args.sessionId,
                requestedBy: args.requestedBy, commandVersion: args.commandVersion,
                command: JSON.stringify(command)
            });
        } else {
            await args.work();
        }
    } catch { /* failures are absorbed into the job row in prod; tests assert via mock call inspection */ }
    return { jobId: `job-${args.kind}-test`, status: 'pending' as const };
})));
const registeredProcessors = vi.hoisted(() => new Map<string, (command: unknown, row: any) => Promise<unknown>>());
const childCommandLog = vi.hoisted(() => [] as Array<{ kind: string; step: string; command: any }>);
const registeredFinalizers = vi.hoisted(() => new Map<string, (command: unknown, row: any, evidence: any) => Promise<unknown>>());
vi.mock('../../srv/submission/background-jobs', async (importOriginal) => ({
    // The real error class: runSubmission narrows on `instanceof`.
    JobAdmissionBusyError: (await importOriginal<typeof import('../../srv/submission/background-jobs')>()).JobAdmissionBusyError,
    startJob: (...args: unknown[]) => (mockStartJob as any)(...args),
    runChildCommand: async (args: any) => {
        const processor = registeredProcessors.get(`${args.kind}\0${args.commandVersion}`);
        if (!processor) throw new Error(`missing child processor ${args.kind}`);
        // Log the command EXACTLY as the handler passed it, so tests can pin
        // that workflow children inherit the parent's artifactDigest instead
        // of relying on stamp-at-child-creation.
        childCommandLog.push({ kind: args.kind, step: args.step, command: args.command });
        // Same provenance stamping as the real path (children persist through
        // the real startJob in production).
        let command = args.command;
        if (command && typeof command === 'object'
            && typeof command.compiledArtifactRef === 'string'
            && command.artifactDigest === undefined) {
            command = { ...command, artifactDigest: getArtifactGenerationDigest(command.compiledArtifactRef) };
        }
        return processor(command, {
            ID: `child-${args.step}`, kind: args.kind, sessionId: args.parent.sessionId,
            requestedBy: args.parent.requestedBy, commandVersion: args.commandVersion,
            command: JSON.stringify(command), parentJobId: args.parent.ID, workflowStep: args.step
        });
    },
    registerBackgroundJobProcessor: (kind: string, version: number, processor: (command: unknown, row: any) => Promise<unknown>) => registeredProcessors.set(`${kind}\0${version}`, processor),
    registerBackgroundJobReconciliationFinalizer: (kind: string, version: number, finalizer: (command: unknown, row: any, evidence: any) => Promise<unknown>) => registeredFinalizers.set(`${kind}\0${version}`, finalizer)
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import { JobAdmissionBusyError } from '../../srv/submission/background-jobs';
import {
    SubmissionError,
    type TransactionSubmitter
} from '../../srv/submission/TransactionSubmitter';
import { ContractNotRegisteredError, registerContract, unregisterContract, getArtifactGenerationDigest } from '../../srv/submission/contract-registry';

// Provenance stamping (0.16.0): startJob resolves the command's
// compiledArtifactRef through the REGISTRY to stamp the artifact-generation
// digest, so the aliases the fixtures use must be registered (the resolver
// itself stays the injected fake). The fixture artifact is any real file;
// the digest only reads bytes.
beforeAll(() => {
    const fixtureArtifact = path.resolve(__dirname, '../fixtures/fake-vault-artifact.mjs');
    for (const name of ['attestation-vault', 'a', 'x']) {
        registerContract(name, {
            artifactPath: fixtureArtifact,
            privateStateId: 'test',
            zkConfigPath: path.resolve(__dirname, '../fixtures')
        });
    }
});
afterAll(() => {
    unregisterContract('attestation-vault');
    unregisterContract('a');
    unregisterContract('x');
});
import {
    SessionNotFoundError,
    WalletMaterialUnavailable
} from '../../srv/submission/wallet-material-factory';
import {
    coerceCircuitArgs,
    loadCircuitArgTypes,
    __clearArgTypeCacheForTests,
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
    artifactPath: '/tmp/managed/contract/index.js',
    artifactDigest: 'a'.repeat(64)
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

    const SIBS4 = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    test.each([
        [{ merkleProof: 'nope' }, /calls\[0\]\.merkleProof must be an object/],
        [{ merkleProof: { fieldValue: '4.2', siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldValue must be an integer/],
        [{ merkleProof: { fieldValue: '-1', siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldValue must be a non-negative integer/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4.slice(0, 2), dirs: [true, false, true, false] } }, /merkleProof\.siblings must be a JSON array of 4 hashes/],
        [{ merkleProof: { fieldValue: '1', siblings: [...SIBS4.slice(0, 3), 'short'], dirs: [true, false, true, false] } }, /merkleProof\.siblings entries must be 64 hex/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4, dirs: [true] } }, /merkleProof\.dirs must be a JSON array of 4 booleans/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4, dirs: [true, false, 'false', true] } }, /merkleProof\.dirs entries must be booleans/]
    ])('rejects a malformed per-call merkleProof %o', async (patch, msg) => {
        const req = await setupAndCallBatch({
            ...VALID_BATCH_ARGS,
            calls: JSON.stringify([{ circuit: 'proveFieldPredicate', args: [], ...patch }])
        });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });
});

// ---- Error translation ----------------------------------------------------

describe('mintShieldedTestToken + deriveTokenType', () => {
    const ADDRESS = 'c8f426c52a5418f3b0acda284ee04d530a38f68ab3c701116fa42fae0e90cfd6';

    function setup(overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {}, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return srv;
    }

    test('rejects a missing contractAddress or sessionId', async () => {
        const srv = setup();
        const r1 = makeReq({ sessionId: 'mint-s1' });
        await srv.handlers['mintShieldedTestToken'](r1);
        expect(r1.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));

        const r2 = makeReq({ contractAddress: ADDRESS });
        await srv.handlers['mintShieldedTestToken'](r2);
        expect(r2.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId/));
    });

    test('enqueues mint() with no arguments and defaults the artifact ref', async () => {
        const srv = setup();
        const req = makeReq({ contractAddress: ADDRESS, sessionId: 'mint-s2' });
        const result = await srv.handlers['mintShieldedTestToken'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-mintShieldedTestToken-test', status: 'pending' });
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            kind: 'mintShieldedTestToken', requestedBy: 'test-user', encryptCommand: true,
            command: { op: 'call', circuit: 'mint', compiledArtifactRef: 'shielded-token', args: [], contractAddress: ADDRESS }
        });
    });

    test('rejects a foreign artifact ref (the result enrichment is fixture-specific)', async () => {
        // The processor stamps the FIXTURE's domain separator and amount onto
        // the result; a foreign mint contract would execute fine and then be
        // reported with a wrong tokenTypeHex. Explicitly repeating the bundled
        // name stays allowed.
        const srv = setup();
        const req = makeReq({ contractAddress: ADDRESS, sessionId: 'mint-s3', compiledArtifactRef: 'my-token' });
        await srv.handlers['mintShieldedTestToken'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/only mints the bundled/));

        const ok = makeReq({ contractAddress: ADDRESS, sessionId: 'mint-s4', compiledArtifactRef: 'shielded-token' });
        await srv.handlers['mintShieldedTestToken'](ok);
        expect(ok.reject).not.toHaveBeenCalled();
    });

    test('deriveTokenType returns the token type without touching a wallet', async () => {
        const walletMaterialFactory = vi.fn();
        const srv = setup({ walletMaterialFactory });
        const req = makeReq({ contractAddress: ADDRESS });
        const out = await srv.handlers['deriveTokenType'](req) as any;
        expect(req.reject).not.toHaveBeenCalled();
        expect(out.tokenTypeHex).toMatch(/^[0-9a-f]{64}$/);
        expect(out.contractAddress).toBe(ADDRESS);
        expect(walletMaterialFactory).not.toHaveBeenCalled();
    });

    test('deriveTokenType rejects a missing or unusable input with 400', async () => {
        const srv = setup();
        const r1 = makeReq({});
        await srv.handlers['deriveTokenType'](r1);
        expect(r1.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));

        const r2 = makeReq({ contractAddress: 'not-an-address' });
        await srv.handlers['deriveTokenType'](r2);
        expect(r2.reject).toHaveBeenCalledWith(400, expect.any(String));

        const r3 = makeReq({ contractAddress: ADDRESS, domainSeparator: 'x'.repeat(40) });
        await srv.handlers['deriveTokenType'](r3);
        expect(r3.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 32/));
    });
});

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

    test('submitContractCallBatch forwards a per-call merkleProof to the submitter and the persisted command', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const SIBS4 = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
        const proof = { fieldValue: '3600', siblings: SIBS4, dirs: [true, false, true, false] };
        const req = makeReq({
            contractAddress: '0xCONTRACT',
            calls: JSON.stringify([
                { circuit: 'anchorContentRoot', args: [] },
                { circuit: 'proveFieldPredicate', args: [], merkleProof: proof }
            ]),
            compiledArtifactRef: 'attestation-vault',
            sessionId: 'session-happy-batch-proof'
        });
        await srv.handlers['submitContractCallBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();

        const batchArgs = ((submitter as any).callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls[0].merkleProof).toBeUndefined();
        expect(batchArgs.calls[1].merkleProof).toEqual(proof);

        const command = mockStartJob.mock.calls.at(-1)?.[0]?.command;
        expect(command.calls[0].merkleProof).toBeUndefined();
        expect(command.calls[1].merkleProof).toEqual(proof);
    });

    test('reconciliation finalizer rebuilds the batch result incl. circuits from command + evidence', async () => {
        setupHandlers({});
        const finalizer = registeredFinalizers.get(`submitContractCallBatch\0${1}`);
        expect(finalizer).toBeDefined();
        const result: any = await finalizer!(
            {
                op: 'callBatch', contractAddress: '0xCONTRACT', compiledArtifactRef: 'attestation-vault',
                calls: [{ circuit: 'attest', args: [] }, { circuit: 'bindPassport', args: [] }],
                sponsorSessionId: 'sponsor-1', artifactDigest: getArtifactGenerationDigest('attestation-vault')
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

    test('a busy admission rejects 503 with a stable code, Retry-After, and $sanitize:false', async () => {
        mockStartJob.mockRejectedValueOnce(new JobAdmissionBusyError('deployContract'));
        const srv = setupHandlers();
        const setHeader = vi.fn();
        const req = { ...makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-busy' }), http: { res: { set: setHeader } } };
        await srv.handlers['deployContract'](req);
        // Rejected as an object: a (status, message) pair loses the code and is sanitised to `Service Unavailable` in production.
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({
            status: 503, code: 'JOB_ADMISSION_BUSY', $sanitize: false,
            message: expect.stringMatching(/nothing was submitted, retry/)
        }));
        expect(setHeader).toHaveBeenCalledWith('Retry-After', '2');
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
            metadataHash: 'b'.repeat(64), contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
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

    // Evidence binding (0.16.0): the recorded anchoring vault is
    // authoritative; a caller pointing at a DIFFERENT vault that attests the
    // same public hash must not turn the document verified.
    test('rejects a caller contractAddress that differs from the recorded anchoring vault', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z', contractAddress: 'aa'.repeat(32) }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA, contractAddress: 'bb'.repeat(32) });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/does not match the vault/));
    });

    test('accepts a caller contractAddress that CONFIRMS the recorded vault (case-insensitive)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, sha256: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z', contractAddress: 'aa'.repeat(32) },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ documentId: DOC_ID, providedSha256: VALID_SHA, contractAddress: 'AA'.repeat(32) });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.verified).toBe(true);
    });
});

// ---- issuePredicateAttestation (ZK predicate, on-chain model) -------------

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
            grantee: VALID_GRANTEE, level: 2, contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
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
            contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
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
            contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
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

    beforeEach(() => __clearArgTypeCacheForTests());

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
        __clearArgTypeCacheForTests();
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
        fieldSalt: 'f5'.repeat(32),
        contentRoot: VALID_ROOT,
        schemaId: 'ab'.repeat(32),
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
        [{ fieldSalt: undefined }, /fieldSalt .*is required/],
        [{ fieldSalt: 'zz' }, /fieldSalt/],
        [{ threshold: undefined }, /threshold is required/],
        [{ threshold: 'abc' }, /threshold must be an integer/],
        [{ predicate: 'between' }, /lessOrEqual.*greaterOrEqual/],
        [{ siblingsJson: 'not-json' }, /siblingsJson must be a JSON array/],
        [{ dirsJson: 'not-json' }, /dirsJson must be a JSON array/],
        [{ siblingsJson: JSON.stringify(SIBLINGS.slice(0, 2)) }, /array of 4 hashes/],
        [{ dirsJson: JSON.stringify([true]) }, /array of 4 booleans/],
        [{ siblingsJson: JSON.stringify([...SIBLINGS.slice(0, 3), 'short']) }, /each sibling must be 64 hex/],
        [{ dirsJson: JSON.stringify([true, false, 'false', true]) }, /dirsJson entries must be booleans/],
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
        expect(anchor.args).toHaveLength(3); // payloadHash + contentRoot + schemaId bytes
        expect(anchor.merkleProof).toBeUndefined();

        expect(prove.circuit).toBe('proveFieldPredicate');
        // args: payloadHash, fieldKey, threshold, op. NEVER the field value.
        expect(prove.args).toHaveLength(4);
        expect(prove.args[2]).toBe(50000n);
        expect(prove.args[3]).toBe(0n);
        // The value + inclusion path travel as witnesses only.
        expect(prove.merkleProof).toEqual({
            fieldValue: '47300',
            fieldSalt: 'f5'.repeat(32),
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

// ---- issueFieldPredicateAttestationBatch (N proofs, ONE transaction) -------

describe('issueFieldPredicateAttestationBatch', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_ROOT = 'd'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const makeClaim = (n: number, patch: any = {}) => ({
        fieldKey: String(n).repeat(64).slice(0, 64),
        value: `${1000 + n}`,
        salt: 'f5'.repeat(32),
        siblings: SIBLINGS,
        dirs: [true, false, true, false],
        predicate: 'lessOrEqual',
        threshold: `${50000 + n}`,
        unit: 'kgCO2e/kWh',
        ...patch
    });
    const VALID_ARGS = (patch: any = {}) => ({
        payloadHash: VALID_PAYLOAD,
        contentRoot: VALID_ROOT,
        schemaId: 'ab'.repeat(32),
        claimsJson: JSON.stringify([makeClaim(1), makeClaim(2)]),
        sessionId: `fieldpredbatch-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault',
        ...patch
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
        [{ contentRoot: 'oops' }, /contentRoot must be 64 hex/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/],
        [{ claimsJson: undefined }, /claimsJson is required/],
        [{ claimsJson: 'not-json' }, /claimsJson must be valid JSON/],
        [{ claimsJson: '[]' }, /non-empty JSON array/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { fieldKey: 'zz' })]) }, /claims\[0\].fieldKey must be 64 hex/],
        [{ claimsJson: JSON.stringify([makeClaim(1), makeClaim(2, { value: '' })]) }, /claims\[1\].value is required/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { value: '47.3' })]) }, /claims\[0\].value must be an integer/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { value: '-5' })]) }, /claims\[0\].value must be a non-negative integer/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { threshold: 'abc' })]) }, /claims\[0\].threshold must be an integer/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { predicate: 'between' })]) }, /claims\[0\].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { siblings: SIBLINGS.slice(0, 2) })]) }, /claims\[0\].siblings must be a JSON array of 4 hashes/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { siblings: [...SIBLINGS.slice(0, 3), 'short'] })]) }, /claims\[0\].siblings entries must be 64 hex/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { dirs: [true] })]) }, /claims\[0\].dirs must be a JSON array of 4 booleans/],
        [{ claimsJson: JSON.stringify([makeClaim(1, { dirs: [true, false, 'false', true] })]) }, /claims\[0\].dirs entries must be booleans/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(patch));
        await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('caps at 8 claims without anchor and 7 with an in-batch contentRoot anchor', async () => {
        const { srv } = setupHandlersWithDb();
        const nine = JSON.stringify(Array.from({ length: 9 }, (_, i) => makeClaim(i + 1)));
        const eight = JSON.stringify(Array.from({ length: 8 }, (_, i) => makeClaim(i + 1)));

        const reqNine = makeReq(VALID_ARGS({ contentRoot: undefined, claimsJson: nine }));
        await srv.handlers['issueFieldPredicateAttestationBatch'](reqNine);
        expect(reqNine.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 8 entries/));

        const reqEightWithAnchor = makeReq(VALID_ARGS({ claimsJson: eight }));
        await srv.handlers['issueFieldPredicateAttestationBatch'](reqEightWithAnchor);
        expect(reqEightWithAnchor.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 7 entries.*anchor/));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['issueFieldPredicateAttestationBatch'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        } finally {
            if (prev === undefined) delete process.env.NIGHTGATE_NETWORK;
            else process.env.NIGHTGATE_NETWORK = prev;
        }
    });

    test('happy path: ONE callBatch with in-batch anchor first, per-call merkleProof on every proof, N row updates', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueFieldPredicateAttestationBatch-test',
            status: 'pending',
            claims: expect.any(String),
            droppedDuplicates: 0
        });
        const claims = JSON.parse(result.claims);
        expect(claims).toHaveLength(2);
        for (const c of claims) {
            expect(c).toEqual({
                predicateAttestationId: expect.any(String),
                fieldKey: expect.stringMatching(/^[0-9a-f]{64}$/),
                predicate: 'lessOrEqual',
                threshold: expect.any(String),
                unit: 'kgCO2e/kWh'
            });
        }

        // Exactly ONE batch submission, never N single calls.
        expect(submitter.callBatch).toHaveBeenCalledTimes(1);
        expect((submitter as any).call).not.toHaveBeenCalled();
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls).toHaveLength(3);

        // Anchor first (distinct entryPoint; segment ordering pins it ahead),
        // no witness proof on it.
        expect(batchArgs.calls[0].circuit).toBe('anchorContentRoot');
        expect(batchArgs.calls[0].args).toHaveLength(3);
        expect(batchArgs.calls[0].merkleProof).toBeUndefined();

        // Every proof call carries ITS OWN merkleProof; the value travels as
        // witness only, never as a circuit arg.
        for (const [i, call] of [batchArgs.calls[1], batchArgs.calls[2]].entries()) {
            expect(call.circuit).toBe('proveFieldPredicate');
            expect(call.args).toHaveLength(4);
            expect(call.args[2]).toBe(BigInt(50000 + i + 1));
            expect(call.args[3]).toBe(0n);
            expect(call.merkleProof).toEqual({
                fieldValue: `${1000 + i + 1}`,
                fieldSalt: 'f5'.repeat(32),
                siblings: SIBLINGS,
                dirs: [true, false, true, false]
            });
            const flatArgs = JSON.stringify(call.args, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
            expect(flatArgs).not.toContain(`${1000 + i + 1}`);
        }

        // 1 up-front INSERT (both rows) + ONE bulk provenTxHash UPDATE (atomic
        // projection: partial proven-marking must be impossible).
        expect(db.run).toHaveBeenCalledTimes(2);
        const inserted = (db.run as Mock).mock.calls[0][0];
        expect(JSON.stringify(inserted)).toContain(VALID_PAYLOAD);
        const update = JSON.stringify((db.run as Mock).mock.calls[1][0]);
        for (const c of claims) expect(update).toContain(c.predicateAttestationId);
    });

    test('without contentRoot the batch contains only the proof calls', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS({ contentRoot: undefined }));

        await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual(['proveFieldPredicate', 'proveFieldPredicate']);
    });

    test('drops exact duplicate claim tuples and reports the count (idempotent on-chain inserts)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const dupe = makeClaim(1);
        const req = makeReq(VALID_ARGS({ claimsJson: JSON.stringify([dupe, makeClaim(2), { ...dupe }]) }));

        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(1);
        expect(JSON.parse(result.claims)).toHaveLength(2);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        // anchor + 2 unique proofs; the duplicate proved nothing extra.
        expect(batchArgs.calls).toHaveLength(3);
        const insertedEntries = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(insertedEntries.match(new RegExp(dupe.fieldKey, 'g'))).toHaveLength(1);
    });

    test('counts N claims against the predicate rate limiter, not one action call', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `fieldpredbatch-rate-${Math.random().toString(36).slice(2)}`;
        const eight = JSON.stringify(Array.from({ length: 8 }, (_, i) => makeClaim(i + 1)));

        const first = makeReq(VALID_ARGS({ contentRoot: undefined, claimsJson: eight, sessionId }));
        await srv.handlers['issueFieldPredicateAttestationBatch'](first);
        expect(first.reject).not.toHaveBeenCalled();

        // 8 of the 10/hour budget consumed; a 3-claim follow-up must trip 429.
        const second = makeReq(VALID_ARGS({ contentRoot: undefined, claimsJson: JSON.stringify([makeClaim(11), makeClaim(12), makeClaim(13)]), sessionId }));
        await srv.handlers['issueFieldPredicateAttestationBatch'](second);
        expect(second.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));

        // All-or-nothing: the rejected batch consumed NOTHING, so the 2
        // remaining slots are still available.
        const third = makeReq(VALID_ARGS({ contentRoot: undefined, claimsJson: JSON.stringify([makeClaim(14), makeClaim(15)]), sessionId }));
        await srv.handlers['issueFieldPredicateAttestationBatch'](third);
        expect(third.reject).not.toHaveBeenCalled();
    });
});

// ---- issueFieldEqualityAttestation (bytes equality, 0.15.0) ----------------

describe('issueFieldEqualityAttestation', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_FIELD_KEY = 'f'.repeat(64);
    const VALID_ROOT = 'd'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const EXPECTED = 'c'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        fieldKey: VALID_FIELD_KEY,
        expectedDigest: EXPECTED,
        fieldSalt: 'f5'.repeat(32),
        contentRoot: VALID_ROOT,
        schemaId: 'ab'.repeat(32),
        siblingsJson: JSON.stringify(SIBLINGS),
        dirsJson: JSON.stringify([true, false, true, false]),
        sessionId: `fieldeq-${Math.random().toString(36).slice(2)}`,
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
        [{ fieldKey: 'zz' }, /fieldKey must be 64 hex/],
        [{ expectedDigest: undefined }, /exactly one of expectedValue \/ expectedDigest/],
        [{ expectedValue: 'NMC811' }, /exactly one of expectedValue \/ expectedDigest/],
        [{ expectedDigest: 'zz' }, /expectedDigest must be 64 hex/],
        [{ siblingsJson: JSON.stringify(SIBLINGS.slice(0, 2)) }, /array of 4 hashes/],
        [{ dirsJson: JSON.stringify([true, false, 'false', true]) }, /entries must be booleans/],
        [{ contentRoot: 'oops' }, /contentRoot must be 64 hex/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['issueFieldEqualityAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['issueFieldEqualityAttestation'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        } finally {
            if (prev === undefined) delete process.env.NIGHTGATE_NETWORK;
            else process.env.NIGHTGATE_NETWORK = prev;
        }
    });

    test('happy path: anchor + proveFieldEquality with the digest as a PUBLIC arg and a path-only bundle', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueFieldEqualityAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueFieldEqualityAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        expect(db.run).toHaveBeenCalledTimes(2); // INSERT + UPDATE
        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('bytesEquality');
        expect(inserted).toContain(EXPECTED);

        expect(submitter.call).toHaveBeenCalledTimes(2);
        const prove = (submitter.call as Mock).mock.calls[1][0];
        expect(prove.circuit).toBe('proveFieldEquality');
        // args: payloadHash, fieldKey, expectedDigest (all public Bytes<32>).
        expect(prove.args).toHaveLength(3);
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(EXPECTED);
        // Salted path bundle: no fieldValue, no fieldDigest, no setProof.
        expect(prove.merkleProof).toEqual({ fieldSalt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false] });
    });

    test('digests a raw expectedValue server-side (exact string, no trimming)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ARGS(), expectedDigest: undefined, expectedValue: ' NMC811 ' });

        await srv.handlers['issueFieldEqualityAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const { blake2b256Hex } = await import('../../srv/submission/document-proof.js');
        const digest = blake2b256Hex(' NMC811 ');
        const prove = (submitter.call as Mock).mock.calls[1][0];
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(digest);
        expect(JSON.stringify((db.run as Mock).mock.calls[0][0])).toContain(digest);
    });
});

// ---- issueFieldMembershipAttestation (set membership, 0.15.0) --------------

describe('issueFieldMembershipAttestation', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_FIELD_KEY = 'f'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const SET_SIBLINGS = ['5'.repeat(64), '6'.repeat(64), '7'.repeat(64), '8'.repeat(64), '9'.repeat(64), 'a'.repeat(64)];
    const SET_ROOT = 'e'.repeat(64);
    const DIGEST = 'c'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHash: VALID_PAYLOAD,
        fieldKey: VALID_FIELD_KEY,
        valueDigest: DIGEST,
        fieldSalt: 'f5'.repeat(32),
        setRoot: SET_ROOT,
        setSiblingsJson: JSON.stringify(SET_SIBLINGS),
        setDirsJson: JSON.stringify([true, false, true, false, true, false]),
        siblingsJson: JSON.stringify(SIBLINGS),
        dirsJson: JSON.stringify([true, false, true, false]),
        sessionId: `fieldmem-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault'
    });

    /** Fake pure circuits for the allowedValuesJson lane (set-root builder). */
    const fakeSetPure = {
        leafHash: vi.fn(), nodeHash: (l: Uint8Array, r: Uint8Array) => {
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i++) out[i] = (l[i] ^ r[i]) ^ 0x5a;
            return out;
        },
        bytesLeafHash: vi.fn(),
        setLeafHash: (d: Uint8Array) => {
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i++) out[i] = d[i] ^ 0xa5;
            return out;
        }
    } as any;

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
            pureCircuitsLoader: vi.fn(async () => fakeSetPure),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHash: 'zz' }, /payloadHash must be 64 hex/],
        [{ fieldKey: undefined }, /fieldKey is required/],
        [{ valueDigest: undefined }, /exactly one of value \/ valueDigest/],
        [{ value: 'EEA' }, /exactly one of value \/ valueDigest/],
        [{ valueDigest: 'zz' }, /valueDigest must be 64 hex/],
        [{ allowedValuesJson: '["EEA"]' }, /not both/],
        [{ setRoot: undefined, setSiblingsJson: undefined, setDirsJson: undefined }, /allowedValuesJson or setRoot \+ setSiblingsJson \+ setDirsJson is required/],
        [{ setRoot: 'zz' }, /setRoot must be 64 hex/],
        [{ setSiblingsJson: JSON.stringify(SET_SIBLINGS.slice(0, 3)) }, /setSiblingsJson must be a JSON array of 6 hashes/],
        [{ setDirsJson: JSON.stringify([true, false, 'false', true, false, true]) }, /setDirsJson entries must be booleans/],
        [{ siblingsJson: JSON.stringify(SIBLINGS.slice(0, 2)) }, /array of 4 hashes/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['issueFieldMembershipAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('happy path (precomputed set lane): proveFieldMembership with digest + both paths as witnesses only', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueFieldMembershipAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueFieldMembershipAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('setMembership');
        expect(inserted).toContain(SET_ROOT);
        // The hidden digest is never persisted in the row.
        expect(inserted).not.toContain(DIGEST);

        expect(submitter.call).toHaveBeenCalledTimes(1); // no contentRoot -> proof only
        const prove = (submitter.call as Mock).mock.calls[0][0];
        expect(prove.circuit).toBe('proveFieldMembership');
        // args: payloadHash, fieldKey, setRoot. NEVER the value digest.
        expect(prove.args).toHaveLength(3);
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(SET_ROOT);
        const flatArgs = JSON.stringify(prove.args, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        expect(flatArgs).not.toContain(DIGEST);
        expect(prove.merkleProof).toEqual({
            fieldDigest: DIGEST,
            fieldSalt: 'f5'.repeat(32),
            siblings: SIBLINGS,
            dirs: [true, false, true, false],
            setProof: { siblings: SET_SIBLINGS, dirs: [true, false, true, false, true, false] }
        });
    });

    test('allowedValuesJson lane: builds the canonical set, rejects non-members BEFORE any job', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const { blake2b256Hex } = await import('../../srv/submission/document-proof.js');
        const { buildMembershipSet, membershipPathFor } = await import('../../srv/submission/set-root.js');

        const list = ['EEA', 'CH', 'NO'];
        const expected = membershipPathFor(list, blake2b256Hex('CH'), fakeSetPure)!;

        const ok = makeReq({
            ...VALID_ARGS(), valueDigest: undefined, value: 'CH',
            setRoot: undefined, setSiblingsJson: undefined, setDirsJson: undefined,
            allowedValuesJson: JSON.stringify(list)
        });
        await srv.handlers['issueFieldMembershipAttestation'](ok);
        expect(ok.reject).not.toHaveBeenCalled();
        const prove = (submitter.call as Mock).mock.calls[0][0];
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(buildMembershipSet(list, fakeSetPure).setRoot);
        expect(prove.merkleProof.setProof).toEqual({ siblings: expected.setSiblings, dirs: expected.setDirs });

        (db.run as Mock).mockClear();
        const notInList = makeReq({
            ...VALID_ARGS(), valueDigest: undefined, value: 'DE',
            setRoot: undefined, setSiblingsJson: undefined, setDirsJson: undefined,
            allowedValuesJson: JSON.stringify(list)
        });
        await srv.handlers['issueFieldMembershipAttestation'](notInList);
        expect(notInList.reject).toHaveBeenCalledWith(400, expect.stringMatching(/not in the allowed list/));
        expect(db.run).not.toHaveBeenCalled(); // no row, no job, no budget spent
    });
});

// ---- Mixed batch (numeric + equality + membership in ONE tx, 0.15.0) -------

describe('issueFieldPredicateAttestationBatch: mixed claim kinds', () => {
    const VALID_PAYLOAD = 'a'.repeat(64);
    const VALID_ROOT = 'd'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const SET_SIBLINGS = ['5'.repeat(64), '6'.repeat(64), '7'.repeat(64), '8'.repeat(64), '9'.repeat(64), 'a'.repeat(64)];
    const SET_ROOT = 'e'.repeat(64);
    const DIGEST = 'c'.repeat(64);
    const EXPECTED = 'b'.repeat(64);

    const numericClaim = {
        fieldKey: '1'.repeat(64), value: '1001', salt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false],
        predicate: 'lessOrEqual', threshold: '50001', unit: 'kg'
    };
    const equalityClaim = {
        fieldKey: '2'.repeat(64), expectedDigest: EXPECTED, salt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false],
        predicate: 'bytesEquality'
    };
    const membershipClaim = {
        fieldKey: '3'.repeat(64), valueDigest: DIGEST, salt: 'f5'.repeat(32),
        setRoot: SET_ROOT, setSiblings: SET_SIBLINGS, setDirs: [true, false, true, false, true, false],
        siblings: SIBLINGS, dirs: [true, false, true, false],
        predicate: 'setMembership'
    };

    const VALID_ARGS = (patch: any = {}) => ({
        payloadHash: VALID_PAYLOAD,
        contentRoot: VALID_ROOT,
        schemaId: 'ab'.repeat(32),
        claimsJson: JSON.stringify([numericClaim, equalityClaim, membershipClaim]),
        sessionId: `mixedbatch-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        compiledArtifactRef: 'attestation-vault',
        ...patch
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
        [{ claimsJson: JSON.stringify([{ ...equalityClaim, expectedDigest: undefined }]) }, /claims\[0\]: pass exactly one of expectedValue \/ expectedDigest/],
        [{ claimsJson: JSON.stringify([{ ...membershipClaim, valueDigest: undefined }]) }, /claims\[0\]: pass exactly one of value \/ valueDigest/],
        [{ claimsJson: JSON.stringify([{ ...membershipClaim, setRoot: undefined }]) }, /claims\[0\]: allowedValues or setRoot \+ setSiblings \+ setDirs is required/],
        [{ claimsJson: JSON.stringify([{ ...membershipClaim, allowedValues: ['x'] }]) }, /claims\[0\]: pass either allowedValues or setRoot/],
        [{ claimsJson: JSON.stringify([{ ...membershipClaim, setSiblings: SET_SIBLINGS.slice(0, 3) }]) }, /claims\[0\].setSiblings must be a JSON array of 6 hashes/],
        [{ claimsJson: JSON.stringify([{ ...numericClaim, predicate: 'between' }]) }, /claims\[0\].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(patch));
        await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('one callBatch carries anchor + all three claim kinds with per-kind args and bundles', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(0);
        const claims = JSON.parse(result.claims);
        expect(claims.map((c: any) => c.predicate)).toEqual(['lessOrEqual', 'bytesEquality', 'setMembership']);
        expect(claims[1].expectedDigest).toBe(EXPECTED);
        expect(claims[2].setRoot).toBe(SET_ROOT);

        expect(submitter.callBatch).toHaveBeenCalledTimes(1);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual([
            'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership'
        ]);

        const [, numeric, equality, membership] = batchArgs.calls;
        expect(numeric.args).toHaveLength(4);
        expect(numeric.merkleProof.fieldValue).toBe('1001');
        expect(equality.args).toHaveLength(3);
        expect(Buffer.from(equality.args[2]).toString('hex')).toBe(EXPECTED);
        expect(equality.merkleProof).toEqual({ fieldSalt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false] });
        expect(membership.args).toHaveLength(3);
        expect(Buffer.from(membership.args[2]).toString('hex')).toBe(SET_ROOT);
        expect(membership.merkleProof).toEqual({
            fieldDigest: DIGEST, fieldSalt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false],
            setProof: { siblings: SET_SIBLINGS, dirs: [true, false, true, false, true, false] }
        });
        // The membership digest never appears as a circuit arg anywhere.
        const allArgs = JSON.stringify(batchArgs.calls.map((c: any) => c.args), (_k, v) => typeof v === 'bigint' ? v.toString() : v);
        expect(allArgs).not.toContain(DIGEST);

        // 1 bulk INSERT + 1 bulk UPDATE, rows carry per-kind statement columns.
        expect(db.run).toHaveBeenCalledTimes(2);
        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('bytesEquality');
        expect(inserted).toContain('setMembership');
        expect(inserted).toContain(EXPECTED);
        expect(inserted).toContain(SET_ROOT);
        expect(inserted).not.toContain(DIGEST);
    });

    test('per-kind dedup tuples: equality dupes by expectedDigest, membership dupes by setRoot', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS({
            claimsJson: JSON.stringify([
                equalityClaim, { ...equalityClaim }, // exact dupe -> dropped
                membershipClaim, { ...membershipClaim, valueDigest: 'd'.repeat(64) } // same (fieldKey, setRoot) -> dropped
            ])
        }));

        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(2);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual([
            'anchorContentRoot', 'proveFieldEquality', 'proveFieldMembership'
        ]);
    });
});

// ---- cross-root document proofs (0.16.0) -----------------------------------

// Shared v4 cross-root fixtures: one schema, two openings.
const DOC_SCHEMA = [
    { fieldKey: 'c1'.repeat(32), kind: 0, scale: '1000' },
    { fieldKey: 'c2'.repeat(32), kind: 1, scale: '0' },
    ...Array.from({ length: 14 }, () => ({ fieldKey: 'ee'.repeat(32), kind: 2, scale: '0' }))
];
const DOC_OPENING_A = {
    saltSeed: '11'.repeat(32),
    slots: [
        { present: true, value: '47300' },
        { present: true, valueDigest: 'cd'.repeat(32) },
        ...Array.from({ length: 14 }, () => ({ present: false }))
    ]
};
const DOC_OPENING_B = {
    saltSeed: '22'.repeat(32),
    slots: [
        { present: true, value: '99000' },
        { present: false },
        ...Array.from({ length: 14 }, () => ({ present: false }))
    ]
};

describe('issueDocumentIntegrityAttestation', () => {
    const PAYLOAD_A = 'a'.repeat(64);
    const PAYLOAD_B = 'b'.repeat(64);
    const ROOT_A = 'd'.repeat(64);
    const ROOT_B = 'e'.repeat(64);
    const SCHEMA_ID = 'ab'.repeat(32);
    const VALID_ARGS = () => ({
        payloadHashA: PAYLOAD_A,
        payloadHashB: PAYLOAD_B,
        allowedMask: 5,
        schemaJson: JSON.stringify(DOC_SCHEMA),
        openingAJson: JSON.stringify(DOC_OPENING_A),
        openingBJson: JSON.stringify(DOC_OPENING_B),
        contentRootA: ROOT_A,
        contentRootB: ROOT_B,
        schemaId: SCHEMA_ID,
        sessionId: `docinteg-${Math.random().toString(36).slice(2)}`,
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
        [{ payloadHashA: undefined }, /payloadHashA is required/],
        [{ payloadHashA: 'zz' }, /payloadHashA must be 64 hex/],
        [{ payloadHashB: undefined }, /payloadHashB is required/],
        [{ payloadHashB: PAYLOAD_A.toUpperCase() }, /must differ/],
        [{ allowedMask: undefined }, /allowedMask is required/],
        [{ allowedMask: -1 }, /0\.\.65535/],
        [{ allowedMask: 65536 }, /0\.\.65535/],
        [{ allowedMask: 1.5 }, /0\.\.65535/],
        [{ allowedMask: 0xffff }, /vacuous/],
        // DOC_SCHEMA has exactly 2 real slots (0, 1); mask 3 frees both.
        [{ allowedMask: 3 }, /frees every real \(non-padding\) schema slot/],
        [{ schemaJson: JSON.stringify(DOC_SCHEMA.slice(0, 15)) }, /exactly 16 slot descriptors/],
        [{ schemaJson: JSON.stringify([{ ...DOC_SCHEMA[0], kind: 9 }, ...DOC_SCHEMA.slice(1)]) }, /kind must be 0/],
        [{ openingAJson: JSON.stringify({ ...DOC_OPENING_A, saltSeed: 'zz' }) }, /saltSeed must be 64 hex/],
        [{ openingBJson: JSON.stringify({ ...DOC_OPENING_B, slots: [{ present: true }, ...DOC_OPENING_B.slots.slice(1)] }) }, /present slot needs value or valueDigest/],
        [{ schemaJson: 'not json' }, /must be valid JSON/],
        [{ contentRootA: 'oops' }, /contentRootA must be 64 hex/],
        [{ contentRootB: 'oops' }, /contentRootB must be 64 hex/],
        [{ schemaId: undefined }, /schemaId .* is required when anchoring/],
        [{ schemaId: 'oops' }, /schemaId/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['issueDocumentIntegrityAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['issueDocumentIntegrityAttestation'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        } finally {
            if (prev === undefined) delete process.env.NIGHTGATE_NETWORK;
            else process.env.NIGHTGATE_NETWORK = prev;
        }
    });

    test('happy path: both anchors then proveDocumentComparison (integrity mode) with mask vector + docPair openings', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueDocumentIntegrityAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueDocumentIntegrityAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('documentIntegrity');
        expect(inserted).toContain(PAYLOAD_B);

        // anchor A, anchor B, then the proof.
        expect(submitter.call).toHaveBeenCalledTimes(3);
        const anchorA = (submitter.call as Mock).mock.calls[0][0];
        expect(anchorA.circuit).toBe('anchorContentRoot');
        expect(Buffer.from(anchorA.args[0]).toString('hex')).toBe(PAYLOAD_A);
        expect(Buffer.from(anchorA.args[1]).toString('hex')).toBe(ROOT_A);
        expect(Buffer.from(anchorA.args[2]).toString('hex')).toBe(SCHEMA_ID);
        const anchorB = (submitter.call as Mock).mock.calls[1][0];
        expect(Buffer.from(anchorB.args[0]).toString('hex')).toBe(PAYLOAD_B);
        expect(Buffer.from(anchorB.args[1]).toString('hex')).toBe(ROOT_B);
        expect(Buffer.from(anchorB.args[2]).toString('hex')).toBe(SCHEMA_ID);

        const prove = (submitter.call as Mock).mock.calls[2][0];
        expect(prove.circuit).toBe('proveDocumentComparison');
        // (a, b, mode=0, allowed_mask, k-dummy)
        expect(prove.args).toHaveLength(5);
        expect(Buffer.from(prove.args[0]).toString('hex')).toBe(PAYLOAD_A);
        expect(Buffer.from(prove.args[1]).toString('hex')).toBe(PAYLOAD_B);
        expect(prove.args[2]).toBe(0n);
        // Mask 5 = slots 0 and 2 allowed, expanded to the Vector<16, Boolean> arg.
        const mask = prove.args[3] as boolean[];
        expect(mask).toHaveLength(16);
        expect(mask[0]).toBe(true);
        expect(mask[1]).toBe(false);
        expect(mask[2]).toBe(true);
        expect(mask.filter(Boolean)).toHaveLength(2);
        expect(prove.args[4]).toBe(1n);
        // docPair bundle: shared schema + both openings; no inclusion path.
        expect(prove.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });
    });

    test('without content roots the proof is the only call', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ARGS(), contentRootA: undefined, contentRootB: undefined });
        await srv.handlers['issueDocumentIntegrityAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(submitter.call).toHaveBeenCalledTimes(1);
        expect((submitter.call as Mock).mock.calls[0][0].circuit).toBe('proveDocumentComparison');
    });
});

describe('issueDocumentDiffAttestation', () => {
    const PAYLOAD_A = 'a'.repeat(64);
    const PAYLOAD_B = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHashA: PAYLOAD_A,
        payloadHashB: PAYLOAD_B,
        k: 2,
        schemaJson: JSON.stringify(DOC_SCHEMA),
        openingAJson: JSON.stringify(DOC_OPENING_A),
        openingBJson: JSON.stringify(DOC_OPENING_B),
        sessionId: `docdiff-${Math.random().toString(36).slice(2)}`,
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
        [{ payloadHashA: undefined }, /payloadHashA is required/],
        [{ payloadHashB: PAYLOAD_A }, /must differ/],
        [{ k: undefined }, /k is required/],
        [{ k: 0 }, /1\.\.16/],
        [{ k: 17 }, /1\.\.16/],
        [{ k: 1.5 }, /1\.\.16/],
        [{ schemaJson: JSON.stringify(DOC_SCHEMA.slice(0, 15)) }, /schemaJson must be a JSON array of exactly 16 slot descriptors/],
        [{ schemaJson: JSON.stringify([{ fieldKey: 'zz', kind: 0, scale: '1' }, ...DOC_SCHEMA.slice(1)]) }, /fieldKey must be 64 hex/],
        [{ openingAJson: JSON.stringify({ ...DOC_OPENING_A, slots: DOC_OPENING_A.slots.slice(0, 15) }) }, /openingAJson.slots must be a JSON array of exactly 16/],
        [{ openingBJson: 'not json' }, /must be valid JSON/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['issueDocumentDiffAttestation'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('happy path: proveDocumentComparison (diff mode) with k as BigInt and docPair openings; k lands in the threshold column', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['issueDocumentDiffAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-issueDocumentDiffAttestation-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('documentDiff');
        expect(inserted).toContain(PAYLOAD_B);

        expect(submitter.call).toHaveBeenCalledTimes(1);
        const prove = (submitter.call as Mock).mock.calls[0][0];
        expect(prove.circuit).toBe('proveDocumentComparison');
        // (a, b, mode=1, mask-dummy, k)
        expect(prove.args).toHaveLength(5);
        expect(Buffer.from(prove.args[0]).toString('hex')).toBe(PAYLOAD_A);
        expect(Buffer.from(prove.args[1]).toString('hex')).toBe(PAYLOAD_B);
        expect(prove.args[2]).toBe(1n);
        expect((prove.args[3] as boolean[]).filter(Boolean)).toHaveLength(0);
        expect(prove.args[4]).toBe(2n);
        expect(prove.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });
    });
});

describe('issueFieldPredicateAttestationBatch: cross-root document claims', () => {
    const PAYLOAD_A = 'a'.repeat(64);
    const PAYLOAD_B = 'b'.repeat(64);
    const FIELD_KEY = 'f'.repeat(64);
    const SIBLINGS = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    const integrityClaim = { predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B, allowedMask: 1, schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B };
    const diffClaim = { predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 1, schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B };
    const numericClaim = {
        fieldKey: FIELD_KEY, value: '1001', salt: 'f5'.repeat(32), siblings: SIBLINGS,
        dirs: [true, false, true, false], predicate: 'greaterOrEqual', threshold: '1000'
    };
    const VALID_ARGS = (claims: unknown[]) => ({
        payloadHash: PAYLOAD_A,
        claimsJson: JSON.stringify(claims),
        sessionId: `docbatch-${Math.random().toString(36).slice(2)}`,
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
        [[{ ...integrityClaim, payloadHashB: undefined }], /payloadHashB must be 64 hex/],
        [[{ ...integrityClaim, payloadHashB: PAYLOAD_A }], /must differ from the batch payloadHash/],
        [[{ ...integrityClaim, allowedMask: 65536 }], /allowedMask must be an integer in 0\.\.65535/],
        [[{ ...integrityClaim, schema: DOC_SCHEMA.slice(0, 15) }], /schema must be a JSON array of exactly 16 slot descriptors/],
        [[{ ...diffClaim, k: 0 }], /k must be an integer in 1\.\.16/],
        [[{ ...diffClaim, openingB: { ...DOC_OPENING_B, slots: DOC_OPENING_B.slots.slice(0, 15) } }], /openingB.slots must be a JSON array of exactly 16/],
        [[{ ...diffClaim, openingA: { ...DOC_OPENING_A, saltSeed: 'zz' } }], /saltSeed must be 64 hex/]
    ])('rejects %o', async (claims, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(claims as unknown[]));
        await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('mixed batch: numeric + integrity + diff assemble one callBatch in claim order', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS([numericClaim, integrityClaim, diffClaim]));

        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(0);
        const claims = JSON.parse(result.claims);
        expect(claims).toHaveLength(3);
        expect(claims[1]).toMatchObject({ predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B, allowedMask: 1 });
        expect(claims[2]).toMatchObject({ predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 1 });

        expect(submitter.callBatch).toHaveBeenCalledTimes(1);
        const batch = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batch.calls.map((c: any) => c.circuit)).toEqual([
            'proveFieldPredicate', 'proveDocumentComparison', 'proveDocumentComparison'
        ]);
        const integ = batch.calls[1];
        expect(Buffer.from(integ.args[0]).toString('hex')).toBe(PAYLOAD_A);
        expect(Buffer.from(integ.args[1]).toString('hex')).toBe(PAYLOAD_B);
        expect(integ.args[2]).toBe(0n);
        const mask = integ.args[3] as boolean[];
        // mask 1 = slot 0 only (mask 3 would free BOTH real slots of the
        // 2-real-field DOC_SCHEMA and is rejected as vacuous since 0.16.0).
        expect(mask.filter(Boolean)).toHaveLength(1);
        expect(mask[0]).toBe(true);
        expect(integ.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });
        const diff = batch.calls[2];
        expect(diff.args[2]).toBe(1n);
        expect(diff.args[4]).toBe(1n);
        expect(diff.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });

        // Rows: documentDiff stores k in threshold; both carry payloadHashB.
        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('documentIntegrity');
        expect(inserted).toContain('documentDiff');
        expect(inserted).toContain(PAYLOAD_B);
    });

    test('dedup: duplicate integrity tuples (payloadHashB + mask) collapse; different k survives', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS([
            integrityClaim, { ...integrityClaim }, diffClaim, { ...diffClaim, k: 2 }
        ]));
        const result: any = await srv.handlers['issueFieldPredicateAttestationBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(1);
        const batch = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batch.calls.map((c: any) => c.circuit)).toEqual([
            'proveDocumentComparison', 'proveDocumentComparison', 'proveDocumentComparison'
        ]);
        expect(batch.calls.map((c: any) => c.args[2])).toEqual([0n, 1n, 1n]);
    });
});

// ---- artifact-generation provenance gates (0.16.0) --------------------------

describe('artifact-generation provenance', () => {
    const procKey = (kind: string, v: number) => kind + String.fromCharCode(0) + v;

    it('workflow children INHERIT the parent artifactDigest (no re-stamp at child time)', async () => {
        childCommandLog.length = 0;
        const submitter = makeSuccessfulSubmitter();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(makeFakeService() as any, db as any, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: {}
            })),
            submitterFactory: vi.fn(() => submitter)
        });
        const parentDigest = getArtifactGenerationDigest('attestation-vault');
        const processor = registeredProcessors.get(procKey('issueFieldPredicateAttestation', 1));
        expect(processor).toBeTruthy();
        await processor!({
            op: 'fieldPredicateWorkflow', predicateAttestationId: 'pa-prov-1',
            payloadHash: 'aa'.repeat(32), fieldKey: 'bb'.repeat(32),
            contractAddress: '0xV', compiledArtifactRef: 'attestation-vault',
            predicate: 'lessOrEqual', threshold: '42', opCode: 0,
            value: '41', salt: 'cc'.repeat(32),
            siblings: ['dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32)],
            dirs: [true, false, true, false],
            contentRoot: 'ee'.repeat(32), schemaId: 'ff'.repeat(32),
            artifactDigest: parentDigest
        }, {
            ID: 'job-prov-parent', kind: 'issueFieldPredicateAttestation',
            sessionId: 'sess-prov', requestedBy: 'test-user', commandVersion: 1
        } as any);
        // anchorContentRoot child + proveFieldPredicate child, both carrying
        // the PARENT's digest as passed by the handler (not re-stamped).
        expect(childCommandLog.length).toBe(2);
        for (const entry of childCommandLog) {
            expect(entry.command.artifactDigest).toBe(parentDigest);
        }
    });

    it('reconciliation finalizer fails closed on a missing or mismatched digest', async () => {
        const finalize = registeredFinalizers.get(procKey('anchorDocument', 1));
        expect(finalize).toBeTruthy();
        const evidence: any = { txHash: '0xtx', finalizedAt: '2026-08-16T00:00:00Z' };
        const base = {
            op: 'anchorDocument', documentId: 'doc-prov-1', payloadHash: 'aa'.repeat(32),
            metadataHash: 'bb'.repeat(32), contractAddress: '0xV', compiledArtifactRef: 'attestation-vault'
        };
        await expect(finalize!(base, { ID: 'job-prov-r1' } as any, evidence))
            .rejects.toThrow(/no artifact-generation digest/);
        await expect(finalize!({ ...base, artifactDigest: 'ff'.repeat(32) }, { ID: 'job-prov-r2' } as any, evidence))
            .rejects.toThrow(/different generation/);
    });
});
