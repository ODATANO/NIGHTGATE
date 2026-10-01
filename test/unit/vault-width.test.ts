// Width-variant coverage of the server layers: the slotWidth registration
// attribute and the vault-family witness factory dispatch. The
// width-parameterized builders are the kit's and tested with the circuits.
import { describe, test, expect, afterEach } from 'vitest';
import {
    registerContract,
    unregisterContract,
    getContractRegistration,
    slotWidthOf
} from '../../srv/submission/contract-registry';
import { buildAttestationVaultWitnesses, getContractWitnessFactory } from '../../srv/submission/contract-witnesses';

const WIDE = 'width-test-vault-32';

afterEach(() => { unregisterContract(WIDE); });

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

    // 64 is NOT supported: the mask path is 32-bit JS bitwise
    // ((1 << 64) wraps to an allowed range of 0..0) and a full unsigned
    // 64-bit mask survives neither Number nor a signed Integer64 column.
    test.each([0, 3, 8, 15, 17, 64, 128, -16])('rejects invalid width %d', (w) => {
        expect(() => registerContract(WIDE, { ...base, slotWidth: w })).toThrow(/slotWidth must be 16 or 32/);
    });
});

describe('contract-witnesses factory dispatch', () => {
    test('vault-family factory dispatch covers width variants and aliases', () => {
        expect(getContractWitnessFactory('attestation-vault')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('attestation-vault-32')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('attestation-vault-v2-alias')).toBe(buildAttestationVaultWitnesses);
        expect(getContractWitnessFactory('counter')).toBeUndefined();
    });
});
