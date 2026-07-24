/**
 * REAL-SDK regression tests for srv/utils/wallet-hd.ts + srv/utils/wallet-info.ts.
 *
 * The per-role HD derivation is the exact spot of the production bug where a
 * raw-seed derivation landed on the wrong (unfunded) Lace account; the fix
 * was verified against a live account. These tests import the ACTUAL ESM SDKs
 * (wallet-sdk-hd, ledger-v8, address-format, unshielded-wallet; all offline,
 * no chain) and pin the derivation of the standard BIP39 test mnemonic, so any
 * drift in our role/account/index path or an SDK upgrade that changes key
 * material fails loudly instead of silently switching accounts.
 *
 * (Under jest none of this was testable: the SDKs are ESM-only. wallet-info's
 * pre-SDK validation lives in wallet-info.test.ts; this file is the SDK path.)
 */
import { deriveRoleSeeds, mnemonicToBip39SeedHex } from '../../srv/utils/wallet-hd';
import { deriveWalletInfo, deriveViewingKeyForAccount } from '../../srv/utils/wallet-info';

// The BIP39 spec test vector phrase: publicly known, never funded on purpose.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Pinned outputs of the live-verified derivation path
// (m / role / account / index via wallet-sdk-hd, roles Zswap/Dust/NightExternal).
const PIN = {
    seedHexPrefix: '5eb00bbddcf069084889a8ab91555681',
    zswap: '92933dd3dff04c57c9f8950d6e08bd5c6f295655c03627a658e09b0726558cad',
    dust: '7bb19a43ffccad92ca25d52dac163c92967b53ff17dda1bbf9061db6a47b09b2',
    night: '822fa63c57f6317cd51d12d80f0e64c2bc2164088dec1c71ca34a87a890190aa',
    zswapAccount1: '291e27c9f12d92192741477e391a75d22c498b89ebb1f80f22468fb5dd7554c0',
    viewingKey: 'cfbaf8ac54cb8fe19b0884e43109b0d59d681260bcc07bd2d3ebcb149203f53d',
    shieldedAddressPreview: 'mn_shield-addr_preview1ywxc2p9986usecc9xert79afzq4m9x35u62sx0a4e2tc5w6mta5ulwhc432vhrlpnvygfep3pxcdt8tgzfstesrm6tf7hjc5jgpl20g2dm5vg',
    nightAddressPreview: 'mn_addr_preview1dwv2rta0a2skyhrvukaw2q9r2sq6yc4jhj63rf7afxpkrrv6g35q4y8xms',
    nightAddressPreviewAccount1: 'mn_addr_preview1kpq4jf9d35tjnw0jtx7vaexaavq7xyj0x497pcqzwqetuyrc7nrq37rt92',
    nightAddressPreprod: 'mn_addr_preprod1dwv2rta0a2skyhrvukaw2q9r2sq6yc4jhj63rf7afxpkrrv6g35q49ekgd',
    dustAddressPreview: 'mn_dust_preview1wwcff2ckd4n5hfj43055td8glwtzkhhf6z88xwf0rpftvgstr7zpx50t9vq',
    attesterId: 'c3ea5802644f99be2bcd7728b1c9577393bbc86b9295575de4e2b2d907de7770',
    attesterIdAccount1: '1c69fa210fd8e4a5393c5d3462fe97e56f9e35eb5d2e1ebcaebb9603115310e3',
    dustAddressPreviewAccount1: 'mn_dust_preview1wvw8w50c8fecwav6fnn0cltnpeuwnq2ngnfvrty7k2uqkjczw2ws7zaffu6',
    dustAddressPreprod: 'mn_dust_preprod1wwcff2ckd4n5hfj43055td8glwtzkhhf6z88xwf0rpftvgstr7zpx43mk3q'
};

const hex = (u8: Uint8Array) => Buffer.from(u8).toString('hex');

describe('mnemonicToBip39SeedHex', () => {
    it('produces the BIP39 spec seed for the test vector phrase', () => {
        const seed = mnemonicToBip39SeedHex(MNEMONIC);
        expect(seed).toHaveLength(128);
        expect(seed.startsWith(PIN.seedHexPrefix)).toBe(true);
    });

    it('rejects an invalid phrase', () => {
        expect(() => mnemonicToBip39SeedHex('not a valid mnemonic phrase at all')).toThrow(/Invalid BIP39 mnemonic/);
    });
});

