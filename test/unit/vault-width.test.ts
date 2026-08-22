// Width-variant coverage (0.19, attestation-vault-32): the slotWidth
// registration attribute and every width-parameterized layer, with the
// 16-slot DEFAULTS pinned byte-identical (NIGHTPASS compatibility).
import { describe, test, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
    registerContract,
    unregisterContract,
    getContractRegistration,
    slotWidthOf
} from '../../srv/submission/contract-registry';
import {
    computeSchemaDescriptors,
    computeSchemaId,
    buildDocumentContentRoot,
    MAX_PROOF_FIELDS,
    type PureCircuits
} from '../../srv/submission/document-proof';
import { buildAttestationVaultWitnesses, getContractWitnessFactory } from '../../srv/submission/contract-witnesses';
import { expandAllowedMask } from '../../srv/submission/predicate-state';

const WIDE = 'width-test-vault-32';

afterEach(() => { unregisterContract(WIDE); });

// ---- registry: slotWidth attribute -----------------------------------------

describe('contract-registry slotWidth', () => {
    const base = { artifactPath: 'x/contract/index.js', privateStateId: 'ps', zkConfigPath: 'x' };

    test('defaults to 16 when absent (existing registrations unchanged)', () => {
        registerContract(WIDE, base);
        expect(slotWidthOf(getContractRegistration(WIDE))).toBe(16);
        expect(slotWidthOf(undefined)).toBe(16);
    });

    test('stores and freezes an explicit width', () => {
        registerContract(WIDE, { ...base, slotWidth: 32 });
        expect(getContractRegistration(WIDE)?.slotWidth).toBe(32);
        expect(slotWidthOf(getContractRegistration(WIDE))).toBe(32);
    });

    // 64 measured but NOT shipped: the mask path is 32-bit JS bitwise
    // ((1 << 64) wraps to an allowed range of 0..0) and a full unsigned
    // 64-bit mask survives neither Number nor a signed Integer64 column.
    test.each([0, 3, 15, 17, 64, 128, -16])('rejects invalid width %d', (w) => {
        expect(() => registerContract(WIDE, { ...base, slotWidth: w })).toThrow(/slotWidth must be 8, 16 or 32/);
    });
});

// ---- document-proof: width-parameterized tree builders ---------------------

// Deterministic stand-in pure circuits (unit tests never load the artifact).
const h = (...parts: (Uint8Array | string)[]): Uint8Array => {
    const hash = createHash('sha256');
    for (const p of parts) hash.update(p);
    return new Uint8Array(hash.digest());
};
const stubPure = {
    leafHash: (k: Uint8Array, v: bigint, s: Uint8Array) => h('leaf', k, String(v), s),
    nodeHash: (l: Uint8Array, r: Uint8Array) => h('node', l, r),
    bytesLeafHash: (k: Uint8Array, d: Uint8Array, s: Uint8Array) => h('bytes', k, d, s),
    absentLeafHash: (k: Uint8Array, s: Uint8Array) => h('absent', k, s),
    setLeafHash: (d: Uint8Array) => h('set', d),
    descriptorLeafHash: (k: Uint8Array, kind: bigint, scale: bigint) => h('desc', k, String(kind), String(scale)),
    slotSalt: (seed: Uint8Array, i: bigint) => h('salt', seed, String(i)),
    emptyLeafKey: () => new Uint8Array(32)
} as unknown as PureCircuits;

