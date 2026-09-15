/**
 * Lace-compatible HD derivation: each key type comes from its own BIP32 role
 * (bip39 seed -> account -> Zswap | Dust | NightExternal -> key 0), never from the raw seed,
 * which would land on a different, empty account.
 */
// Named imports: bip39's CJS build has no default export.
import { validateMnemonic, mnemonicToSeedSync } from 'bip39';

const ACCOUNT = 0;
const KEY_INDEX = 0;

export interface RoleSeeds {
    /** Shielded (Zswap) account seed → ZswapSecretKeys.fromSeed. */
    zswap: Uint8Array;
    /** Dust account seed → DustSecretKey.fromSeed. */
    dust: Uint8Array;
    /** Unshielded (Night) account seed → unshielded createKeystore. */
    night: Uint8Array;
}

let cachedHd: any;
async function loadWalletHd(): Promise<any> {
    if (!cachedHd) cachedHd = await import('@midnightntwrk/wallet-sdk-hd');
    return cachedHd;
}

/** BIP39 mnemonic → 64-byte seed as 128-char hex. Throws on an invalid phrase. */
export function mnemonicToBip39SeedHex(mnemonic: string): string {
    const m = mnemonic.trim();
    if (!validateMnemonic(m)) {
        throw new Error('Invalid BIP39 mnemonic');
    }
    return mnemonicToSeedSync(m).toString('hex');
}

/** Per-role 32-byte seeds of a 64-byte BIP39 seed at BIP32 account `accountIndex` (default 0). */
export async function deriveRoleSeeds(bip39Seed: Uint8Array, accountIndex: number = ACCOUNT): Promise<RoleSeeds> {
    if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error('accountIndex must be a non-negative integer');
    }
    const { HDWallet, Roles } = await loadWalletHd();
    const res = HDWallet.fromSeed(bip39Seed);
    if (res?.type !== 'seedOk') {
        throw new Error(`HDWallet.fromSeed failed: ${res?.error ?? 'unknown'}`);
    }
    const hd = res.hdWallet;
    try {
        return {
            zswap: deriveOne(hd, Roles.Zswap, accountIndex),
            dust:  deriveOne(hd, Roles.Dust, accountIndex),
            night: deriveOne(hd, Roles.NightExternal, accountIndex)
        };
    } finally {
        hd.clear?.();
    }
}

function deriveOne(hd: any, role: number, accountIndex: number): Uint8Array {
    const d = hd.selectAccount(accountIndex).selectRole(role).deriveKeyAt(KEY_INDEX);
    if (d?.type !== 'keyDerived' || d.key?.length !== 32) {
        throw new Error(`HD key derivation failed for role ${role}: ${d?.type ?? 'no result'}`);
    }
    return d.key as Uint8Array;
}
