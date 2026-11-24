/**
 * Tests for srv/submission/handlers.ts (OData action handlers).
 *
 * Drives `registerSubmissionHandlers` against a stub service that just
 * captures handler registrations, then invokes them directly with synthetic
 * Request objects. This exercises the full plumbing, argument validation,
 * rate limiting, error translation, without standing up a full CAP runtime.
 *
 * The submitter dispatches deploy/call via the wallet worker. These tests use
 * a fake `TransactionSubmitter` via the `submitterFactory` seam; handlers
 * don't know about the worker at all.
 */

import { PLATFORM_POOL_SENTINEL } from '../../srv/submission/sponsor-pool';
import { resolveContractPackage } from '@odatano/contract-kit/node';
import type { Mock } from 'vitest';
// Handlers wrap the submitter call in startJob and return `{ jobId, status }`
// instead of awaiting the SDK round-trip. The stub here invokes `work`
// synchronously so the assertions about `submitter.deploy` /
// `submitter.call` argument shape hold.
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
                && typeof command.contractName === 'string'
                && command.artifactDigest === undefined) {
                command = { ...command, artifactDigest: getArtifactGenerationDigest(command.contractName) };
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
const recordLearnedSpy = vi.hoisted(() => vi.fn(async () => []));
const recordMintedSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../srv/submission/learned-token-types', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    recordLearnedTokenTypes: (...args: unknown[]) => (recordLearnedSpy as any)(...args)
}));
vi.mock('../../srv/sessions/agent-grants', async (importOriginal) => ({
    ...(await importOriginal<any>()),
    recordMintedTokenTypes: (...args: unknown[]) => (recordMintedSpy as any)(...args)
}));
const childCommandLog = vi.hoisted(() => [] as Array<{ kind: string; step: string; command: any }>);
const registeredFinalizers = vi.hoisted(() => new Map<string, (command: unknown, row: any, evidence: any) => Promise<unknown>>());
vi.mock('../../srv/submission/background-jobs', async (importOriginal) => ({
    // The real error classes: runSubmission narrows on `instanceof`.
    JobAdmissionBusyError: (await importOriginal<typeof import('../../srv/submission/background-jobs')>()).JobAdmissionBusyError,
    IdempotencyConflictError: (await importOriginal<typeof import('../../srv/submission/background-jobs')>()).IdempotencyConflictError,
    IdempotencyKeyInvalidError: (await importOriginal<typeof import('../../srv/submission/background-jobs')>()).IdempotencyKeyInvalidError,
    WorkflowReconciliationRequiredError: (await importOriginal<typeof import('../../srv/submission/background-jobs')>()).WorkflowReconciliationRequiredError,
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
            && typeof command.contractName === 'string'
            && command.artifactDigest === undefined) {
            command = { ...command, artifactDigest: getArtifactGenerationDigest(command.contractName) };
        }
        return processor(command, {
            ID: `child-${args.step}`, kind: args.kind, sessionId: args.parent.sessionId,
            requestedBy: args.parent.requestedBy, commandVersion: args.commandVersion,
            command: JSON.stringify(command), parentJobId: args.parent.ID, workflowStep: args.step
        });
    },
    registerBackgroundJobProcessor: (kind: string, version: number, _traits: unknown, processor: (command: unknown, row: any) => Promise<unknown>) => registeredProcessors.set(`${kind}\0${version}`, processor),
    registerBackgroundJobReconciliationFinalizer: (kind: string, version: number, finalizer: (command: unknown, row: any, evidence: any) => Promise<unknown>) => registeredFinalizers.set(`${kind}\0${version}`, finalizer)
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import { __resetRateLimitersForTests } from '../../srv/utils/rate-classes';
import { computeRecordKey } from '../../srv/submission/predicate-state';
import { JobAdmissionBusyError } from '../../srv/submission/background-jobs';
import { currentCommand } from '../../srv/submission/job-registry';
import {
    SubmissionError,
    type TransactionSubmitter
} from '../../srv/submission/TransactionSubmitter';
import { ContractNotRegisteredError, registerContract, unregisterContract, getArtifactGenerationDigest } from '../../srv/submission/contract-registry';

// Provenance stamping: startJob resolves the command's
// contractName through the REGISTRY to stamp the artifact-generation
// digest, so the aliases the fixtures use must be registered (the resolver
// itself stays the injected fake). The fixture artifact is any real file;
// the digest only reads bytes.
beforeAll(() => {
    const fixtureArtifact = path.resolve(__dirname, '../fixtures/fake-vault-artifact.mjs');
    for (const name of ['attestation-vault', 'a', 'x', 'token-factory']) {
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
    unregisterContract('token-factory');
});
import {
    SessionNotFoundError,
    WalletMaterialUnavailable
} from '../../srv/submission/wallet-material-factory';
import {
    loadCircuitArgTypes,
    __clearArgTypeCacheForTests,
    type CircuitArgType
} from '../../srv/submission/arg-coercion';
import path from 'path';
import { HEX64_RE } from '../../srv/utils/hex-patterns';
import { runFinalizer } from '../fixtures/run-finalizer';
import { pinEnv } from '../fixtures/pin-env';

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
    contractName: 'attestation-vault',
    sessionId: 'session-abc',
    initialPrivateState: { counter: 0 }
};

const VALID_CALL_ARGS = {
    contractAddress: '0xCONTRACT',
    circuit: 'increment',
    contractName: 'attestation-vault',
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

// The attester id every test session signs as (the resolver is injected).
const ATTESTER_ID = '9e'.repeat(32);

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
        registerSubmissionHandlers(srv as any, {} as any);
        const req = makeReq(data);
        return srv.handlers['deployContract'](req).then(() => req);
    }

    test('rejects missing contractName', async () => {
        const req = await setupAndCallDeploy({ sessionId: 's', initialPrivateState: {} });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractName/));
    });

    test('rejects missing sessionId', async () => {
        const req = await setupAndCallDeploy({ contractName: 'a', initialPrivateState: {} });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId/));
    });

    test('rejects an initialPrivateState that is not an object', async () => {
        const req = await setupAndCallDeploy({ ...VALID_DEPLOY_ARGS, initialPrivateState: [1] });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/JSON object/));
    });

});

describe('submitContractCall: argument validation', () => {
    function setupAndCallSubmit(data: Record<string, unknown>) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any);
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

    test('rejects an initialPrivateState that is not an object (multi-caller seeding)', async () => {
        const req = await setupAndCallSubmit({ ...VALID_CALL_ARGS, initialPrivateState: [1] });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/initialPrivateState must be a JSON object/));
    });
});

describe('submitContractCallBatch: argument validation', () => {
    const VALID_BATCH_ARGS = {
        contractAddress: '0xCONTRACT',
        calls: JSON.stringify([{ circuit: 'attest', args: [] }, { circuit: 'bindPassport', args: [] }]),
        contractName: 'attestation-vault',
        sessionId: 'session-batch-validation'
    };

    function setupAndCallBatch(data: Record<string, unknown>) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any);
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

    test('rejects an initialPrivateState that is not an object', async () => {
        const req = await setupAndCallBatch({ ...VALID_BATCH_ARGS, initialPrivateState: [1] });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/initialPrivateState must be a JSON object/));
    });

    const SIBS4 = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
    test.each([
        [{ merkleProof: 'nope' }, /calls\[0\]\.merkleProof must be an object/],
        [{ merkleProof: { fieldValue: '4.2', siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldValue must be an integer/],
        [{ merkleProof: { fieldValue: '-1', siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldValue must be a non-negative integer/],
        [{ merkleProof: { fieldValue: (2n ** 64n).toString(), siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldValue exceeds Uint<64>/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4.slice(0, 2), dirs: [true, false, true, false] } }, /merkleProof\.siblings must be an array of 4 hashes/],
        [{ merkleProof: { fieldValue: '1', siblings: [...SIBS4.slice(0, 3), 'short'], dirs: [true, false, true, false] } }, /merkleProof\.siblings entries must be 64 hex/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4, dirs: [true] } }, /merkleProof\.dirs must be an array of 4 booleans/],
        [{ merkleProof: { fieldValue: '1', siblings: SIBS4, dirs: [true, false, 'false', true] } }, /merkleProof\.dirs entries must be booleans/],
        [{ merkleProof: { fieldValue: '1', fieldSalt: 'abc', siblings: SIBS4, dirs: [true, false, true, false] } }, /merkleProof\.fieldSalt must be 64 hex/]
    ])('rejects a malformed per-call merkleProof %o', async (patch, msg) => {
        const req = await setupAndCallBatch({
            ...VALID_BATCH_ARGS,
            calls: JSON.stringify([{ circuit: 'proveFieldPredicate', args: [], ...patch }])
        });
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });
});

// ---- Error translation ----------------------------------------------------