describe('document-proof width parameter', () => {
    const specs = [{ field: 'a' }, { field: 'b', kind: 'bytes' as const }];
    const doc = { a: 12, b: 'hello' };
    const seed = new Uint8Array(32).fill(7);

    test('default width stays 16 (descriptor count, opening slots, path depth)', () => {
        expect(computeSchemaDescriptors(specs)).toHaveLength(MAX_PROOF_FIELDS);
        const built = buildDocumentContentRoot(doc, specs, stubPure, seed);
        expect(built.schema).toHaveLength(16);
        expect(built.opening.slots).toHaveLength(16);
        expect(built.fields[0].siblings).toHaveLength(4);
    });

    test('width 32 builds a depth-5 tree with 32 slots', () => {
        expect(computeSchemaDescriptors(specs, 32)).toHaveLength(32);
        const built = buildDocumentContentRoot(doc, specs, stubPure, seed, 32);
        expect(built.schema).toHaveLength(32);
        expect(built.opening.slots).toHaveLength(32);
        expect(built.fields[0].siblings).toHaveLength(5);
        expect(built.fields[0].dirs).toHaveLength(5);
        // Different tree shape => different roots and schema ids than width 16.
        const narrow = buildDocumentContentRoot(doc, specs, stubPure, seed);
        expect(built.contentRoot).not.toBe(narrow.contentRoot);
        expect(built.schemaId).not.toBe(narrow.schemaId);
        expect(built.schemaId).toBe(computeSchemaId(specs, stubPure, 32));
    });

    test('same inputs are deterministic per width', () => {
        const a = buildDocumentContentRoot(doc, specs, stubPure, seed, 32);
        const b = buildDocumentContentRoot(doc, specs, stubPure, seed, 32);
        expect(a.contentRoot).toBe(b.contentRoot);
    });
});

// ---- contract-witnesses: slotWidth-sized decode ----------------------------

describe('contract-witnesses slotWidth', () => {
    const secret = new Uint8Array(32).fill(1);
    const hex64 = 'ab'.repeat(32);
    const schemaOf = (n: number) => Array.from({ length: n }, () => ({ fieldKey: hex64, kind: 1, scale: '0' }));
    const openingOf = (n: number) => ({ saltSeed: hex64, slots: Array.from({ length: n }, () => ({ present: false })) });
    const pathOf = (n: number) => ({ siblings: Array.from({ length: n }, () => hex64), dirs: Array.from({ length: n }, () => true) });

    test('default stays 16/4 (message byte-identical)', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { fieldSalt: hex64, ...pathOf(5) }
        })).toThrow(/must each have 4 entries/);
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: schemaOf(32) as any, openingA: openingOf(32), openingB: openingOf(32) } }
        })).toThrow(/exactly 16 entries/);
    });

    test('slotWidth 32 sizes schema/opening/path checks', () => {
        const w = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            slotWidth: 32,
            merkleProof: { docPair: { schema: schemaOf(32) as any, openingA: openingOf(32), openingB: openingOf(32) } }
        });
        const [, ds] = w.doc_schema({ privateState: null });
        expect(ds).toHaveLength(32);
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            slotWidth: 32,
            merkleProof: { docPair: { schema: schemaOf(16) as any, openingA: openingOf(32), openingB: openingOf(32) } }
        })).toThrow(/exactly 32 entries/);
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            slotWidth: 32,
            merkleProof: { fieldSalt: hex64, ...pathOf(4) }
        })).toThrow(/must each have 5 entries/);
        const ok = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            slotWidth: 32,
            merkleProof: { fieldSalt: hex64, ...pathOf(5) }
        });
        const [, sibs] = ok.merkle_siblings({ privateState: null });
        expect(sibs).toHaveLength(5);
    });

    test('vault-family factory dispatch covers width variants and aliases', () => {
        expect(getContractWitnessFactory('attestation-vault')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('attestation-vault-32')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('attestation-vault-v2-alias')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('counter')).toBeUndefined();
    });
});

// ---- predicate-state: width-sized mask expansion ---------------------------

describe('expandAllowedMask width', () => {
    test('default 16 unchanged (bounds message byte-identical)', () => {
        expect(expandAllowedMask(0)).toEqual(Array(16).fill(false));
        expect(expandAllowedMask(0xffff)).toEqual(Array(16).fill(true));
        expect(() => expandAllowedMask(0x10000)).toThrow(/0\.\.65535/);
    });

    test('width 32 accepts the full 32-bit range including bit 31', () => {
        expect(expandAllowedMask(0, 32)).toEqual(Array(32).fill(false));
        expect(expandAllowedMask(0xffffffff, 32)).toEqual(Array(32).fill(true));
        const bit31 = expandAllowedMask(0x80000000, 32);
        expect(bit31[31]).toBe(true);
        expect(bit31.slice(0, 31).every(b => b === false)).toBe(true);
        expect(() => expandAllowedMask(0x100000000, 32)).toThrow(/0\.\.4294967295/);
        expect(() => expandAllowedMask(-1, 32)).toThrow(/0\.\.4294967295/);
    });
});

