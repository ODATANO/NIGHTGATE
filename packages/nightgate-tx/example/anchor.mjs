// Anchor a document on Midnight under YOUR identity, with a sponsor paying the
// fee. This is the whole integration: no server of your own, no proof server,
// no Docker, no database.
//
//   npm install @odatano/nightgate-tx
//   NIGHTGATE_URL=https://... VAULT=... SEED_HEX=... node anchor.mjs ./mydoc.json
//
// What happens:
//   1. your seed -> your attester id, locally
//   2. the document is hashed locally (nothing about it is sent anywhere)
//   3. the transaction is built, PROVEN and signed locally
//   4. only ~5 KB of finalized transaction goes to the sponsor
//   5. the sponsor pays the dust and submits; the anchor is yours
//
// Verification needs nothing at all: verifyAttestationState is a plain GET, so
// anyone can check the anchor without a wallet, a key, or this package.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';

const SPONSOR = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const VAULT = process.env.VAULT;
const SEED_HEX = process.env.SEED_HEX;
const SPONSOR_SESSION = process.env.SPONSOR_SESSION_ID;
const NETWORK = process.env.NETWORK || 'preprod';
const INDEXER_HTTP = process.env.INDEXER_HTTP_URL || `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`;
const INDEXER_WS = process.env.INDEXER_WS_URL || INDEXER_HTTP.replace(/^http/, 'ws') + '/ws';
const NODE_URL = process.env.NODE_URL || `wss://rpc.${NETWORK}.midnight.network/`;
const file = process.argv[2];

if (!VAULT || !SEED_HEX || !file) {
    console.error('usage: VAULT=<addr> SEED_HEX=<128 hex> node anchor.mjs <file.json>');
    process.exit(2);
}

const ng = connect({ baseUrl: SPONSOR });

// 1 + 2: identity and document hash, both local.
const document = await readFile(file);
const payloadHash = createHash('sha256').update(document).digest('hex');
const metadataHash = createHash('sha256').update(JSON.stringify({ file, at: new Date().toISOString() })).digest('hex');

const builder = await createTxBuilder({
    seedHex: SEED_HEX,
    networkId: NETWORK,
    indexerHttpUrl: INDEXER_HTTP,
    indexerWsUrl: INDEXER_WS,
    nodeUrl: NODE_URL,
    // The sponsor's own zk-config: this is what pins the prover keys to the
    // generation of the contract actually deployed at VAULT.
    zkConfigBaseUrl: `${SPONSOR}/zk-config/attestation-vault`,
    contractClass: Contract,
    onProgress: e => e.phase === 'zk-assets' && console.log('fetching prover keys (first run only)...')
});
console.log(`attester id : ${builder.attesterId}`);
console.log(`payload hash: ${payloadHash}`);

// 3: build + prove + sign, all in this process.
const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const { finalizedTxB64, serializedBytes } = await builder.buildSponsorable({ contractAddress: VAULT, call });
console.log(`built locally: ${serializedBytes} bytes (nothing submitted yet)`);

// 4 + 5: hand over the bytes. This is the only thing that leaves the machine;
// sponsorFinalized submits the job AND waits for the on-chain result.
const result = await ng.sponsorFinalized({ finalizedTxB64, sponsorSessionId: SPONSOR_SESSION });
console.log(`anchored: ${result.txHash}`);

await builder.close();

// Anyone can verify this without a wallet and without this package:
console.log(`\nverify:\n  curl "${SPONSOR}/api/v1/nightgate/verifyAttestationState(contractAddress='${VAULT}',payloadHash='${payloadHash}')"`);
