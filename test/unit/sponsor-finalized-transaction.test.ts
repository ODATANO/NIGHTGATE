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
const workerCalls = vi.hoisted(() => [] as any[]);
const workerImpl = vi.hoisted(() => ({ fn: async (_args: any): Promise<any> => ({ txHash: '00aa', circuits: ['attest'], contractAddress: 'c' }) }));
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: vi.fn(async (args: any) => { startJobCalls.push(args); return { jobId: 'job-1', status: 'pending' }; }),
    runChildCommand: vi.fn(),
    registerBackgroundJobProcessor: vi.fn((kind: string, _v: number, fn: any) => processors.set(kind, fn)),
    registerBackgroundJobReconciliationFinalizer: vi.fn()
}));
vi.mock('../../srv/midnight/wallet-worker-client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    walletSponsorFinalizedTx: vi.fn(async (args: any) => { workerCalls.push(args); return workerImpl.fn(args); })
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
    acquireSponsor, releaseSponsor, PLATFORM_POOL_SENTINEL
} from '../../srv/submission/sponsor-pool';
import { resolveFeeSponsor } from '../../srv/submission/fee-sponsor';

function makeFakeService() {
    const handlers: Record<string, (req: any) => Promise<unknown>> = {};
    return { handlers, on: vi.fn((action: string, fn: any) => { handlers[action] = fn; }) };
}
function makeReq(data: Record<string, unknown>) {
    return { data, user: { id: 'test-user' }, reject: vi.fn((status: number, message: string) => { const e: any = new Error(message); e.status = status; return e; }) };
}
function setup() {
    const srv = makeFakeService();
    registerSubmissionHandlers(srv as any, { run: vi.fn() } as any, {
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