// ---- browser twins (ESM) ---------------------------------------------------

describe('browser witness/call helpers width', () => {
    test('witnesses.mjs slotWidth mirrors the server twin', async () => {
        // @ts-expect-error the .mjs ships its types as witnesses.d.ts (package-export mapped), no .d.mts twin
        const mod = await import('../../src/browser/witnesses.mjs');
        const hex64 = 'cd'.repeat(32);
        const secret = new Uint8Array(32).fill(2);
        const opening32 = { saltSeed: hex64, slots: Array.from({ length: 32 }, () => ({ present: false })) };
        const schema32 = Array.from({ length: 32 }, () => ({ fieldKey: hex64, kind: 2, scale: '0' }));
        const w = mod.buildAttestationVaultWitnesses({
            attestationSecret: secret, slotWidth: 32,
            merkleProof: { docPair: { schema: schema32, openingA: opening32, openingB: opening32 } }
        });
        const [, slots] = w.doc_slots_a({ privateState: null });
        expect(slots).toHaveLength(32);
        expect(() => mod.buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: schema32, openingA: opening32, openingB: opening32 } }
        })).toThrow(/exactly 16 entries/);
    });

    test('prepare* helpers pass the raw bundle through and size by slotWidth', async () => {
        // @ts-expect-error untyped browser-internal module (duck-typed on purpose)
        const mod = await import('../../src/browser/attestation-vault-calls.mjs');
        const hex64 = 'ef'.repeat(32);
        const schema32 = Array.from({ length: 32 }, (_, i) => ({ fieldKey: hex64, kind: i < 4 ? 1 : 2, scale: '0' }));
        const opening32 = { saltSeed: hex64, slots: Array.from({ length: 32 }, () => ({ present: false })) };
        const docPair = { schema: schema32, openingA: opening32, openingB: opening32 };
        const call = mod.prepareProveFieldsDiffer({
            payloadHashA: 'aa'.repeat(32), payloadHashB: 'bb'.repeat(32), k: 20, docPair, slotWidth: 32
        });
        expect(call.args[3]).toHaveLength(32);
        expect(call.args[4]).toBe(20n);
        expect(call.merkleProof).toEqual({ docPair });
        expect(call.slotWidth).toBe(32);
        // Default width still caps k at 16 with the original message.
        expect(() => mod.prepareProveFieldsDiffer({
            payloadHashA: 'aa'.repeat(32), payloadHashB: 'bb'.repeat(32), k: 17,
            docPair: { schema: schema32.slice(0, 16), openingA: { ...opening32, slots: opening32.slots.slice(0, 16) }, openingB: { ...opening32, slots: opening32.slots.slice(0, 16) } }
        })).toThrow(/1\.\.16/);
        // Width-32 integrity: full 32-bit mask bound, bit 31 usable.
        const integ = mod.prepareProveFieldsUnchangedExcept({
            payloadHashA: 'aa'.repeat(32), payloadHashB: 'bb'.repeat(32),
            allowedMask: 0x80000001, docPair, slotWidth: 32
        });
        expect(integ.args[3][0]).toBe(true);
        expect(integ.args[3][31]).toBe(true);
        expect(integ.args[3].filter(Boolean)).toHaveLength(2);
        expect(() => mod.prepareProveFieldsUnchangedExcept({
            payloadHashA: 'aa'.repeat(32), payloadHashB: 'bb'.repeat(32),
            allowedMask: 0x100000000, docPair, slotWidth: 32
        })).toThrow(/0\.\.4294967295/);
    });
});
