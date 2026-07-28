// Live AC for docs/feature-requests/wasm-proving-without-docker.md:
// with the SERVER started under NIGHTGATE_PROVING_MODE=wasm (and ideally a
// dead NIGHTGATE_PROOF_SERVER_URL so any accidental server-proving fails
// loudly), build → sign → prove → submit a NIGHT self-transfer and get a
// node-accepted tx hash. Proving runs in-process; no proof server involved.
//
// Server (separate terminal):
//   NIGHTGATE_PROVING_MODE=wasm NIGHTGATE_PROOF_SERVER_URL=http://127.0.0.1:9999 npm run dev
//
// Then:
//   node --env-file=.env scripts/run-wasm-proving-e2e.mjs
//   (or: npm run wasm-proving:e2e)
//
// Inputs (env vars):
//   NIGHTGATE_URL            default http://localhost:4004
//   LACE_VIEWING_KEY         required (64 hex)
//   LACE_MNEMONIC            required (BIP39 phrase; server HD-derives keys)
//   WASM_E2E_AMOUNT          default '1000000' NIGHT atoms, sent to own address
//   E2E_PREWARM_TIMEOUT_MIN  default 240
//   E2E_JOB_POLL_INTERVAL_MS default 5000

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 30_000
}));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const AMOUNT = process.env.WASM_E2E_AMOUNT || '1000000';
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
            return result ? JSON.parse(result) : {};
        }
        if (status === 'failed') {
            process.stdout.write('\n');
            fail(`[${label}] job ${jobId} failed: ${errorCode}: ${errorMessage}`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function waitForServer() {
    step('Waiting for NIGHTGATE to be reachable');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`);
            if (r.ok) { console.log('OK   server up'); return; }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    fail(`Server at ${URL_BASE} did not respond within 30s`);
}

(async () => {
    await waitForServer();

    step('1. connectWallet (read-only session)');
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet → HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet returned no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning → facade prewarm (restore + catch-up sync)');
    const tPrewarm = Date.now();
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning → HTTP ${r.status}: ${pretty(r.body)}`);
    const prewarmJobId = r.body?.prewarmJobId;
    if (prewarmJobId) {
        await pollJob(sessionId, prewarmJobId, 'prewarm');
    }
    console.log(`OK   prewarm done in ${((Date.now() - tPrewarm) / 1000).toFixed(1)}s`);

    step('3. deriveWalletInfo → own unshielded NIGHT address');
    r = await post('/deriveWalletInfo', { mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`deriveWalletInfo → HTTP ${r.status}: ${pretty(r.body)}`);
    const nightAddress = r.body?.nightAddress;
    if (!nightAddress) fail(`deriveWalletInfo returned no nightAddress: ${pretty(r.body)}`);
    console.log(`OK   nightAddress = ${nightAddress.slice(0, 32)}...`);

    step('4. getWalletBalance (pre-flight)');
    r = await fetch(`${ENDPOINT}/getWalletBalance(sessionId=${sessionId})`);
    let balance = null;
    if (r.ok) {
        balance = await r.json();
        console.log(`OK   unshieldedNight=${balance.unshieldedNight} dust=${balance.dustBalance} registered=${balance.registeredNightUtxoCount}/${balance.totalNightUtxoCount}`);
        if (BigInt(balance.unshieldedNight) < BigInt(AMOUNT)) {
            fail(`unshielded NIGHT balance ${balance.unshieldedNight} < send amount ${AMOUNT}`);
        }
        if (BigInt(balance.dustBalance) === 0n) fail('dust balance is 0; register NIGHT for dust generation first');
    } else {
        console.log(`WARN getWalletBalance → HTTP ${r.status}; continuing (sendNight will validate funds)`);
    }

    step(`5. sendNight ${AMOUNT} atoms → own address (proving in-process, mode=wasm on the server)`);
    const tSend = Date.now();
    r = await post('/sendNight', { sessionId, receiverAddress: nightAddress, amount: AMOUNT });
    if (r.status !== 200 && r.status !== 201) fail(`sendNight → HTTP ${r.status}: ${pretty(r.body)}`);
    const sendJob = r.body?.jobId;
    if (!sendJob) fail(`sendNight returned no jobId: ${pretty(r.body)}`);
    const sendResult = await pollJob(sessionId, sendJob, 'sendNight');
    const sendSecs = ((Date.now() - tSend) / 1000).toFixed(1);

    if (!sendResult?.txId) fail(`send job succeeded but carries no txId: ${pretty(sendResult)}`);
    console.log(`\nPASS  txId=${sendResult.txId}`);
    console.log(`      toLedger=${sendResult.toLedger} amount=${sendResult.amount}`);
    console.log(`      job wall-clock ${sendSecs}s (includes sync gate + build + prove + submit)`);
    console.log('\nCross-check the server log for:');
    console.log('  "proving mode: wasm (in-process prover; proof server not used for wallet proving)"');
    console.log('and record the proving duration in the FR (AC-6).');
})();