describe('mintFactoryToken', () => {
    const FACTORY = 'd96fcca18b3ca748af0c0934d88a47113bb52e586afe334f3d9f5e66e5aea02c';
    const RECIPIENT = '1b'.repeat(32);
    const ISSUER = '2c'.repeat(32);
    const TOKEN = { issuerKey: ISSUER, domain: '3d'.repeat(32), tokenType: '4e'.repeat(32) };

    // The executor re-reads the grant when a job runs: this row is what every db read answers.
    const GRANT_ROW = { ID: 'grant-9', userId: 'test-user', sessionId: 'mint-f1', isActive: true, allowedActions: JSON.stringify(['mintFactoryToken']), allowedCircuits: JSON.stringify(['mint']) };
    function setup(overrides: any = {}) {
        const srv = makeFakeService();
        const tokenFactory = {
            issuerKeyForSession: vi.fn(async () => ISSUER),
            describeToken: vi.fn(async () => ({ ...TOKEN }))
        };
        // The fixture has no contract-info.json: hand the executor the factory's mint signature.
        const mintArgTypes = [
            { name: 'name', kind: 'Bytes', length: 32 },
            { name: 'amount', kind: 'Uint', maxval: 2 ** 64 },
            { name: 'recipient', kind: 'Struct', elements: [{ name: 'bytes', kind: 'Bytes', length: 32 }] }
        ];
        registerSubmissionHandlers(srv as any, { run: vi.fn(async () => ({ ...GRANT_ROW })) } as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            circuitArgTypesLoader: vi.fn((_: string, circuit: string) => (circuit === 'mint' ? mintArgTypes as any : undefined)),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' },
                ensureFacade: vi.fn(async () => undefined)
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            tokenFactory,
            ...overrides
        });
        return { srv, tokenFactory };
    }
    const valid = { contractAddress: FACTORY, name: 'CREDIT', amount: '1000', receiverCoinPublicKey: RECIPIENT, sessionId: 'mint-f1' };

    beforeEach(() => { recordLearnedSpy.mockClear(); recordMintedSpy.mockClear(); });

    test('validates address, name, amount, recipient and session before any wallet or registry work', async () => {
        const { srv, tokenFactory } = setup();
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ ...valid, contractAddress: undefined }, /contractAddress/],
            [{ ...valid, contractAddress: 'zz' }, /64 hex/],
            [{ ...valid, name: '' }, /name/],
            [{ ...valid, name: 'x'.repeat(33) }, /32 bytes/],
            [{ ...valid, amount: '0' }, /positive/],
            [{ ...valid, amount: '1.5' }, /integer/],
            [{ ...valid, amount: '18446744073709551616' }, /Uint<64>/],
            [{ ...valid, receiverCoinPublicKey: 'abc' }, /receiverCoinPublicKey/],
            [{ ...valid, sessionId: undefined }, /sessionId/]
        ];
        for (const [data, re] of cases) {
            const req = makeReq(data);
            await srv.handlers['mintFactoryToken'](req);
            expect(req.reject, JSON.stringify(data)).toHaveBeenCalledWith(400, expect.stringMatching(re));
        }
        expect(tokenFactory.issuerKeyForSession).not.toHaveBeenCalled();
        expect(mockStartJob).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'mintFactoryToken' }));
    });

    test('enqueues mint(name, amount, recipient) on the token-factory lineage with the type known up front', async () => {
        const { srv, tokenFactory } = setup();
        const req = makeReq({ ...valid, contractAddress: FACTORY.toUpperCase(), amount: 1000 });
        const out = await srv.handlers['mintFactoryToken'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(out).toEqual({
            jobId: 'job-mintFactoryToken-test', status: 'pending',
            name: 'CREDIT', amount: '1000', issuerKey: ISSUER, domain: TOKEN.domain, tokenType: TOKEN.tokenType
        });
        expect(tokenFactory.issuerKeyForSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mint-f1', expectedUserId: 'test-user' }));
        expect(tokenFactory.describeToken).toHaveBeenCalledWith({ issuerKey: ISSUER, name: 'CREDIT', contractAddress: FACTORY });
        const call = mockStartJob.mock.calls.at(-1)?.[0];
        expect(call).toMatchObject({
            kind: 'mintFactoryToken', sessionId: 'mint-f1', requestedBy: 'test-user', encryptCommand: true,
            request: { contractAddress: FACTORY, name: 'CREDIT', amount: '1000', receiverCoinPublicKey: RECIPIENT, tokenType: TOKEN.tokenType },
            command: {
                op: 'call', circuit: 'mint', contractName: 'token-factory', contractAddress: FACTORY, mintedTokenType: TOKEN.tokenType,
                args: [{ $bytes: Buffer.from('CREDIT').toString('hex').padEnd(64, '0') }, { $uint: '1000' }, { bytes: { $bytes: RECIPIENT } }]
            }
        });
        expect(JSON.stringify(call.request)).not.toMatch(/issuerSecret/);
    });

    test('the pool never issues a token: a pool grant is refused, and no session is taken from the pool', async () => {
        const { srv, tokenFactory } = setup();
        process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS = 'pool-1';
        try {
            // As the grant hook leaves it: the grant's session filled in, the pool placeholder as the sponsor.
            const poolGrant = makeReq({ ...valid, sponsorSessionId: PLATFORM_POOL_SENTINEL });
            (poolGrant as any).agentGrant = { sponsorSessionId: PLATFORM_POOL_SENTINEL };
            await srv.handlers['mintFactoryToken'](poolGrant);
            expect(poolGrant.reject).toHaveBeenCalledWith(403, expect.stringMatching(/the pool pays fees and never issues a token\. Build the mint with @odatano\/nightgate-tx/));

            // Without a session there is none to sign with. The pool is not asked.
            const sessionless = makeReq({ ...valid, sessionId: undefined });
            (sessionless as any).agentGrant = { sponsorSessionId: null };
            await srv.handlers['mintFactoryToken'](sessionless);
            expect(sessionless.reject).toHaveBeenCalledWith(400, 'sessionId is required');
            expect(tokenFactory.issuerKeyForSession).not.toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
        }
    });

    test('a fee sponsor wallet is never the wallet an action acts as, for its owner too and for a job that is already queued', async () => {
        const walletMaterialFactory = vi.fn(async () => ({
            accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' },
            ensureFacade: vi.fn(async () => undefined)
        }));
        const { srv, tokenFactory } = setup({ walletMaterialFactory });
        process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS = 'pool-1,pool-2';
        try {
            const asSponsor = makeReq({ ...valid, sessionId: 'pool-2' });
            await srv.handlers['mintFactoryToken'](asSponsor);
            expect(asSponsor.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 403, message: expect.stringMatching(/is a fee sponsor: it pays fees and does nothing else/) }));
            expect(walletMaterialFactory).not.toHaveBeenCalled();
            expect(tokenFactory.issuerKeyForSession).not.toHaveBeenCalled();

            // A job that was queued while the wallet was no sponsor yet is refused when it runs.
            const queued = registeredProcessors.get(`mintFactoryToken\0${1}`)!;
            const command = {
                op: 'call', contractAddress: FACTORY, circuit: 'mint', contractName: 'token-factory',
                args: [{ $bytes: '00'.repeat(32) }, { $uint: '1' }, { bytes: { $bytes: RECIPIENT } }],
                mintedTokenType: TOKEN.tokenType, artifactDigest: getArtifactGenerationDigest('token-factory')
            };
            await expect(queued(command, { ID: 'job-s', kind: 'mintFactoryToken', sessionId: 'pool-1', requestedBy: 'test-user', commandVersion: 1, command: JSON.stringify(command) }))
                .rejects.toThrow(/is a fee sponsor: it pays fees and does nothing else/);
            expect(walletMaterialFactory).not.toHaveBeenCalled();
        } finally {
            delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
        }
    });

    test('a grant on a wallet of its own mints as that wallet, whoever pays the fee', async () => {
        const { srv, tokenFactory } = setup();
        const own = makeReq({ ...valid });
        (own as any).agentGrant = { sponsorSessionId: null };
        await srv.handlers['mintFactoryToken'](own);
        expect(own.reject).not.toHaveBeenCalled();
        expect(tokenFactory.issuerKeyForSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'mint-f1', expectedUserId: 'test-user' }));
    });

    test('the executor records the landed type as learned and on the grant, and returns it with the call result', async () => {
        const submitter = makeSuccessfulSubmitter();
        setup({ submitterFactory: vi.fn(() => submitter) });
        const processor = registeredProcessors.get('mintFactoryToken\u00001');
        expect(processor).toBeTypeOf('function');
        const command = {
            op: 'call', contractAddress: FACTORY, circuit: 'mint', contractName: 'token-factory',
            args: [{ $bytes: '00'.repeat(32) }, { $uint: '1' }, { bytes: { $bytes: RECIPIENT } }],
            mintedTokenType: TOKEN.tokenType, artifactDigest: getArtifactGenerationDigest('token-factory')
        };
        const result: any = await processor!(command, { ID: 'job-x', kind: 'mintFactoryToken', sessionId: 'mint-f1', requestedBy: 'test-user', grantId: 'grant-9', commandVersion: 1, command: JSON.stringify(command) });
        expect(result).toMatchObject({ txHash: '0xcafe', tokenType: TOKEN.tokenType });
        const [callArgs] = (submitter.call as any).mock.calls.at(-1);
        expect(callArgs.circuit).toBe('mint');
        expect(callArgs.args[1]).toBe(1n);
        expect(Buffer.from(callArgs.args[2].bytes).toString('hex')).toBe(RECIPIENT);
        expect(recordLearnedSpy).toHaveBeenCalledWith(expect.anything(), [TOKEN.tokenType], expect.objectContaining({ grantId: 'grant-9', txHash: '0xcafe' }));
        expect(recordMintedSpy).toHaveBeenCalledWith(expect.anything(), 'grant-9', [TOKEN.tokenType]);

        // the finalizer does the same bookkeeping when the indexer proves the mint after a lost broadcast
        recordLearnedSpy.mockClear(); recordMintedSpy.mockClear();
        const finalizer = registeredFinalizers.get('mintFactoryToken\u00001')!;
        expect(finalizer).toBeTypeOf('function');
        const finalized: any = await runFinalizer(finalizer, command, { ID: 'job-z', kind: 'mintFactoryToken', sessionId: 'mint-f1', grantId: 'grant-9' }, { submissionId: null, txHash: 'ab'.repeat(32), contractAddress: FACTORY, finalizedAt: null, blockHeight: 7 }, { run: vi.fn(async () => undefined) });
        expect(finalized).toMatchObject({ reconciled: true, txHash: 'ab'.repeat(32), tokenType: TOKEN.tokenType, contractAddress: FACTORY });
        expect(recordLearnedSpy).toHaveBeenCalledWith(expect.anything(), [TOKEN.tokenType], expect.objectContaining({ grantId: 'grant-9', txHash: 'ab'.repeat(32) }));
        expect(recordMintedSpy).toHaveBeenCalledWith(expect.anything(), 'grant-9', [TOKEN.tokenType]);

        // a grant whose circuit list lacks `mint` stops the queued job
        setup();
        GRANT_ROW.allowedCircuits = JSON.stringify(['attest']);
        try {
            await expect(registeredProcessors.get('mintFactoryToken\u00001')!(command, { ID: 'job-y', kind: 'mintFactoryToken', sessionId: 'mint-f1', requestedBy: 'test-user', grantId: 'grant-9', commandVersion: 1, command: JSON.stringify(command) }))
                .rejects.toMatchObject({ code: 'AGENT_GRANT_SCOPE' });
        } finally {
            GRANT_ROW.allowedCircuits = JSON.stringify(['mint']);
        }
    });

    const burn = { contractAddress: FACTORY, name: 'CREDIT', amount: '250', sessionId: 'mint-f1' };

    test('burn validates address, name, amount, issuer key and session before any wallet work', async () => {
        const { srv, tokenFactory } = setup();
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ ...burn, contractAddress: 'zz' }, /64 hex/],
            [{ ...burn, name: '' }, /name/],
            [{ ...burn, amount: '0' }, /positive/],
            [{ ...burn, issuerKey: 'abc' }, /issuerKey must be 64 hex/],
            [{ ...burn, sessionId: undefined }, /sessionId is required/]
        ];
        for (const [data, re] of cases) {
            const req = makeReq(data);
            await srv.handlers['burnFactoryToken'](req);
            expect(req.reject, JSON.stringify(data)).toHaveBeenCalledWith(400, expect.stringMatching(re));
        }
        expect(tokenFactory.describeToken).not.toHaveBeenCalled();
        expect(mockStartJob).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'burnFactoryToken' }));
    });

    test('burn sends a fresh coin of the token to the contract, under the issuer key the caller names', async () => {
        const { srv, tokenFactory } = setup();
        const req = makeReq({ ...burn, issuerKey: ISSUER.toUpperCase() });
        const out = await srv.handlers['burnFactoryToken'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(tokenFactory.issuerKeyForSession).not.toHaveBeenCalled();
        expect(tokenFactory.describeToken).toHaveBeenCalledWith({ issuerKey: ISSUER, name: 'CREDIT', contractAddress: FACTORY });
        expect(out).toMatchObject({ name: 'CREDIT', amount: '250', issuerKey: ISSUER, domain: TOKEN.domain, tokenType: TOKEN.tokenType });
        const call = mockStartJob.mock.calls.at(-1)?.[0];
        expect(call).toMatchObject({
            kind: 'burnFactoryToken', sessionId: 'mint-f1', encryptCommand: true,
            request: { contractAddress: FACTORY, amount: '250', issuerKey: ISSUER, tokenType: TOKEN.tokenType },
            command: { op: 'call', circuit: 'burn', contractName: 'token-factory', contractAddress: FACTORY }
        });
        const [domain, coin] = call.command.args;
        expect(domain).toEqual({ $bytes: TOKEN.domain });
        expect(coin.color).toEqual({ $bytes: TOKEN.tokenType });
        expect(coin.value).toEqual({ $uint: '250' });
        expect(coin.nonce.$bytes).toMatch(HEX64_RE);
        // The nonce is new for every burn and never part of what an idempotency key compares.
        expect(JSON.stringify(call.idempotencyPayload)).not.toContain(coin.nonce.$bytes);
    });

    test('burn without an issuer key burns a token the session itself issued', async () => {
        const { srv, tokenFactory } = setup();
        await srv.handlers['burnFactoryToken'](makeReq(burn));
        expect(tokenFactory.issuerKeyForSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mint-f1', expectedUserId: 'test-user' }));
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'burnFactoryToken', request: { issuerKey: ISSUER } });
    });
});

describe('deriveTokenType', () => {
    const ADDRESS = 'c8f426c52a5418f3b0acda284ee04d530a38f68ab3c701116fa42fae0e90cfd6';

    function setup(overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return srv;
    }

    test('deriveTokenType returns the token type without touching a wallet', async () => {
        const walletMaterialFactory = vi.fn();
        const srv = setup({ walletMaterialFactory });
        const req = makeReq({ contractAddress: ADDRESS, domainSeparator: 'example:token' });
        const out = await srv.handlers['deriveTokenType'](req) as any;
        expect(req.reject).not.toHaveBeenCalled();
        expect(out.tokenType).toMatch(HEX64_RE);
        expect(out.contractAddress).toBe(ADDRESS);
        expect(walletMaterialFactory).not.toHaveBeenCalled();
    });

    test('deriveTokenType rejects a missing or unusable input with 400', async () => {
        const srv = setup();
        const r1 = makeReq({});
        await srv.handlers['deriveTokenType'](r1);
        expect(r1.reject).toHaveBeenCalledWith(400, expect.stringMatching(/contractAddress/));

        const r2 = makeReq({ contractAddress: 'not-an-address', domainSeparator: 'example:token' });
        await srv.handlers['deriveTokenType'](r2);
        expect(r2.reject).toHaveBeenCalledWith(400, expect.stringMatching(/rawTokenType failed/));

        const r4 = makeReq({ contractAddress: ADDRESS });
        await srv.handlers['deriveTokenType'](r4);
        expect(r4.reject).toHaveBeenCalledWith(400, 'domainSeparator is required');

        const r3 = makeReq({ contractAddress: ADDRESS, domainSeparator: 'x'.repeat(40) });
        await srv.handlers['deriveTokenType'](r3);
        expect(r3.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 32/));
    });
});

