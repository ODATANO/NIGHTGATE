// Native-ESM integration check for ledger-v8 seed-key derivation.
// Verifies that ZswapSecretKeys.fromSeed and DustSecretKey.fromSeed accept the
// shapes that srv/submission/wallet-material-factory.ts uses, and that the
// derived public keys are stable across runs for a fixed seed.
//
// Run: node scripts/integration-test-wallet-keys.mjs

import { ZswapSecretKeys, DustSecretKey } from '@midnight-ntwrk/ledger-v8';

const SEED_HEX = 'a'.repeat(64);          // 32-byte test seed
const seedBytes = new Uint8Array(Buffer.from(SEED_HEX, 'hex'));

let failures = 0;
function ok(name, actual) {
    if (actual === undefined || actual === null) { console.error(`FAIL ${name}: ${actual}`); failures++; }
    else console.log(`OK   ${name}: ${typeof actual === 'string' ? actual.slice(0, 32) + '...' : actual}`);
}

const zswap1 = ZswapSecretKeys.fromSeed(seedBytes);
ok('ZswapSecretKeys.coinPublicKey',       zswap1.coinPublicKey);
ok('ZswapSecretKeys.encryptionPublicKey', zswap1.encryptionPublicKey);

const dust1 = DustSecretKey.fromSeed(seedBytes);
ok('DustSecretKey.fromSeed returns', dust1);

// Determinism check
const zswap2 = ZswapSecretKeys.fromSeed(seedBytes);
if (zswap1.coinPublicKey !== zswap2.coinPublicKey) {
    console.error('FAIL coinPublicKey deterministic'); failures++;
} else {
    console.log('OK   coinPublicKey deterministic');
}
if (zswap1.encryptionPublicKey !== zswap2.encryptionPublicKey) {
    console.error('FAIL encryptionPublicKey deterministic'); failures++;
} else {
    console.log('OK   encryptionPublicKey deterministic');
}

// Different seed → different pubkeys
const seed2 = new Uint8Array(Buffer.from('b'.repeat(64), 'hex'));
const zswap3 = ZswapSecretKeys.fromSeed(seed2);
if (zswap1.coinPublicKey === zswap3.coinPublicKey) {
    console.error('FAIL different seeds produce different coinPublicKeys'); failures++;
} else {
    console.log('OK   different seeds → different coinPublicKeys');
}

// Clean up, proves the API supports it without throwing.
zswap1.clear();
zswap2.clear();
zswap3.clear();
console.log('OK   ZswapSecretKeys.clear() callable');

console.log();
if (failures === 0) {
    console.log('All seed-derivation checks passed.');
    process.exit(0);
} else {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
}
