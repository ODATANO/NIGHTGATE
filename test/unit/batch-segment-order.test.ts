/**
 * Tests for srv/midnight/batch-segment-order.ts: deterministic segment
 * ordering for batched contract calls. Fake transactions stand in for the
 * ledger-v8 WASM objects; the contract under test is pure Map surgery plus
 * the proof-provider wrapper semantics.
 */

import {
    BatchCausalityError,
    findCausalityViolation,
    orderBatchSegments,
    withOrderedBatchSegments
} from '../../srv/midnight/batch-segment-order';

function intentFor(circuit: string | Uint8Array) {
    return { actions: [{ entryPoint: circuit }] };
}

/**
 * An intent whose call carries the given execution stages. `partitionTranscripts`
 * decides these by gas cost, so the same circuit is 'g' on a small contract
 * state and 'f' once it grows expensive (live-observed: attest at 5.34G was
 * guaranteed, at 6.04G fallible).
 */
function stagedIntent(circuit: string, stages: 'g' | 'f' | 'gf') {
    return {
        actions: [{
            entryPoint: circuit,
            guaranteedTranscript: stages.includes('g') ? { gas: { computeTime: 5_150_000_000n } } : undefined,
            fallibleTranscript: stages.includes('f') ? { gas: { computeTime: 6_040_000_000n } } : undefined
        }]
    };
}

function txWithIntents(entries: Array<[number, any]>) {
    return { intents: new Map(entries) } as any;
}

describe('orderBatchSegments', () => {
    test('reassigns the existing segment ids, ascending, in call order', () => {
        const attest = intentFor('attest');
        const bind = intentFor('bindPassport');
        const root = intentFor('anchorContentRoot');
        // Randomized: root got the smallest id, attest the largest.
        const tx = txWithIntents([[7, root], [23, attest], [11, bind]]);

        const ordered = orderBatchSegments(tx, ['attest', 'bindPassport', 'anchorContentRoot']);

        expect(ordered).toBe(true);
        // Same id set, reassigned: attest -> 7, bind -> 11, root -> 23.
        expect(Array.from(tx.intents.entries()).sort((a: any, b: any) => a[0] - b[0]))
            .toEqual([[7, attest], [11, bind], [23, root]]);
    });

    test('decodes Uint8Array entryPoints', () => {
        const enc = new TextEncoder();
        const attest = intentFor(enc.encode('attest'));
        const bind = intentFor(enc.encode('bindPassport'));
        const tx = txWithIntents([[9, bind], [4, attest]]);

        expect(orderBatchSegments(tx, ['attest', 'bindPassport'])).toBe(true);
        expect(tx.intents.get(4)).toBe(attest);
        expect(tx.intents.get(9)).toBe(bind);
    });

    test('leaves unmatched intents (e.g. a foreign segment) untouched', () => {
        const attest = intentFor('attest');
        const bind = intentFor('bindPassport');
        const foreign = intentFor('somethingElse');
        const tx = txWithIntents([[3, foreign], [8, bind], [5, attest]]);

        expect(orderBatchSegments(tx, ['attest', 'bindPassport'])).toBe(true);
        expect(tx.intents.get(3)).toBe(foreign); // untouched id
        expect(tx.intents.get(5)).toBe(attest);
        expect(tx.intents.get(8)).toBe(bind);
    });

    test('duplicate circuit names are consumed pairwise (ids still ascend)', () => {
        const first = intentFor('attest');
        const second = intentFor('attest');
        const tx = txWithIntents([[20, first], [6, second]]);

        expect(orderBatchSegments(tx, ['attest', 'attest'])).toBe(true);
        const ids = Array.from(tx.intents.keys()).sort((a: any, b: any) => a - b);
        expect(ids).toEqual([6, 20]);
        expect(new Set(tx.intents.values())).toEqual(new Set([first, second]));
    });

    test('mismatch (missing intent for a listed circuit) leaves the map unchanged', () => {
        const attest = intentFor('attest');
        const tx = txWithIntents([[5, attest]]);
        const before = tx.intents;

        expect(orderBatchSegments(tx, ['attest', 'bindPassport'])).toBe(false);
        expect(tx.intents).toBe(before);
        expect(tx.intents.get(5)).toBe(attest);
    });

    test('no-ops on missing intents map and on single-call batches', () => {
        expect(orderBatchSegments({} as any, ['a', 'b'])).toBe(false);
        expect(orderBatchSegments({ intents: undefined } as any, ['a', 'b'])).toBe(false);
        const single = txWithIntents([[5, intentFor('attest')]]);
        expect(orderBatchSegments(single, ['attest'])).toBe(false);
    });
});

