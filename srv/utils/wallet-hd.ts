/**
 * HD key derivation that matches the Lace wallet.
 * Each key type is derived from its own BIP32 role, never from the raw seed.
 * Using the raw seed would give a different, empty account.
 */
// Named imports: bip39's CJS build has no default export.
import { validateMnemonic, mnemonicToSeedSync } from 'bip39';

const ACCOUNT = 0;
const KEY_INDEX = 0;

export interface RoleSeeds {
    zswap: Uint8Array;
    dust: Uint8Array;
    night: Uint8Array;
}

let cachedHd: any;
async function loadWalletHd(): Promise<any> {
    if (!cachedHd) cachedHd = await import('@midnightntwrk/wallet-sdk-hd');
    return cachedHd;
}

export function mnemonicToBip39SeedHex(mnemonic: string): string {
    const m = mnemonic.trim();
    if (!validateMnemonic(m)) {
        throw new Error('Invalid BIP39 mnemonic');
    }
    return mnemonicToSeedSync(m).toString('hex');
}

/** Derives one 32-byte seed per key type from a BIP39 seed, for account `accountIndex`. */
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
