// Live lane for `@odatano/nightgate/txbuilder`: the AGENT side of cross-server
// fee sponsoring. Everything that touches the caller's key happens HERE, in
// this process; the server only ever sees ~5 KB of finalized transaction.
//
// What runs:
//   1. A throwaway caller identity is derived locally from a fresh seed.
//   2. The prover keys are fetched from the sponsor's public /zk-config and
//      cached on disk (second run is offline).
//   3. `attest` is built, PROVEN IN-PROCESS (wasm), signed and finalized
//      locally. Nothing is submitted; nothing secret leaves this process.
//   4. Only the base64 transaction is POSTed to the sponsor, which pays the
//      dust and submits.
//   5. The attestation is verified on chain to carry OUR attester id.
//
// This is what an autonomous agent does: it proves under its own identity and
// pays for the API call (x402 later), while the sponsor covers the chain fee.
//
// Server (separate terminal): npm run dev
// Then:  NIGHTGATE_VAULT=<vault> node --env-file=.env scripts/run-txbuilder-e2e.mjs
//
// Needs LACE_VIEWING_KEY / LACE_MNEMONIC only for the SPONSOR side (our funded
// wallet). The caller side needs no funds at all.
//
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { createTxBuilder } from '../src/txbuilder/index.mjs';
import { prepareAttest } from '../src/browser/index.mjs';
import { Contract } from '../contracts/attestation-vault/src/managed/attestation-vault/contract/index.js';

const require = createRequire(import.meta.url);
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VAULT = process.env.NIGHTGATE_VAULT;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const INDEXER_HTTP = process.env.NIGHTGATE_INDEXER_HTTP_URL;
const NODE_URL = process.env.NIGHTGATE_NODE_URL;

function fail(m) { console.error(`\nFAIL ${m}`); process.exit(1); }
function step(n) { console.log(`\n--- ${n} ---`); }
if (!VAULT) fail('NIGHTGATE_VAULT (the shared vault address) is required');
if (!VK || !MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_VIEWING_KEY + LACE_MNEMONIC are required (the SPONSOR wallet)');
if (!INDEXER_HTTP) fail('NIGHTGATE_INDEXER_HTTP_URL is required');
if (!NODE_URL) fail('NIGHTGATE_NODE_URL is required');
// Use the plugin's own derivation: the indexer path is versioned (/api/v4/…),
// so a hand-rolled regex silently drops the /ws suffix and the wallet never syncs.
const { deriveIndexerWsUrl } = require('../srv/utils/nightgate-config.js');
const INDEXER_WS = process.env.NIGHTGATE_INDEXER_WS_URL || deriveIndexerWsUrl(INDEXER_HTTP);

async function post(path, body) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60 * 60 * 1000)
    });
    const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, body: j };
}
async function poll(sessionId, jobId, label) {
    for (;;) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        const { status, result, errorCode, errorMessage } = r.body ?? {};
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed' || status === 'reconciliation_required') fail(`[${label}] ${status}: ${errorCode} :: ${errorMessage}`);
        process.stdout.write('.');
        await new Promise(res => setTimeout(res, 5000));
    }
}
function fnCall(name, params) {
    const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v : `'${v}'`}`);
    return `/${name}(${parts.join(',')})`;
}

(async () => {
    step('0. Sponsor session (our funded wallet; the ONLY thing the server holds)');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sponsorSession = r.body?.sessionId; if (!sponsorSession) fail(`connectWallet: ${JSON.stringify(r.body)}`);
    r = await post('/connectWalletForSigning', { sessionId: sponsorSession, mnemonic: MNEMONIC });
    if (r.body?.prewarmJobId) { console.log('     syncing sponsor...'); await poll(sponsorSession, r.body.prewarmJobId, 'sponsor prewarm'); }
    console.log(`OK   sponsor ready (${sponsorSession})`);

    step('1. LOCAL builder: fresh identity, prover keys fetched + cached');
    const seedHex = randomBytes(64).toString('hex');       // never sent anywhere
    const cacheDir = join(tmpdir(), 'nightgate-txbuilder-e2e');
    const t0 = Date.now();
    const builder = await createTxBuilder({
        seedHex,
        networkId: process.env.NIGHTGATE_NETWORK || 'preprod',
        indexerHttpUrl: INDEXER_HTTP,
        indexerWsUrl: INDEXER_WS,
        nodeUrl: NODE_URL,
        zkConfigBaseUrl: `${URL_BASE}/zk-config/attestation-vault`,
        contractClass: Contract,
        cacheDir,
        onProgress: (e) => { if (e.phase === 'zk-asset' && e.fetched % 10 === 0) process.stdout.write('.'); }
    });
    console.log(`\nOK   builder ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`     zk assets: ${builder.zkAssets.fetched} fetched, ${builder.zkAssets.cached} from cache (${cacheDir})`);
    console.log(`     indexer ws ${INDEXER_WS}`);
    console.log(`     attesterId ${builder.attesterId.slice(0, 24)}… (derived locally; the server never sees the seed)`);

    step('2. Build + prove + sign LOCALLY (nothing submitted, nothing secret sent)');
    const payloadHash = randomBytes(32).toString('hex');
    const call = prepareAttest({
        payloadHash,
        metadataHash: randomBytes(32).toString('hex'),
        attestationSecret: builder.attestationSecret
    });
    const t1 = Date.now();
    const { finalizedTxB64, serializedBytes } = await builder.buildSponsorable({ contractAddress: VAULT, call });
    console.log(`OK   built + proven locally in ${((Date.now() - t1) / 1000).toFixed(1)}s: ${serializedBytes} bytes`);

    step('3. Ship ONLY the bytes to the sponsor; it pays the dust and submits');
    const sponsored = await post('/sponsorFinalizedTransaction', { finalizedTxB64, sponsorSessionId: sponsorSession });
    if (sponsored.status !== 200 && sponsored.status !== 201) fail(`sponsorFinalizedTransaction -> HTTP ${sponsored.status}: ${JSON.stringify(sponsored.body)}`);
    const out = await poll(sponsorSession, sponsored.body.jobId, 'sponsor');
    console.log(`OK   sponsor submitted: ${out.txHash}`);

    step('4. Verify on chain that the attestation is OURS');
    const res = await fetch(`${ENDPOINT}${fnCall('verifyAttestationState', { contractAddress: VAULT, payloadHash })}`);
    const v = await res.json();
    const attesterOk = String(v.attesterId ?? '').toLowerCase() === builder.attesterId.toLowerCase();
    console.log(`     attested=${v.attested} attesterId=${String(v.attesterId ?? '').slice(0, 24)}…`);

    await builder.close();

    step('SUMMARY');
    if (v.attested === true && attesterOk) {
        console.log('OK   AGENT-SIDE BUILD + SPONSORED SUBMIT WORKS');
        console.log(`     the ${serializedBytes}-byte transaction was built, proven and signed on THIS machine`);
        console.log('     the seed and attestation secret never left the process');
        console.log('     the sponsor paid the dust; the attestation carries OUR attester id');
        console.log(`     txHash ${out.txHash}`);
        process.exit(0);
    }
    fail(`attestation not ours or not present: attested=${v.attested} attesterMatch=${attesterOk}`);
})();
