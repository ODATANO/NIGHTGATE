/**
 * Per-contract witness factory dispatch; the witness builder itself is the
 * kit's and tested with the circuits.
 */

import { getContractWitnessFactory } from '../../srv/submission/contract-witnesses';

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