describe('findCausalityViolation', () => {
    test('flags a fallible call that has a guaranteed call behind it', () => {
        // The live 1010/188 shape: attest goes fallible once the vault fills,
        // its dependents stay guaranteed, and the ledger rejects the batch.
        const tx = txWithIntents([
            [10, stagedIntent('attest', 'f')],
            [20, stagedIntent('anchorContentRoot', 'g')],
            [30, stagedIntent('bindPassport', 'g')]
        ]);

        const violation = findCausalityViolation(tx);

        expect(violation).toMatch(/'attest' \(segment 10\) carries a FALLIBLE/);
        expect(violation).toMatch(/'anchorContentRoot' \(segment 20\) behind it carries a GUARANTEED/);
    });

    test('accepts the same calls when the fallible one is LAST', () => {
        const tx = txWithIntents([
            [10, stagedIntent('anchorContentRoot', 'g')],
            [20, stagedIntent('bindPassport', 'f')]
        ]);
        expect(findCausalityViolation(tx)).toBeNull();
    });

    test('accepts an all-fallible batch (nothing guaranteed can be starved)', () => {
        const tx = txWithIntents([
            [10, stagedIntent('attest', 'f')],
            [20, stagedIntent('anchorContentRoot', 'f')]
        ]);
        expect(findCausalityViolation(tx)).toBeNull();
    });

    test('a call carrying BOTH stages still starves a later guaranteed call', () => {
        const tx = txWithIntents([
            [10, stagedIntent('attest', 'gf')],
            [20, stagedIntent('bindPassport', 'g')]
        ]);
        expect(findCausalityViolation(tx)).toMatch(/FALLIBLE/);
    });

    test('judges by APPLY order (ascending segment id), not map order', () => {
        // Same calls, inserted the other way round: the fallible call ends up
        // LAST in apply order, so this batch is fine.
        const tx = txWithIntents([
            [30, stagedIntent('bindPassport', 'f')],
            [10, stagedIntent('anchorContentRoot', 'g')]
        ]);
        expect(findCausalityViolation(tx)).toBeNull();
    });

    test('fails OPEN when the SDK exposes no transcripts', () => {
        const tx = txWithIntents([[10, intentFor('attest')], [20, intentFor('bindPassport')]]);
        expect(findCausalityViolation(tx)).toBeNull();
    });

    test('ignores intents without a contract call (fee/dust segments)', () => {
        const tx = txWithIntents([
            [1, { actions: [] }],
            [10, stagedIntent('attest', 'f')]
        ]);
        expect(findCausalityViolation(tx)).toBeNull();
    });
});

