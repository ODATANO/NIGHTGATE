// Checks through the client SDK that the wallet holds a minted shielded token under the type deriveTokenType computes.
// Run: node --env-file=.env scripts/run-mint-token-e2e.mjs against `npm run serve`
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
if (conn?.jobId) { console.log('     syncing...'); await ng.waitForJob({ jobId: conn.jobId, sessionId }); }
console.log(`OK   session ${sessionId}`);

let contractAddress = process.env.MINT_E2E_CONTRACT || '';
if (!contractAddress) {
    step('2. Deploy @odatano/contract-shielded-token');
    const dep = await ng.deployContract({ contractName: 'shielded-token', sessionId, initialPrivateState: '{}' })
        .catch(e => fail(`deploy: ${e.message}`));
    contractAddress = dep.contractAddress;
}
console.log(`OK   contract ${contractAddress}`);

// The separator the contract pads to 32 bytes in its mint circuit.
const DOMAIN_SEPARATOR = 'nightgate:zswap-e2e';

step('3. deriveTokenType (compute-only)');
const derived = await ng.deriveTokenType({ contractAddress, domainSeparator: DOMAIN_SEPARATOR });
if (!/^[0-9a-f]{64}$/.test(derived.tokenType ?? '')) fail(`deriveTokenType returned no tokenType: ${JSON.stringify(derived)}`);
const viaHex = await ng.deriveTokenType({ contractAddress, domainSeparator: derived.domainSeparator });
if (viaHex.tokenType !== derived.tokenType) fail('the text form and the hex form of the separator disagree');
const held = async () => BigInt((await ng.getWalletBalance({ sessionId })).shieldedTokens?.find(t => t.tokenType === derived.tokenType)?.amount ?? 0);
const before = await held();
console.log(`OK   tokenType ${derived.tokenType}, held before: ${before}`);

step('4. submitContractCall mint()');
const mint = await ng.submitContractCall({ contractAddress, circuit: 'mint', contractName: 'shielded-token', sessionId, args: '[]' })
    .catch(e => fail(`mint: ${e.message}`));
if (!mint.txHash) fail(`mint returned no txHash: ${JSON.stringify(mint)}`);
console.log(`OK   minted: tx ${mint.txHash}`);

step('5. The wallet holds the mint under the derived type');
let after = before;
for (let i = 0; i < 60 && after <= before; i++) {
    await new Promise(r => setTimeout(r, 5000));
    after = await held();
}
if (after <= before) fail(`the wallet shows no new coin of type ${derived.tokenType} after 5 minutes`);
console.log(`OK   held after: ${after}`);

step('SUMMARY');
console.log('OK   MINT + TOKEN-TYPE LANE WORKS');
console.log(`     contract ${contractAddress}`);
console.log(`     mint tx  ${mint.txHash}`);
console.log(`     token    ${derived.tokenType} (${after - before} atoms to own zswap key)`);
process.exit(0);
