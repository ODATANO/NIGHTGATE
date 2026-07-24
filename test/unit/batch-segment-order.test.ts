/**
 * Tests for srv/midnight/batch-segment-order.ts: deterministic segment
 * ordering for batched contract calls. Fake transactions stand in for the
 * ledger-v8 WASM objects; the contract under test is pure Map surgery plus
 * the proof-provider wrapper semantics.
 */

import { orderBatchSegments, withOrderedBatchSegments } from '../../srv/midnight/batch-segment-order';

function intentFor(circuit: string | Uint8Array) {
    return { actions: [{ entryPoint: circuit }] };
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
