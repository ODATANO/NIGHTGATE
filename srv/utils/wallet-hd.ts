/**
 * Midnight HD key derivation (matches Lace / the Midnight reference wallet).
 *
 * Lace derives each wallet key type from a SEPARATE BIP32 role of the BIP39
 * seed — NOT from the raw seed. Feeding the raw 32-byte seed into
 * `ZswapSecretKeys.fromSeed` lands on a different account than the user's Lace
 * wallet, so the facade sees an empty wallet and deploys fail with "could not
 * balance dust". This module reproduces Lace's derivation:
 *
 *   bip39 seed (64B) → HDWallet.fromSeed → account 0 → role
 *     {Zswap | Dust | NightExternal} → deriveKeyAt(0) → 32-byte role seed
 *     → SDK ZswapSecretKeys.fromSeed / DustSecretKey.fromSeed / createKeystore
 *
 * Verified against a live Lace preprod account via
 * `scripts/probe-seed-derivation.mjs`: role Zswap at account 0 / index 0
 * reproduces the Lace shielded address exactly.
 *
 * `@midnightntwrk/wallet-sdk-hd` is ESM-only; loaded via dynamic import from
 * this CommonJS module (same pattern as srv/midnight/sdk-loader.ts).
 */
// Named imports: bip39's CJS build sets `__esModule` but exposes no default
// export, so `import bip39 from 'bip39'` resolves to undefined under
// esModuleInterop's __importDefault. Named bindings map to the real exports.
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

/**
 * Derive the per-role 32-byte seeds from a 64-byte BIP39 seed, matching Lace.
 * Each result is fed to the SDK's fromSeed/createKeystore for its key type.
 */
export async function deriveRoleSeeds(bip39Seed: Uint8Array): Promise<RoleSeeds> {
    const { HDWallet, Roles } = await loadWalletHd();
    const res = HDWallet.fromSeed(bip39Seed);
    if (res?.type !== 'seedOk') {
        throw new Error(`HDWallet.fromSeed failed: ${res?.error ?? 'unknown'}`);
    }
    const hd = res.hdWallet;
    try {
        return {
            zswap: deriveOne(hd, Roles.Zswap),
            dust:  deriveOne(hd, Roles.Dust),
            night: deriveOne(hd, Roles.NightExternal)
        };
    } finally {
        hd.clear?.();
    }
}

function deriveOne(hd: any, role: number): Uint8Array {
    const d = hd.selectAccount(ACCOUNT).selectRole(role).deriveKeyAt(KEY_INDEX);
    if (d?.type !== 'keyDerived' || d.key?.length !== 32) {
        throw new Error(`HD key derivation failed for role ${role}: ${d?.type ?? 'no result'}`);
    }
    return d.key as Uint8Array;
}
