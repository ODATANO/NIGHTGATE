// Native-ESM integration check for srv/crawler/utxo-identity.ts.
//
// `Midnight.UnshieldedTokens` reports a UTXO's raw 32-byte owner and its
// (intentHash, outputNo); the stored row needs the Bech32m address and the
// DUST initial nonce, which the crawler derives. This check pins those
// derivations against values READ FROM THE MIDNIGHT INDEXER for the same
// UTXOs on preprod, so the crawler's rows are the indexer's rows.
//
// Reference data: preprod blocks 2647473, 2647521 and 2647181, taken from the
// indexer's unshieldedCreatedOutputs. Nothing here talks to the network.
//
// Run: node scripts/integration-test-utxo-identity.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodeUnshieldedOwner, computeInitialNonce } = require('../srv/crawler/utxo-identity.js');

/** Raw owner + (intentHash, outputNo) from the chain event, against the indexer's row. */
const CASES = [
    {
        rawOwner: '4fa22fa1e5889899009d27f9beef0b03cce7c766f3c22009a9ddfee20e5e3a58',
        intentHash: '873d24618de9ea63080b27443a1bc983969697eec9909546513b6d5b7037d793',
        outputNo: 0,
        owner: 'mn_addr_preprod1f73zlg093zvfjqyaylumamctq0xw03mx70pzqzdfmhlwyrj78fvqfa87l9',
        initialNonce: '1d1063f2aab96628e69fcd2219acbf5267f8eee03c587e916695aa529831ec60'
    },
    {
        rawOwner: '239fda41847c14a42f022131eac0d2dd2a627b0806eb61b15913883780ef4d2f',
        intentHash: '873d24618de9ea63080b27443a1bc983969697eec9909546513b6d5b7037d793',
        outputNo: 1,
        owner: 'mn_addr_preprod1yw0a5svy0s22gtczyyc74sxjm54xy7cgqm4krv2ezwyr0q80f5hs7hks9m',
        initialNonce: '6f0b51271a9dcec28ee39365e041124628c905d2c8665353aacaf96546f1ec62'
    },
    {
        rawOwner: 'c6da38b29a6192271b45e2ca26eaafeb653c6cae9c9cfd5b57d1489035d85174',
        intentHash: '2abd9f0f119f307fa40e1c07a46ae95f7574e36d48e732a84c200254e8033959',
        outputNo: 0,
        owner: 'mn_addr_preprod1cmdr3v56vxfzwx69ut9zd640adjncm9wnjw06k6h69yfqdwc296q8na0x9',
        initialNonce: '7a2e77a994a7f60c15e7093def0e04b065c6d6a07c88739b68dd069fc1f1528a'
    },
    {
        rawOwner: '239fda41847c14a42f022131eac0d2dd2a627b0806eb61b15913883780ef4d2f',
        intentHash: '2abd9f0f119f307fa40e1c07a46ae95f7574e36d48e732a84c200254e8033959',
        outputNo: 2,
        owner: 'mn_addr_preprod1yw0a5svy0s22gtczyyc74sxjm54xy7cgqm4krv2ezwyr0q80f5hs7hks9m',
        initialNonce: 'cb1d6655c81dc1a53009ac3a2c55e70646f92dff16b57762e162bc01ca54d225'
    },
    // One transaction, two intents, both output 0: why the UnshieldedUtxos
    // uniqueness runs on (intentHash, outputIndex) and not on the transaction.
    {
        rawOwner: '0710d19c2cee2fb7999666705243ab2580e08193944f2f5986fdcc04a6a5f792',
        intentHash: '7391ee1ffb3c6a741a8ceb3ec432eaa2b7ba793e7ec795c29a274718fd18b3da',
        outputNo: 0,
        owner: 'mn_addr_preprod1qugdr8pvachm0xvkvec9ysatykqwpqvnj38j7kvxlhxqff4977fql0tc2l',
        initialNonce: '06a8a9a412edd998882c7a117b7c627350d2664018cd93b2f1ceb8c04e91445e'
    },
    {
        rawOwner: '0710d19c2cee2fb7999666705243ab2580e08193944f2f5986fdcc04a6a5f792',
        intentHash: '940fd68379217481e3e51d6dae4144ceff27ecf9c2ce1dbc80d66519ba9753ae',
        outputNo: 0,
        owner: 'mn_addr_preprod1qugdr8pvachm0xvkvec9ysatykqwpqvnj38j7kvxlhxqff4977fql0tc2l',
        initialNonce: 'f60a44c76099a51c9f6fd0bfdd501139056bcefae35e839dbfd57deb4ebf0fa0'
    }
];

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`OK   ${name}${detail ? `: ${detail}` : ''}`);
    else { console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); failures++; }
}

for (const c of CASES) {
    const label = `${c.intentHash.slice(0, 8)}#${c.outputNo}`;
    const owner = await encodeUnshieldedOwner(c.rawOwner, 'preprod');
    check(`${label} owner matches the indexer`, owner === c.owner, owner.slice(0, 32) + '...');
    const nonce = await computeInitialNonce(c.outputNo, c.intentHash);
    check(`${label} initialNonce matches the indexer`, nonce === c.initialNonce, nonce.slice(0, 16) + '...');
}

// Same 32 bytes, different chain: the HRP has to follow the network.
const preview = await encodeUnshieldedOwner(CASES[0].rawOwner, 'preview');
check('the network drives the address HRP', preview.startsWith('mn_addr_preview1') && preview !== CASES[0].owner,
    preview.slice(0, 24) + '...');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
