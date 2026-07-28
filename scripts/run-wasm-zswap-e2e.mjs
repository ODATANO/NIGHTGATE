// zswap in-process proving measurement (wasm-proving-without-docker FR).
//
// NIGHT is unshielded-only, so no NIGHT flow can ever exercise the zswap
// prover circuits. This runner creates the missing shielded funds itself:
//   1. deploy contracts/shielded-token (mint circuit, compiled artifact)
//   2. submitContractCall mint() → 100000000 atoms of the contract's
//      shielded token to the caller's own zswap public key
//   3. wait for the wallet to sync the minted coin, then
//   4. sendNight with tokenTypeHex → shielded SELF-transfer of the custom
//      token. The wallet-side build of that tx spends + recreates a
//      shielded coin: zswap/spend + zswap/output prove IN-PROCESS when the
//      server runs NIGHTGATE_PROVING_MODE=wasm.
//
// The proof server must be reachable for steps 1-2 (contract circuit,
// separate midnight-js stack); step 4 is pure wallet proving.
//
// Server (separate terminal):
//   NIGHTGATE_PROVING_MODE=wasm npm run dev
// Then:
//   node --env-file=.env scripts/run-wasm-zswap-e2e.mjs
//   (or: npm run wasm-zswap:e2e)
//
// Extra env vars on top of the shared ones:
//   ZSWAP_E2E_CONTRACT       reuse an already-deployed shielded-token address
//                            (skips deploy; mint still runs)
//   ZSWAP_E2E_SKIP_MINT      '1' to skip mint (coin already in wallet)
//   ZSWAP_E2E_SEND_AMOUNT    default '1000000'
//   ZSWAP_E2E_SYNC_RETRIES   default 20 (x30s = 10 min for the mint to sync)

import bip39 from 'bip39';
import { createRequire } from 'node:module';
import { Agent, setGlobalDispatcher } from 'undici';

const require = createRequire(import.meta.url);
const { rawTokenType } = require('@midnight-ntwrk/compact-runtime');

setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 30_000
}));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const DOMAIN_SEP_STR = 'nightgate:zswap-e2e'; // must match shielded-token.compact pad(32, ...)
const SEND_AMOUNT = process.env.ZSWAP_E2E_SEND_AMOUNT || '1000000';
const SYNC_RETRIES = parseInt(process.env.ZSWAP_E2E_SYNC_RETRIES || '20', 10);
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK || !/^[0-9a-fA-F]{64}$/.test(VK)) fail('LACE_VIEWING_KEY (64 hex) is required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39 phrase) is required');

async function post(path, body, timeoutMs = 60 * 60 * 1000) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

