/**
 * Tests for srv/submission/contract-witnesses.ts.
 *
 * Covers:
 *  - deriveAttestationSecret determinism + non-collision across seeds
 *  - buildAttestationVaultWitnesses passes private state through unchanged
 *  - getContractWitnessFactory returns the right factory by name
 */

import {
    buildAttestationVaultWitnesses,
    deriveAttestationSecret,
    getContractWitnessFactory
} from '../../srv/submission/contract-witnesses';

describe('deriveAttestationSecret', () => {
    const seedA = new Uint8Array(32).fill(0x11);
    const seedB = new Uint8Array(32).fill(0x22);

    test('returns 32 bytes', () => {
        const out = deriveAttestationSecret(seedA);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.byteLength).toBe(32);
    });

    test('is deterministic for the same seed', () => {
        const a = deriveAttestationSecret(seedA);
        const b = deriveAttestationSecret(seedA);
        expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    });

    test('differs for different seeds (domain separation works)', () => {
        const a = deriveAttestationSecret(seedA);
        const b = deriveAttestationSecret(seedB);
        expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
    });

    test('does not return the raw seed (one-way HMAC)', () => {
        const out = deriveAttestationSecret(seedA);
        expect(Buffer.from(out).toString('hex')).not.toBe(Buffer.from(seedA).toString('hex'));
    });
});

describe('buildAttestationVaultWitnesses', () => {
    test('returns an object with local_secret_key', () => {
        const secret = new Uint8Array(32).fill(0xab);
        const witnesses = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(typeof witnesses.local_secret_key).toBe('function');
    });

    test('local_secret_key returns [privateState, secret] tuple', () => {
        const secret = new Uint8Array(32).fill(0xab);
        const witnesses = buildAttestationVaultWitnesses({ attestationSecret: secret });
        const fakePrivateState = { some: 'state' };
        const [ps, returnedSecret] = witnesses.local_secret_key({
            privateState: fakePrivateState
        });
        expect(ps).toBe(fakePrivateState);
        expect(returnedSecret).toBe(secret);
    });

    test('local_secret_key returns the same secret on every call (witness determinism)', () => {
        const secret = new Uint8Array(32).fill(0xab);
        const witnesses = buildAttestationVaultWitnesses({ attestationSecret: secret });
        const a = witnesses.local_secret_key({ privateState: null });
        const b = witnesses.local_secret_key({ privateState: null });
        expect(a[1]).toBe(b[1]);
        expect(Buffer.from(a[1]).toString('hex')).toBe(Buffer.from(b[1]).toString('hex'));
    });
});

describe('buildAttestationVaultWitnesses: field-bound proof witnesses (proveFieldPredicate)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const SIB = ['1', '2', '3', '4'].map((n) => n.repeat(64)); // 4 × 64-hex
    const proof = { fieldValue: '3600', siblings: SIB, dirs: [true, false, true, false] };

    test('always exposes field_value / merkle_siblings / merkle_dirs (Witnesses<PS> shape complete)', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(typeof w.field_value).toBe('function');
        expect(typeof w.merkle_siblings).toBe('function');
        expect(typeof w.merkle_dirs).toBe('function');
    });

    test('field_value returns [privateState, bigint] when merkleProof supplied', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: proof });
        const ps = { s: 2 };
        const [outPs, v] = w.field_value({ privateState: ps });
        expect(outPs).toBe(ps);
        expect(v).toBe(3600n);
    });

    test('merkle_siblings returns 4 decoded 32-byte digests', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: proof });
        const [, sibs] = w.merkle_siblings({ privateState: null });
        expect(Array.isArray(sibs)).toBe(true);
        expect(sibs).toHaveLength(4);
        for (const s of sibs) {
            expect(s).toBeInstanceOf(Uint8Array);
            expect(s.byteLength).toBe(32);
        }
        expect(Buffer.from(sibs[0]).toString('hex')).toBe('1'.repeat(64));
    });

    test('merkle_dirs returns the boolean direction vector', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: proof });
        const [, dirs] = w.merkle_dirs({ privateState: null });
        expect(dirs).toEqual([true, false, true, false]);
    });

    test('field witnesses throw if invoked without merkleProof', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(() => w.field_value({ privateState: null })).toThrow(/without a merkleProof/);
        expect(() => w.merkle_siblings({ privateState: null })).toThrow(/without a merkleProof/);
        expect(() => w.merkle_dirs({ privateState: null })).toThrow(/without a merkleProof/);
    });

    test('wrong-length path fails fast at build time', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { fieldValue: '1', siblings: SIB.slice(0, 3), dirs: [true, false, true, false] }
        })).toThrow(/must each have 4 entries/);
    });
});

