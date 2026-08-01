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

describe('buildAttestationVaultWitnesses: predicate witnesses (commitValue/provePredicate)', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const SALT_HEX = 'a'.repeat(64);

    test('always exposes attested_value + value_salt (Witnesses<PS> shape is complete)', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(typeof w.attested_value).toBe('function');
        expect(typeof w.value_salt).toBe('function');
    });

    test('attested_value returns [privateState, bigint] when witnessValues supplied', () => {
        const w = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            witnessValues: { attestedValue: '47300', valueSalt: SALT_HEX }
        });
        const ps = { s: 1 };
        const [outPs, v] = w.attested_value({ privateState: ps });
        expect(outPs).toBe(ps);
        expect(v).toBe(47300n);
    });

    test('value_salt returns the decoded 32-byte opening', () => {
        const w = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            witnessValues: { attestedValue: '1', valueSalt: SALT_HEX }
        });
        const [, salt] = w.value_salt({ privateState: null });
        expect(salt).toBeInstanceOf(Uint8Array);
        expect(salt.byteLength).toBe(32);
        expect(Buffer.from(salt).toString('hex')).toBe(SALT_HEX);
    });

    test('attested_value / value_salt throw if invoked without witnessValues', () => {
        const w = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(() => w.attested_value({ privateState: null })).toThrow(/without a per-call value/);
        expect(() => w.value_salt({ privateState: null })).toThrow(/without a per-call salt/);
    });

    test('local_secret_key still works alongside predicate witnesses', () => {
        const w = buildAttestationVaultWitnesses({
            attestationSecret: secret,
            witnessValues: { attestedValue: '5', valueSalt: SALT_HEX }
        });
        const [, s] = w.local_secret_key({ privateState: null });
        expect(s).toBe(secret);
    });

    test('malformed salt fails fast at build time', () => {
        expect(() => buildAttestationVaultWitnesses({
            attestationSecret: secret,
            witnessValues: { attestedValue: '1', valueSalt: 'xyz' }
        })).toThrow(/64 hex/);
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
