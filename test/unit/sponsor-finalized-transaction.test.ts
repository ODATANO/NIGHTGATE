/**
 * `sponsorFinalizedTransaction` (0.17.0): the sponsor pays for whatever bytes
 * it is handed, so the two things that must hold are (a) an idempotency key
 * dedupes on the TRANSACTION, not on its size, and (b) the allow-list travels
 * with the job.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const startJobCalls = vi.hoisted(() => [] as any[]);
const processors = vi.hoisted(() => new Map<string, (command: any, job: any) => Promise<unknown>>());
// The VERSION each processor registered under: startJob only finds a
// processor registered under the SAME version its action passes as
// commandVersion (background-jobs processorKey), so a mismatch is a live 500
// on every job of that kind while unit tests that ignore the version stay green.
const processorVersions = vi.hoisted(() => new Map<string, number>());
const workerCalls = vi.hoisted(() => [] as any[]);
const workerImpl = vi.hoisted(() => ({ fn: async (_args: any): Promise<any> => ({ txHash: '00aa', circuits: ['attest'], contractAddress: 'c' }) }));
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: vi.fn(async (args: any) => { startJobCalls.push(args); return { jobId: 'job-1', status: 'pending' }; }),
    runChildCommand: vi.fn(),
    registerBackgroundJobProcessor: vi.fn((kind: string, v: number, fn: any) => { processors.set(kind, fn); processorVersions.set(kind, v); }),
    registerBackgroundJobReconciliationFinalizer: vi.fn()
}));
const unboundWorkerCalls = vi.hoisted(() => [] as any[]);
const unboundWorkerImpl = vi.hoisted(() => ({ fn: async (_args: any): Promise<any> => ({ txHash: '00bb', circuits: ['attest'], contractAddress: 'c', note: 'b' }) }));
const unboundIntentHooks = vi.hoisted(() => [] as any[]);
const boundIntentHooks = vi.hoisted(() => [] as any[]);
vi.mock('../../srv/midnight/wallet-worker-client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    walletSponsorFinalizedTx: vi.fn(async (args: any, onSubmitIntent?: any) => { workerCalls.push(args); boundIntentHooks.push(onSubmitIntent); return workerImpl.fn(args); }),
    walletSponsorUnboundTx: vi.fn(async (args: any, onSubmitIntent?: any) => { unboundWorkerCalls.push(args); unboundIntentHooks.push(onSubmitIntent); return unboundWorkerImpl.fn(args); })
}));
const boundaryCalls = vi.hoisted(() => [] as any[]);
vi.mock('../../srv/submission/job-execution-context', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportExternalExecution: vi.fn(async (h: any) => { boundaryCalls.push(['external_execution', h]); }),
    reportExternalSubmission: vi.fn(async (h: any) => { boundaryCalls.push(['submitted', h]); }),
    reportSubmissionRejected: vi.fn(async (h: any) => { boundaryCalls.push(['rejected', h]); })
}));
vi.mock('../../srv/submission/fee-sponsor', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveFeeSponsor: vi.fn(async () => ({ sponsorSessionId: 'sponsor-1', accountId: 'acct-1' })),
    ensureFeeSponsorFacade: vi.fn(async () => undefined)
}));
vi.mock('../../srv/midnight/providers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureNetworkId: vi.fn(async () => undefined)
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import {
    __resetSponsorPoolForTests, envMsSetting, pickFreeSponsor,
    acquireSponsor, releaseSponsor, PLATFORM_POOL_SENTINEL, sponsorCandidatesNonExclusive
} from '../../srv/submission/sponsor-pool';
import { resolveFeeSponsor } from '../../srv/submission/fee-sponsor';
import { reportExternalSubmission } from '../../srv/submission/job-execution-context';

function makeFakeService() {
    const handlers: Record<string, (req: any) => Promise<unknown>> = {};
    return { handlers, on: vi.fn((action: string, fn: any) => { handlers[action] = fn; }) };
}
function makeReq(data: Record<string, unknown>) {
    return { data, user: { id: 'test-user' }, reject: vi.fn((status: number, message: string) => { const e: any = new Error(message); e.status = status; return e; }) };
}
// db.run captures PendingSubmissions writes (one row per broadcast attempt).
const dbWrites: any[] = [];
const fakeDb = { run: vi.fn(async (q: any) => { dbWrites.push(q); return 1; }) };
function setup() {
    const srv = makeFakeService();
    registerSubmissionHandlers(srv as any, fakeDb as any, {
        resolveContractImpl: vi.fn(),
        walletMaterialFactory: vi.fn(),
        submitterFactory: vi.fn()
    } as any);
    return srv;
}

/** Two DIFFERENT transactions that serialize to the SAME number of base64 chars. */
const TX_A = Buffer.from(new Uint8Array(600).fill(0xa1)).toString('base64');
const TX_B = Buffer.from(new Uint8Array(600).fill(0xb2)).toString('base64');