describe('buildAttestationVaultWitnesses: batch proof holder (per-call rebinding)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const SIB_A = ['1', '2', '3', '4'].map((n) => n.repeat(64));
    const SIB_B = ['5', '6', '7', '8'].map((n) => n.repeat(64));
    const proofA = { fieldValue: '100', siblings: SIB_A, dirs: [true, false, false, false] };
    const proofB = { fieldValue: '200', siblings: SIB_B, dirs: [false, true, true, true] };

    test('resolves the CURRENT proof at invocation time; swapping rebinds all three witnesses', () => {
        const holder: { current?: typeof proofA } = { current: proofA };
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProofHolder: holder });

        expect(w.field_value({ privateState: null })[1]).toBe(100n);
        expect(Buffer.from(w.merkle_siblings({ privateState: null })[1][0]).toString('hex')).toBe('1'.repeat(64));
        expect(w.merkle_dirs({ privateState: null })[1]).toEqual([true, false, false, false]);

        holder.current = proofB;
        expect(w.field_value({ privateState: null })[1]).toBe(200n);
        expect(Buffer.from(w.merkle_siblings({ privateState: null })[1][0]).toString('hex')).toBe('5'.repeat(64));
        expect(w.merkle_dirs({ privateState: null })[1]).toEqual([false, true, true, true]);
    });

    test('empty holder throws (a call without its own proof must not inherit one)', () => {
        const holder: { current?: typeof proofA } = {};
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProofHolder: holder });
        expect(() => w.field_value({ privateState: null })).toThrow(/empty batch proof holder/);
        holder.current = proofA;
        expect(w.field_value({ privateState: null })[1]).toBe(100n);
        holder.current = undefined;
        expect(() => w.merkle_siblings({ privateState: null })).toThrow(/empty batch proof holder/);
    });

    test('malformed current proof fails the invoking call, not the build', () => {
        const holder: { current?: any } = { current: { fieldValue: '1', siblings: SIB_A.slice(0, 3), dirs: [true, false, true, false] } };
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProofHolder: holder });
        expect(() => w.field_value({ privateState: null })).toThrow(/must each have 4 entries/);
    });

    test('merkleProof and merkleProofHolder together are rejected at build time', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: proofA,
            merkleProofHolder: { current: proofB }
        })).toThrow(/mutually exclusive/);
    });

    test('static merkleProof path is unchanged by the holder feature', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: proofA });
        expect(w.field_value({ privateState: null })[1]).toBe(100n);
        expect(() => buildAttestationVaultWitnesses({ attestationSecret: secret }).field_value({ privateState: null }))
            .toThrow(/without a merkleProof/);
    });
});

describe('buildAttestationVaultWitnesses: bytes proof witnesses (proveFieldEquality/proveFieldMembership)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const SIB = ['1', '2', '3', '4'].map((n) => n.repeat(64));
    const SET_SIB = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => n.repeat(64));
    const DIGEST = '9'.repeat(64);
    const membershipProof = {
        fieldDigest: DIGEST, siblings: SIB, dirs: [true, false, true, false],
        setProof: { siblings: SET_SIB, dirs: [false, true, false, true, false, true] }
    };

    test('always exposes field_digest / set_siblings / set_dirs (Witnesses<PS> shape complete)', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(typeof w.field_digest).toBe('function');
        expect(typeof w.set_siblings).toBe('function');
        expect(typeof w.set_dirs).toBe('function');
    });

    test('membership bundle serves digest, content path and set path', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: membershipProof });
        const [, digest] = w.field_digest({ privateState: null });
        expect(Buffer.from(digest).toString('hex')).toBe(DIGEST);
        const [, setSibs] = w.set_siblings({ privateState: null });
        expect(setSibs).toHaveLength(6);
        expect(Buffer.from(setSibs[0]).toString('hex')).toBe('a'.repeat(64));
        expect(w.set_dirs({ privateState: null })[1]).toEqual([false, true, false, true, false, true]);
        // The content-path witnesses serve the same bundle.
        expect(w.merkle_siblings({ privateState: null })[1]).toHaveLength(4);
    });

    test('equality bundle (path only) serves the content path but throws for the membership witnesses', () => {
        const w = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { siblings: SIB, dirs: [true, false, true, false] }
        });
        expect(w.merkle_siblings({ privateState: null })[1]).toHaveLength(4);
        expect(() => w.field_value({ privateState: null })).toThrow(/numeric proof bundle/);
        expect(() => w.field_digest({ privateState: null })).toThrow(/bytes proof bundle/);
        expect(() => w.set_siblings({ privateState: null })).toThrow(/membership-set path/);
        expect(() => w.set_dirs({ privateState: null })).toThrow(/membership-set path/);
    });

    test('wrong-length set path fails fast at build time', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { ...membershipProof, setProof: { siblings: SET_SIB.slice(0, 5), dirs: [true, true, true, true, true, true] } }
        })).toThrow(/must each have 6 entries/);
    });

    test('holder mode rebinds across MIXED bundles (numeric -> membership -> equality)', () => {
        const numeric = { fieldValue: '100', siblings: SIB, dirs: [true, false, false, false] };
        const equality = { siblings: SIB, dirs: [false, false, false, true] };
        const holder: { current?: any } = { current: numeric };
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProofHolder: holder });

        expect(w.field_value({ privateState: null })[1]).toBe(100n);
        expect(() => w.field_digest({ privateState: null })).toThrow(/bytes proof bundle/);

        holder.current = membershipProof;
        expect(Buffer.from(w.field_digest({ privateState: null })[1]).toString('hex')).toBe(DIGEST);
        expect(w.set_dirs({ privateState: null })[1]).toEqual([false, true, false, true, false, true]);
        expect(() => w.field_value({ privateState: null })).toThrow(/numeric proof bundle/);

        holder.current = equality;
        expect(w.merkle_dirs({ privateState: null })[1]).toEqual([false, false, false, true]);
        expect(() => w.set_siblings({ privateState: null })).toThrow(/membership-set path/);
    });
});

