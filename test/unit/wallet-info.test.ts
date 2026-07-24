/**
 * Tests for srv/utils/wallet-info.ts.
 *
 * Only the validation paths are unit-tested here: they run before any
 * dynamic import of the ESM-only SDK packages, which Jest's resolver can't
 * load (same constraint as wallet-hd.test.ts). Derivation correctness,
 * including the Lace-address match, is verified live by
 * scripts/integration-test-derive-wallet-info.mjs.
 */

import { resolveBip39SeedHex, deriveWalletInfo, deriveAttesterId } from '../../srv/utils/wallet-info';
import { deriveAttestationSecret } from '../../srv/submission/contract-witnesses';
import { persistentHash, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';
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

describe('deriveAttesterId', () => {
    const zswapSeed = () => Uint8Array.from(Array(32).fill(1));

    test('pins the golden vector (formula stability across releases)', () => {
        // caller_id() = persistentHash<Bytes<32>>(local_secret_key()), with the
        // secret from deriveAttestationSecret. Live-verified on preprod: the
        // vault's attestation_owners entry for a Main-attested payload equals
        // this derivation of Main's zswap seed (vault da9b0bcf…, 2026-07-24).
        expect(deriveAttesterId(zswapSeed()))
            .toBe('7961a1e00d6341753fb38beb513ea72ea5e3cd990df81fb1435b1df9445814fe');
    });

    test('equals persistentHash(Bytes<32>) of the witness secret', () => {
        const secret = deriveAttestationSecret(zswapSeed());
        const expected = Buffer.from(persistentHash(new CompactTypeBytes(32), secret)).toString('hex');
        expect(deriveAttesterId(zswapSeed())).toBe(expected);
    });

    test('does not mutate the caller-owned seed', () => {
        const seed = zswapSeed();
        deriveAttesterId(seed);
        expect(Array.from(seed)).toEqual(Array(32).fill(1));
    });

    test('is deterministic and seed-sensitive', () => {
        expect(deriveAttesterId(zswapSeed())).toBe(deriveAttesterId(zswapSeed()));
        const other = Uint8Array.from(Array(32).fill(2));
        expect(deriveAttesterId(other)).not.toBe(deriveAttesterId(zswapSeed()));
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
