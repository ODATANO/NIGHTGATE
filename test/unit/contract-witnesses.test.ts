/**
 * Per-contract witness factory dispatch; the witness builder itself is the
 * kit's and tested with the circuits.
 */

import { getContractWitnessFactory, deriveTokenFactoryIssuerSecret, deriveAttestationSecret } from '../../srv/submission/contract-witnesses';

describe('getContractWitnessFactory', () => {
    test('returns the factory for attestation-vault', () => {
        const factory = getContractWitnessFactory('attestation-vault');
        expect(typeof factory).toBe('function');
    });

    test('returns the factory witnesses for token-factory and its aliases; mint reads the issuer secret, nothing else does', () => {
        const factory = getContractWitnessFactory('token-factory-preprod')!;
        expect(typeof factory).toBe('function');
        const secret = new Uint8Array(32).fill(9);
        const witnesses = factory({ issuerSecret: secret });
        expect(witnesses.issuerSecret({ privateState: 'ps' })).toEqual(['ps', secret]);
        const vacant = getContractWitnessFactory('token-factory')!({});
        expect(() => vacant.issuerSecret({ privateState: null })).toThrow(/issuerSecret/);
    });

    test('the issuer secret is deterministic per seed and distinct from the vault secret', () => {
        const seed = new Uint8Array(32).fill(1);
        const a = deriveTokenFactoryIssuerSecret(seed);
        expect(a).toHaveLength(32);
        expect(Buffer.from(a).equals(Buffer.from(deriveTokenFactoryIssuerSecret(seed)))).toBe(true);
        expect(Buffer.from(a).equals(Buffer.from(deriveAttestationSecret(seed)))).toBe(false);
        expect(Buffer.from(a).equals(Buffer.from(deriveTokenFactoryIssuerSecret(new Uint8Array(32).fill(2))))).toBe(false);
    });

    test('returns undefined for unknown contract names', () => {
        expect(getContractWitnessFactory('counter')).toBeUndefined();
        expect(getContractWitnessFactory('does-not-exist')).toBeUndefined();
        expect(getContractWitnessFactory('')).toBeUndefined();
    });
});