describe('deriveRoleSeeds (real wallet-sdk-hd)', () => {
    const bip39Seed = () => new Uint8Array(Buffer.from(mnemonicToBip39SeedHex(MNEMONIC), 'hex'));

    it('derives the pinned per-role seeds for account 0', async () => {
        const seeds = await deriveRoleSeeds(bip39Seed());
        expect(hex(seeds.zswap)).toBe(PIN.zswap);
        expect(hex(seeds.dust)).toBe(PIN.dust);
        expect(hex(seeds.night)).toBe(PIN.night);
    });

    it('the three roles never collapse onto one key (the original bug shape)', async () => {
        const seeds = await deriveRoleSeeds(bip39Seed());
        expect(hex(seeds.zswap)).not.toBe(hex(seeds.dust));
        expect(hex(seeds.zswap)).not.toBe(hex(seeds.night));
        expect(hex(seeds.dust)).not.toBe(hex(seeds.night));
    });

    it('accountIndex selects an independent account (pinned)', async () => {
        const seeds1 = await deriveRoleSeeds(bip39Seed(), 1);
        expect(hex(seeds1.zswap)).toBe(PIN.zswapAccount1);
        expect(hex(seeds1.zswap)).not.toBe(PIN.zswap);
    });

    it('rejects invalid account indices before touching the SDK', async () => {
        await expect(deriveRoleSeeds(bip39Seed(), -1)).rejects.toThrow(/accountIndex must be a non-negative integer/);
        await expect(deriveRoleSeeds(bip39Seed(), 1.5)).rejects.toThrow(/accountIndex must be a non-negative integer/);
    });

    it('surfaces the SDK error for an out-of-spec seed length', async () => {
        await expect(deriveRoleSeeds(new Uint8Array(3))).rejects.toThrow(/HDWallet\.fromSeed failed/);
    });
});

describe('deriveWalletInfo (real ledger + address-format + unshielded SDKs)', () => {
    it('derives the pinned preview wallet info for account 0', async () => {
        const info = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview' });
        expect(info).toEqual({
            viewingKey: PIN.viewingKey,
            shieldedAddress: PIN.shieldedAddressPreview,
            nightAddress: PIN.nightAddressPreview,
            dustAddress: PIN.dustAddressPreview,
            attesterId: PIN.attesterId,
            accountIndex: 0,
            network: 'preview'
        });
    });

    it('encodes the network into the Bech32m HRP (preprod)', async () => {
        const info = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preprod' });
        expect(info.nightAddress).toBe(PIN.nightAddressPreprod);
        expect(info.nightAddress.startsWith('mn_addr_preprod1')).toBe(true);
        expect(info.dustAddress).toBe(PIN.dustAddressPreprod);
        expect(info.dustAddress.startsWith('mn_dust_preprod1')).toBe(true);
        // attesterId is a pure function of the seed: same value on every network
        expect(info.attesterId).toBe(PIN.attesterId);
    });

    it('accountIndex 1 lands on the pinned second account', async () => {
        const info = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview', accountIndex: 1 });
        expect(info.nightAddress).toBe(PIN.nightAddressPreviewAccount1);
        expect(info.accountIndex).toBe(1);
        expect(info.dustAddress).toBe(PIN.dustAddressPreviewAccount1);
        expect(info.attesterId).toBe(PIN.attesterIdAccount1);
        expect(info.attesterId).not.toBe(PIN.attesterId);
    });

    it('accepts a raw 128-hex BIP39 seed and matches the mnemonic-derived result', async () => {
        const seedHex = mnemonicToBip39SeedHex(MNEMONIC);
        const viaSeed = await deriveWalletInfo({ seedHex, network: 'preview' });
        const viaMnemonic = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview' });
        expect(viaSeed).toEqual(viaMnemonic);
    });

    it('derivation is deterministic across calls (reconnect safety)', async () => {
        const a = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview' });
        const b = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview' });
        expect(a).toEqual(b);
    });
});

describe('deriveViewingKeyForAccount (connectWalletForSigning consistency check)', () => {
    it('matches deriveWalletInfo for account 0 (pinned) and differs for account 1', async () => {
        const seedHex = mnemonicToBip39SeedHex(MNEMONIC);
        expect(await deriveViewingKeyForAccount(seedHex, 0)).toBe(PIN.viewingKey);
        const account1 = await deriveViewingKeyForAccount(seedHex, 1);
        expect(account1).not.toBe(PIN.viewingKey);
        // The check accepts exactly what deriveWalletInfo told the consumer.
        const info1 = await deriveWalletInfo({ seedHex, network: 'preview', accountIndex: 1 });
        expect(account1).toBe(info1.viewingKey);
    });
});
