/**
 * Wallet identity (viewing key, addresses, attester id) from a mnemonic or seed, without a session.
 * Derivation must stay identical to the signing path. The seed is never logged or returned;
 * role seeds are zeroed and secret keys cleared after use.
 */
import { persistentHash, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';
import { mnemonicToBip39SeedHex, deriveRoleSeeds, type RoleSeeds } from './wallet-hd';
import { deriveAttestationSecret } from '../submission/contract-witnesses';
import { loadLedgerV8 } from '../midnight/sdk-loader';

export interface WalletInfo {
    viewingKey: string;      // 64-hex zswap encryption public key (connectWallet input)
    shieldedAddress: string; // mn_shield-addr_... (receives shielded assets)
    nightAddress: string;    // mn_addr_... unshielded NIGHT address (faucet target)
    dustAddress: string;     // mn_dust_... DUST address (dust-generation receiver)
    attesterId: string;      // 64-hex AttestationVault attester identity (caller_id)
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

/** Vault attester id: `persistentHash<Bytes<32>>(deriveAttestationSecret(zswapSeed))`, byte-exact to `caller_id()`. */
export function deriveAttesterId(zswapSeed: Uint8Array): string {
    const secret = deriveAttestationSecret(zswapSeed);
    try {
        return Buffer.from(persistentHash(new CompactTypeBytes(32), secret)).toString('hex');
    } finally {
        secret.fill(0);
    }
}

/** Viewing key of one seed account; lets connectWalletForSigning refuse a seed that is not the session's. */
export async function deriveViewingKeyForAccount(bip39SeedHex: string, accountIndex: number): Promise<string> {
    // The finally must cover a throwing derivation, so bip39Seed is always zeroed.
    const bip39Seed = new Uint8Array(Buffer.from(bip39SeedHex, 'hex'));
    let roleSeeds: RoleSeeds | undefined;
    try {
        roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
        const ledger = await loadLedgerV8();
        const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
        try {
            return zswapKeys.encryptionPublicKey;
        } finally {
            zswapKeys.clear?.();
        }
    } finally {
        bip39Seed.fill(0);
        if (roleSeeds) {
            roleSeeds.zswap.fill(0);
            roleSeeds.dust.fill(0);
            roleSeeds.night.fill(0);
        }
    }
}

/** Validated 64-byte BIP39 seed hex from a mnemonic or seed. */
export function resolveBip39SeedHex(opts: Pick<DeriveWalletInfoOptions, 'mnemonic' | 'seedHex'>): string {
    if (opts.mnemonic) {
        return mnemonicToBip39SeedHex(opts.mnemonic);
    }
    if (opts.seedHex) {
        if (!BIP39_SEED_HEX_RE.test(opts.seedHex)) {
            throw new Error('seedHex must be 128 hex characters (64-byte BIP39 seed)');
        }
        return opts.seedHex.toLowerCase();
    }
    throw new Error('either mnemonic or seedHex (64-byte BIP39 seed, 128 hex chars) is required');
}

/** Viewing key, addresses and attester id of a wallet account. */
export async function deriveWalletInfo(opts: DeriveWalletInfoOptions): Promise<WalletInfo> {
    const accountIndex = opts.accountIndex ?? 0;
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error('accountIndex must be a non-negative integer');
    }
    if (!opts.network) throw new Error('network is required');

    const bip39SeedHex = resolveBip39SeedHex(opts);
    // The finally must cover a throwing derivation, so bip39Seed is always zeroed.
    const bip39Seed = new Uint8Array(Buffer.from(bip39SeedHex, 'hex'));
    let roleSeeds: RoleSeeds | undefined;
    try {
        roleSeeds = await deriveRoleSeeds(bip39Seed, accountIndex);
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

        // The `dustReceiverAddress` when another wallet sponsors this wallet's dust generation.
        const dustKey = ledger.DustSecretKey.fromSeed(roleSeeds.dust);
        let dustAddress: string;
        try {
            dustAddress = af.DustAddress.encodePublicKey(opts.network, dustKey.publicKey);
        } finally {
            dustKey.clear?.();
        }

        // Network-independent; known before the wallet's first on-chain call.
        const attesterId = deriveAttesterId(roleSeeds.zswap);

        return { viewingKey, shieldedAddress, nightAddress, dustAddress, attesterId, accountIndex, network: opts.network };
    } finally {
        bip39Seed.fill(0);
        if (roleSeeds) {
            roleSeeds.zswap.fill(0);
            roleSeeds.dust.fill(0);
            roleSeeds.night.fill(0);
        }
    }
}
