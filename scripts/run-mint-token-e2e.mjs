// Live lane for mintShieldedTestToken + deriveTokenType (0.17.0), driven
// entirely through the client SDK (`src/sdk/client.mjs`): deploy the bundled
// shielded-token contract, mint, and pin that the job's tokenTypeHex equals
// the compute-only derivation.
//
// Server (separate terminal): npm run serve
// Then: node --env-file=.env scripts/run-mint-token-e2e.mjs
//
// SPDX-License-Identifier: Apache-2.0

import bip39 from 'bip39';
import { connect } from '../src/sdk/client.mjs';

const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
if (!VK || !MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) {
    console.error('FAIL LACE_VIEWING_KEY + LACE_MNEMONIC required'); process.exit(1);
}
const fail = (m) => { console.error(`\nFAIL ${m}`); process.exit(1); };
const step = (n) => console.log(`\n--- ${n} ---`);

const ng = connect({ baseUrl: process.env.NIGHTGATE_URL || 'http://localhost:4004', timeoutMs: 60 * 60 * 1000 });

step('1. Session');
const { sessionId } = await ng.connectWallet({ viewingKey: VK });
const conn = await ng.connectWalletForSigning({ sessionId, mnemonic: MNEMONIC });
if (conn?.prewarmJobId) { console.log('     syncing...'); await ng.waitForJob({ jobId: conn.prewarmJobId, sessionId }); }
console.log(`OK   session ${sessionId}`);

let contractAddress = process.env.MINT_E2E_CONTRACT || '';
if (!contractAddress) {
    step('2. Deploy contracts/shielded-token');
    const dep = await ng.deployContract({ compiledArtifactRef: 'shielded-token', sessionId, initialPrivateState: '{}' })
        .catch(e => fail(`deploy: ${e.message}`));
    contractAddress = dep.contractAddress;
}
console.log(`OK   contract ${contractAddress}`);

step('3. mintShieldedTestToken');
const mint = await ng.mintShieldedTestToken({ contractAddress, sessionId })
    .catch(e => fail(`mint: ${e.message}`));
if (!mint.txHash) fail(`mint returned no txHash: ${JSON.stringify(mint)}`);
if (!/^[0-9a-f]{64}$/.test(mint.tokenTypeHex ?? '')) fail(`mint returned no tokenTypeHex: ${JSON.stringify(mint)}`);
console.log(`OK   minted: tx ${mint.txHash}`);
console.log(`     tokenTypeHex ${mint.tokenTypeHex}, amount ${mint.amount}`);

step('4. deriveTokenType agrees (compute-only)');
const derived = await ng.deriveTokenType({ contractAddress });
if (derived.tokenTypeHex !== mint.tokenTypeHex) {
    fail(`derivation mismatch: job says ${mint.tokenTypeHex}, deriveTokenType says ${derived.tokenTypeHex}`);
}
// and an explicit separator (string + hex form) lands on the same identity
const viaString = await ng.deriveTokenType({ contractAddress, domainSeparator: 'nightgate:zswap-e2e' });
const viaHex = await ng.deriveTokenType({ contractAddress, domainSeparator: derived.domainSeparator });
if (viaString.tokenTypeHex !== derived.tokenTypeHex || viaHex.tokenTypeHex !== derived.tokenTypeHex) {
    fail('separator forms disagree');
}
console.log(`OK   compute-only derivation matches the mint job (string + hex separator forms agree)`);

step('SUMMARY');
console.log('OK   MINT + TOKEN-TYPE LANE WORKS');
console.log(`     contract ${contractAddress}`);
console.log(`     mint tx  ${mint.txHash}`);
console.log(`     token    ${mint.tokenTypeHex} (${mint.amount} atoms to own zswap key)`);
process.exit(0);