describe('sponsorFinalizedTransaction', () => {
    beforeEach(() => {
        startJobCalls.length = 0;
        workerCalls.length = 0;
        __resetSponsorPoolForTests();
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        workerImpl.fn = async () => ({ txHash: '00aa', circuits: ['attest'], contractAddress: 'c' });
    });

    test('rejects without finalizedTxB64 or sponsorSessionId', async () => {
        const srv = setup();
        const r1 = makeReq({ sponsorSessionId: 's' });
        await srv.handlers['sponsorFinalizedTransaction'](r1);
        expect(r1.reject).toHaveBeenCalledWith(400, expect.stringMatching(/finalizedTxB64/));

        const r2 = makeReq({ finalizedTxB64: TX_A });
        await srv.handlers['sponsorFinalizedTransaction'](r2);
        expect(r2.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sponsorSessionId/));
    });

    test('fingerprints the transaction CONTENT, so equal-length bodies do not dedupe', async () => {
        // The bug this pins: a length-only fingerprint made these two requests
        // identical, and the second caller was handed the first one's job, so a
        // different transaction than the one submitted would have been reported.
        expect(TX_A.length).toBe(TX_B.length);
        expect(TX_A).not.toBe(TX_B);

        const srv = setup();
        await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1', idempotencyKey: 'same-key' }));
        await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_B, sponsorSessionId: 'sponsor-1', idempotencyKey: 'same-key' }));

        expect(startJobCalls).toHaveLength(2);
        expect(startJobCalls[0].request).not.toEqual(startJobCalls[1].request);
        expect(startJobCalls[0].request.txHash).toBe(bytesToHex(sha256(Buffer.from(TX_A, 'base64'))));
        expect(startJobCalls[1].request.txHash).toBe(bytesToHex(sha256(Buffer.from(TX_B, 'base64'))));
    });

    test('the same transaction under the same key keeps one fingerprint', async () => {
        const srv = setup();
        await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1', idempotencyKey: 'same-key' }));
        await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1', idempotencyKey: 'same-key' }));
        expect(startJobCalls[0].request).toEqual(startJobCalls[1].request);
    });

    test('returns the SPONSOR session the job is keyed by (agent grants inject it server-side)', async () => {
        const srv = setup();
        const out: any = await srv.handlers['sponsorFinalizedTransaction'](
            makeReq({ finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1' }));
        expect(out).toMatchObject({ jobId: 'job-1', status: 'pending', sessionId: 'sponsor-1' });
    });

    test('pool jobs are keyed under the SENTINEL: stable idempotency identity', async () => {
        // The review finding this pins: keying under whichever member was free
        // made a retry with the same idempotencyKey land under a DIFFERENT
        // session and start a second job.
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        const srv = setup();
        const out1: any = await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, idempotencyKey: 'k1' }));
        const out2: any = await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, idempotencyKey: 'k1' }));
        expect(out1.sessionId).toBe(PLATFORM_POOL_SENTINEL);
        expect(out2.sessionId).toBe(PLATFORM_POOL_SENTINEL);
        expect(startJobCalls[0].sessionId).toBe(PLATFORM_POOL_SENTINEL);
        expect(startJobCalls[1].sessionId).toBe(PLATFORM_POOL_SENTINEL);
        expect(startJobCalls[0].request).toEqual(startJobCalls[1].request); // identical dedupe identity
    });

    test('a broken pool member does not block ADMISSION (no resolve before startJob)', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'dead-1,pool-2';
        const srv = setup();
        const callsBefore = (resolveFeeSponsor as any).mock.calls.length;
        const req = makeReq({ finalizedTxB64: TX_A });
        const out: any = await srv.handlers['sponsorFinalizedTransaction'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(out.sessionId).toBe(PLATFORM_POOL_SENTINEL);
        // deferred to the processor: admission resolved NO sponsor
        expect((resolveFeeSponsor as any).mock.calls.length).toBe(callsBefore);
    });

    test('omitted sponsor WITHOUT a pool still rejects 400', async () => {
        const srv = setup();
        const req = makeReq({ finalizedTxB64: TX_A });
        await srv.handlers['sponsorFinalizedTransaction'](req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/sponsorSessionId is required/));
    });

    test('a fully busy pool QUEUES until a lease frees up instead of failing instantly', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        await acquireSponsor(['pool-1'], 0);
        await acquireSponsor(['pool-2'], 0);
        setTimeout(() => releaseSponsor('pool-2'), 400);
        const processor = processors.get('sponsorFinalizedTransaction')!;
        const out: any = await processor(
            { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL },
            { ID: 'j', sessionId: PLATFORM_POOL_SENTINEL, requestedBy: 'test-user', commandVersion: 1 }
        );
        expect(out.txHash).toBe('00aa');
    });

    test('a NaN lease-wait env falls back to the default instead of waiting forever', async () => {
        for (const bad of ['abc', 'Infinity', 'NaN', '-5', '1.5']) {
            process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS = bad;
            expect(envMsSetting('NIGHTGATE_SPONSOR_LEASE_WAIT_MS', 120_000), bad).toBe(120_000);
        }
        process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS = '0';
        expect(envMsSetting('NIGHTGATE_SPONSOR_LEASE_WAIT_MS', 120_000)).toBe(0);
        delete process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS;
    });

    test('the LAST failing sponsor is benched too, so the next job skips it', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1';
        process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS = '0';
        try {
            setup();
            const processor = processors.get('sponsorFinalizedTransaction')!;
            workerImpl.fn = async () => { throw new Error('wallet not genuinely synced within 180000ms'); };
            await expect(processor(
                { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL },
                { ID: 'j', sessionId: PLATFORM_POOL_SENTINEL, requestedBy: 'test-user', commandVersion: 1 }
            )).rejects.toThrow(/genuinely synced/);
            expect(pickFreeSponsor(['pool-1'])).toBeNull(); // benched, not merely released
        } finally {
            delete process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS;
        }
    });

    test('a pool member whose RESOLUTION fails (FeeSponsorError) fails over too', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'dead-1,pool-2';
        setup();
        (resolveFeeSponsor as any).mockImplementationOnce(async () => {
            const e: any = new Error('Sponsor session has no signing key.');
            e.name = 'FeeSponsorError';
            throw e;
        });
        const processor = processors.get('sponsorFinalizedTransaction')!;
        const out: any = await processor(
            { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL },
            { ID: 'j', sessionId: PLATFORM_POOL_SENTINEL, requestedBy: 'test-user', commandVersion: 1 }
        );
        expect(out.txHash).toBe('00aa'); // second member landed
    });

    test('the processor fails over to the next pool sponsor on a retryable failure', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        const processor = processors.get('sponsorFinalizedTransaction')!;
        let calls = 0;
        workerImpl.fn = async () => {
            if (++calls === 1) throw new Error('wallet not genuinely synced within 180000ms');
            return { txHash: '00bb', circuits: ['attest'], contractAddress: 'c' };
        };
        const out: any = await processor(
            { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL },
            { ID: 'j', sessionId: 'pool-1', requestedBy: 'test-user', commandVersion: 1 }
        );
        expect(out.txHash).toBe('00bb');
        expect(calls).toBe(2); // first candidate failed retryably, second landed
    });

    test('a NON-retryable failure does not burn the rest of the pool', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        const processor = processors.get('sponsorFinalizedTransaction')!;
        let calls = 0;
        workerImpl.fn = async () => { calls++; throw new Error("refusing to sponsor: circuit 'evil' is not sponsorable"); };
        await expect(processor(
            { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL },
            { ID: 'j', sessionId: 'pool-1', requestedBy: 'test-user', commandVersion: 1 }
        )).rejects.toThrow(/not sponsorable/);
        expect(calls).toBe(1); // policy refusals fail identically everywhere; no retry
    });

    test('an explicit sponsor stays exact: no failover across the pool', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        const processor = processors.get('sponsorFinalizedTransaction')!;
        let calls = 0;
        workerImpl.fn = async () => { calls++; throw new Error('wallet not genuinely synced within 180000ms'); };
        await expect(processor(
            { op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: 'pool-1' },
            { ID: 'j', sessionId: 'pool-1', requestedBy: 'test-user', commandVersion: 1 }
        )).rejects.toThrow(/genuinely synced/);
        expect(calls).toBe(1);
    });

    test('carries the sponsor allow-list into the persisted command', async () => {
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS = '0xVAULT, 0xOTHER';
        process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS = 'attest';
        try {
            const srv = setup();
            await srv.handlers['sponsorFinalizedTransaction'](makeReq({ finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1' }));
            expect(startJobCalls[0].command).toMatchObject({
                op: 'sponsorFinalized',
                allowedContracts: ['0xVAULT', '0xOTHER'],
                allowedCircuits: ['attest']
            });
            expect(startJobCalls[0].encryptCommand).toBe(true);
        } finally {
            delete process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS;
            delete process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS;
        }
    });
});

describe('sponsorUnboundTransaction (0.18 parallel channel)', () => {
    beforeEach(() => {
        startJobCalls.length = 0;
        __resetSponsorPoolForTests();
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
    });

    test('starts its job under the command version its processor is registered with', async () => {
        // Regression: the processor was once registered with an env-derived
        // "concurrency" in the VERSION slot (default 4), so startJob looked for
        // v1 and every live job failed with "no command processor registered".
        const srv = setup();
        const req = makeReq({ unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1' });
        await srv.handlers['sponsorUnboundTransaction'](req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(startJobCalls).toHaveLength(1);
        expect(startJobCalls[0].kind).toBe('sponsorUnboundTransaction');
        expect(processorVersions.get('sponsorUnboundTransaction')).toBe(startJobCalls[0].commandVersion);
        expect(startJobCalls[0].commandVersion).toBe(1);
    });

    test('every replayable job any handler starts has a processor under that exact version', async () => {
        const srv = setup();
        for (const [action, data] of [
            ['sponsorFinalizedTransaction', { finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1' }],
            ['sponsorUnboundTransaction', { unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1' }]
        ] as const) {
            await srv.handlers[action](makeReq(data));
        }
        expect(startJobCalls.length).toBeGreaterThanOrEqual(2);
        for (const call of startJobCalls) {
            if (call.command === undefined) continue; // non-replayable jobs need no processor
            expect(processorVersions.get(call.kind), `processor version for ${call.kind}`).toBe(call.commandVersion);
        }
    });
});

describe('sponsorUnboundTransaction pool spread', () => {
    beforeEach(() => {
        startJobCalls.length = 0;
        unboundWorkerCalls.length = 0;
        __resetSponsorPoolForTests();
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-a,pool-b,pool-c,pool-d';
        vi.mocked(resolveFeeSponsor).mockImplementation(async ({ sponsorSessionId }: any) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` } as any));
    });

    test('concurrent pool jobs go to DIFFERENT wallets (LRU touch happens before the first await)', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        // The worker holds each sponsoring for a while, like a real prove+submit.
        unboundWorkerImpl.fn = async () => { await new Promise((r) => setTimeout(r, 30)); return { txHash: '00bb', circuits: ['attest'], contractAddress: 'c', note: 'b' }; };
        const command = { op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL, allowedContracts: [], allowedCircuits: [] };
        const job = { ID: 'j', requestedBy: 'u' } as any;
        await Promise.all([proc(command, job), proc(command, job), proc(command, job), proc(command, job)]);
        const used = unboundWorkerCalls.map((c) => c.sponsorSessionId);
        expect(new Set(used).size).toBe(4);
        expect(used.sort()).toEqual(['acct-pool-a', 'acct-pool-b', 'acct-pool-c', 'acct-pool-d']);
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
    });
});

describe('sponsorUnboundTransaction external-effect boundary', () => {
    beforeEach(() => {
        boundaryCalls.length = 0; unboundIntentHooks.length = 0; dbWrites.length = 0; unboundWorkerCalls.length = 0;
        __resetSponsorPoolForTests();
        process.env.NIGHTGATE_SPONSOR_DUST_RETRIES = '2';
        process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS = '0';
        vi.mocked(resolveFeeSponsor).mockImplementation(async ({ sponsorSessionId }: any) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` } as any));
    });
    afterEach(() => { delete process.env.NIGHTGATE_SPONSOR_DUST_RETRIES; delete process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS; });
    const inserts = () => dbWrites.filter((q) => q?.INSERT?.into?.ref?.[0]?.endsWith?.('PendingSubmissions') || JSON.stringify(q).includes('PendingSubmissions') && q?.INSERT);
    const updates = () => dbWrites.filter((q) => q?.UPDATE);

    test('the pre-broadcast submit-intent hook records external_execution + the txHash BEFORE the worker sends', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        // The worker would call the hook with the identifier right before broadcasting.
        unboundWorkerImpl.fn = async () => {
            const hook = unboundIntentHooks.at(-1);
            await hook('00deadbeef'.padEnd(64, '0'));
            return { txHash: '00deadbeef'.padEnd(64, '0'), circuits: ['attest'], contractAddress: 'c', note: 'b' };
        };
        await proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any);
        expect(boundaryCalls[0][0]).toBe('external_execution');
        expect(boundaryCalls[0][1].submissionId).toMatch(/[0-9a-f-]{36}/);
        expect(boundaryCalls[1][0]).toBe('submitted');
        expect(boundaryCalls[1][1]).toMatchObject({ txHash: '00deadbeef'.padEnd(64, '0'), submissionId: boundaryCalls[0][1].submissionId });
        expect(inserts().length).toBe(1); // one PendingSubmissions row for the one attempt
    });

    test('a rebuild-retry after a broadcast crosses the boundary ONCE and gets its own PendingSubmissions row (review P1)', async () => {
        // Live-shaped sequence: attempt 1 announces + broadcasts, the ledger
        // answers 196 (dust race) -> attempt 2 is rebuilt, announces a NEW
        // identifier and broadcasts again. external_execution may only be
        // reported once (markJobExternalExecution is not re-entrant); every
        // attempt reports submitted with its identifier.
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        let n = 0;
        unboundWorkerImpl.fn = async () => {
            n++;
            const hook = unboundIntentHooks.at(-1);
            await hook(`00attempt${n}`.padEnd(64, '0'));
            if (n === 1) throw new Error('Transaction submission error <- RpcError: 1010: Invalid Transaction: Custom error: 196');
            return { txHash: `00attempt${n}`.padEnd(64, '0'), circuits: ['attest'], contractAddress: 'c', note: 'b' };
        };
        const out: any = await proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any);
        expect(out.txHash).toBe('00attempt2'.padEnd(64, '0'));
        expect(boundaryCalls.filter((c) => c[0] === 'external_execution').length).toBe(1);
        const submitted = boundaryCalls.filter((c) => c[0] === 'submitted').map((c) => c[1].txHash);
        expect(submitted).toEqual(['00attempt1'.padEnd(64, '0'), '00attempt2'.padEnd(64, '0')]);
        expect(inserts().length).toBe(2); // one PendingSubmissions row per attempt
        // a 196 is a pre-inclusion reject: the attempt row is REJECTED and the
        // job's hash was taken off (reportSubmissionRejected) before the rebuild
        expect(JSON.stringify(updates())).toMatch(/REJECTED/);
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').map((c) => c[1].txHash)).toEqual(['00attempt1'.padEnd(64, '0')]);
    });

    test('an exhausted run of pre-inclusion rejects ends with the hash removed (plain failed, not reconciliation)', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        let n = 0;
        unboundWorkerImpl.fn = async () => {
            n++;
            await unboundIntentHooks.at(-1)(`00rej${n}`.padEnd(64, '0'));
            throw new Error('Transaction submission error <- RpcError: 1010: Invalid Transaction: Custom error: 196');
        };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any))
            .rejects.toThrow(/Custom error: 196/);
        expect(n).toBe(3); // 1 + DUST_RETRIES(2)
        // every attempt's hash was reported rejected -> the job row carries no hash at the end
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').length).toBe(3);
        expect(boundaryCalls.filter((c) => c[0] === 'external_execution').length).toBe(1);
    });

    test('an AMBIGUOUS outcome (watch timed out, indexer silent) is NOT rebuilt: it propagates with the hash in place for reconciliation', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        let n = 0;
        unboundWorkerImpl.fn = async () => {
            n++;
            await unboundIntentHooks.at(-1)('00ambiguous'.padEnd(64, '0'));
            throw new Error('submit watch timed out after 60000ms without a Finalized status');
        };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any))
            .rejects.toThrow(/submit watch timed out/);
        expect(n).toBe(1); // exactly ONE broadcast, no second transaction
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').length).toBe(0); // hash stays: may be on-chain
        expect(JSON.stringify(updates())).not.toMatch(/REJECTED|REBUILT/);
    });

    test('a call that landed but did NOT apply (PARTIAL_SUCCESS) is TERMINAL: no sponsor-side rebuild, hash kept, attempt row REBUILT-marked for audit', async () => {
        // Live (rc10 N=8 burst): 6 losers x 4 rebuild retries, every retry
        // rejected at admission with 1010: the CALLER's transcript is stale,
        // re-attaching fresh dust to the same caller bytes cannot help.
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        let n = 0;
        unboundWorkerImpl.fn = async () => {
            n++;
            await unboundIntentHooks.at(-1)(`00partial${n}`.padEnd(64, '0'));
            throw new Error('sponsored transaction 00partial1 is in block 42 but its contract call did NOT apply (ledger result PARTIAL_SUCCESS, failed segment 7); the sponsor paid the fee, the call must be rebuilt against the current contract state');
        };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any))
            .rejects.toThrow(/did NOT apply/);
        expect(n).toBe(1); // exactly one broadcast, no sponsor-side rebuild
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').length).toBe(0); // it IS on-chain: hash stays
    });
});