describe('buildAttestationVaultWitnesses: cross-root docPair witnesses (proveDocumentComparison, v4)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const SCHEMA = [
        { fieldKey: 'a1'.repeat(32), kind: 0, scale: '1000' },
        { fieldKey: 'b2'.repeat(32), kind: 1, scale: '0' },
        ...Array.from({ length: 14 }, () => ({ fieldKey: 'ee'.repeat(32), kind: 2, scale: '0' }))
    ];
    const OPENING_A = {
        saltSeed: '11'.repeat(32),
        slots: [
            { present: true, value: '47300' },
            { present: true, valueDigest: 'cd'.repeat(32) },
            ...Array.from({ length: 14 }, () => ({ present: false }))
        ]
    };
    const OPENING_B = {
        saltSeed: '22'.repeat(32),
        slots: [
            { present: true, value: '99000' },
            { present: false },
            ...Array.from({ length: 14 }, () => ({ present: false }))
        ]
    };
    const PAIR = { docPair: { schema: SCHEMA, openingA: OPENING_A, openingB: OPENING_B } };

    test('always exposes the five doc witnesses (Witnesses<PS> shape complete)', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        for (const name of ['doc_schema', 'doc_salt_a', 'doc_salt_b', 'doc_slots_a', 'doc_slots_b']) {
            expect(typeof w[name]).toBe('function');
        }
    });

    test('docPair bundle decodes schema + both openings into runtime shapes, no siblings needed', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProof: PAIR });
        const [, ds] = w.doc_schema({ privateState: null });
        expect(ds).toHaveLength(16);
        expect(Buffer.from(ds[0].field_key).toString('hex')).toBe('a1'.repeat(32));
        expect(ds[0].kind).toBe(0n);
        expect(ds[0].scale).toBe(1000n);
        expect(ds[15].kind).toBe(2n);
        expect(Buffer.from(w.doc_salt_a({ privateState: null })[1]).toString('hex')).toBe('11'.repeat(32));
        expect(Buffer.from(w.doc_salt_b({ privateState: null })[1]).toString('hex')).toBe('22'.repeat(32));
        const [, oa] = w.doc_slots_a({ privateState: null });
        expect(oa[0]).toMatchObject({ present: true, uint_value: 47300n });
        expect(Buffer.from(oa[1].value_digest).toString('hex')).toBe('cd'.repeat(32));
        const [, ob] = w.doc_slots_b({ privateState: null });
        expect(ob[1].present).toBe(false);
        // Absent slots carry well-typed neutral members.
        expect(ob[15]).toMatchObject({ present: false, uint_value: 0n });
        // The single-field witnesses still demand an inclusion path.
        expect(() => w.merkle_siblings({ privateState: null })).toThrow(/inclusion path/);
    });

    test('wrong-length or half-supplied bundles fail fast at build time', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: SCHEMA.slice(0, 15), openingA: OPENING_A, openingB: OPENING_B } }
        })).toThrow(/exactly 16 entries/);
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: SCHEMA, openingA: OPENING_A } }
        })).toThrow(/schema, openingA and openingB/);
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: {} }
        })).toThrow(/schema, openingA and openingB/);
    });

    test('holder mode rebinds docPair bundles per call like every other bundle kind', () => {
        const holder: { current?: any } = { current: PAIR };
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret, merkleProofHolder: holder });
        expect(Buffer.from(w.doc_salt_a({ privateState: null })[1]).toString('hex')).toBe('11'.repeat(32));
        holder.current = { docPair: { schema: SCHEMA, openingA: OPENING_B, openingB: OPENING_A } };
        expect(Buffer.from(w.doc_salt_a({ privateState: null })[1]).toString('hex')).toBe('22'.repeat(32));
        holder.current = { siblings: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)], dirs: [true, false, true, false] };
        expect(() => w.doc_schema({ privateState: null })).toThrow(/schema/);
    });
});

describe('getContractWitnessFactory', () => {
    test('returns the factory for attestation-vault', () => {
        const factory = getContractWitnessFactory('attestation-vault');
        expect(typeof factory).toBe('function');
    });

    test('returns undefined for unknown contract names', () => {
        expect(getContractWitnessFactory('counter')).toBeUndefined();
        expect(getContractWitnessFactory('does-not-exist')).toBeUndefined();
        expect(getContractWitnessFactory('')).toBeUndefined();
    });
});
