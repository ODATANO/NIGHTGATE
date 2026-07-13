// Native-ESM integration check for srv/utils/wallet-info.ts (FR
// derive-wallet-info): derives the connectable identity of a wallet from a
// mnemonic and verifies it against the KNOWN Lace account.
//
// The decisive assertion: at accountIndex 0 / network preprod, the derived
// shielded address must equal the real Lace wallet's shielded address (the
// same reference value scripts/probe-seed-derivation.mjs validated the HD
// derivation against). That proves deriveWalletInfo lands on exactly the
// account Lace (and connectWalletForSigning) uses, so a wallet created
// programmatically from a fresh phrase behaves identically.
//
// The mnemonic never leaves this machine and is never printed.
//
// Run: node --env-file=.env scripts/integration-test-derive-wallet-info.mjs
//      (needs LACE_MNEMONIC in .env; LACE_SHIELD_ADDR overrides the target)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deriveWalletInfo } = require('../srv/utils/wallet-info.js');

const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const TARGET =
    process.env.LACE_SHIELD_ADDR ||
    'mn_shield-addr_preprod1a7cgj9vg6cy09x0pmg92u49lznjpnnnhlxmrjzeksfxqscmej9daafh4qyvk5chz7qlv0en4hqcaekazcmwfmz63hjxu4zprppd4xus4hywuq';

if (!MNEMONIC) {
    console.error('FAIL LACE_MNEMONIC env var is required (run with node --env-file=.env)');
    process.exit(1);
}

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`OK   ${name}${detail ? `: ${detail}` : ''}`);
    else { console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); failures++; }
}

const preprod = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preprod' });
check('shieldedAddress matches the live Lace account', preprod.shieldedAddress === TARGET,
    preprod.shieldedAddress.slice(0, 40) + '...');
check('viewingKey is 64 hex chars', /^[0-9a-fA-F]{64}$/.test(preprod.viewingKey),
    preprod.viewingKey.slice(0, 12) + '...');
check('nightAddress carries the unshielded preprod HRP', preprod.nightAddress.startsWith('mn_addr_preprod1'),
    preprod.nightAddress.slice(0, 28) + '...');
check('accountIndex defaults to 0', preprod.accountIndex === 0);

// seedHex path must land on the same identity as the mnemonic path.
const bip39 = require('bip39');
const seedHex = bip39.mnemonicToSeedSync(MNEMONIC).toString('hex');
const viaSeed = await deriveWalletInfo({ seedHex, network: 'preprod' });
check('seedHex path equals mnemonic path', viaSeed.shieldedAddress === preprod.shieldedAddress
    && viaSeed.viewingKey === preprod.viewingKey && viaSeed.nightAddress === preprod.nightAddress);

// A different account index is a different, deterministic identity.
const acct1a = await deriveWalletInfo({ mnemonic: MNEMONIC, accountIndex: 1, network: 'preprod' });
const acct1b = await deriveWalletInfo({ mnemonic: MNEMONIC, accountIndex: 1, network: 'preprod' });
check('accountIndex 1 differs from account 0', acct1a.viewingKey !== preprod.viewingKey
    && acct1a.shieldedAddress !== preprod.shieldedAddress && acct1a.nightAddress !== preprod.nightAddress);
check('accountIndex 1 is deterministic', acct1a.viewingKey === acct1b.viewingKey
    && acct1a.shieldedAddress === acct1b.shieldedAddress);

// Network changes only the encoding, visible in the HRP.
const preview = await deriveWalletInfo({ mnemonic: MNEMONIC, network: 'preview' });
check('preview encoding carries the preview HRP', preview.shieldedAddress.startsWith('mn_shield-addr_preview1')
    && preview.nightAddress.startsWith('mn_addr_preview1'));
check('viewingKey is network-independent', preview.viewingKey === preprod.viewingKey);

console.log();
if (failures === 0) { console.log('All derive-wallet-info checks passed.'); process.exit(0); }
console.error(`${failures} check(s) failed.`); process.exit(1);