/** Poll a job to a terminal state. Returns { ok, result | errorCode+errorMessage }. */
async function pollJob(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== lastStatus) {
            process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`);
            lastStatus = status;
        } else {
            process.stdout.write('.');
        }
        if (status === 'succeeded') {
            process.stdout.write('\n');
            return { ok: true, result: result ? JSON.parse(result) : {} };
        }
        if (status === 'failed') {
            process.stdout.write('\n');
            return { ok: false, errorCode, errorMessage };
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

function domainSepBytes() {
    const ds = new Uint8Array(32);
    for (let i = 0; i < DOMAIN_SEP_STR.length; i++) ds[i] = DOMAIN_SEP_STR.charCodeAt(i);
    return ds;
}

(async () => {
    step('Waiting for NIGHTGATE to be reachable');
    {
        const deadline = Date.now() + 30_000;
        let up = false;
        while (Date.now() < deadline && !up) {
            try { up = (await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`)).ok; } catch { /* retry */ }
            if (!up) await new Promise(r => setTimeout(r, 1000));
        }
        if (!up) fail(`Server at ${URL_BASE} did not respond within 30s`);
        console.log('OK   server up');
    }

    step('1. connectWallet + connectWalletForSigning (prewarm)');
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet → HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning → HTTP ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) {
        const pw = await pollJob(sessionId, r.body.prewarmJobId, 'prewarm');
        if (!pw.ok) fail(`prewarm failed: ${pw.errorCode}: ${pw.errorMessage}`);
    }
    console.log('OK   prewarm done');

    step('2. deriveWalletInfo → own shielded address');
    r = await post('/deriveWalletInfo', { mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`deriveWalletInfo → HTTP ${r.status}: ${pretty(r.body)}`);
    const shieldedAddress = r.body?.shieldedAddress;
    if (!shieldedAddress) fail(`no shieldedAddress: ${pretty(r.body)}`);
    console.log(`OK   shieldedAddress = ${shieldedAddress.slice(0, 36)}...`);

    let contractAddress = process.env.ZSWAP_E2E_CONTRACT;
    if (contractAddress) {
        step(`3. Reusing deployed shielded-token at ${contractAddress.slice(0, 16)}...`);
    } else {
        step('3. deployContract(shielded-token)');
        const tDeploy = Date.now();
        r = await post('/deployContract', { compiledArtifactRef: 'shielded-token', sessionId, initialPrivateState: '{}' });
        if (r.status >= 400) fail(`deployContract → HTTP ${r.status}: ${pretty(r.body)}`);
        const dep = await pollJob(sessionId, r.body.jobId, 'deploy');
        if (!dep.ok) fail(`deploy failed: ${dep.errorCode}: ${dep.errorMessage}`);
        contractAddress = dep.result?.contractAddress;
        if (!contractAddress) fail(`no contractAddress: ${pretty(dep.result)}`);
        console.log(`OK   deployed in ${((Date.now() - tDeploy) / 1000).toFixed(1)}s: ${contractAddress}`);
    }

    const tokenTypeHex = rawTokenType(domainSepBytes(), contractAddress);
    console.log(`     rawTokenType = ${tokenTypeHex}`);

    if (process.env.ZSWAP_E2E_SKIP_MINT === '1') {
        step('4. Skipping mint (ZSWAP_E2E_SKIP_MINT=1)');
    } else {
        step('4. submitContractCall shielded-token.mint() → 100000000 atoms to own zswap key');
        const tMint = Date.now();
        r = await post('/submitContractCall', {
            contractAddress,
            circuit: 'mint',
            compiledArtifactRef: 'shielded-token',
            sessionId,
            args: '[]'
        });
        if (r.status >= 400) fail(`submitContractCall(mint) → HTTP ${r.status}: ${pretty(r.body)}`);
        const mint = await pollJob(sessionId, r.body.jobId, 'mint');
        if (!mint.ok) fail(`mint failed: ${mint.errorCode}: ${mint.errorMessage}`);
        console.log(`OK   minted in ${((Date.now() - tMint) / 1000).toFixed(1)}s: txHash=${mint.result?.txHash}`);
    }

    step(`5. Shielded SELF-transfer of ${SEND_AMOUNT} token atoms (zswap proves in-process)`);
    // The wallet must first SYNC the minted coin from the indexer; until then
    // the send fails with insufficient funds. Retry with backoff.
    let sendResult = null;
    let sendSecs = null;
    for (let attempt = 1; attempt <= SYNC_RETRIES; attempt++) {
        const tSend = Date.now();
        r = await post('/sendNight', {
            sessionId,
            receiverAddress: shieldedAddress,
            amount: SEND_AMOUNT,
            tokenTypeHex
        });
        if (r.status >= 400) fail(`sendNight → HTTP ${r.status}: ${pretty(r.body)}`);
        const send = await pollJob(sessionId, r.body.jobId, `send#${attempt}`);
        if (send.ok) {
            sendResult = send.result;
            sendSecs = ((Date.now() - tSend) / 1000).toFixed(1);
            break;
        }
        console.log(`     attempt ${attempt}/${SYNC_RETRIES} failed (${send.errorCode}: ${String(send.errorMessage).slice(0, 100)});`);
        console.log('     minted coin probably not synced yet, retrying in 30s...');
        await new Promise(r => setTimeout(r, 30_000));
    }
    if (!sendResult?.txId) fail(`shielded self-transfer did not succeed within ${SYNC_RETRIES} attempts`);

    console.log(`\nPASS  zswap circuits proved in-process (mode=wasm on the server)`);
    console.log(`      contract      = ${contractAddress}`);
    console.log(`      tokenType     = ${tokenTypeHex}`);
    console.log(`      transfer txId = ${sendResult.txId}`);
    console.log(`      toLedger=${sendResult.toLedger} amount=${sendResult.amount}`);
    console.log(`      send job wall-clock ${sendSecs}s (sync gate + build + zswap prove + submit)`);
    console.log('\nCross-check the server log for the "proving mode: wasm" line.');
})();
