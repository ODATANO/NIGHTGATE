/**
 * Tests for srv/submission/predicate-state.ts (crawler-free claim reader).
 *
 * Exercises readPredicateResult against a FAKE `ledger()`-shaped object and a
 * fake queryContractState: no SDK, no chain. The claim-key recomputes need the
 * ESM compact-runtime and are covered by test/unit/state-readers-production-path.test.ts
 * (pinned encoding) and test/integration/attestation-vault.test.ts (byte-exact
 * match to a circuit-emitted key).
 */
import { readPredicateResult, expandAllowedMask, anchoredRootOf, anchorOf } from '../../srv/submission/predicate-state';

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

const NOW = 1_700_000_000;

/** The `claims` map as fill-byte -> valid_until, plus optional anchors (fill -> root fill). */
function makeLedger(claims: Record<number, bigint>, anchors: Record<number, number> = {}) {
    const fillOf = (k: Uint8Array) => k[0];
    return {
        claims: {
            member: (k: Uint8Array) => fillOf(k) in claims,
            lookup: (k: Uint8Array) => claims[fillOf(k)]
        },
        content_anchors: {
            member: (k: Uint8Array) => fillOf(k) in anchors,
            lookup: (k: Uint8Array) => ({ root: b(anchors[fillOf(k)]), schema: b(anchors[fillOf(k)] + 1) })
        }
    } as any;
}

function readFor(ledger: any, claimFill: number, nowSeconds: number = NOW) {
    return readPredicateResult({
        contractAddress: '0xVAULT',
        claimKey: hx(b(claimFill)),
        ledger: () => ledger,
        queryContractState: async () => ({}),
        nowSeconds
    });
}

describe('readPredicateResult', () => {
    test('claim key present and unexpired → true', async () => {
        expect(await readFor(makeLedger({ 0x42: BigInt(NOW + 1) }), 0x42)).toBe(true);
    });

    test('claim key present but expired → false', async () => {
        expect(await readFor(makeLedger({ 0x42: BigInt(NOW) }), 0x42)).toBe(false);
        expect(await readFor(makeLedger({ 0x42: BigInt(NOW - 10) }), 0x42)).toBe(false);
    });

    test('claim key absent → false', async () => {
        expect(await readFor(makeLedger({ 0x42: BigInt(NOW + 1) }), 0x99)).toBe(false);
    });

    test('the kind selector does not change the map: every kind reads `claims`', async () => {
        const led = makeLedger({ 0x42: BigInt(NOW + 100) });
        for (const kind of ['field', 'equality', 'membership', 'integrity', 'diff'] as const) {
            expect(await readPredicateResult({
                contractAddress: '0xVAULT', claimKey: hx(b(0x42)), kind,
                ledger: () => led, queryContractState: async () => ({}), nowSeconds: NOW
            })).toBe(true);
        }
    });

    test('defaults nowSeconds to the wall clock', async () => {
        const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
        expect(await readPredicateResult({
            contractAddress: '0xVAULT', claimKey: hx(b(0x42)),
            ledger: () => makeLedger({ 0x42: future }), queryContractState: async () => ({})
        })).toBe(true);
        expect(await readPredicateResult({
            contractAddress: '0xVAULT', claimKey: hx(b(0x42)),
            ledger: () => makeLedger({ 0x42: 1n }), queryContractState: async () => ({})
        })).toBe(false);
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
            ledger: (s: any) => { seen.push(s); return makeLedger({ 0x42: BigInt(NOW + 1) }); },
            queryContractState: async () => ({ data: 'CHARGED_STATE' }),
            nowSeconds: NOW
        });
        expect(seen[0]).toBe('CHARGED_STATE');
        expect(r).toBe(true);
    });
});

describe('anchorOf', () => {
    test('returns root and schema as hex, or null without an anchor', () => {
        const led = makeLedger({}, { 0xaa: 0xdd });
        expect(anchorOf(led, hx(b(0xaa)))).toEqual({ root: hx(b(0xdd)), schema: hx(b(0xde)) });
        expect(anchoredRootOf(led, hx(b(0xaa)))).toBe(hx(b(0xdd)));
        expect(anchorOf(led, hx(b(0xab)))).toBeNull();
        expect(anchoredRootOf(led, hx(b(0xab)))).toBeNull();
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
