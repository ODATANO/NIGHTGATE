/**
 * Tests for srv/utils/wallet-info.ts.
 *
 * Only the validation paths are unit-tested here: they run before any
 * dynamic import of the ESM-only SDK packages, which Jest's resolver can't
 * load (same constraint as wallet-hd.test.ts). Derivation correctness,
 * including the Lace-address match, is verified live by
 * scripts/integration-test-derive-wallet-info.mjs.
 */

import { resolveBip39SeedHex, deriveWalletInfo } from '../../srv/utils/wallet-info';
import { mnemonicToSeedSync } from 'bip39';

const VALID = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VALID_SEED_HEX = mnemonicToSeedSync(VALID).toString('hex');

describe('resolveBip39SeedHex', () => {
    test('mnemonic path returns the BIP39 seed hex', () => {
        expect(resolveBip39SeedHex({ mnemonic: VALID })).toBe(VALID_SEED_HEX);
    });

    test('seedHex path lower-cases and passes through', () => {
        expect(resolveBip39SeedHex({ seedHex: VALID_SEED_HEX.toUpperCase() })).toBe(VALID_SEED_HEX);
    });

    test('mnemonic wins when both are provided', () => {
        expect(resolveBip39SeedHex({ mnemonic: VALID, seedHex: 'f'.repeat(128) })).toBe(VALID_SEED_HEX);
    });

    test('rejects an invalid mnemonic', () => {
        expect(() => resolveBip39SeedHex({ mnemonic: 'not a phrase' })).toThrow(/Invalid BIP39/);
    });

    test('rejects a malformed seedHex', () => {
        expect(() => resolveBip39SeedHex({ seedHex: 'abc' })).toThrow(/128 hex/);
        expect(() => resolveBip39SeedHex({ seedHex: 'g'.repeat(128) })).toThrow(/128 hex/);
    });

    test('rejects missing input', () => {
        expect(() => resolveBip39SeedHex({})).toThrow(/either mnemonic or seedHex/);
    });
});

describe('deriveWalletInfo input validation (pre-SDK)', () => {
    test('rejects a negative accountIndex', async () => {
        await expect(deriveWalletInfo({ mnemonic: VALID, accountIndex: -1, network: 'preview' }))
            .rejects.toThrow(/non-negative integer/);
    });

    test('rejects a fractional accountIndex', async () => {
        await expect(deriveWalletInfo({ mnemonic: VALID, accountIndex: 1.5, network: 'preview' }))
            .rejects.toThrow(/non-negative integer/);
    });

    test('rejects a missing network', async () => {
        await expect(deriveWalletInfo({ mnemonic: VALID, network: '' }))
            .rejects.toThrow(/network is required/);
    });

    test('rejects missing secrets', async () => {
        await expect(deriveWalletInfo({ network: 'preview' }))
            .rejects.toThrow(/either mnemonic or seedHex/);
    });
});
