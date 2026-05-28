// Derives a Midnight wallet's seedHex (for connectWalletForSigning) and a
// viewing-key-shaped 64-hex value (for connectWallet) from a BIP39 mnemonic.
//
// The "viewing key" here is the encryptionPublicKey from ZswapSecretKeys.fromSeed,
// which is a stable 64-hex identifier per wallet. NIGHTGATE only uses it as a
// stable seed for HMAC-derived accountId, so any deterministic-per-wallet hex
// string works; encryptionPublicKey is the cleanest choice.
//
// Run: LACE_MNEMONIC="word1 word2 ..." node scripts/derive-keys.mjs

import bip39 from 'bip39';
import { ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';

const MNEMONIC = process.env.LACE_MNEMONIC;
if (!MNEMONIC) {
    console.error('LACE_MNEMONIC env var required');
    process.exit(1);
}
if (!bip39.validateMnemonic(MNEMONIC.trim())) {
    console.error('Mnemonic failed BIP39 validation');
    process.exit(1);
}

const fullSeed = bip39.mnemonicToSeedSync(MNEMONIC.trim()); // 64 bytes
const seed32   = fullSeed.subarray(0, 32);
const seedHex  = seed32.toString('hex');

const keys = ZswapSecretKeys.fromSeed(new Uint8Array(seed32));
const viewingKey = keys.encryptionPublicKey;
const coinPubKey = keys.coinPublicKey;

console.log(JSON.stringify({
    seedHex,
    viewingKey,
    coinPublicKey: coinPubKey
}, null, 2));
