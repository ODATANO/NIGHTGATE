/**
 * Tests for srv/utils/wallet-hd.ts.
 *
 * Only `mnemonicToBip39SeedHex` is unit-tested here — it's pure bip39 (CJS),
 * loadable in Jest. `deriveRoleSeeds` dynamic-imports the ESM-only
 * `@midnightntwrk/wallet-sdk-hd`, which Jest's resolver can't load; its
 * correctness (the per-role HD path that matches Lace) is verified against a
 * live account by scripts/probe-seed-derivation.mjs.
 */

import { mnemonicToBip39SeedHex } from '../../srv/utils/wallet-hd';
import { mnemonicToSeedSync } from 'bip39';

// Standard BIP39 test vector (checksum-valid 12-word phrase).
const VALID = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('mnemonicToBip39SeedHex', () => {
    test('returns the 128-hex (64-byte) BIP39 seed for a valid mnemonic', () => {
        const hex = mnemonicToBip39SeedHex(VALID);
        expect(hex).toMatch(/^[0-9a-f]{128}$/);
        expect(hex).toBe(mnemonicToSeedSync(VALID).toString('hex'));
    });

    test('is deterministic for the same phrase', () => {
        expect(mnemonicToBip39SeedHex(VALID)).toBe(mnemonicToBip39SeedHex(VALID));
    });

    test('trims surrounding whitespace before deriving', () => {
        expect(mnemonicToBip39SeedHex(`  ${VALID}  \n`)).toBe(mnemonicToBip39SeedHex(VALID));
    });

    test('throws on an invalid (bad-checksum) mnemonic', () => {
        expect(() => mnemonicToBip39SeedHex('not a real mnemonic phrase at all here'))
            .toThrow(/Invalid BIP39 mnemonic/);
    });
});