describe('error translation to OData status codes', () => {
    function setupHandlers(overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            // Successful happy path by default
            resolveContractImpl: vi.fn(async (_name: string) => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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
        expect(mockStartJob.mock.calls.at(-1)?.[0].command).not.toHaveProperty('recoveryId');
    });

    test('deployContract carries recoveryId (lower-cased) into the command and to submitter.deploy', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const recoveryId = 'AB'.repeat(32);
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-happy-1r', recoveryId });
        await srv.handlers['deployContract'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({ command: { op: 'deploy', recoveryId: 'ab'.repeat(32) } });
        expect(submitter.deploy).toHaveBeenCalledWith(expect.objectContaining({ recoveryId: 'ab'.repeat(32) }));
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
            contractName: 'attestation-vault',
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

    test('submitContractCallBatch puts the call order into the idempotency payload, so a retry that changes it is a conflict', async () => {
        const srv = setupHandlers({ submitterFactory: () => makeSuccessfulSubmitter() });
        const payloadOf = async (independentCalls: boolean | undefined) => {
            const req = makeReq({ contractAddress: '0xCONTRACT', calls: JSON.stringify([{ circuit: 'attest', args: [] }, { circuit: 'bindPassport', args: [] }]),
                contractName: 'attestation-vault', sessionId: 'session-order', ...(independentCalls === undefined ? {} : { independentCalls }) });
            await srv.handlers['submitContractCallBatch'](req);
            return mockStartJob.mock.calls.at(-1)?.[0].idempotencyPayload;
        };
        const ordered = await payloadOf(undefined);
        expect(ordered.independentCalls).toBe(false);
        expect(await payloadOf(false)).toEqual(ordered);
        expect((await payloadOf(true)).independentCalls).toBe(true);
    });

    test('submitContractCallBatch forwards a per-call merkleProof to the submitter and the persisted command', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const SIBS4 = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
        // A complete single-field proof: the salt is what the field_salt witness needs.
        const proof = { fieldValue: '3600', fieldSalt: 'a'.repeat(64), siblings: SIBS4, dirs: [true, false, true, false] };
        const req = makeReq({
            contractAddress: '0xCONTRACT',
            calls: JSON.stringify([
                { circuit: 'anchorContentRoot', args: [] },
                { circuit: 'proveFieldPredicate', args: [], merkleProof: { ...proof, fieldSalt: proof.fieldSalt.toUpperCase() } }
            ]),
            contractName: 'attestation-vault',
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

    test('submitContractCallBatch accepts a docPair bundle without an inclusion path and forwards it', async () => {
        const submitter = makeSuccessfulSubmitter();
        const srv = setupHandlers({ submitterFactory: () => submitter });
        const slot = (i: number) => ({ fieldKey: String(i).padStart(2, '0').repeat(32), kind: 0, scale: '0' });
        const opening = (fill: string) => ({ saltSeed: fill.repeat(64), slots: Array.from({ length: 16 }, () => ({ present: true, value: '1' })) });
        const docPair = { schema: Array.from({ length: 16 }, (_, i) => slot(i)), openingA: opening('a'), openingB: opening('b') };
        const req = makeReq({
            contractAddress: '0xCONTRACT',
            calls: JSON.stringify([{ circuit: 'proveDocumentComparison', args: [], merkleProof: { docPair } }]),
            contractName: 'attestation-vault',
            sessionId: 'session-happy-batch-docpair'
        });
        await srv.handlers['submitContractCallBatch'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const forwarded = ((submitter as any).callBatch as Mock).mock.calls[0][0].calls[0].merkleProof;
        expect(forwarded.docPair.schema).toHaveLength(16);
        expect(forwarded.docPair.openingA.slots).toHaveLength(16);
        expect(forwarded.docPair.openingB.saltSeed).toBe('b'.repeat(64));
        expect(forwarded.siblings).toBeUndefined();
    });

    test('reconciliation finalizer rebuilds the batch result incl. circuits from command + evidence', async () => {
        setupHandlers({});
        const finalizer = registeredFinalizers.get(`submitContractCallBatch\0${1}`);
        expect(finalizer).toBeDefined();
        const result: any = await finalizer!(
            {
                op: 'callBatch', contractAddress: '0xCONTRACT', contractName: 'attestation-vault',
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
            { op: 'call', contractAddress: '0xC', circuit: 'attest', contractName: 'attestation-vault', args: [] },
            { ID: 'job-x', kind: 'submitContractCallBatch', sessionId: 's', requestedBy: 'u', commandVersion: 1 }
        )).rejects.toThrow(/incompatible with submitContractCallBatch/);
    });

    test('executor guard: a job admitted under a grant is refused at execution once the grant is revoked', async () => {
        const submitter = makeSuccessfulSubmitter();
        const db = { run: vi.fn(async () => ({ ID: 'grant-1', isActive: false, revokedAt: '2026-09-15T00:00:00Z' })) };
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'acc', privateStoragePasswordProvider: () => 'x', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' } })),
            submitterFactory: () => submitter
        });
        const processor = registeredProcessors.get(`submitContractCall\0${1}`);
        await expect(processor!(
            { op: 'call', contractAddress: '0xC', circuit: 'attest', contractName: 'attestation-vault', args: [], artifactDigest: getArtifactGenerationDigest('attestation-vault') },
            { ID: 'job-g', kind: 'submitContractCall', sessionId: 's', requestedBy: 'u', commandVersion: 1, grantId: 'grant-1' }
        )).rejects.toMatchObject({ code: 'AGENT_GRANT_REVOKED', retryable: false });
        expect(submitter.call).not.toHaveBeenCalled();
    });

    test('executor guard: a job admitted under a grant is refused once the grant no longer covers its contract', async () => {
        const submitter = makeSuccessfulSubmitter();
        const db = { run: vi.fn(async () => ({ ID: 'grant-1', isActive: true, allowedActions: JSON.stringify(['submitContractCall']), allowedContracts: JSON.stringify(['0xother']) })) };
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'acc', privateStoragePasswordProvider: () => 'x', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' } })),
            submitterFactory: () => submitter
        });
        const processor = registeredProcessors.get(`submitContractCall\0${1}`);
        await expect(processor!(
            { op: 'call', contractAddress: '0xC', circuit: 'attest', contractName: 'attestation-vault', args: [], artifactDigest: getArtifactGenerationDigest('attestation-vault') },
            { ID: 'job-g2', kind: 'submitContractCall', sessionId: 's', requestedBy: 'u', commandVersion: 1, grantId: 'grant-1' }
        )).rejects.toMatchObject({ code: 'AGENT_GRANT_SCOPE', retryable: false });
        expect(submitter.call).not.toHaveBeenCalled();
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
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 404, code: 'CONTRACT_NOT_REGISTERED', message: expect.stringMatching(/not registered/) }));
    });

    test('SessionNotFoundError → 404', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: vi.fn(async () => { throw new SessionNotFoundError('s'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-404' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 404, code: 'SESSION_NOT_FOUND', message: expect.stringMatching(/not found/) }));
    });

    test('WalletMaterialUnavailable → 501', async () => {
        const srv = setupHandlers({
            walletMaterialFactory: vi.fn(async () => { throw new WalletMaterialUnavailable('signing not impl'); })
        });
        const req = makeReq({ ...VALID_DEPLOY_ARGS, sessionId: 'session-501' });
        await srv.handlers['deployContract'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 501, code: 'WALLET_MATERIAL_UNAVAILABLE', message: expect.stringMatching(/Wallet material unavailable/) }));
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

    // A SubmissionError thrown inside the work fn does not surface via OData:
    // startJob captures it into BackgroundJobs.{errorCode,errorMessage} for
    // the caller to retrieve via getJobStatus, and the action response stays
    // `{ jobId, status: 'pending' }`. Error-classification coverage lives in
    // background-jobs.test.ts; here we verify the handler returns the
    // success-path shape when the submitter throws.
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

// One prove limiter for every prove action: the sessions of earlier tests must not fill a principal's key table.
beforeEach(() => __resetRateLimitersForTests());

describe('rate limiting', () => {
    test('deployContract: 5 deploys/hour/session, 6th gets 429', async () => {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' } })),
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

    test('submitContractCall: 60 prove calls/hour/session, 61st gets 429', async () => {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, {} as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({ accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' } })),
            submitterFactory: () => makeSuccessfulSubmitter()
        });

        const sessionId = `rate-test-call-${Date.now()}`;
        for (let i = 0; i < 60; i++) {
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
        payloadHash: VALID_SHA256,
        contentType: 'application/pdf',
        size: 1024,
        storageRef: 'file:///tmp/doc.pdf',
        metadata: '{"type":"demo"}',
        sessionId: `anchor-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function makeFakeDb() {
        const run = vi.fn().mockResolvedValue(undefined);
        return { run };
    }

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = makeFakeDb();
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test('rejects missing payloadHash', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), payloadHash: undefined });
        await srv.handlers['anchorDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
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

    test('an agent-output envelope records its producedAt in the job request', async () => {
        const { srv } = setupHandlersWithDb({ submitterFactory: () => makeSuccessfulSubmitter() });
        await srv.handlers['anchorDocument'](makeReq({
            ...VALID_ANCHOR_ARGS(),
            contentType: 'application/vnd.nightgate.agent-output.v1+json',
            metadata: JSON.stringify({ v: 1, producedAt: '2026-09-26T08:00:00.000Z' })
        }));
        expect(mockStartJob.mock.calls.at(-1)![0].request).toMatchObject({ producedAt: '2026-09-26T08:00:00.000Z' });
    });

    test('one plain attest with Uint8Array args; the session attester id is recorded and returned', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ANCHOR_ARGS());

        const result: any = await srv.handlers['anchorDocument'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-anchorDocument-test', status: 'pending', anchorId: expect.any(String), attesterId: ATTESTER_ID });
        const started = mockStartJob.mock.calls.at(-1)![0];
        expect(started.kind).toBe('anchorDocument');
        expect(started.command).toMatchObject({ op: 'anchorDocument', attesterId: ATTESTER_ID, payloadHash: VALID_SHA256 });
        expect(started.request).toMatchObject({ attesterId: ATTESTER_ID });
        expect(started.request).not.toHaveProperty('producedAt');
        // What the row stores belongs to the request, so a retry that changes it is a conflict, not the first job.
        const args = VALID_ANCHOR_ARGS();
        expect(started.idempotencyPayload).toMatchObject({ storageRef: args.storageRef, contentType: args.contentType ?? null, size: args.size ?? null });

        // INSERT with the attester id (sync) + anchoredTxHash UPDATE (executor) = 2 db.run calls.
        expect(db.run).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain(ATTESTER_ID);

        // ONE transaction: attest(payload_hash, metadata_hash). The record key
        // is derived in-circuit from the caller, so nothing else travels.
        expect(submitter.call).toHaveBeenCalledTimes(1);
        const callArgs = (submitter.call as Mock).mock.calls[0][0];
        expect(callArgs.circuit).toBe('attest');
        expect(callArgs.contractAddress).toBe('0xVAULT');
        expect(callArgs.contractName).toBe('attestation-vault');
        expect(callArgs.args).toHaveLength(2);
        expect(callArgs.args[0]).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(callArgs.args[0]).toString('hex')).toBe(VALID_SHA256);
        expect(callArgs.args[1]).toBeInstanceOf(Uint8Array);
        expect(callArgs.args[1]).toHaveLength(32);
        expect(childCommandLog.filter(c => c.kind === 'anchorCommit' || c.kind === 'anchorReveal')).toHaveLength(0);
    });

    test('reconciliation finalizer restores the document projection and typed result without submitting', async () => {
        const { db } = setupHandlersWithDb();
        db.run.mockClear();
        const finalizer = registeredFinalizers.get('anchorDocument\0' + '1')!;
        const result = await runFinalizer(finalizer, {
            op: 'anchorDocument', anchorId: 'doc-reconciled', payloadHash: VALID_SHA256,
            metadataHash: 'b'.repeat(64), contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xanchor', finalizedAt: '2026-07-22T10:00:00Z' }, db);

        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('doc-reconciled');
        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('0xanchor');
        expect(result).toMatchObject({ reconciled: true, anchorId: 'doc-reconciled', txHash: '0xanchor' });
    });

    test('a command stored by an older version names the anchor documentId and is settled the same way', async () => {
        const { db } = setupHandlersWithDb();
        db.run.mockClear();
        const finalizer = registeredFinalizers.get('anchorDocument\0' + '1')!;
        const result = await runFinalizer(finalizer, currentCommand({
            op: 'anchorDocument', documentId: 'doc-stored', payloadHash: VALID_SHA256,
            metadataHash: 'b'.repeat(64), contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }), {}, { txHash: '0xanchor', finalizedAt: '2026-07-22T10:00:00Z' }, db);

        expect(JSON.stringify(db.run.mock.calls[0][0])).toContain('doc-stored');
        expect(result).toMatchObject({ reconciled: true, anchorId: 'doc-stored' });
        expect(result).not.toHaveProperty('documentId');
    });

    test('defaults contractName to attestation-vault when omitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ANCHOR_ARGS(), contractName: undefined });
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
        // Only the INSERT ran; the anchoredTxHash UPDATE did not, because the work threw first.
        expect(db.run).toHaveBeenCalledTimes(1);
        // The handler still returns successfully; failure is in the job row.
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({ jobId: expect.any(String), status: 'pending' });
    });

    test('rate-limited at 60 prove calls/hour/session', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `anchor-rate-${Date.now()}`;
        for (let i = 0; i < 60; i++) {
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
    // Preview has a built-in indexer, so the live state check runs without local config.
    pinEnv({ NIGHTGATE_NETWORK: 'preview' });
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

    function setupHandlersWithDb(db: any, overrides: any = {}) {
        const srv = makeFakeService();
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(),
            walletMaterialFactory: vi.fn(),
            submitterFactory: vi.fn(),
            ...overrides
        });
        return srv;
    }

    test('rejects missing anchorId', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({ payloadHash: VALID_SHA });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/anchorId/));
    });

    test('rejects missing payloadHash', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([]));
        const req = makeReq({ anchorId: DOC_ID });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/payloadHash/));
    });

    test('404 when document not found', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([undefined]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringMatching(/not found/));
    });

    test('hash matches + anchored + tx status SUCCESS without a live read: included, not verified', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        // No recorded vault, no caller vault: nothing to read live state for.
        // The inclusion is reported; a verdict needs the live record.
        expect(result).toEqual({
            verified: false,
            included: true,
            stateChecked: false,
            anchoredTxHash: TX_HASH,
            anchoredAt: '2026-05-19T12:00:00Z',
            payloadHash: VALID_SHA
        });
    });

    test('verified: false when provided hash differs (tampered)', async () => {
        const tampered = 'b'.repeat(64);
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: tampered });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
        expect(result.payloadHash).toBe('');
        // Skips the tx lookup when hash mismatched: only 1 db.run, not 3.
        // (We can't easily assert call count without exposing the db here,
        //  but the result coming back is enough proof the short-circuit fired.)
    });

    test('verified: false when not yet anchored (no txHash)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: null, anchoredAt: null }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result).toEqual({
            verified: false,
            included: false,
            stateChecked: false,
            anchoredTxHash: '',
            anchoredAt: null,
            payloadHash: VALID_SHA
        });
    });

    test('verified: false when tx exists but status is not SUCCESS', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'FAILURE' }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
    });

    test('verified: false when tx is not yet indexed (crawler lag)', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            undefined // no Transactions row yet
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(result.verified).toBe(false);
    });

    test('hash comparison is case-insensitive', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA.toLowerCase(), anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z' },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA.toUpperCase() });
        const result: any = await srv.handlers['verifyDocument'](req);
        // The upper-cased hash still matches: the tx lookup ran and reported inclusion.
        expect(result).toMatchObject({ included: true, payloadHash: VALID_SHA.toLowerCase() });
    });

    // Evidence binding: the recorded anchoring vault is
    // authoritative; a caller pointing at a DIFFERENT vault that attests the
    // same public hash must not turn the document verified.
    test('rejects a caller contractAddress that differs from the recorded anchoring vault', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z', contractAddress: 'aa'.repeat(32) }
        ]));
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA, contractAddress: 'bb'.repeat(32) });
        await srv.handlers['verifyDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/does not match the vault/));
    });

    test('accepts a caller contractAddress that CONFIRMS the recorded vault (case-insensitive)', async () => {
        const reader = vi.fn(async () => ({ attested: true, contentRootOk: false, schemaOk: false, attesterId: 'x' }));
        const srv = setupHandlersWithDb(makeDbWithSequence([
            { ID: DOC_ID, payloadHash: VALID_SHA, attesterId: 'ab'.repeat(32), anchoredTxHash: TX_HASH, anchoredAt: '2026-05-19T12:00:00Z', contractAddress: 'aa'.repeat(32) },
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]), { attestationStateReader: reader, resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })) });
        const req = makeReq({ anchorId: DOC_ID, payloadHash: VALID_SHA, contractAddress: 'AA'.repeat(32) });
        const result: any = await srv.handlers['verifyDocument'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({ verified: true, included: true, stateChecked: true });
        expect(reader).toHaveBeenCalledTimes(1);
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
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(), walletMaterialFactory: vi.fn(), submitterFactory: vi.fn()
        });
        return srv;
    }
    const provenRow = () => ({
        ID: PA_ID, predicate: 'lessOrEqual', threshold: '50000', unit: 'kgCO2e/kWh',
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

    test('proven + tx SUCCESS without a live read: included, not verified', async () => {
        const srv = setupHandlersWithDb(makeDbWithSequence([
            provenRow(),
            { ID: TX_ID, hash: TX_HASH },
            { status: 'SUCCESS', outcomeSource: 'substrate-system-events' }
        ]));
        const req = makeReq({ predicateAttestationId: PA_ID });
        const result: any = await srv.handlers['verifyPredicateAttestation'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            verified: false, included: true, stateChecked: false, predicate: 'lessOrEqual', threshold: '50000',
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
        contractName: 'attestation-vault'
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
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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

    test('rejects missing grantee', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), grantee: undefined });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/grantee is required/));
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

    test('happy path: SELECT + INSERT after the session check + single grantDisclosure call + UPDATE grantedTxHash', async () => {
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

        // SELECT.one existing + INSERT (both after the session check) + UPDATE (executor) = 3 db.run.
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

    test('the confirmation UPDATE only writes rows unstamped or stamped strictly below the landed height', async () => {
        const submitter = makeSuccessfulSubmitter();
        (submitter.call as Mock).mockResolvedValueOnce({ submissionId: 'sub-h', txHash: '0xcafe', contractAddress: '0xCONTRACT', status: 'included', blockHeight: 600 });
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        await srv.handlers['grantDisclosure'](makeReq(VALID_ARGS()));
        const update = db.run.mock.calls.map((c: any[]) => c[0]).find((q: any) => q?.UPDATE);
        const where = JSON.stringify(update.UPDATE.where);
        expect(where).toContain('"changedAtHeight"');
        expect(where).toContain('"<"');
        expect(where).not.toContain('"<="');
        expect(where).toContain('600');
    });

    test('a confirmation of unknown height writes only an unstamped row', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        await srv.handlers['grantDisclosure'](makeReq(VALID_ARGS()));
        const update = db.run.mock.calls.map((c: any[]) => c[0]).find((q: any) => q?.UPDATE);
        const where = JSON.stringify(update.UPDATE.where);
        expect(where).toContain('"changedAtHeight"');
        expect(where).toContain('"null"');
        expect(where).not.toContain('"<"');
    });

    test('defaults contractName to attestation-vault', async () => {
        const resolveContractImpl = vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE }));
        const { srv } = setupHandlersWithDb({ resolveContractImpl });
        await srv.handlers['grantDisclosure'](makeReq({ ...VALID_ARGS(), contractName: undefined }));
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
        const result = await runFinalizer(registeredFinalizers.get('grantDisclosure\0' + '1')!, {
            op: 'grantDisclosure', disclosureGrantId: 'grant-reconciled', payloadHash: VALID_PAYLOAD,
            grantee: VALID_GRANTEE, level: 2, contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xgrant', finalizedAt: null }, db);

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
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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
        // The re-grant records the request as pendingLevel; the confirmed
        // level and any revoke marker stay until the chain took the change.
        const updates = queries.filter(q => q.UPDATE);
        expect(updates.length).toBeGreaterThanOrEqual(2);
        const request = JSON.stringify(updates[0].UPDATE.data ?? updates[0].UPDATE.with);
        expect(request).toContain('"pendingLevel":1');
        expect(request).not.toContain('"level":1');
        expect(request).not.toContain('"revokedTxHash"');
        // The in-process inclusion confirms it: level moves, marker and revoke clear.
        const confirmed = JSON.stringify(updates[1].UPDATE.data ?? updates[1].UPDATE.with);
        expect(confirmed).toContain('"level":1');
        expect(confirmed).toContain('"pendingLevel":null');
        expect(confirmed).toContain('"revokedTxHash":null');
        expect(confirmed).toContain('"grantedTxHash":"0xcafe"');
    });

    test('an idempotent replay of a finished grant restores the pendingLevel it found', async () => {
        const srv = makeFakeService();
        const run = vi.fn()
            .mockResolvedValueOnce({ ID: 'existing-grant-row', pendingLevel: null })
            .mockResolvedValue(undefined);
        registerSubmissionHandlers(srv as any, { run }, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            disclosureReindexer: vi.fn()
        });
        mockStartJob.mockImplementationOnce((async () => ({ jobId: 'job-original', status: 'succeeded', deduplicated: true })) as any);

        const req = makeReq({ ...VALID_ARGS(), idempotencyKey: 'idem-replay' });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).not.toHaveBeenCalled();

        const updates = run.mock.calls.map(c => c[0]).filter((q: any) => q.UPDATE);
        expect(JSON.stringify(updates[0].UPDATE.data ?? updates[0].UPDATE.with)).toContain('"pendingLevel":1');
        const restore = updates.at(-1);
        expect(JSON.stringify(restore.UPDATE.data ?? restore.UPDATE.with)).toContain('"pendingLevel":null');
    });

    test('an idempotency key longer than the column is a 400, not a 500', async () => {
        const { srv } = setupHandlersWithDb();
        const { IdempotencyKeyInvalidError } = await vi.importActual<typeof import('../../srv/submission/background-jobs')>('../../srv/submission/background-jobs');
        mockStartJob.mockImplementationOnce(async () => { throw new IdempotencyKeyInvalidError(); });
        const req = makeReq({ ...VALID_ARGS(), idempotencyKey: 'k'.repeat(129) });
        await srv.handlers['grantDisclosure'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_INVALID' }));
    });

    test('a reindex failure does not fail the grant and queues a durable reindexDisclosures retry job', async () => {
        process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS = '0';
        try {
            const { srv } = setupHandlersWithDb({
                disclosureReindexer: vi.fn().mockRejectedValue(new Error('indexer down'))
            });
            const req = makeReq(VALID_ARGS());
            const result: any = await srv.handlers['grantDisclosure'](req);
            expect(req.reject).not.toHaveBeenCalled();
            expect(result).toMatchObject({ jobId: expect.any(String), status: 'pending' });
            const retry = mockStartJob.mock.calls.map(c => c[0]).find(a => a.kind === 'reindexDisclosures');
            expect(retry).toMatchObject({
                sessionId: expect.any(String),
                idempotencyKey: expect.stringMatching(/^reindex:0xvault:tip:job-test$/),
                encryptCommand: false,
                command: { op: 'reindexDisclosures', contractAddress: expect.stringMatching(/^0xvault$/i), contractName: 'attestation-vault', atHeight: null }
            });
        } finally {
            delete process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS;
        }
    });

    test('the reindexDisclosures job retries with backoff until the reindex lands', async () => {
        process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS = '200';
        try {
            const reindexer = vi.fn()
                .mockRejectedValueOnce(new Error('indexer down'))
                .mockResolvedValueOnce({ indexed: 3, deactivated: 1, snapshotHeight: 700 });
            setupHandlersWithDb({ disclosureReindexer: reindexer });
            const processor = registeredProcessors.get(`reindexDisclosures\0${1}`);
            const result = await processor!(
                { op: 'reindexDisclosures', contractAddress: '0xVAULT', contractName: 'attestation-vault', atHeight: 700, artifactDigest: getArtifactGenerationDigest('attestation-vault') },
                { ID: 'job-r', kind: 'reindexDisclosures', sessionId: 's', requestedBy: 'u', commandVersion: 1 }
            );
            expect(result).toEqual({ reindexed: true, attempts: 2, indexed: 3, deactivated: 1, snapshotHeight: 700 });
            expect(reindexer).toHaveBeenCalledTimes(2);
            expect(reindexer.mock.calls[0][0]).toMatchObject({ contractAddress: '0xVAULT', atHeight: 700 });
        } finally {
            delete process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS;
        }
    });

    test('the reindexDisclosures job fails DISCLOSURE_REINDEX_FAILED once the retry window is spent', async () => {
        process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS = '0';
        try {
            const reindexer = vi.fn().mockRejectedValue(new Error('indexer down'));
            setupHandlersWithDb({ disclosureReindexer: reindexer });
            const processor = registeredProcessors.get(`reindexDisclosures\0${1}`);
            await expect(processor!(
                { op: 'reindexDisclosures', contractAddress: '0xVAULT', contractName: 'attestation-vault', atHeight: null, artifactDigest: getArtifactGenerationDigest('attestation-vault') },
                { ID: 'job-r2', kind: 'reindexDisclosures', sessionId: 's', requestedBy: 'u', commandVersion: 1 }
            )).rejects.toMatchObject({ code: 'DISCLOSURE_REINDEX_FAILED', retryable: false });
            expect(reindexer).toHaveBeenCalledTimes(1);
        } finally {
            delete process.env.NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS;
        }
    });

    test('forwards idempotencyKey to startJob', async () => {
        const { srv } = setupHandlersWithDb();
        await srv.handlers['grantDisclosure'](makeReq({ ...VALID_ARGS(), idempotencyKey: 'idem-1' }));
        expect(mockStartJob).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'grantDisclosure', idempotencyKey: 'idem-1'
        }));
    });

    test('rate-limited at 60 prove calls/hour/session', async () => {
        const { srv } = setupHandlersWithDb();
        const sessionId = `disc-rate-${Date.now()}`;
        for (let i = 0; i < 60; i++) {
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
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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
        const result = await runFinalizer(registeredFinalizers.get('revokeDisclosure\0' + '1')!, {
            op: 'revokeDisclosure', payloadHash: VALID_PAYLOAD, grantee: VALID_GRANTEE,
            contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xrevoke', finalizedAt: null }, db);

        const update = JSON.stringify(db.run.mock.calls[0][0]);
        expect(update).toContain('0xrevoke');
        expect(update).toContain('false');
        expect(reindexer).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ reconciled: true, payloadHash: VALID_PAYLOAD, grantee: VALID_GRANTEE, txHash: '0xrevoke' });
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

// ---- registerDocument: the registrar assigns a document id to an owner ----

describe('registerDocument', () => {
    const VALID_PASSPORT = 'c'.repeat(64);
    const VALID_OWNER = 'd'.repeat(64);
    const VALID_ARGS = () => ({
        documentId: VALID_PASSPORT,
        ownerId: VALID_OWNER,
        sessionId: `regp-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test('rejects missing ownerId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ownerId: undefined });
        await srv.handlers['registerDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/ownerId is required/));
    });

    test('rejects missing sessionId', async () => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), sessionId: undefined });
        await srv.handlers['registerDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sessionId is required/));
    });

    test('happy path: single registerDocument call, no projection writes; returns { jobId, status }', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['registerDocument'](req);

        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({ jobId: 'job-registerDocument-test', status: 'pending' });

        // No DB projection for passport ownership; the chain is the source of truth.
        expect(db.run).not.toHaveBeenCalled();

        expect(submitter.call).toHaveBeenCalledTimes(1);
        const c0 = (submitter.call as Mock).mock.calls[0][0];
        expect(c0.circuit).toBe('registerDocument');
        expect(c0.args).toHaveLength(3);
        expect(c0.args[0]).toBe(0n);
        expect(c0.args[1]).toBeInstanceOf(Uint8Array);
        expect(c0.args[2]).toBeInstanceOf(Uint8Array);
    });

    test('reconciliation finalizer rebuilds the documented result from evidence', async () => {
        setupHandlersWithDb();
        const result = await registeredFinalizers.get('registerDocument\0' + '1')!({
            op: 'registerDocument', documentId: VALID_PASSPORT, ownerId: VALID_OWNER,
            contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xregister', finalizedAt: null });

        expect(result).toEqual({
            reconciled: true, documentId: VALID_PASSPORT, ownerId: VALID_OWNER, mode: 0,
            contractAddress: '0xVAULT', txHash: '0xregister'
        });
    });

    test('a command stored by an older version names the id passportId and gives the same result', async () => {
        setupHandlersWithDb();
        const result = await registeredFinalizers.get('registerDocument\0' + '1')!(currentCommand({
            op: 'registerPassport', passportId: VALID_PASSPORT, ownerId: VALID_OWNER,
            contractAddress: '0xVAULT', compiledArtifactRef: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }), {}, { txHash: '0xregister', finalizedAt: null });

        expect(result).toEqual({
            reconciled: true, documentId: VALID_PASSPORT, ownerId: VALID_OWNER, mode: 0,
            contractAddress: '0xVAULT', txHash: '0xregister'
        });
    });

    test('retract finalizer (recovery after a crash) deactivates the payload grants like the executor and reindexes', async () => {
        const reindexer = vi.fn().mockResolvedValue({ indexed: 0, deactivated: 0 });
        const { db } = setupHandlersWithDb({ disclosureReindexer: reindexer });
        const payload = 'e'.repeat(64);
        const result = await runFinalizer(registeredFinalizers.get('retractAttestation\0' + '1')!, {
            op: 'retract', mode: 0, key: payload,
            contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xretract', finalizedAt: null, blockHeight: 700 }, db);
        expect(result).toEqual({ reconciled: true, mode: 0, key: payload, contractAddress: '0xVAULT', txHash: '0xretract' });
        expect(db.run).toHaveBeenCalledTimes(1);
        const q: any = (db.run as Mock).mock.calls[0][0];
        expect(q.UPDATE).toBeDefined();
        const json = JSON.stringify(q.UPDATE);
        expect(json).toContain('"isActive":false');
        expect(json).toContain('0xretract');
        expect(json).toContain(payload);
        // The projection follows the ledger, whatever the guarded write could touch.
        expect(reindexer).toHaveBeenCalledWith(expect.objectContaining({ contractAddress: '0xVAULT', atHeight: 700 }));
    });

    test('retract finalizer for an expired-claim purge (mode 1) writes nothing', async () => {
        const { db } = setupHandlersWithDb();
        const result = await registeredFinalizers.get('purgeExpired\0' + '1')!({
            op: 'retract', mode: 1, key: 'f'.repeat(64),
            contractAddress: '0xVAULT', contractName: 'attestation-vault',
            artifactDigest: getArtifactGenerationDigest('attestation-vault')
        }, {}, { txHash: '0xpurge', finalizedAt: null });
        expect(result).toMatchObject({ reconciled: true, mode: 1 });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('a mode outside 0 to 4 is refused before any wallet work', async () => {
        const walletMaterialFactory = vi.fn();
        const { srv } = setupHandlersWithDb({ walletMaterialFactory });
        const req = makeReq({ ...VALID_ARGS(), mode: 5 });
        await srv.handlers['registerDocument'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/^mode must be 0 \(register\)/));
        expect(walletMaterialFactory).not.toHaveBeenCalled();
    });

    test('an unregister sends no owner and a registrar change sends no document id, both as zeros', async () => {
        const { srv } = setupHandlersWithDb();
        await srv.handlers['registerDocument'](makeReq({ ...VALID_ARGS(), mode: 1, ownerId: undefined }));
        expect(mockStartJob.mock.calls.at(-1)?.[0].command).toMatchObject({ mode: 1, documentId: VALID_PASSPORT, ownerId: '00'.repeat(32) });
        await srv.handlers['registerDocument'](makeReq({ ...VALID_ARGS(), mode: 2, documentId: undefined, ownerId: 'AB'.repeat(32) }));
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            kind: 'registerDocument',
            request: { mode: 2, documentId: '00'.repeat(32), ownerId: 'ab'.repeat(32), contractAddress: '0xvault' }
        });
    });

    test('retractAttestation needs the payload hash and removes the session\'s own record', async () => {
        // Only the stored job matters here; the processor stops at the submit.
        const { srv } = setupHandlersWithDb({ submitterFactory: () => ({ ...makeSuccessfulSubmitter(), call: vi.fn(async () => { throw new Error('not sent in this test'); }) }) });
        const missing = makeReq({ sessionId: 's1', contractAddress: '0xVAULT' });
        await srv.handlers['retractAttestation'](missing);
        expect(missing.reject).toHaveBeenCalledWith(400, 'payloadHash is required');

        const noVault = makeReq({ sessionId: 's1', payloadHash: 'EE'.repeat(32) });
        await srv.handlers['retractAttestation'](noVault);
        expect(noVault.reject).toHaveBeenCalledWith(400, 'contractAddress is required');

        await srv.handlers['retractAttestation'](makeReq({ sessionId: 's1', payloadHash: 'EE'.repeat(32), contractAddress: '0xVAULT' }));
        expect(mockStartJob.mock.calls.at(-1)?.[0]).toMatchObject({
            kind: 'retractAttestation',
            request: { mode: 0, key: 'ee'.repeat(32), contractAddress: '0xvault' },
            command: { op: 'retract', mode: 0, key: 'ee'.repeat(32), attesterId: ATTESTER_ID }
        });
    });

    test('purgeExpired takes only claims, needs a key and names no attester', async () => {
        const { srv } = setupHandlersWithDb();
        const wrongKind = makeReq({ kind: 'attestation', key: 'f'.repeat(64), sessionId: 's1', contractAddress: '0xVAULT' });
        await srv.handlers['purgeExpired'](wrongKind);
        expect(wrongKind.reject).toHaveBeenCalledWith(400, "kind must be 'claim'");

        const noKey = makeReq({ kind: 'claim', sessionId: 's1', contractAddress: '0xVAULT' });
        await srv.handlers['purgeExpired'](noKey);
        expect(noKey.reject).toHaveBeenCalledWith(400, 'key is required');

        const noSession = makeReq({ kind: 'claim', key: 'f'.repeat(64), contractAddress: '0xVAULT' });
        await srv.handlers['purgeExpired'](noSession);
        expect(noSession.reject).toHaveBeenCalledWith(400, 'sessionId is required');

        await srv.handlers['purgeExpired'](makeReq({ kind: 'claim', key: 'F'.repeat(64), sessionId: 's1', contractAddress: '0xVAULT' }));
        const call = mockStartJob.mock.calls.at(-1)?.[0];
        expect(call).toMatchObject({ kind: 'purgeExpired', request: { mode: 1, key: 'f'.repeat(64) }, command: { op: 'retract', mode: 1 } });
        expect(call.command.attesterId).toBeUndefined();
    });
});

// ---- registerGranteeIdentity (grantee binding) ----------------------------

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
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
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
        expect(result.granteeId).toMatch(HEX64_RE);
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

describe('arg-coercion: loadCircuitArgTypes (real attestation-vault artifact)', () => {
    const VAULT_ZK = resolveContractPackage('@odatano/contract-attestation-vault', path.resolve(__dirname, '..', '..')).zkConfigPath;

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
        registerSubmissionHandlers(srv as any, {} as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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

    test('Bytes<32> hex args reach the circuit as Uint8Array(32) (bindPassport)', async () => {
        const { srv, submitter } = setup();
        const passportId = '11'.repeat(32);
        const payloadHash = '22'.repeat(32);
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', contractName: 'x',
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

    test('attest becomes callable generically (real artifact introspection)', async () => {
        const VAULT_ZK = resolveContractPackage('@odatano/contract-attestation-vault', path.resolve(__dirname, '..', '..')).zkConfigPath;
        __clearArgTypeCacheForTests();
        // Use the REAL loader against the REAL attestation-vault artifact path.
        const { srv, submitter } = setup({
            circuitArgTypesLoader: undefined,
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE, zkConfigPath: VAULT_ZK }))
        });
        const req = makeReq({
            contractAddress: '0xVAULT', circuit: 'attest', contractName: 'attestation-vault',
            sessionId: `attest-${Date.now()}`, args: JSON.stringify(['aa'.repeat(32), 'bb'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const args = callArgsOf(submitter);
        expect(args[0]).toBeInstanceOf(Uint8Array);
        expect(args[1]).toBeInstanceOf(Uint8Array);
        expect((args[0] as Uint8Array).length).toBe(32);
    });

    test('Uint arg reaches the circuit as BigInt', async () => {
        const { srv, submitter } = setup({
            circuitArgTypesLoader: () => [{ name: 'level', kind: 'Uint', maxval: 255 }] as CircuitArgType[]
        });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'setLevel', contractName: 'x',
            sessionId: `uint-${Date.now()}`, args: JSON.stringify([2])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(callArgsOf(submitter)[0]).toBe(2n);
    });

    test('invalid hex → 400, not a deep circuit error', async () => {
        const { srv } = setup();
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', contractName: 'x',
            sessionId: `badhex-${Date.now()}`, args: JSON.stringify(['zz'.repeat(32), '22'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'ARG_COERCION_FAILED', message: expect.stringMatching(/args\[0\].*hex/) }));
    });

    test('wrong byte length → 400', async () => {
        const { srv } = setup();
        const req = makeReq({
            contractAddress: '0xC', circuit: 'bindPassport', contractName: 'x',
            sessionId: `badlen-${Date.now()}`, args: JSON.stringify(['11'.repeat(16), '22'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'ARG_COERCION_FAILED', message: expect.stringMatching(/expected 32 bytes/) }));
    });

    test('strict: untagged arg with no circuit metadata → 400 (no silent passthrough)', async () => {
        // Loader returns undefined → no contract-info.json found for the circuit.
        const { srv } = setup({ circuitArgTypesLoader: () => undefined });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'mystery', contractName: 'x',
            sessionId: `nometa-${Date.now()}`, args: JSON.stringify(['aa'.repeat(32)])
        });
        await srv.handlers['submitContractCall'](req);
        expect(req.reject).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'ARG_COERCION_FAILED', message: expect.stringMatching(/could not determine the circuit parameter type/) }));
    });

    test('strict: tagged values still work with no circuit metadata', async () => {
        const { srv, submitter } = setup({ circuitArgTypesLoader: () => undefined });
        const req = makeReq({
            contractAddress: '0xC', circuit: 'mystery', contractName: 'x',
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

// ---- proveFieldPredicate (field-bound ZK predicate) -------------

describe('proveFieldPredicate', () => {
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
        siblings: SIBLINGS,
        dirs: [true, false, true, false],
        predicate: 'lessOrEqual',
        threshold: '50000',
        unit: 'kgCO2e/kWh',
        sessionId: `fieldpred-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHash: undefined }, /payloadHash is required/],
        [{ fieldKey: undefined }, /fieldKey is required/],
        [{ value: undefined }, /value is required/],
        [{ value: '' }, /value is required/],
        [{ value: '47.3' }, /value must be an integer/],
        [{ value: '-5' }, /value must be a non-negative integer/],
        [{ fieldSalt: undefined }, /fieldSalt .*is required/],
        [{ threshold: undefined }, /threshold is required/],
        [{ threshold: 'abc' }, /threshold must be an integer/],
        [{ threshold: '18446744073709551616' }, /threshold exceeds Uint<64>/],
        [{ threshold: 2 ** 53 }, /threshold is above 2\^53 as a JSON number/],
        [{ value: 2 ** 53 + 2 }, /value is above 2\^53 as a JSON number/],
        [{ value: '0x10' }, /value must be an integer \(decimal string\)/],
        [{ predicate: 'between' }, /lessOrEqual.*greaterOrEqual/],
        [{ siblings: SIBLINGS.slice(0, 2) }, /array of 4 hashes/],
        [{ dirs: [true] }, /array of 4 booleans/],
        [{ siblings: [...SIBLINGS.slice(0, 3), 'short'] }, /siblings entries must be 64 hex/],
        [{ dirs: [true, false, 'false', true] }, /dirs entries must be booleans/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['proveFieldPredicate'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['proveFieldPredicate'](req);
            expect(req.reject).toHaveBeenCalledWith(403, expect.stringMatching(/mainnet/i));
        } finally {
            if (prev === undefined) delete process.env.NIGHTGATE_NETWORK;
            else process.env.NIGHTGATE_NETWORK = prev;
        }
    });

    // A parent that runs a second time must find its step by the same command. A default expiry computed per run would differ.
    test('without validUntil the command carries a fixed expiry, so a second run builds the same steps', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
            const { srv } = setupHandlersWithDb({ submitterFactory: () => makeSuccessfulSubmitter() });
            await srv.handlers['proveFieldPredicate'](makeReq(VALID_ARGS()));
            const started = mockStartJob.mock.calls.at(-1)?.[0];
            const expected = Math.floor(Date.parse('2026-11-20T12:00:00Z') / 1000) + 365 * 24 * 60 * 60;
            expect(started.command.validUntil).toBe(expected);
            // The fingerprint holds the caller's expiry, not the default, so a retry later still matches the first job.
            expect(started.idempotencyPayload).toMatchObject({ validUntil: null, unit: VALID_ARGS().unit });
            await srv.handlers['proveFieldPredicate'](makeReq({ ...VALID_ARGS(), validUntil: '2027-01-01T00:00:00Z', unit: 'kWh' }));
            expect(mockStartJob.mock.calls.at(-1)?.[0].idempotencyPayload).toMatchObject({ validUntil: Date.parse('2027-01-01T00:00:00Z') / 1000, unit: 'kWh' });

            const stepsOfRun = async () => {
                childCommandLog.length = 0;
                const processor = registeredProcessors.get(`proveFieldPredicate\0${started.commandVersion}`);
                await processor!({ ...started.command, artifactDigest: getArtifactGenerationDigest('attestation-vault') }, {
                    ID: 'job-rerun', kind: 'proveFieldPredicate', sessionId: started.sessionId, requestedBy: 'test-user', commandVersion: 1
                } as any);
                return childCommandLog.map(c => c.command);
            };
            const first = await stepsOfRun();
            vi.setSystemTime(new Date('2026-11-20T13:00:00Z'));
            const second = await stepsOfRun();
            expect(first).toHaveLength(2);
            expect(second).toEqual(first);
            expect(first.at(-1).args.at(-1)).toBe(String(expected));
        } finally {
            vi.useRealTimers();
        }
    });

    test('happy path with contentRoot: INSERT + anchorContentRoot + proveFieldPredicate + UPDATE; value travels only as witness', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['proveFieldPredicate'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveFieldPredicate-test',
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
        expect(prove.args).toHaveLength(5);
        expect(prove.args[2]).toBe(50000n);
        expect(prove.args[3]).toBe(0n);
        // The value + inclusion path travel as witnesses only.
        expect(prove.merkleProof).toEqual({
            fieldValue: '47300',
            fieldSalt: 'f5'.repeat(32),
            siblings: SIBLINGS,
            dirs: [true, false, true, false]
        });
        // Exact per argument: the time-derived argument may contain the digits.
        const flatArgs = prove.args.map((a: unknown) => typeof a === 'bigint' ? a.toString() : a);
        expect(flatArgs).not.toContain('47300');
    });

    test('without contentRoot only proveFieldPredicate is submitted', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ARGS(), contentRoot: undefined });

        await srv.handlers['proveFieldPredicate'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(submitter.call).toHaveBeenCalledTimes(1);
        expect((submitter.call as Mock).mock.calls[0][0].circuit).toBe('proveFieldPredicate');
    });

    test('persists the fieldKey (lowercased) so the crawler-free fallback can recompute the claim key', async () => {
        const { srv, db } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), fieldKey: VALID_FIELD_KEY.toUpperCase() });
        await srv.handlers['proveFieldPredicate'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const inserted = (db.run as Mock).mock.calls[0][0];
        expect(JSON.stringify(inserted)).toContain(VALID_FIELD_KEY);
    });
});

// ---- proveClaims (N proofs, ONE transaction) -------

describe('proveClaims', () => {
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
        claims: [makeClaim(1), makeClaim(2)],
        sessionId: `fieldpredbatch-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault',
        ...patch
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHash: undefined }, /payloadHash is required/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/],
        [{ claims: undefined }, /claims is required/],
        [{ claims: [] }, /claims is required/],
        [{ claims: [makeClaim(1, { fieldKey: 'zz' })] }, /claims\[0\].fieldKey must be 64 hex/],
        [{ claims: [makeClaim(1), makeClaim(2, { value: '' })] }, /claims\[1\].value is required/],
        [{ claims: [makeClaim(1, { value: '47.3' })] }, /claims\[0\].value must be an integer/],
        [{ claims: [makeClaim(1, { value: '-5' })] }, /claims\[0\].value must be a non-negative integer/],
        [{ claims: [makeClaim(1, { threshold: 'abc' })] }, /claims\[0\].threshold must be an integer/],
        [{ claims: [makeClaim(1, { predicate: 'between' })] }, /claims\[0\].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'/],
        [{ claims: [makeClaim(1, { siblings: SIBLINGS.slice(0, 2) })] }, /claims\[0\].siblings must be an array of 4 hashes/],
        [{ claims: [makeClaim(1, { siblings: [...SIBLINGS.slice(0, 3), 'short'] })] }, /claims\[0\].siblings entries must be 64 hex/],
        [{ claims: [makeClaim(1, { dirs: [true] })] }, /claims\[0\].dirs must be an array of 4 booleans/],
        [{ claims: [makeClaim(1, { dirs: [true, false, 'false', true] })] }, /claims\[0\].dirs entries must be booleans/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(patch));
        await srv.handlers['proveClaims'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('caps at 8 claims without anchor and 7 with an in-batch contentRoot anchor', async () => {
        const { srv } = setupHandlersWithDb();
        const nine = Array.from({ length: 9 }, (_, i) => makeClaim(i + 1));
        const eight = Array.from({ length: 8 }, (_, i) => makeClaim(i + 1));

        const reqNine = makeReq(VALID_ARGS({ contentRoot: undefined, claims: nine }));
        await srv.handlers['proveClaims'](reqNine);
        expect(reqNine.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 8 entries/));

        const reqEightWithAnchor = makeReq(VALID_ARGS({ claims: eight }));
        await srv.handlers['proveClaims'](reqEightWithAnchor);
        expect(reqEightWithAnchor.reject).toHaveBeenCalledWith(400, expect.stringMatching(/at most 7 entries.*anchor/));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['proveClaims'](req);
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

        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveClaims-test',
            status: 'pending',
            claims: expect.any(Array),
            droppedDuplicates: 0
        });
        const claims = result.claims;
        expect(claims).toHaveLength(2);
        for (const c of claims) {
            expect(c).toEqual({
                predicateAttestationId: expect.any(String),
                fieldKey: expect.stringMatching(HEX64_RE),
                predicate: 'lessOrEqual',
                threshold: expect.any(String),
                unit: 'kgCO2e/kWh',
                expectedDigest: null, setRoot: null, payloadHashB: null, allowedMask: null, k: null
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
            expect(call.args).toHaveLength(5);
            expect(call.args[2]).toBe(BigInt(50000 + i + 1));
            expect(call.args[3]).toBe(0n);
            expect(call.merkleProof).toEqual({
                fieldValue: `${1000 + i + 1}`,
                fieldSalt: 'f5'.repeat(32),
                siblings: SIBLINGS,
                dirs: [true, false, true, false]
            });
            const flatArgs = call.args.map((a: unknown) => typeof a === 'bigint' ? a.toString() : a);
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

        await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual(['proveFieldPredicate', 'proveFieldPredicate']);
    });

    test('drops exact duplicate claim tuples and reports the count (idempotent on-chain inserts)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const dupe = makeClaim(1);
        const req = makeReq(VALID_ARGS({ claims: [dupe, makeClaim(2), { ...dupe }] }));

        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(1);
        expect(result.claims).toHaveLength(2);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        // anchor + 2 unique proofs; the duplicate proved nothing extra.
        expect(batchArgs.calls).toHaveLength(3);
        const insertedEntries = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(insertedEntries.match(new RegExp(dupe.fieldKey, 'g'))).toHaveLength(1);
    });

    test('counts N claims against the prove class, not one action call; the env count applies at once', async () => {
        process.env.NIGHTGATE_PROVE_RATE_LIMIT = '10';
        const { srv } = setupHandlersWithDb();
        const sessionId = `fieldpredbatch-rate-${Math.random().toString(36).slice(2)}`;
        const eight = Array.from({ length: 8 }, (_, i) => makeClaim(i + 1));

        const first = makeReq(VALID_ARGS({ contentRoot: undefined, claims: eight, sessionId }));
        await srv.handlers['proveClaims'](first);
        expect(first.reject).not.toHaveBeenCalled();

        // 8 of the 10 per hour consumed; a 3-claim follow-up must trip 429.
        const second = makeReq(VALID_ARGS({ contentRoot: undefined, claims: [makeClaim(11), makeClaim(12), makeClaim(13)], sessionId }));
        await srv.handlers['proveClaims'](second);
        expect(second.reject).toHaveBeenCalledWith(429, expect.stringMatching(/Rate limited/));

        // All-or-nothing: the rejected batch consumed NOTHING, so the 2
        // remaining slots are still available.
        const third = makeReq(VALID_ARGS({ contentRoot: undefined, claims: [makeClaim(14), makeClaim(15)], sessionId }));
        await srv.handlers['proveClaims'](third);
        expect(third.reject).not.toHaveBeenCalled();
        delete process.env.NIGHTGATE_PROVE_RATE_LIMIT;
    });
});

// ---- proveFieldEquality (bytes equality) ------------------------

describe('proveFieldEquality', () => {
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
        siblings: SIBLINGS,
        dirs: [true, false, true, false],
        sessionId: `fieldeq-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHash: undefined }, /payloadHash is required/],
        [{ expectedDigest: undefined }, /exactly one of expectedValue \/ expectedDigest/],
        [{ expectedValue: 'NMC811' }, /exactly one of expectedValue \/ expectedDigest/],
        [{ siblings: SIBLINGS.slice(0, 2) }, /array of 4 hashes/],
        [{ dirs: [true, false, 'false', true] }, /entries must be booleans/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['proveFieldEquality'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['proveFieldEquality'](req);
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

        const result: any = await srv.handlers['proveFieldEquality'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveFieldEquality-test',
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
        expect(prove.args).toHaveLength(4);
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(EXPECTED);
        // Salted path bundle: no fieldValue, no fieldDigest, no setProof.
        expect(prove.merkleProof).toEqual({ fieldSalt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false] });
    });

    test('digests a raw expectedValue server-side (exact string, no trimming)', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq({ ...VALID_ARGS(), expectedDigest: undefined, expectedValue: ' NMC811 ' });

        await srv.handlers['proveFieldEquality'](req);
        expect(req.reject).not.toHaveBeenCalled();
        const { blake2b256Hex } = await import('../../srv/submission/document-proof.js');
        const digest = blake2b256Hex(' NMC811 ');
        const prove = (submitter.call as Mock).mock.calls[1][0];
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(digest);
        expect(JSON.stringify((db.run as Mock).mock.calls[0][0])).toContain(digest);
    });
});

// ---- proveFieldMembership (set membership) ----------------------

describe('proveFieldMembership', () => {
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
        setSiblings: SET_SIBLINGS,
        setDirs: [true, false, true, false, true, false],
        siblings: SIBLINGS,
        dirs: [true, false, true, false],
        sessionId: `fieldmem-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    /** Fake pure circuits for the allowedValues lane (set-root builder). */
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
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            pureCircuitsLoader: vi.fn(async () => fakeSetPure),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ fieldKey: undefined }, /fieldKey is required/],
        [{ valueDigest: undefined }, /exactly one of value \/ valueDigest/],
        [{ value: 'EEA' }, /exactly one of value \/ valueDigest/],
        [{ allowedValues: ['EEA'] }, /not both/],
        [{ setRoot: undefined, setSiblings: undefined, setDirs: undefined }, /allowedValues or setRoot \+ setSiblings \+ setDirs is required/],
        [{ setSiblings: SET_SIBLINGS.slice(0, 3) }, /setSiblings must be an array of 6 hashes/],
        [{ setDirs: [true, false, 'false', true, false, true] }, /setDirs entries must be booleans/],
        [{ siblings: SIBLINGS.slice(0, 2) }, /array of 4 hashes/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['proveFieldMembership'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('happy path (precomputed set lane): proveFieldMembership with digest + both paths as witnesses only', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['proveFieldMembership'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveFieldMembership-test',
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
        expect(prove.args).toHaveLength(4);
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

    test('allowedValues lane: builds the canonical set, rejects non-members BEFORE any job', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const { blake2b256Hex } = await import('../../srv/submission/document-proof.js');
        const { buildMembershipSet, membershipPathFor } = await import('../../srv/submission/set-root.js');

        const list = ['EEA', 'CH', 'NO'];
        const expected = membershipPathFor(list, blake2b256Hex('CH'), fakeSetPure)!;

        const ok = makeReq({
            ...VALID_ARGS(), valueDigest: undefined, value: 'CH',
            setRoot: undefined, setSiblings: undefined, setDirs: undefined,
            allowedValues: list
        });
        await srv.handlers['proveFieldMembership'](ok);
        expect(ok.reject).not.toHaveBeenCalled();
        const prove = (submitter.call as Mock).mock.calls[0][0];
        expect(Buffer.from(prove.args[2]).toString('hex')).toBe(buildMembershipSet(list, fakeSetPure).setRoot);
        expect(prove.merkleProof.setProof).toEqual({ siblings: expected.setSiblings, dirs: expected.setDirs });

        (db.run as Mock).mockClear();
        const notInList = makeReq({
            ...VALID_ARGS(), valueDigest: undefined, value: 'DE',
            setRoot: undefined, setSiblings: undefined, setDirs: undefined,
            allowedValues: list
        });
        await srv.handlers['proveFieldMembership'](notInList);
        expect(notInList.reject).toHaveBeenCalledWith(400, expect.stringMatching(/not in the allowed list/));
        expect(db.run).not.toHaveBeenCalled(); // no row, no job, no budget spent
    });
});

// ---- Mixed batch (numeric + equality + membership in ONE tx) ---------------

describe('proveClaims: mixed claim kinds', () => {
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
        claims: [numericClaim, equalityClaim, membershipClaim],
        sessionId: `mixedbatch-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault',
        ...patch
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ claims: [{ ...equalityClaim, expectedDigest: undefined }] }, /claims\[0\]: pass exactly one of expectedValue \/ expectedDigest/],
        [{ claims: [{ ...membershipClaim, valueDigest: undefined }] }, /claims\[0\]: pass exactly one of value \/ valueDigest/],
        [{ claims: [{ ...membershipClaim, setRoot: undefined }] }, /claims\[0\]: allowedValues or setRoot \+ setSiblings \+ setDirs is required/],
        [{ claims: [{ ...membershipClaim, allowedValues: ['x'] }] }, /claims\[0\]: pass either allowedValues or setRoot/],
        [{ claims: [{ ...membershipClaim, setSiblings: SET_SIBLINGS.slice(0, 3) }] }, /claims\[0\].setSiblings must be an array of 6 hashes/],
        [{ claims: [{ ...numericClaim, predicate: 'between' }] }, /claims\[0\].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(patch));
        await srv.handlers['proveClaims'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('one callBatch carries anchor + all three claim kinds with per-kind args and bundles', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(0);
        const claims = result.claims;
        expect(claims.map((c: any) => c.predicate)).toEqual(['lessOrEqual', 'bytesEquality', 'setMembership']);
        expect(claims[1].expectedDigest).toBe(EXPECTED);
        expect(claims[2].setRoot).toBe(SET_ROOT);

        expect(submitter.callBatch).toHaveBeenCalledTimes(1);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual([
            'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership'
        ]);

        const [, numeric, equality, membership] = batchArgs.calls;
        expect(numeric.args).toHaveLength(5);
        expect(numeric.merkleProof.fieldValue).toBe('1001');
        expect(equality.args).toHaveLength(4);
        expect(Buffer.from(equality.args[2]).toString('hex')).toBe(EXPECTED);
        expect(equality.merkleProof).toEqual({ fieldSalt: 'f5'.repeat(32), siblings: SIBLINGS, dirs: [true, false, true, false] });
        expect(membership.args).toHaveLength(4);
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
            claims: [
                equalityClaim, { ...equalityClaim }, // exact dupe -> dropped
                membershipClaim, { ...membershipClaim, valueDigest: 'd'.repeat(64) } // same (fieldKey, setRoot) -> dropped
            ]
        }));

        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(2);
        const batchArgs = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batchArgs.calls.map((c: any) => c.circuit)).toEqual([
            'anchorContentRoot', 'proveFieldEquality', 'proveFieldMembership'
        ]);
    });
});

// ---- cross-root document proofs --------------------------------------------

// Shared cross-root fixtures: one schema, two openings.
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

describe('proveDocumentIntegrity', () => {
    const PAYLOAD_A = 'a'.repeat(64);
    const PAYLOAD_B = 'b'.repeat(64);
    const ROOT_A = 'd'.repeat(64);
    const ROOT_B = 'e'.repeat(64);
    const SCHEMA_ID = 'ab'.repeat(32);
    const VALID_ARGS = () => ({
        payloadHashA: PAYLOAD_A,
        payloadHashB: PAYLOAD_B,
        allowedMask: 5,
        schema: DOC_SCHEMA,
        openingA: DOC_OPENING_A,
        openingB: DOC_OPENING_B,
        contentRootA: ROOT_A,
        contentRootB: ROOT_B,
        schemaId: SCHEMA_ID,
        sessionId: `docinteg-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter()),
            ...overrides
        });
        return { srv, db };
    }

    test.each([
        [{ payloadHashA: undefined }, /payloadHashA is required/],
        [{ payloadHashB: undefined }, /payloadHashB is required/],
        [{ payloadHashB: PAYLOAD_A.toUpperCase() }, /must differ/],
        [{ allowedMask: undefined }, /allowedMask is required/],
        [{ allowedMask: -1 }, /0\.\.65535/],
        [{ allowedMask: 65536 }, /0\.\.65535/],
        [{ allowedMask: 1.5 }, /0\.\.65535/],
        [{ allowedMask: 0xffff }, /vacuous/],
        // DOC_SCHEMA has exactly 2 real slots (0, 1); mask 3 frees both.
        [{ allowedMask: 3 }, /frees every real \(non-padding\) schema slot/],
        [{ schema: DOC_SCHEMA.slice(0, 15) }, /exactly 16 slot descriptors/],
        [{ schema: [{ ...DOC_SCHEMA[0], kind: 9 }, ...DOC_SCHEMA.slice(1)] }, /kind must be 0/],
        [{ openingA: { ...DOC_OPENING_A, saltSeed: 'zz' } }, /saltSeed must be 64 hex/],
        [{ openingB: { ...DOC_OPENING_B, slots: [{ present: true }, ...DOC_OPENING_B.slots.slice(1)] } }, /present slot needs value or valueDigest/],
        [{ schemaId: undefined }, /schemaId is required when anchoring/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['proveDocumentIntegrity'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('is blocked on mainnet by default (403)', async () => {
        const prev = process.env.NIGHTGATE_NETWORK;
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        try {
            const { srv } = setupHandlersWithDb();
            const req = makeReq(VALID_ARGS());
            await srv.handlers['proveDocumentIntegrity'](req);
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

        const result: any = await srv.handlers['proveDocumentIntegrity'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveDocumentIntegrity-test',
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
        expect(prove.args).toHaveLength(6);
        expect(Buffer.from(prove.args[0]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_A));
        expect(Buffer.from(prove.args[1]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_B));
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
        await srv.handlers['proveDocumentIntegrity'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(submitter.call).toHaveBeenCalledTimes(1);
        expect((submitter.call as Mock).mock.calls[0][0].circuit).toBe('proveDocumentComparison');
    });
});

describe('proveDocumentDiff', () => {
    const PAYLOAD_A = 'a'.repeat(64);
    const PAYLOAD_B = 'b'.repeat(64);
    const VALID_ARGS = () => ({
        payloadHashA: PAYLOAD_A,
        payloadHashB: PAYLOAD_B,
        k: 2,
        schema: DOC_SCHEMA,
        openingA: DOC_OPENING_A,
        openingB: DOC_OPENING_B,
        sessionId: `docdiff-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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
        [{ schema: DOC_SCHEMA.slice(0, 15) }, /schema must be an array of exactly 16 slot descriptors/],
        [{ schema: [{ fieldKey: 'zz', kind: 0, scale: '1' }, ...DOC_SCHEMA.slice(1)] }, /fieldKey must be 64 hex/],
        [{ openingA: { ...DOC_OPENING_A, slots: DOC_OPENING_A.slots.slice(0, 15) } }, /openingA.slots must be an array of exactly 16/],
        [{ sessionId: undefined }, /sessionId is required/],
        [{ contractAddress: undefined }, /contractAddress is required/]
    ])('rejects %o', async (patch, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq({ ...VALID_ARGS(), ...patch });
        await srv.handlers['proveDocumentDiff'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('happy path: proveDocumentComparison (diff mode) with k as BigInt and docPair openings; k lands in its own column', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS());

        const result: any = await srv.handlers['proveDocumentDiff'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result).toEqual({
            jobId: 'job-proveDocumentDiff-test',
            status: 'pending',
            predicateAttestationId: expect.any(String)
        });

        const inserted = JSON.stringify((db.run as Mock).mock.calls[0][0]);
        expect(inserted).toContain('documentDiff');
        expect(inserted).toContain(PAYLOAD_B);
        expect((db.run as Mock).mock.calls[0][0].INSERT.entries[0]).toMatchObject({ k: 2, threshold: null });

        expect(submitter.call).toHaveBeenCalledTimes(1);
        const prove = (submitter.call as Mock).mock.calls[0][0];
        expect(prove.circuit).toBe('proveDocumentComparison');
        // (a, b, mode=1, mask-dummy, k)
        expect(prove.args).toHaveLength(6);
        expect(Buffer.from(prove.args[0]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_A));
        expect(Buffer.from(prove.args[1]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_B));
        expect(prove.args[2]).toBe(1n);
        expect((prove.args[3] as boolean[]).filter(Boolean)).toHaveLength(0);
        expect(prove.args[4]).toBe(2n);
        expect(prove.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });
    });
});

describe('proveClaims: cross-root document claims', () => {
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
        claims: claims,
        sessionId: `docbatch-${Math.random().toString(36).slice(2)}`,
        contractAddress: '0xVAULT',
        contractName: 'attestation-vault'
    });

    function setupHandlersWithDb(overrides: any = {}) {
        const srv = makeFakeService();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(srv as any, db, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'a',
                privateStoragePasswordProvider: () => '0123456789ABCDEFG',
                walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
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
        [[{ ...integrityClaim, schema: DOC_SCHEMA.slice(0, 15) }], /schema must be an array of exactly 16 slot descriptors/],
        [[{ ...diffClaim, k: 0 }], /k must be an integer in 1\.\.16/],
        [[{ ...diffClaim, openingB: { ...DOC_OPENING_B, slots: DOC_OPENING_B.slots.slice(0, 15) } }], /openingB.slots must be an array of exactly 16/],
        [[{ ...diffClaim, openingA: { ...DOC_OPENING_A, saltSeed: 'zz' } }], /saltSeed must be 64 hex/]
    ])('rejects %o', async (claims, msg) => {
        const { srv } = setupHandlersWithDb();
        const req = makeReq(VALID_ARGS(claims as unknown[]));
        await srv.handlers['proveClaims'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(msg));
    });

    test('mixed batch: numeric + integrity + diff assemble one callBatch in claim order', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS([numericClaim, integrityClaim, diffClaim]));

        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(0);
        const claims = result.claims;
        expect(claims).toHaveLength(3);
        expect(claims[1]).toMatchObject({ predicate: 'documentIntegrity', payloadHashB: PAYLOAD_B, allowedMask: 1 });
        expect(claims[2]).toMatchObject({ predicate: 'documentDiff', payloadHashB: PAYLOAD_B, k: 1 });

        expect(submitter.callBatch).toHaveBeenCalledTimes(1);
        const batch = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batch.calls.map((c: any) => c.circuit)).toEqual([
            'proveFieldPredicate', 'proveDocumentComparison', 'proveDocumentComparison'
        ]);
        const integ = batch.calls[1];
        expect(Buffer.from(integ.args[0]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_A));
        expect(Buffer.from(integ.args[1]).toString('hex')).toBe(await computeRecordKey(ATTESTER_ID, PAYLOAD_B));
        expect(integ.args[2]).toBe(0n);
        const mask = integ.args[3] as boolean[];
        // mask 1 = slot 0 only (mask 3 would free BOTH real slots of the
        // 2-real-field DOC_SCHEMA and is rejected as vacuous).
        expect(mask.filter(Boolean)).toHaveLength(1);
        expect(mask[0]).toBe(true);
        expect(integ.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });
        const diff = batch.calls[2];
        expect(diff.args[2]).toBe(1n);
        expect(diff.args[4]).toBe(1n);
        expect(diff.merkleProof).toEqual({ docPair: { schema: DOC_SCHEMA, openingA: DOC_OPENING_A, openingB: DOC_OPENING_B } });

        // Rows: only the numeric claim has a threshold, only the diff a k; both document kinds carry payloadHashB.
        const rows: Array<Record<string, unknown>> = (db.run as Mock).mock.calls[0][0].INSERT.entries;
        expect(rows.map(r => [r.predicate, r.threshold, r.k])).toEqual([
            ['greaterOrEqual', '1000', null], ['documentIntegrity', null, null], ['documentDiff', null, 1]
        ]);
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
        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(1);
        const batch = (submitter.callBatch as Mock).mock.calls[0][0];
        expect(batch.calls.map((c: any) => c.circuit)).toEqual([
            'proveDocumentComparison', 'proveDocumentComparison', 'proveDocumentComparison'
        ]);
        expect(batch.calls.map((c: any) => c.args[2])).toEqual([0n, 1n, 1n]);
    });

    test('a comparison that names the batch attester as attesterIdB equals one that leaves it out', async () => {
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS([integrityClaim, { ...integrityClaim, attesterIdB: ATTESTER_ID.toUpperCase() }]));
        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(1);
        expect((submitter.callBatch as Mock).mock.calls[0][0].calls).toHaveLength(1);
        // The row names the attester of document B, like the single actions do.
        const row = (db.run as Mock).mock.calls[0][0].INSERT.entries[0];
        expect(row).toMatchObject({ predicate: 'documentIntegrity', attesterIdB: ATTESTER_ID });
    });

    test('a comparison against another attester keeps that attester and stays a claim of its own', async () => {
        const OTHER = 'c7'.repeat(32);
        const submitter = makeSuccessfulSubmitter();
        const { srv, db } = setupHandlersWithDb({ submitterFactory: () => submitter });
        const req = makeReq(VALID_ARGS([integrityClaim, { ...integrityClaim, attesterIdB: OTHER }]));
        const result: any = await srv.handlers['proveClaims'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.droppedDuplicates).toBe(0);
        const rows = (db.run as Mock).mock.calls[0][0].INSERT.entries;
        expect(rows.map((r: any) => r.attesterIdB)).toEqual([ATTESTER_ID, OTHER]);
    });
});

// ---- artifact-generation provenance gates -----------------------------------

describe('artifact-generation provenance', () => {
    const procKey = (kind: string, v: number) => kind + String.fromCharCode(0) + v;

    it('workflow children INHERIT the parent artifactDigest (no re-stamp at child time)', async () => {
        childCommandLog.length = 0;
        const submitter = makeSuccessfulSubmitter();
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(makeFakeService() as any, db as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => submitter)
        });
        const parentDigest = getArtifactGenerationDigest('attestation-vault');
        const processor = registeredProcessors.get(procKey('proveFieldPredicate', 1));
        expect(processor).toBeTruthy();
        await processor!({
            op: 'fieldPredicateWorkflow', predicateAttestationId: 'pa-prov-1',
            payloadHash: 'aa'.repeat(32), attesterId: ATTESTER_ID, fieldKey: 'bb'.repeat(32),
            contractAddress: '0xV', contractName: 'attestation-vault',
            predicate: 'lessOrEqual', threshold: '42', opCode: 0,
            value: '41', salt: 'cc'.repeat(32),
            siblings: ['dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32)],
            dirs: [true, false, true, false],
            contentRoot: 'ee'.repeat(32), schemaId: 'ff'.repeat(32),
            artifactDigest: parentDigest
        }, {
            ID: 'job-prov-parent', kind: 'proveFieldPredicate',
            sessionId: 'sess-prov', requestedBy: 'test-user', commandVersion: 1
        } as any);
        // anchorContentRoot child + proveFieldPredicate child, both carrying
        // the PARENT's digest as passed by the handler (not re-stamped).
        expect(childCommandLog.length).toBe(2);
        for (const entry of childCommandLog) {
            expect(entry.command.artifactDigest).toBe(parentDigest);
        }
    });

    it('a parent that runs again an hour later hands its steps the same commands', async () => {
        // A step is found again by its key and its payload. A step command that changed between runs would conflict.
        const db = { run: vi.fn().mockResolvedValue(undefined) };
        registerSubmissionHandlers(makeFakeService() as any, db as any, {
            attesterIdResolver: vi.fn(async () => ATTESTER_ID),
            resolveContractImpl: vi.fn(async () => ({ ...RESOLVED_CONTRACT_FIXTURE })),
            walletMaterialFactory: vi.fn(async () => ({
                accountId: 'acc', privateStoragePasswordProvider: () => '0123456789ABCDEFG', walletAndMidnightProvider: { getCoinPublicKey: () => '', getEncryptionPublicKey: () => '' }
            })),
            submitterFactory: vi.fn(() => makeSuccessfulSubmitter())
        });
        const processor = registeredProcessors.get(procKey('proveFieldPredicate', 1))!;
        const parentCommand = {
            op: 'fieldPredicateWorkflow', predicateAttestationId: 'pa-rerun-1', validUntil: 1_900_000_000,
            payloadHash: 'aa'.repeat(32), attesterId: ATTESTER_ID, fieldKey: 'bb'.repeat(32),
            contractAddress: '0xV', contractName: 'attestation-vault',
            predicate: 'lessOrEqual', threshold: '42', opCode: 0, value: '41', salt: 'cc'.repeat(32),
            siblings: ['dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32), 'dd'.repeat(32)], dirs: [true, false, true, false],
            contentRoot: 'ee'.repeat(32), schemaId: 'ff'.repeat(32), artifactDigest: getArtifactGenerationDigest('attestation-vault')
        };
        const parentRow = { ID: 'job-rerun-parent', kind: 'proveFieldPredicate', sessionId: 'sess-rerun', requestedBy: 'test-user', commandVersion: 1 } as any;
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-11-24T10:00:00Z'));
            childCommandLog.length = 0;
            await processor(parentCommand, parentRow);
            const firstRun = childCommandLog.map(c => ({ ...c }));
            vi.setSystemTime(new Date('2026-11-24T11:00:00Z'));
            childCommandLog.length = 0;
            await processor(parentCommand, parentRow);
            expect(firstRun.length).toBeGreaterThan(0);
            expect(childCommandLog).toEqual(firstRun);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reconciliation finalizer fails closed on a missing or mismatched digest', async () => {
        const finalize = registeredFinalizers.get(procKey('anchorDocument', 1));
        expect(finalize).toBeTruthy();
        const evidence: any = { txHash: '0xtx', finalizedAt: '2026-08-16T00:00:00Z' };
        const base = {
            op: 'anchorDocument', anchorId: 'doc-prov-1', payloadHash: 'aa'.repeat(32),
            metadataHash: 'bb'.repeat(32), contractAddress: '0xV', contractName: 'attestation-vault'
        };
        await expect(finalize!(base, { ID: 'job-prov-r1' } as any, evidence))
            .rejects.toThrow(/no artifact-generation digest/);
        await expect(finalize!({ ...base, artifactDigest: 'ff'.repeat(32) }, { ID: 'job-prov-r2' } as any, evidence))
            .rejects.toThrow(/different generation/);
    });
});