describe('withOrderedBatchSegments', () => {
    test('reorders before delegating and passes all arguments through', async () => {
        const attest = intentFor('attest');
        const bind = intentFor('bindPassport');
        const tx = txWithIntents([[9, bind], [4, attest]]);
        const seen: any[] = [];
        const provider = {
            proveTx: vi.fn(async (t: any, cfg: unknown) => { seen.push([t, cfg]); return 'proven'; })
        };

        const wrapped = withOrderedBatchSegments(provider, ['attest', 'bindPassport']);
        const out = await wrapped.proveTx(tx, { zk: 'config' });

        expect(out).toBe('proven');
        expect(seen).toEqual([[tx, { zk: 'config' }]]);
        expect(tx.intents.get(4)).toBe(attest); // reordered before the delegate saw it
        expect(tx.intents.get(9)).toBe(bind);
    });

    test('a throwing intents surface aborts BEFORE proving (fail-closed)', async () => {
        const evil = { get intents() { throw new Error('wasm boundary says no'); } };
        const provider = { proveTx: vi.fn(async (_tx: unknown) => 'proven') };

        const wrapped = withOrderedBatchSegments(provider, ['a', 'b']);

        await expect(wrapped.proveTx(evil))
            .rejects.toThrow(/wasm boundary says no.*aborting before proving/s);
        expect(provider.proveTx).not.toHaveBeenCalled();
    });

    test('an intent mismatch aborts BEFORE proving (fail-closed)', async () => {
        const provider = { proveTx: vi.fn(async () => 'ok') };
        const wrapped = withOrderedBatchSegments(provider, ['a', 'b']);

        await expect(wrapped.proveTx(txWithIntents([[1, intentFor('a')]])))
            .rejects.toThrow(/could not match.*aborting before proving/s);
        expect(provider.proveTx).not.toHaveBeenCalled();
    });

    test('a causality violation aborts BEFORE proving (no proof, no submit)', async () => {
        const provider = { proveTx: vi.fn(async () => 'proven') };
        const tx = txWithIntents([
            [20, stagedIntent('anchorContentRoot', 'g')],
            [10, stagedIntent('attest', 'f')]
        ]);

        const wrapped = withOrderedBatchSegments(provider, ['attest', 'anchorContentRoot']);

        await expect(wrapped.proveTx(tx))
            .rejects.toThrow(/violates the ledger's causality constraint.*FALLIBLE.*Aborted before proving/s);
        expect(provider.proveTx).not.toHaveBeenCalled();
    });

    test('a batch whose calls are all guaranteed proves normally', async () => {
        const provider = { proveTx: vi.fn(async () => 'proven') };
        const tx = txWithIntents([
            [20, stagedIntent('anchorContentRoot', 'g')],
            [10, stagedIntent('attest', 'g')]
        ]);

        const wrapped = withOrderedBatchSegments(provider, ['attest', 'anchorContentRoot']);

        await expect(wrapped.proveTx(tx)).resolves.toBe('proven');
        expect(provider.proveTx).toHaveBeenCalledTimes(1);
    });

    test('single-call batches skip ordering and delegate', async () => {
        const provider = { proveTx: vi.fn(async () => 'ok') };
        const wrapped = withOrderedBatchSegments(provider, ['a']);

        await expect(wrapped.proveTx(txWithIntents([[1, intentFor('a')]]))).resolves.toBe('ok');
        expect(provider.proveTx).toHaveBeenCalledTimes(1);
    });

    test('preserves the rest of the provider surface via the prototype chain', () => {
        const provider = { proveTx: async () => 'x', somethingElse: () => 42 };
        const wrapped = withOrderedBatchSegments(provider, ['a', 'b']);
        expect(wrapped.somethingElse()).toBe(42);
        expect(wrapped.proveTx).not.toBe(provider.proveTx);
    });
});

describe('orderBatchSegments with independentCalls: stage grouping', () => {
    // The proof-cart shapes measured on a grown vault (batch-segments log
    // lines): the same circuit lands in different stages for different claim
    // keys, so call order alone violates causality about every second cart.
    function cart(stages: Array<'g' | 'f' | 'gf'>) {
        const names = ['proveFieldMembership', 'proveFieldPredicate', 'proveFieldPredicate', 'proveFieldPredicate', 'proveFieldPredicate'];
        const intents = names.map((n, i) => stagedIntent(n, stages[i]));
        // Randomized ids, deliberately not in call order.
        const ids = [50, 10, 40, 20, 30];
        return { tx: txWithIntents(intents.map((it, i) => [ids[i], it] as [number, any])), names, intents };
    }
    const applyOrder = (tx: any) => Array.from(tx.intents.entries()).sort((a: any, b: any) => a[0] - b[0]).map((e: any) => e[1]);

    test('g,g,f,g,f in call order is refused; grouped it is guaranteed-first and passes', () => {
        const { tx, names, intents } = cart(['g', 'g', 'f', 'g', 'f']);
        expect(orderBatchSegments(tx, names)).toBe(true);
        expect(findCausalityViolation(tx)).toMatch(/FALLIBLE/);

        const { tx: tx2, intents: intents2 } = cart(['g', 'g', 'f', 'g', 'f']);
        expect(orderBatchSegments(tx2, names, { independentCalls: true })).toBe(true);
        expect(findCausalityViolation(tx2)).toBeNull();
        // membership, predicate#1, predicate#3 (all g) first, then #2 and #4 (f), call order within a group
        expect(applyOrder(tx2)).toEqual([intents2[0], intents2[1], intents2[3], intents2[2], intents2[4]]);
        void intents;
    });

    test('g,g,g,f,g grouped: the single fallible claim moves last', () => {
        const { tx, names, intents } = cart(['g', 'g', 'g', 'f', 'g']);
        expect(orderBatchSegments(tx, names, { independentCalls: true })).toBe(true);
        expect(findCausalityViolation(tx)).toBeNull();
        expect(applyOrder(tx)).toEqual([intents[0], intents[1], intents[2], intents[4], intents[3]]);
    });

    test('an all-guaranteed cart keeps call order under grouping (byte-identical to today)', () => {
        const { tx, names, intents } = cart(['g', 'g', 'g', 'g', 'g']);
        expect(orderBatchSegments(tx, names, { independentCalls: true })).toBe(true);
        expect(applyOrder(tx)).toEqual(intents);
    });

    test('orderedPrefix pins a leading dependency (in-batch anchor) even when it carries a fallible transcript', () => {
        const anchor = stagedIntent('anchorContentRoot', 'gf');
        const p1 = stagedIntent('proveFieldPredicate', 'g');
        const p2 = stagedIntent('proveFieldPredicate', 'f');
        const tx = txWithIntents([[30, p2], [10, anchor], [20, p1]]);
        expect(orderBatchSegments(tx, ['anchorContentRoot', 'proveFieldPredicate', 'proveFieldPredicate'], { independentCalls: true, orderedPrefix: 1 })).toBe(true);
        // anchor stays first (dependency), the rest is grouped; the anchor's
        // fallible part then starves p1, which is the real, unfixable case.
        expect(applyOrder(tx)).toEqual([anchor, p1, p2]);
        expect(findCausalityViolation(tx)).toMatch(/'anchorContentRoot' \(segment 10\)/);
    });

    test('without independentCalls a dependent batch keeps call order regardless of stages', () => {
        const attest = stagedIntent('attest', 'f');
        const anchor = stagedIntent('anchorContentRoot', 'g');
        const tx = txWithIntents([[20, anchor], [10, attest]]);
        expect(orderBatchSegments(tx, ['attest', 'anchorContentRoot'], {})).toBe(true);
        expect(applyOrder(tx)).toEqual([attest, anchor]);
    });

    test('stages are read per intent, so unknown transcripts count as guaranteed-only (fail-open like the check)', () => {
        const a = intentFor('a');
        const b = stagedIntent('b', 'f');
        const tx = txWithIntents([[1, b], [2, a]]);
        expect(orderBatchSegments(tx, ['b', 'a'], { independentCalls: true })).toBe(true);
        expect(applyOrder(tx)).toEqual([a, b]);
    });
});

describe('withOrderedBatchSegments: grouping and the structured refusal', () => {
    test('independentCalls turns a refused cart into a proven one', async () => {
        const provider = { proveTx: vi.fn(async () => 'proven') };
        const names = ['proveFieldMembership', 'proveFieldPredicate', 'proveFieldPredicate'];
        // Same-named calls are picked in map-encounter order: the fallible
        // predicate comes first, so call order yields g,f,g (refused).
        const mk = () => txWithIntents([[2, stagedIntent('proveFieldPredicate', 'f')], [1, stagedIntent('proveFieldMembership', 'g')], [3, stagedIntent('proveFieldPredicate', 'g')]]);

        await expect(withOrderedBatchSegments(provider, names).proveTx(mk())).rejects.toThrow(/causality/);
        expect(provider.proveTx).not.toHaveBeenCalled();
        await expect(withOrderedBatchSegments(provider, names, { independentCalls: true }).proveTx(mk())).resolves.toBe('proven');
        expect(provider.proveTx).toHaveBeenCalledTimes(1);
    });

    test('the refusal carries code + per-call stages, in the error and in the message', async () => {
        const provider = { proveTx: vi.fn(async () => 'proven') };
        const tx = txWithIntents([[20, stagedIntent('anchorContentRoot', 'g')], [10, stagedIntent('attest', 'f')]]);
        let err: any;
        try { await withOrderedBatchSegments(provider, ['attest', 'anchorContentRoot']).proveTx(tx); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(BatchCausalityError);
        expect(err.code).toBe('BatchCausalityViolation');
        expect(err.calls).toEqual([
            { name: 'attest', segId: 10, stages: 'f:6.04G' },
            { name: 'anchorContentRoot', segId: 20, stages: 'g:5.15G' }
        ]);
        expect(err.message).toMatch(/Stages in apply order: attest=10\[f:6\.04G\] anchorContentRoot=20\[g:5\.15G\]$/);
        expect(provider.proveTx).not.toHaveBeenCalled();
    });
});
