/**
 * Tests for srv/submission/predicate-state.ts (crawler-free predicate-result
 * reader).
 *
 * Exercises readPredicateResult against a FAKE `ledger()`-shaped object and a
 * fake queryContractState: no SDK, no chain. The claim-key recompute
 * (computePredicateClaimKey) needs the ESM compact-runtime and is covered by
 * scripts/integration-test-attestation-vault.mjs (byte-exact match to a live-emitted key).
 */
import { readPredicateResult, expandAllowedMask } from '../../srv/submission/predicate-state';

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

/** The five result maps as fill-byte -> boolean maps. */
function makeLedger(
    fieldResults: Record<number, boolean>,
    equalityResults: Record<number, boolean> = {},
    membershipResults: Record<number, boolean> = {},
    integrityResults: Record<number, boolean> = {},
    diffResults: Record<number, boolean> = {}
) {
    const fillOf = (k: Uint8Array) => k[0];
    const map = (m: Record<number, boolean>) => ({
        member: (k: Uint8Array) => fillOf(k) in m,
        lookup: (k: Uint8Array) => m[fillOf(k)]
    });
    return {
        field_predicate_results: map(fieldResults),
        field_equality_results: map(equalityResults),
        field_membership_results: map(membershipResults),
        document_integrity_results: map(integrityResults),
        document_diff_results: map(diffResults)
    } as any;
}

function readFor(ledger: any, claimFill: number) {
    return readPredicateResult({
        contractAddress: '0xVAULT',
        claimKey: hx(b(claimFill)),
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

    test('default kind reads field_predicate_results only', async () => {
        const led = makeLedger({ 0x42: true }, { 0x43: true });
        expect(await readFor(led, 0x42)).toBe(true);
        expect(await readFor(led, 0x43)).toBe(false);
    });

    test("kind: 'equality' / 'membership' read their own maps only", async () => {
        const led = makeLedger({}, { 0x42: true }, { 0x43: true });
        const readKind = (fill: number, kind: any) => readPredicateResult({
            contractAddress: '0xVAULT', claimKey: hx(b(fill)), kind,
            ledger: () => led, queryContractState: async () => ({})
        });
        expect(await readKind(0x42, 'equality')).toBe(true);
        expect(await readKind(0x43, 'membership')).toBe(true);
        // Cross-map isolation: the same key does not leak across kinds.
        expect(await readKind(0x42, 'membership')).toBe(false);
        expect(await readKind(0x43, 'equality')).toBe(false);
        expect(await readKind(0x42, 'field')).toBe(false);
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

    test("kind: 'integrity' / 'diff' read the cross-root maps only", async () => {
        const led = makeLedger({}, {}, {}, { 0x42: true }, { 0x43: true });
        const readKind = (fill: number, kind: any) => readPredicateResult({
            contractAddress: '0xVAULT', claimKey: hx(b(fill)), kind,
            ledger: () => led, queryContractState: async () => ({})
        });
        expect(await readKind(0x42, 'integrity')).toBe(true);
        expect(await readKind(0x43, 'diff')).toBe(true);
        // Cross-map isolation: the same key does not leak across kinds.
        expect(await readKind(0x42, 'diff')).toBe(false);
        expect(await readKind(0x43, 'integrity')).toBe(false);
        expect(await readKind(0x42, 'equality')).toBe(false);
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

describe('expandAllowedMask', () => {
    test('bit i set -> slot i allowed, little-endian bit order', () => {
        expect(expandAllowedMask(0)).toEqual(Array(16).fill(false));
        expect(expandAllowedMask(0xffff)).toEqual(Array(16).fill(true));
        const m = expandAllowedMask(0b1000000000000101);
        expect(m[0]).toBe(true);
        expect(m[1]).toBe(false);
        expect(m[2]).toBe(true);
        expect(m[15]).toBe(true);
        expect(m.filter(Boolean)).toHaveLength(3);
    });

    test('always 16 entries', () => {
        expect(expandAllowedMask(1)).toHaveLength(16);
    });

    test('rejects out-of-range and non-integer masks', () => {
        for (const bad of [-1, 0x10000, 1.5, NaN]) {
            expect(() => expandAllowedMask(bad)).toThrow(/0\.\.65535/);
        }
    });
});