describe('sponsorUnboundTransaction dust-retry policy (review P2)', () => {
    beforeEach(() => {
        unboundWorkerCalls.length = 0;
        __resetSponsorPoolForTests();
        process.env.NIGHTGATE_SPONSOR_DUST_RETRIES = '2';
        process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS = '0';
        vi.mocked(resolveFeeSponsor).mockImplementation(async ({ sponsorSessionId }: any) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` } as any));
    });
    afterEach(() => { delete process.env.NIGHTGATE_SPONSOR_DUST_RETRIES; delete process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS; });

    test('a coded dust race that outlives the retries fails the job WITHOUT benching the sponsor', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        unboundWorkerImpl.fn = async () => { throw new Error('Transaction submission error <- RpcError: 1010: Invalid Transaction: Custom error: 196'); };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any))
            .rejects.toThrow(/Custom error: 196/);
        expect(unboundWorkerCalls.length).toBe(3); // 1 + 2 retries
        // NOT benched: the sponsor is still a candidate right away.
        expect(sponsorCandidatesNonExclusive(['sponsor-1'])).toEqual(['sponsor-1']);
    });

    test('a GENERIC pool Invalid gets at most one rebuild (proof-cost bound), then fails without benching', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        unboundWorkerImpl.fn = async () => { throw new Error('Transaction submission error <- SubmissionError: Transaction submission failed <- TransactionInvalidError: Transaction is invalid and was rejected by the node'); };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', requestedBy: 'u' } as any))
            .rejects.toThrow(/TransactionInvalidError/);
        expect(unboundWorkerCalls.length).toBe(2); // 1 + ONE rebuild, despite DUST_RETRIES=2
        expect(sponsorCandidatesNonExclusive(['sponsor-1'])).toEqual(['sponsor-1']);
    });
});

describe('sponsorFinalizedTransaction external-effect boundary (review round 5)', () => {
    beforeEach(() => {
        boundaryCalls.length = 0; boundIntentHooks.length = 0; dbWrites.length = 0; workerCalls.length = 0;
        __resetSponsorPoolForTests();
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        vi.mocked(resolveFeeSponsor).mockImplementation(async ({ sponsorSessionId }: any) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` } as any));
    });

    test('the BOUND sponsor path announces its identifier before broadcasting: external_execution + submitted + a PendingSubmissions row', async () => {
        setup();
        const proc = processors.get('sponsorFinalizedTransaction')!;
        workerImpl.fn = async () => {
            const hook = boundIntentHooks.at(-1);
            expect(typeof hook).toBe('function'); // the processor passes the hook
            await hook('00bound'.padEnd(64, '0'));
            return { txHash: '00bound'.padEnd(64, '0'), circuits: ['attest'], contractAddress: 'c' };
        };
        const out: any = await proc({ op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', sessionId: 'sponsor-1', requestedBy: 'u', commandVersion: 1 } as any);
        expect(out.txHash).toBe('00bound'.padEnd(64, '0'));
        expect(boundaryCalls.map((c) => c[0])).toEqual(['external_execution', 'submitted']);
        expect(boundaryCalls[1][1]).toMatchObject({ txHash: '00bound'.padEnd(64, '0') });
        expect(dbWrites.filter((q) => q?.INSERT).length).toBe(1);
    });

    test('a bound failover after a pre-inclusion reject closes the attempt row REJECTED and clears the hash before trying the next sponsor', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        const proc = processors.get('sponsorFinalizedTransaction')!;
        let n = 0;
        workerImpl.fn = async () => {
            n++;
            await boundIntentHooks.at(-1)(`00b${n}`.padEnd(64, '0'));
            if (n === 1) throw new Error('1010: Invalid Transaction: Custom error: 170');
            return { txHash: `00b${n}`.padEnd(64, '0'), circuits: ['attest'], contractAddress: 'c' };
        };
        const out: any = await proc({ op: 'sponsorFinalized', finalizedTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL }, { ID: 'j', sessionId: 'pool-1', requestedBy: 'u', commandVersion: 1 } as any);
        expect(out.txHash).toBe('00b2'.padEnd(64, '0'));
        expect(boundaryCalls.filter((c) => c[0] === 'external_execution').length).toBe(1);
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').map((c) => c[1].txHash)).toEqual(['00b1'.padEnd(64, '0')]);
        expect(JSON.stringify(dbWrites.filter((q) => q?.UPDATE))).toMatch(/REJECTED/);
    });
});

