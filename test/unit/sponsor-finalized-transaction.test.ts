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
vi.mock('../../srv/submission/background-jobs', () => ({
    startJob: vi.fn(async (args: any) => { startJobCalls.push(args); return { jobId: 'job-1', status: 'pending' }; }),
    runChildCommand: vi.fn(),
    registerBackgroundJobProcessor: vi.fn(),
    registerBackgroundJobReconciliationFinalizer: vi.fn()
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
    beforeEach(() => { startJobCalls.length = 0; });

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
