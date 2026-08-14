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

    test('invokes a call entry\'s before() hook immediately before ITS callTx, in call order', async () => {
        const { found, contracts } = makeFakes();
        const sequence: string[] = [];
        (found.callTx.attest as any).mockImplementation(async () => { sequence.push('call:attest'); });
        (found.callTx.bindPassport as any).mockImplementation(async () => { sequence.push('call:bindPassport'); });
        (found.callTx.anchorContentRoot as any).mockImplementation(async () => { sequence.push('call:anchorContentRoot'); });

        await runBatchInScope(contracts, PROVIDERS, found, [
            { circuit: 'attest', args: [], before: () => sequence.push('before:attest') },
            { circuit: 'bindPassport', args: [] }, // no hook: untouched
            { circuit: 'anchorContentRoot', args: [], before: () => sequence.push('before:anchorContentRoot') }
        ], ADDR);

        expect(sequence).toEqual([
            'before:attest', 'call:attest',
            'call:bindPassport',
            'before:anchorContentRoot', 'call:anchorContentRoot'
        ]);
    });

    test('before() hooks drive a mutable witness holder deterministically (batch proof rebinding)', async () => {
        const { found, contracts } = makeFakes();
        const holder: { current?: string } = {};
        const seenAtCallTime: Array<string | undefined> = [];
        (found.callTx.attest as any).mockImplementation(async () => { seenAtCallTime.push(holder.current); });

        await runBatchInScope(contracts, PROVIDERS, found, [
            { circuit: 'attest', args: [], before: () => { holder.current = 'proof-A'; } },
            { circuit: 'attest', args: [], before: () => { holder.current = 'proof-B'; } },
            { circuit: 'attest', args: [], before: () => { holder.current = undefined; } }
        ], ADDR);

        expect(seenAtCallTime).toEqual(['proof-A', 'proof-B', undefined]);
    });

    test('a throwing before() hook aborts inside the scope before its callTx runs', async () => {
        const { found, contracts } = makeFakes();
        await expect(runBatchInScope(contracts, PROVIDERS, found, [
            { circuit: 'attest', args: [] },
            { circuit: 'bindPassport', args: [], before: () => { throw new Error('bad proof holder'); } }
        ], ADDR)).rejects.toThrow(/bad proof holder/);
        expect(found.callTx.attest).toHaveBeenCalledTimes(1);
        expect(found.callTx.bindPassport).not.toHaveBeenCalled();
    });

    test('wraps the proof provider so batch segments prove in call order', async () => {
        const attest = { actions: [{ entryPoint: 'attest' }] };
        const bind = { actions: [{ entryPoint: 'bindPassport' }] };
        const tx: any = { intents: new Map<number, any>([[9, bind], [4, attest]]) };
        const proveTx = vi.fn(async () => 'proven');
        const providers = { proofProvider: { proveTx }, other: 'stuff' };
        let scopeProviders: any;
        const contracts = {
            withContractScopedTransaction: vi.fn(async (p: any, fn: (ctx: unknown) => Promise<void>) => {
                scopeProviders = p;
                await fn({});
                return { public: { txHash: '0x1', status: 'SucceedEntirely' } };
            })
        };
        const found = { callTx: { attest: vi.fn(async () => { }), bindPassport: vi.fn(async () => { }) } };

        await runBatchInScope(contracts, providers, found, [
            { circuit: 'attest', args: [] },
            { circuit: 'bindPassport', args: [] }
        ], ADDR);

        // The scope got a shallow copy with a wrapped proof provider; the rest
        // of the bundle is untouched.
        expect(scopeProviders).not.toBe(providers);
        expect(scopeProviders.other).toBe('stuff');
        expect(scopeProviders.proofProvider).not.toBe(providers.proofProvider);

        // Proving through the wrapper reorders the segment ids into call order
        // (attest gets the smaller id), then delegates to the real provider.
        await expect(scopeProviders.proofProvider.proveTx(tx)).resolves.toBe('proven');
        expect(proveTx).toHaveBeenCalledWith(tx);
        expect(tx.intents.get(4)).toBe(attest);
        expect(tx.intents.get(9)).toBe(bind);
    });

    // ---- segment mode selection (NIGHTGATE_BATCH_SEGMENT_MODE) -------------

    /**
     * Contracts fake that behaves like submitTxCore: the scope run builds a
     * tx with the given layout and pushes it through the wrapped proof
     * provider, so the selected segment mode sees a realistic tx.
     */
    function makeLayoutFakes(layout: Array<[number, string]>) {
        const contracts = {
            withContractScopedTransaction: vi.fn(async (p: any, fn: (ctx: unknown) => Promise<void>) => {
                await fn({});
                const tx: any = { intents: new Map(layout.map(([id, ep]) => [id, { actions: [{ entryPoint: ep }] }])) };
                await p.proofProvider.proveTx(tx);
                return { public: { txHash: '0xlayout', status: 'SucceedEntirely' } };
            })
        };
        const found = { callTx: { attest: vi.fn(async () => { }), bindPassport: vi.fn(async () => { }) } };
        const providers = { proofProvider: { proveTx: vi.fn(async () => 'proven') } };
        return { contracts, found, providers };
    }

    test('an unrecognized segment mode falls back to the default rewrite (one build, ids permuted)', async () => {
        process.env.NIGHTGATE_BATCH_SEGMENT_MODE = 'rewrit'; // typo
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const { contracts, found, providers } = makeLayoutFakes(
                [[9, 'attest'], [4, 'bindPassport']] // inverted -> rewrite permutes
            );
            const out = await runBatchInScope(contracts, providers, found, [
                { circuit: 'attest', args: [] },
                { circuit: 'bindPassport', args: [] }
            ], ADDR);
            expect(out.txHash).toBe('0xlayout');
            expect(contracts.withContractScopedTransaction).toHaveBeenCalledTimes(1);
            expect(providers.proofProvider.proveTx).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown NIGHTGATE_BATCH_SEGMENT_MODE 'rewrit'"));
        } finally {
            delete process.env.NIGHTGATE_BATCH_SEGMENT_MODE;
            warn.mockRestore();
        }
    });

    test('observe mode proves as-is, ids untouched (diagnosis)', async () => {
        process.env.NIGHTGATE_BATCH_SEGMENT_MODE = 'observe';
        try {
            let provenTx: any;
            const contracts = {
                withContractScopedTransaction: vi.fn(async (p: any, fn: (ctx: unknown) => Promise<void>) => {
                    await fn({});
                    const tx: any = { intents: new Map([[9, { actions: [{ entryPoint: 'attest' }] }], [4, { actions: [{ entryPoint: 'bindPassport' }] }]]) };
                    await p.proofProvider.proveTx(tx);
                    provenTx = tx;
                    return { public: { txHash: '0xobserve', status: 'SucceedEntirely' } };
                })
            };
            const found = { callTx: { attest: vi.fn(async () => { }), bindPassport: vi.fn(async () => { }) } };
            const providers = { proofProvider: { proveTx: vi.fn(async () => 'proven') } };

            const out = await runBatchInScope(contracts, providers, found, [
                { circuit: 'attest', args: [] },
                { circuit: 'bindPassport', args: [] }
            ], ADDR);
            expect(out.txHash).toBe('0xobserve');
            // Inverted layout survives untouched: observe never reorders.
            expect(provenTx.intents.get(9).actions[0].entryPoint).toBe('attest');
            expect(provenTx.intents.get(4).actions[0].entryPoint).toBe('bindPassport');
        } finally {
            delete process.env.NIGHTGATE_BATCH_SEGMENT_MODE;
        }
    });

    test('default rewrite orders an 8-call batch in one build', async () => {
        const circuits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
        // Worst-case layout: ids fully inverted relative to call order.
        const layout: Array<[number, string]> = circuits.map((ep, i) => [80 - i * 10, ep]);
        let provenTx: any;
        const contracts = {
            withContractScopedTransaction: vi.fn(async (p: any, fn: (ctx: unknown) => Promise<void>) => {
                await fn({});
                const tx: any = { intents: new Map(layout.map(([id, ep]) => [id, { actions: [{ entryPoint: ep }] }])) };
                await p.proofProvider.proveTx(tx);
                provenTx = tx;
                return { public: { txHash: '0x8call', status: 'SucceedEntirely' } };
            })
        };
        const found = { callTx: Object.fromEntries(circuits.map(c => [c, vi.fn(async () => { })])) };
        const providers = { proofProvider: { proveTx: vi.fn(async () => 'proven') } };

        const out = await runBatchInScope(contracts, providers, found, circuits.map(c => ({ circuit: c, args: [] })), ADDR);

        expect(out.txHash).toBe('0x8call');
        expect(contracts.withContractScopedTransaction).toHaveBeenCalledTimes(1);
        // Ids permuted so ascending order equals call order.
        const idsAsc = [...provenTx.intents.keys()].sort((a: number, b: number) => a - b);
        expect(idsAsc.map((id: number) => provenTx.intents.get(id).actions[0].entryPoint)).toEqual(circuits);
    });

    test('rewrite is the default without any env (ids permuted into call order)', async () => {
        const attest = { actions: [{ entryPoint: 'attest' }] };
        const bind = { actions: [{ entryPoint: 'bindPassport' }] };
        const tx: any = { intents: new Map<number, any>([[4, bind], [9, attest]]) }; // inverted
        let scopeProviders: any;
        const contracts = {
            withContractScopedTransaction: vi.fn(async (p: any, fn: (ctx: unknown) => Promise<void>) => {
                scopeProviders = p;
                await fn({});
                return { public: { txHash: '0x1', status: 'SucceedEntirely' } };
            })
        };
        const found = { callTx: { attest: vi.fn(async () => { }), bindPassport: vi.fn(async () => { }) } };
        const providers = { proofProvider: { proveTx: vi.fn(async () => 'proven') } };

        await runBatchInScope(contracts, providers, found, [
            { circuit: 'attest', args: [] },
            { circuit: 'bindPassport', args: [] }
        ], ADDR);
        await expect(scopeProviders.proofProvider.proveTx(tx)).resolves.toBe('proven');
        // Rewrite semantics: ids permuted so attest gets the smaller id.
        expect(tx.intents.get(4)).toBe(attest);
        expect(tx.intents.get(9)).toBe(bind);
    });
});
