/**
 * Tests for srv/submission/predicate-state.ts (crawler-free predicate-result
 * reader).
 *
 * Exercises readPredicateResult against a FAKE `ledger()`-shaped object and a
 * fake queryContractState: no SDK, no chain. The claim-key recompute
 * (computePredicateClaimKey) needs the ESM compact-runtime and is covered by
 * scripts/spike-state-verification.mjs (byte-exact match to a live-emitted key).
 */
import { readPredicateResult } from '../../srv/submission/predicate-state';

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** predicate_results + field_predicate_results as fill-byte -> boolean maps. */
function makeLedger(results: Record<number, boolean>, fieldResults: Record<number, boolean> = {}) {
    const fillOf = (k: Uint8Array) => k[0];
    const map = (m: Record<number, boolean>) => ({
        member: (k: Uint8Array) => fillOf(k) in m,
        lookup: (k: Uint8Array) => m[fillOf(k)]
    });
    return { predicate_results: map(results), field_predicate_results: map(fieldResults) } as any;
}

function readFor(ledger: any, claimFill: number, field = false) {
    return readPredicateResult({
        contractAddress: '0xVAULT',
        claimKey: hx(b(claimFill)),
        field,
        ledger: () => ledger,
        queryContractState: async () => ({})
    });
}

describe('readPredicateResult', () => {
    test('claim key present with true result → true', async () => {
        expect(await readFor(makeLedger({ 0x42: true }), 0x42)).toBe(true);
    });

    test('claim key present but false result → false', async () => {
        expect(await readFor(makeLedger({ 0x42: false }), 0x42)).toBe(false);
    });

    test('claim key absent → false', async () => {
        expect(await readFor(makeLedger({ 0x42: true }), 0x99)).toBe(false);
    });

    test('field=true reads field_predicate_results, not predicate_results', async () => {
        // Same fill present as true in the FIELD map only; the plain map is empty.
        const led = makeLedger({}, { 0x42: true });
        expect(await readFor(led, 0x42, true)).toBe(true);
        expect(await readFor(led, 0x42, false)).toBe(false);
    });

    test('field=true with absent field key → false', async () => {
        expect(await readFor(makeLedger({ 0x42: true }, { 0x43: true }), 0x42, true)).toBe(false);
    });

    test('no contract state (null) → returns null (clean negative)', async () => {
        const r = await readPredicateResult({
            contractAddress: '0xVAULT',
            claimKey: hx(b(0x42)),
            ledger: () => { throw new Error('ledger should not be called'); },
            queryContractState: async () => null
        });
        expect(r).toBeNull();
    });

    test('decodes via state.data when present (ChargedState shape)', async () => {
        const seen: any[] = [];
        const r = await readPredicateResult({
            contractAddress: '0xVAULT',
            claimKey: hx(b(0x42)),
            ledger: (s: any) => { seen.push(s); return makeLedger({ 0x42: true }); },
            queryContractState: async () => ({ data: 'CHARGED_STATE' })
        });
        expect(seen[0]).toBe('CHARGED_STATE');
        expect(r).toBe(true);
    });
});
