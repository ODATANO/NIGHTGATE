/**
 * Tests for srv/submission/attestation-state.ts (crawler-free attestation reader).
 *
 * Exercises readAttestationState against a FAKE `ledger()`-shaped object and a
 * fake queryContractState: no SDK, no chain. The flat maps here mirror the real
 * compiled artifact's public_attestations / attestation_owners / content_roots
 * (all keyed by the known payload_hash; member/lookup only).
 */
import { readAttestationState } from '../../srv/submission/attestation-state';

const b = (fill: number) => new Uint8Array(32).fill(fill);
const hx = (u: Uint8Array) => Buffer.from(u).toString('hex');

/**
 * Build a fake decoded ledger from fill-byte specs. `attested` is the set of
 * payload-hash fills present in public_attestations; `owners` maps a payload
 * fill to its attester fill; `roots` maps a payload fill to its anchored content
 * root fill.
 */
function makeLedger(spec: {
    attested?: number[];
    owners?: Record<number, number>;
    roots?: Record<number, number>;
}) {
    const attested = spec.attested ?? [];
    const owners = spec.owners ?? {};
    const roots = spec.roots ?? {};
    const fillOf = (k: Uint8Array) => k[0]; // 32 bytes filled with one value
    const flat = (map: Record<number, number>) => ({
        member: (k: Uint8Array) => fillOf(k) in map,
        lookup: (k: Uint8Array) => b(map[fillOf(k)])
    });
    return {
        public_attestations: {
            member: (k: Uint8Array) => attested.includes(fillOf(k)),
            lookup: (k: Uint8Array) => b(0) // metadata hash; unused by the reader
        },
        attestation_owners: flat(owners),
        content_roots: flat(roots)
    } as any;
}

function readFor(ledger: any, payloadFill: number, contentRootFill?: number) {
    return readAttestationState({
        contractAddress: '0xVAULT',
        payloadHash: hx(b(payloadFill)),
        contentRoot: contentRootFill === undefined ? undefined : hx(b(contentRootFill)),
        ledger: () => ledger,
        queryContractState: async () => ({}) // non-null → ledger() is consulted
    });
}

describe('readAttestationState', () => {
    test('attested present, no contentRoot supplied → attested true, contentRootOk false, attesterId set', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 } });
        const r = await readFor(led, 0xaa);
        expect(r).toEqual({ attested: true, contentRootOk: false, attesterId: hx(b(0x11)) });
    });

    test('attestation absent → attested false, attesterId empty', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 } });
        const r = await readFor(led, 0x99);
        expect(r).toEqual({ attested: false, contentRootOk: false, attesterId: '' });
    });

    test('contentRoot matches the anchored root → contentRootOk true', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 }, roots: { 0xaa: 0xdd } });
        const r = await readFor(led, 0xaa, 0xdd);
        expect(r).toMatchObject({ attested: true, contentRootOk: true });
    });

    test('contentRoot mismatch → contentRootOk false', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 }, roots: { 0xaa: 0xdd } });
        const r = await readFor(led, 0xaa, 0xee);
        expect(r).toMatchObject({ attested: true, contentRootOk: false });
    });

    test('contentRoot supplied but none anchored → contentRootOk false', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 } });
        const r = await readFor(led, 0xaa, 0xdd);
        expect(r).toMatchObject({ attested: true, contentRootOk: false });
    });

    test('contentRoot compare is case-insensitive', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 }, roots: { 0xaa: 0xdd } });
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            payloadHash: hx(b(0xaa)),
            contentRoot: hx(b(0xdd)).toUpperCase(),
            ledger: () => led,
            queryContractState: async () => ({})
        });
        expect(r).toMatchObject({ contentRootOk: true });
    });

    test('no contract state (null) → returns null (clean negative)', async () => {
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            payloadHash: hx(b(0xaa)),
            ledger: () => { throw new Error('ledger should not be called'); },
            queryContractState: async () => null
        });
        expect(r).toBeNull();
    });

    test('decodes via state.data when present (ChargedState shape)', async () => {
        const led = makeLedger({ attested: [0xaa], owners: { 0xaa: 0x11 } });
        const seen: any[] = [];
        const r = await readAttestationState({
            contractAddress: '0xVAULT',
            payloadHash: hx(b(0xaa)),
            ledger: (s: any) => { seen.push(s); return led; },
            queryContractState: async () => ({ data: 'CHARGED_STATE' })
        });
        expect(seen[0]).toBe('CHARGED_STATE');
        expect(r).toMatchObject({ attested: true });
    });
});
