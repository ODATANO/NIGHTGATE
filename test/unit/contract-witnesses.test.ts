/**
 * Tests for srv/submission/contract-witnesses.ts (T10-extended).
 *
 * Covers:
 *  - deriveAttestationSecret determinism + non-collision across seeds
 *  - buildAttestationVaultWitnesses passes private state through unchanged
 *  - getContractWitnessFactory returns the right factory by name
 */

import {
    buildAttestationVaultWitnesses,
    deriveAttestationSecret,
    getContractWitnessFactory,
    hasContractWitnessFactory
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

    test('hasContractWitnessFactory matches getContractWitnessFactory', () => {
        expect(hasContractWitnessFactory('attestation-vault')).toBe(true);
        expect(hasContractWitnessFactory('counter')).toBe(false);
        expect(hasContractWitnessFactory('unknown')).toBe(false);
    });
});