describe('submit-intent persistence (review round 6)', () => {
    beforeEach(() => {
        boundaryCalls.length = 0; unboundIntentHooks.length = 0; dbWrites.length = 0; unboundWorkerCalls.length = 0;
        __resetSponsorPoolForTests();
        process.env.NIGHTGATE_SPONSOR_DUST_RETRIES = '0';
        process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS = '0';
        vi.mocked(resolveFeeSponsor).mockImplementation(async ({ sponsorSessionId }: any) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` } as any));
    });
    afterEach(() => { delete process.env.NIGHTGATE_SPONSOR_DUST_RETRIES; delete process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS; delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION; });

    test('the attempt row stores the WORKER-inspected coordinates and the CONCRETE sponsor (not the pool sentinel)', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'pool-1,pool-2';
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        unboundWorkerImpl.fn = async () => {
            await unboundIntentHooks.at(-1)('00coords'.padEnd(64, '0'), {
                txHash: '00coords'.padEnd(64, '0'), contractAddress: 'dd'.repeat(32), circuits: ['anchorContentRoot'], note: 'backing-Q', sponsorAccountId: 'acct-pool-1'
            });
            return { txHash: '00coords'.padEnd(64, '0'), circuits: ['anchorContentRoot'], contractAddress: 'dd'.repeat(32), note: 'backing-Q' };
        };
        // allow-list names a DIFFERENT contract/circuit first: the row must carry what was inspected, not the list head
        await proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: PLATFORM_POOL_SENTINEL, allowedContracts: ['aa'.repeat(32), 'dd'.repeat(32)], allowedCircuits: ['attest', 'anchorContentRoot'] }, { ID: 'j', sessionId: PLATFORM_POOL_SENTINEL, requestedBy: 'u' } as any);
        const insert: any = dbWrites.find((q) => q?.INSERT);
        const row = insert.INSERT.entries[0];
        expect(row.contractAddress).toBe('dd'.repeat(32));
        expect(row.circuitName).toBe('anchorContentRoot');
        expect(row.finalizedTxData).toBeUndefined(); // public snapshot field untouched
        const coords = JSON.parse(row.submitIntentData);
        expect(coords).toMatchObject({ feeSponsor: 'pool-1', sponsorAccountId: 'acct-pool-1', circuits: ['anchorContentRoot'], contractAddress: 'dd'.repeat(32), note: 'backing-Q' });
        expect(coords.feeSponsor).not.toBe(PLATFORM_POOL_SENTINEL);
    });

    test('when the job-status write fails after the INSERT, the intent is nacked AND the attempt row is closed REJECTED (never left pending)', async () => {
        setup();
        const proc = processors.get('sponsorUnboundTransaction')!;
        vi.mocked(reportExternalSubmission as any).mockRejectedValueOnce(new Error('Lease lost before markJobSubmitted(j)'));
        unboundWorkerImpl.fn = async () => {
            // the worker: announce -> the hook throws -> the worker nacks and does not broadcast
            await unboundIntentHooks.at(-1)('00nack'.padEnd(64, '0'), { txHash: '00nack'.padEnd(64, '0') });
            throw new Error('unreachable: the hook must have thrown');
        };
        await expect(proc({ op: 'sponsorUnbound', unboundTxB64: TX_A, sponsorSessionId: 'sponsor-1', allowedContracts: [], allowedCircuits: [] }, { ID: 'j', sessionId: 'sponsor-1', requestedBy: 'u' } as any))
            .rejects.toThrow(/Lease lost/);
        expect(dbWrites.filter((q) => q?.INSERT).length).toBe(1);
        const closing = dbWrites.filter((q) => q?.UPDATE);
        expect(JSON.stringify(closing)).toMatch(/REJECTED/);
        expect(boundaryCalls.filter((c) => c[0] === 'rejected').length).toBe(1);
    });
});
