/**
 * Programmatic wallet identity derivation (FR derive-wallet-info).
 *
 * Pure function of the secret input: derives the connectable identity of a
 * wallet WITHOUT creating a session or persisting anything. Consumers use the
 * result to fund a fresh wallet (`nightAddress` at the faucet) and to open
 * sessions (`connectWallet(viewingKey)` + `connectWalletForSigning`), removing
 * the last Lace dependency from programmatic wallet creation.
 *
 * Derivation is IDENTICAL to the signing path: BIP39 seed -> per-role HD seeds
 * (srv/utils/wallet-hd.ts, Lace-exact) -> ZswapSecretKeys for the shielded
 * account, unshielded keystore for the NIGHT account. `viewingKey` is the
 * zswap encryption public key, the same 64-hex value the signing adapter's
 * `getEncryptionPublicKey()` returns and `validateViewingKey` accepts.
 *
 * Secret hygiene: the mnemonic/seed is never logged or returned; role seeds
 * are zeroed and the zswap secret keys cleared after use.
 *
 * The SDK packages are ESM-only; loaded via dynamic import from this CommonJS
 * module (same pattern as srv/midnight/wallet-worker.ts).
 */
import { mnemonicToBip39SeedHex, deriveRoleSeeds } from './wallet-hd';
import { loadLedgerV8 } from '../midnight/sdk-loader';

export interface WalletInfo {
    viewingKey: string;      // 64-hex zswap encryption public key (connectWallet input)
    shieldedAddress: string; // mn_shield-addr_... (receives shielded assets)
    nightAddress: string;    // mn_addr_... unshielded NIGHT address (faucet target)
    accountIndex: number;
    network: string;
}

export interface DeriveWalletInfoOptions {
    mnemonic?: string;
    seedHex?: string;        // 64-byte BIP39 seed as 128 hex chars
    accountIndex?: number;   // default 0
    network: string;         // encoding network (preview | preprod | ...)
}

let cachedAddressFormat: any;
async function loadAddressFormat(): Promise<any> {
    if (!cachedAddressFormat) cachedAddressFormat = await import('@midnightntwrk/wallet-sdk-address-format');
    return cachedAddressFormat;
}

let cachedUnshielded: any;
async function loadUnshielded(): Promise<any> {
    if (!cachedUnshielded) cachedUnshielded = await import('@midnightntwrk/wallet-sdk-unshielded-wallet');
    return cachedUnshielded;
}

const BIP39_SEED_HEX_RE = /^[0-9a-fA-F]{128}$/;

/**
 * Resolve the 64-byte BIP39 seed hex from the options, validating input.
 * Split out so the (jest-loadable, ESM-free) validation paths are unit-testable.
 */
export function resolveBip39SeedHex(opts: Pick<DeriveWalletInfoOptions, 'mnemonic' | 'seedHex'>): string {
    if (opts.mnemonic) {
        return mnemonicToBip39SeedHex(opts.mnemonic); // throws on an invalid phrase
    }
    if (opts.seedHex) {
        if (!BIP39_SEED_HEX_RE.test(opts.seedHex)) {
            throw new Error('seedHex must be 128 hex characters (64-byte BIP39 seed)');
        }
        return opts.seedHex.toLowerCase();
    }
    throw new Error('either mnemonic or seedHex (64-byte BIP39 seed, 128 hex chars) is required');
}

/** Derive viewing key + addresses for a wallet account. See module docs. */
export async function deriveWalletInfo(opts: DeriveWalletInfoOptions): Promise<WalletInfo> {
    const accountIndex = opts.accountIndex ?? 0;
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error('accountIndex must be a non-negative integer');
    }
    if (!opts.network) throw new Error('network is required');

    const bip39SeedHex = resolveBip39SeedHex(opts);
    const bip39Seed = new Uint8Array(Buffer.from(bip39SeedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
    try {
        const ledger = await loadLedgerV8();
        const af = await loadAddressFormat();
        const unshielded = await loadUnshielded();

        const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
        let viewingKey: string;
        let shieldedAddress: string;
        try {
            viewingKey = zswapKeys.encryptionPublicKey;
            const addr = new af.ShieldedAddress(
                af.ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey),
                af.ShieldedEncryptionPublicKey.fromHexString(viewingKey)
            );
            shieldedAddress = af.MidnightBech32m.encode(opts.network, addr).toString();
        } finally {
            zswapKeys.clear?.();
        }

        const keystore = unshielded.createKeystore(roleSeeds.night, opts.network);
        const nightAddress: string = unshielded.PublicKey.fromKeyStore(keystore).address;

        return { viewingKey, shieldedAddress, nightAddress, accountIndex, network: opts.network };
    } finally {
        bip39Seed.fill(0);
        roleSeeds.zswap.fill(0);
        roleSeeds.dust.fill(0);
        roleSeeds.night.fill(0);
    }
}
