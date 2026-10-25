// Anchor a document on Midnight under YOUR identity, with a sponsor paying the
// fee. This is the whole integration: no server of your own, no indexer, no
// proof server, no Docker, no database.
//
//   npm install @odatano/nightgate-tx
//   NIGHTGATE_URL=https://api.preprod.odatano.dev ODATANO_KEY=oda_... VAULT=... SEED_HEX=... node anchor.mjs ./mydoc.json
//
// What happens:
//   1. your seed -> your attester id, locally
//   2. the document is hashed locally (nothing about it is sent anywhere)
//   3. the transaction is built, PROVEN and signed locally; the chain is read through the API
//   4. only ~5 KB of transaction goes to the sponsor, which pays the dust and submits
//   5. the identifier resolves to the hash explorers show
//
// Verification needs nothing at all: the public verify route takes no key.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connect, createTxBuilder } from '@odatano/nightgate-tx';
import { waitLanded } from '@odatano/nightgate-tx/txbuilder';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault-32';

const BASE = (process.env.NIGHTGATE_URL || 'https://api.preprod.odatano.dev').replace(/\/+$/, '');
const KEY = process.env.ODATANO_KEY;
const VAULT = process.env.VAULT;
const SEED_HEX = process.env.SEED_HEX;
const NETWORK = process.env.NETWORK || 'preprod';
const file = process.argv[2];

if (!KEY || !VAULT || !SEED_HEX || !file) {
    console.error('usage: ODATANO_KEY=oda_... VAULT=<64 hex> SEED_HEX=<128 hex> node anchor.mjs <file.json>');
    process.exit(2);
}

// An oda_ key goes as Bearer; a bare ngat_ grant against a server without the gateway as agentToken.
const api = KEY.startsWith('ngat_') ? { baseUrl: BASE, agentToken: KEY } : { baseUrl: BASE, token: KEY };
const ng = connect(api);

// 1 + 2: identity and document hash, both local.
const document = await readFile(file);
const payloadHash = createHash('sha256').update(document).digest('hex');
const metadataHash = createHash('sha256').update(JSON.stringify({ file, at: new Date().toISOString() })).digest('hex');

const builder = await createTxBuilder({
    seedHex: SEED_HEX,
    networkId: NETWORK,
    api,
    // An attest moves no value, so the wallet need not sync.
    walletSync: false,
    // The sponsor's own zk-config pins the prover keys to the contract deployed at VAULT.
    zkConfigBaseUrl: `${BASE}/zk-config/attestation-vault-32`,
    contractClass: Contract,
    contractName: 'attestation-vault-32',
    onProgress: e => e.phase === 'zk-assets' && console.log('fetching prover keys (first run only)...')
});
console.log(`attester id : ${builder.attesterId}`);
console.log(`payload hash: ${payloadHash}`);

try {
    // 3: build + prove + sign, all in this process.
    const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
    const { unboundTxB64, serializedBytes } = await builder.buildSponsorable({ contractAddress: VAULT, call, bind: false });
    console.log(`built locally: ${serializedBytes} bytes (nothing submitted yet)`);

    // 4: hand over the bytes; sponsorUnbound submits the job AND waits for the chain.
    const job = await ng.sponsorUnbound({ unboundTxB64, idempotencyKey: `anchor-${payloadHash}` });
    console.log(`anchored, identifier ${job.txHash}`);

    // 5: the hash explorers show.
    const landed = await waitLanded(job.txHash, { api, timeoutMs: 120_000 });
    console.log(`explorer hash: ${landed?.txHash ?? job.transactionHash ?? '(not indexed yet)'}`);
} finally {
    await builder.close();
}

console.log(`\nverify, no key needed:\n  curl "${BASE}/odata/v4/midnight-verify/verifyAttestationState(contractAddress='${VAULT}',attesterId='${builder.attesterId}',payloadHash='${payloadHash}',compiledArtifactRef='attestation-vault-32')"`);
