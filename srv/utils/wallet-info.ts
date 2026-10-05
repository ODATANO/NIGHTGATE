/**
 * Derives a wallet's viewing key, addresses and attester id from a mnemonic or seed, without a session.
 * The derivation must match the one used for signing.
 * The seed is never logged or returned, and all secret material is wiped after use.
 */
import { persistentHash, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';
import { mnemonicToBip39SeedHex, deriveRoleSeeds, type RoleSeeds } from './wallet-hd';
import { deriveAttestationSecret } from '../submission/contract-witnesses';
import { loadLedgerV8 } from '../midnight/sdk-loader';

export interface WalletInfo {
    viewingKey: string;      // shielded encryption public key, 64 hex chars, the input of connectWallet
    shieldedAddress: string; // mn_shield-addr_..., receives shielded tokens
    nightAddress: string;    // mn_addr_..., the unshielded NIGHT address
    dustAddress: string;     // mn_dust_..., receives generated dust
    attesterId: string;      // the wallet's identity in the attestation vault contract, 64 hex chars
    accountIndex: number;
    network: string;
}

export interface DeriveWalletInfoOptions {
    mnemonic?: string | null;
    seedHex?: string | null; // 64-byte BIP39 seed as 128 hex chars
    accountIndex?: number;   // default 0
    network: string;         // network the addresses are encoded for, for example preprod
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

/** The wallet's attester id. It is the same value the vault contract computes with `caller_id()`. */
export function deriveAttesterId(zswapSeed: Uint8Array): string {
    const secret = deriveAttestationSecret(zswapSeed);
    try {
        return Buffer.from(persistentHash(new CompactTypeBytes(32), secret)).toString('hex');
    } finally {
        secret.fill(0);
    }
}

/** Viewing key of one account of a seed. Used to refuse a seed that does not belong to the session. */
export async function deriveViewingKeyForAccount(bip39SeedHex: string, accountIndex: number): Promise<string> {
    // The seed is wiped in `finally`, even when derivation throws.
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

export async function deriveWalletInfo(opts: DeriveWalletInfoOptions): Promise<WalletInfo> {
    const accountIndex = opts.accountIndex ?? 0;
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error('accountIndex must be a non-negative integer');
    }
    if (!opts.network) throw new Error('network is required');

    const bip39SeedHex = resolveBip39SeedHex(opts);
    // The seed is wiped in `finally`, even when derivation throws.
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

        // Another wallet that generates dust for this one sends it to this address.
        const dustKey = ledger.DustSecretKey.fromSeed(roleSeeds.dust);
        let dustAddress: string;
        try {
            dustAddress = af.DustAddress.encodePublicKey(opts.network, dustKey.publicKey);
        } finally {
            dustKey.clear?.();
        }

        // The same on every network, and known before the wallet's first transaction.
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
