/**
 * Tests for srv/midnight/batch-call-scope.ts, the unit-testable core of the
 * worker's `submitContractCallBatch` op (the worker module itself cannot be
 * imported outside a worker thread). Fakes stand in for the contracts SDK and
 * the findDeployedContract result.
 */

import { runBatchInScope } from '../../srv/midnight/batch-call-scope';

const PROVIDERS = { fake: 'providers' };
const ADDR = '0xCONTRACT';

function makeFakes() {
    const invoked: Array<{ circuit: string; txCtx: unknown; args: unknown[] }> = [];
    const txCtx = { fake: 'txCtx' };
    const found = {
        callTx: {
            attest: vi.fn(async (ctx: unknown, ...args: unknown[]) => { invoked.push({ circuit: 'attest', txCtx: ctx, args }); }),
            bindPassport: vi.fn(async (ctx: unknown, ...args: unknown[]) => { invoked.push({ circuit: 'bindPassport', txCtx: ctx, args }); }),
            anchorContentRoot: vi.fn(async (ctx: unknown, ...args: unknown[]) => { invoked.push({ circuit: 'anchorContentRoot', txCtx: ctx, args }); })
        }
    };
    const contracts = {
        withContractScopedTransaction: vi.fn(async (providers: unknown, fn: (ctx: unknown) => Promise<void>, options: any) => {
            expect(providers).toBe(PROVIDERS);
            await fn(txCtx);
            return { public: { txHash: '0xbatch', status: 'SucceedEntirely' }, options };
        })
    };
    return { invoked, txCtx, found, contracts };
}

describe('runBatchInScope', () => {
    test('runs every call in order with the shared txCtx and maps the finalized result', async () => {
        const { invoked, txCtx, found, contracts } = makeFakes();
        const calls = [
            { circuit: 'attest', args: ['a1', 'a2'] },
            { circuit: 'bindPassport', args: ['b1'] },
            { circuit: 'anchorContentRoot', args: [] }
        ];

        const out = await runBatchInScope(contracts, PROVIDERS, found, calls, ADDR);

        expect(out).toEqual({
            txHash: '0xbatch',
            onChainStatus: 'SucceedEntirely',
            circuits: ['attest', 'bindPassport', 'anchorContentRoot']
        });
        expect(contracts.withContractScopedTransaction).toHaveBeenCalledTimes(1);
        // Ordered, and every call got the SAME txCtx as first arg (the batching overload).
        expect(invoked.map(i => i.circuit)).toEqual(['attest', 'bindPassport', 'anchorContentRoot']);
        for (const i of invoked) expect(i.txCtx).toBe(txCtx);
        expect(invoked[0].args).toEqual(['a1', 'a2']);
        expect(invoked[1].args).toEqual(['b1']);
        expect(invoked[2].args).toEqual([]);
        // Scope name carries the joined circuit list.
        const options = contracts.withContractScopedTransaction.mock.calls[0][2];
        expect(options).toEqual({ scopeName: 'batch:attest+bindPassport+anchorContentRoot' });
    });

    test('rejects an empty calls array without touching the SDK', async () => {
        const { found, contracts } = makeFakes();
        await expect(runBatchInScope(contracts, PROVIDERS, found, [], ADDR))
            .rejects.toThrow(/non-empty array/);
        expect(contracts.withContractScopedTransaction).not.toHaveBeenCalled();
    });

    test('rejects an unknown circuit BEFORE opening the scope', async () => {
        const { found, contracts } = makeFakes();
        await expect(runBatchInScope(contracts, PROVIDERS, found, [
            { circuit: 'attest', args: [] },
            { circuit: 'noSuchCircuit', args: [] }
        ], ADDR)).rejects.toThrow(/Circuit 'noSuchCircuit' not found on contract at 0xCONTRACT/);
        // Validation is pre-scope: nothing was invoked, no scope was opened.
        expect(contracts.withContractScopedTransaction).not.toHaveBeenCalled();
        expect(found.callTx.attest).not.toHaveBeenCalled();
    });

    test('clear error when the SDK lacks withContractScopedTransaction', async () => {
        const { found } = makeFakes();
        await expect(runBatchInScope({}, PROVIDERS, found, [{ circuit: 'attest', args: [] }], ADDR))
            .rejects.toThrow(/withContractScopedTransaction not found/);
    });

    test('a throwing call propagates out of the scope (SDK discards unsubmitted calls)', async () => {
        const { found, contracts } = makeFakes();
        (found.callTx.bindPassport as any).mockRejectedValueOnce(new Error('proof failed'));
        await expect(runBatchInScope(contracts, PROVIDERS, found, [
            { circuit: 'attest', args: [] },
            { circuit: 'bindPassport', args: [] }
        ], ADDR)).rejects.toThrow(/proof failed/);
    });

    test('missing public tx data maps to empty strings (submitter turns that into MalformedResult)', async () => {
        const { found } = makeFakes();
        const contracts = {
            withContractScopedTransaction: vi.fn(async (_p: unknown, fn: (ctx: unknown) => Promise<void>) => {
                await fn({});
                return {}; // no .public
            })
        };
        const out = await runBatchInScope(contracts, PROVIDERS, found, [{ circuit: 'attest', args: [] }], ADDR);
        expect(out).toEqual({ txHash: '', onChainStatus: '', circuits: ['attest'] });
    });
});
