// Probe: which mnemonic→seed derivation reproduces the Lace account?
//
// NIGHTGATE currently derives the wallet seed as the first 32 bytes of the
// BIP39 PBKDF2 seed, then ZswapSecretKeys.fromSeed(seed). That lands on a
// DIFFERENT Midnight account than Lace (confirmed via mismatched dust addr),
// so the facade sees an empty wallet and deploys fail with "could not balance
// dust".
//
// This script derives the SHIELDED address under several candidate seed
// derivations and flags the one that matches your real Lace shielded address.
// The shielded address encodes both zswap pubkeys, so a match uniquely
// identifies the correct derivation. Whichever candidate matches: its `seedHex`
// is what belongs in .env as LACE_SEED_HEX (the factory already does
// fromSeed(seedHex), so no code change is needed once the seed is right).
//
// The mnemonic never leaves your machine — it's read from env only.
//
// Run:
//   LACE_MNEMONIC="word1 word2 ..." node scripts/probe-seed-derivation.mjs
// Optional (defaults to the address you gave during T15 triage):
//   LACE_SHIELD_ADDR="mn_shield-addr_preprod1..."   the target to match
//   NIGHTGATE_NETWORK=preprod

import bip39 from 'bip39';
import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import {
    ShieldedAddress,
    ShieldedCoinPublicKey,
    ShieldedEncryptionPublicKey,
    MidnightBech32m
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';

const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const NETWORK = process.env.NIGHTGATE_NETWORK || 'preprod';
const TARGET =
    process.env.LACE_SHIELD_ADDR ||
    'mn_shield-addr_preprod1a7cgj9vg6cy09x0pmg92u49lznjpnnnhlxmrjzeksfxqscmej9daafh4qyvk5chz7qlv0en4hqcaekazcmwfmz63hjxu4zprppd4xus4hywuq';

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }

if (!MNEMONIC) fail('LACE_MNEMONIC env var is required (e.g. LACE_MNEMONIC="word1 ..." node scripts/probe-seed-derivation.mjs)');
if (!bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC failed BIP39 validation');

const fullSeed = bip39.mnemonicToSeedSync(MNEMONIC);          // 64 bytes (PBKDF2)
const entropyHex = bip39.mnemonicToEntropy(MNEMONIC);          // 16 or 32 bytes hex

// Candidate 32-byte seeds fed to ZswapSecretKeys.fromSeed.
const candidates = [
    ['pbkdf2-first32  (CURRENT NIGHTGATE)', fullSeed.subarray(0, 32)],
    ['mnemonic-entropy', Buffer.from(entropyHex, 'hex')],
    ['pbkdf2-last32', fullSeed.subarray(32, 64)],
];

// HD-path candidates via Midnight's wallet-sdk-hd. HDWallet.fromSeed takes the
// BIP39 seed; we brute-force account x role x index and feed each derived key
// into ZswapSecretKeys.fromSeed. The Zswap role at account 0 / index 0 is the
// expected Lace path, but we enumerate to be certain.
const roleNames = Object.fromEntries(Object.entries(Roles).map(([k, v]) => [v, k]));
const hdRes = HDWallet.fromSeed(new Uint8Array(fullSeed));
if (hdRes.type === 'seedOk') {
    const hd = hdRes.hdWallet;
    for (const acct of [0, 1, 2]) {
        for (const role of Object.values(Roles)) {
            for (const index of [0, 1]) {
                const der = hd.selectAccount(acct).selectRole(role).deriveKeyAt(index);
                if (der?.type === 'keyDerived' && der.key?.length === 32) {
                    candidates.push([`hd a${acct}/${roleNames[role]}/i${index}`, Buffer.from(der.key)]);
                }
            }
        }
    }
} else {
    console.log(`(HDWallet.fromSeed failed: ${hdRes.error}); skipping HD candidates\n`);
}

function shieldedAddressFor(seedBytes) {
    if (seedBytes.length !== 32) {
        return { error: `seed is ${seedBytes.length} bytes, ZswapSecretKeys.fromSeed wants 32` };
    }
    const z = ZswapSecretKeys.fromSeed(new Uint8Array(seedBytes));
    const coinPk = z.coinPublicKey;
    const encPk = z.encryptionPublicKey;
    const addr = new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(coinPk),
        ShieldedEncryptionPublicKey.fromHexString(encPk)
    );
    const str = MidnightBech32m.encode(NETWORK, addr).toString();
    z.clear?.();
    return { addr: str, coinPk, seedHex: Buffer.from(seedBytes).toString('hex') };
}

console.log(`network: ${NETWORK}`);
console.log(`target shielded address (Lace):\n  ${TARGET}\n`);

let matched = null;
for (const [label, seed] of candidates) {
    let r;
    try { r = shieldedAddressFor(seed); }
    catch (e) { r = { error: e?.message || String(e) }; }

    if (r.error) {
        console.log(`[${label}]\n  skipped: ${r.error}\n`);
        continue;
    }
    const hit = r.addr === TARGET;
    if (hit) matched = { label, seedHex: r.seedHex };
    console.log(`[${label}]${hit ? '   <<< MATCH >>>' : ''}`);
    console.log(`  shielded: ${r.addr}`);
    console.log(`  seedHex : ${r.seedHex}\n`);
}

if (matched) {
    console.log(`MATCH: derivation "${matched.label}" reproduces the Lace account.`);
    console.log(`Put this in .env as LACE_SEED_HEX:\n  LACE_SEED_HEX=${matched.seedHex}`);
} else {
    console.log('NO MATCH among simple candidates → Lace likely uses an HD-path derivation.');
    console.log('Next step would be replicating Midnight\'s HD scheme (BIP32 path) — tell Claude and we\'ll wire it.');
}
