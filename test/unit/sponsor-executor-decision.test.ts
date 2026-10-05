/**
 * The sponsoring executors (`sponsorFinalizedTransaction`, `sponsorUnboundTransaction`)
 * act on the worker's failure CODE through one decision table: a dust race
 * rebuilds on the same sponsor, a policy refusal fails without touching the
 * pool, a sponsor-health failure benches the wallet and fails over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerSubmitError } from '../../srv/midnight/wallet-worker-protocol';

const registeredProcessors = vi.hoisted(() => new Map<string, (command: unknown, row: any) => Promise<unknown>>());
const sponsorCalls = vi.hoisted(() => ({ finalized: vi.fn(), unbound: vi.fn() }));

vi.mock('../../srv/submission/background-jobs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/submission/background-jobs')>()),
    startJob: vi.fn(async () => ({ jobId: 'j', status: 'pending' })),
    runChildCommand: vi.fn(),
    // (kind, version, [traits,] processor): the processor is the last argument.
    registerBackgroundJobProcessor: (kind: string, version: number, ...rest: unknown[]) => registeredProcessors.set(`${kind}\0${version}`, rest[rest.length - 1] as (command: unknown, row: any) => Promise<unknown>),
    registerBackgroundJobReconciliationFinalizer: () => undefined
}));
vi.mock('../../srv/midnight/wallet-worker-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/midnight/wallet-worker-client')>()),
    walletSponsorFinalizedTx: (...args: unknown[]) => sponsorCalls.finalized(...args),
    walletSponsorUnboundTx: (...args: unknown[]) => sponsorCalls.unbound(...args)
}));
vi.mock('../../srv/submission/fee-sponsor', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/submission/fee-sponsor')>()),
    resolveFeeSponsor: vi.fn(async ({ sponsorSessionId }: { sponsorSessionId: string }) => ({ sponsorSessionId, accountId: `acct-${sponsorSessionId}` })),
    ensureFeeSponsorFacade: vi.fn(async () => undefined)
}));
vi.mock('../../srv/midnight/providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/midnight/providers')>()),
    ensureNetworkId: vi.fn(async () => undefined)
}));

import { registerSubmissionHandlers } from '../../srv/submission/handlers';
import { __resetSponsorPoolForTests, sponsorCandidatesNonExclusive, PLATFORM_POOL_SENTINEL } from '../../srv/submission/sponsor-pool';

const coded = (code: any, extra: Record<string, unknown> = {}, message = 'worker failure') =>
    new WorkerSubmitError({ name: 'Error', message, code, retryable: false, ...extra } as any);

function boot() {
    const srv: any = { on: vi.fn(), before: vi.fn(), after: vi.fn() };
    const db = { run: vi.fn(async () => 1) };
    registerSubmissionHandlers(srv, db, {});
    return { srv, db };
}

const JOB = { ID: 'job-1', sessionId: 'sp-1', requestedBy: 'user-1', kind: 'sponsorFinalizedTransaction' } as any;

describe('sponsor executors follow the failure code', () => {
    const env = { ...process.env };
    beforeEach(() => {
        __resetSponsorPoolForTests();
        sponsorCalls.finalized.mockReset();
        sponsorCalls.unbound.mockReset();
        process.env.NIGHTGATE_NETWORK = 'preprod';
        process.env.NIGHTGATE_SPONSOR_DUST_RETRIES = '2';
        process.env.NIGHTGATE_SPONSOR_DUST_BACKOFF_MS = '0';
        process.env.NIGHTGATE_SPONSOR_LEASE_WAIT_MS = '1000';
        delete process.env.NIGHTGATE_SPONSOR_POLICY_FILE;
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
    });
    afterEach(() => { process.env = { ...env }; });

    it('finalized: a dust race rebuilds on the SAME sponsor and never benches it', async () => {
        boot();
        const run = registeredProcessors.get('sponsorFinalizedTransaction\u00001')!;
        sponsorCalls.finalized
            .mockRejectedValueOnce(coded('dust-race', { ledgerCode: '1010/170', retryable: true }, 'wallet not genuinely synced within 1ms <- 1010: Custom error: 170'))
            .mockResolvedValueOnce({ txHash: 'h', circuits: ['attest'], contractAddress: 'c' });
        const out: any = await run({ op: 'sponsorFinalized', finalizedTxB64: 'AAAA', sponsorSessionId: 'sp-1' }, JOB);
        expect(out.feeSponsor).toBe('sp-1');
        expect(sponsorCalls.finalized).toHaveBeenCalledTimes(2);
        expect(sponsorCalls.finalized.mock.calls.map((c: any[]) => c[0].sponsorSessionId)).toEqual(['acct-sp-1', 'acct-sp-1']);
        expect(sponsorCandidatesNonExclusive(['sp-1'])).toEqual(['sp-1']); // not benched
    });

    it('finalized: a policy refusal fails at once, the sponsor stays usable', async () => {
        boot();
        const run = registeredProcessors.get('sponsorFinalizedTransaction\u00001')!;
        sponsorCalls.finalized.mockRejectedValueOnce(coded('policy', {}, "refusing to sponsor: circuit 'x' is not sponsorable"));
        await expect(run({ op: 'sponsorFinalized', finalizedTxB64: 'AAAA', sponsorSessionId: 'sp-1' }, JOB)).rejects.toThrow(/not sponsorable/);
        expect(sponsorCalls.finalized).toHaveBeenCalledTimes(1);
        expect(sponsorCandidatesNonExclusive(['sp-1'])).toEqual(['sp-1']);
    });

    it('finalized: a sponsor-health failure benches the wallet and fails over inside the pool', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'sp-1,sp-2';
        boot();
        const run = registeredProcessors.get('sponsorFinalizedTransaction\u00001')!;
        sponsorCalls.finalized
            .mockRejectedValueOnce(new Error('wallet not genuinely synced within 180000ms'))
            .mockResolvedValueOnce({ txHash: 'h', circuits: ['attest'], contractAddress: 'c' });
        const out: any = await run({ op: 'sponsorFinalized', finalizedTxB64: 'AAAA', sponsorSessionId: PLATFORM_POOL_SENTINEL }, { ...JOB, sessionId: PLATFORM_POOL_SENTINEL });
        expect(out.feeSponsor).toBe('sp-2');
        expect(sponsorCandidatesNonExclusive(['sp-1', 'sp-2'])).toEqual(['sp-2']); // sp-1 benched
    });

    it('unbound: the generic pool Invalid gets one rebuild, then fails without benching', async () => {
        boot();
        const run = registeredProcessors.get('sponsorUnboundTransaction\u00001')!;
        sponsorCalls.unbound
            .mockRejectedValueOnce(coded('dust-race', { ledgerCode: 'pool-invalid', retryable: true }))
            .mockRejectedValueOnce(coded('dust-race', { ledgerCode: 'pool-invalid', retryable: true }));
        await expect(run({ op: 'sponsorUnbound', unboundTxB64: 'AAAA', sponsorSessionId: 'sp-1' }, { ...JOB, kind: 'sponsorUnboundTransaction' })).rejects.toThrow(/worker failure/);
        expect(sponsorCalls.unbound).toHaveBeenCalledTimes(2);
        expect(sponsorCandidatesNonExclusive(['sp-1'])).toEqual(['sp-1']);
    });

    it('unbound: an ambiguous outcome is thrown untouched for reconciliation, no rebuild', async () => {
        boot();
        const run = registeredProcessors.get('sponsorUnboundTransaction\u00001')!;
        sponsorCalls.unbound.mockRejectedValueOnce(coded('ambiguous', {}, 'submit watch timed out'));
        await expect(run({ op: 'sponsorUnbound', unboundTxB64: 'AAAA', sponsorSessionId: 'sp-1' }, { ...JOB, kind: 'sponsorUnboundTransaction' })).rejects.toThrow(/timed out/);
        expect(sponsorCalls.unbound).toHaveBeenCalledTimes(1);
    });
});
