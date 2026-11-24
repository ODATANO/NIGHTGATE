/**
 * Per-contract witness factory dispatch; the witness builder itself is the
 * kit's and tested with the circuits.
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { getContractWitnessFactory, isVaultLineage, deriveTokenFactoryIssuerSecret, deriveAttestationSecret } from '../../srv/submission/contract-witnesses';

/** The context a circuit hands a witness. Only the private state matters to these witnesses. */
function witnessContext(privateState: unknown): WitnessContext<unknown, unknown> {
    return { privateState, ledger: undefined, contractAddress: '' };
}

describe('getContractWitnessFactory', () => {
    test('returns the factory for attestation-vault', () => {
        const factory = getContractWitnessFactory('attestation-vault');
        expect(typeof factory).toBe('function');
    });

    test('only the two vault packages take the deployer\'s attester id in their constructor', () => {
        expect(['attestation-vault', 'attestation-vault-32'].map(isVaultLineage)).toEqual([true, true]);
        expect(['attestation-vault-demo', 'token-factory', 'counter', undefined].map(isVaultLineage)).toEqual([false, false, false, false]);
    });

    test('a name that only starts like a contract package gets no witnesses', () => {
        for (const name of ['token-factory-preprod', 'attestation-vault-demo', 'attestation-vault-v2-alias', 'toString', 'constructor', undefined]) {
            expect(getContractWitnessFactory(name), String(name)).toBeUndefined();
        }
    });

    test('returns the factory witnesses for token-factory; mint reads the issuer secret, nothing else does', () => {
        const factory = getContractWitnessFactory('token-factory')!;
        expect(typeof factory).toBe('function');
        const secret = new Uint8Array(32).fill(9);
        const witnesses = factory({ issuerSecret: secret });
        expect(witnesses.issuerSecret(witnessContext('ps'))).toEqual(['ps', secret]);
        const vacant = getContractWitnessFactory('token-factory')!({});
        expect(() => vacant.issuerSecret(witnessContext(null))).toThrow(/issuerSecret/);
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
