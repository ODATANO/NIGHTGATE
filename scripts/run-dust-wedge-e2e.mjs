// Live AC for docs/feature-requests/dust-pending-note-leak-on-presubmit-abort.md
// (0.15.2 dust wedge protection): force a dust-spending submission to die
// provably PRE-MEMPOOL, then prove the wallet is NOT wedged: the pre-build
// dust snapshot restore kicked in (server log), getWalletBalance still shows
// the dust UTXO with nothing stuck pending, and a follow-up normal send
// succeeds end-to-end.
//
// The reject is forced via a transaction TTL that is valid at request time
// (the API rejects past TTLs with a 400) but expires while the in-process
// proving runs (minutes for a transfer in wasm mode): the build+prove
// pipeline runs for real (the dust spend IS booked, the exact state the
// incident poisoned), and the node rejects the finalized tx at validity
// check (1010 invalid, the same guard branch as the incident's 1014).
//
// Server (separate terminal): npm run dev
// Then:  node --env-file=.env scripts/run-dust-wedge-e2e.mjs
//
// Inputs (env vars):
//   NIGHTGATE_URL             default http://localhost:4004
//   LACE_VIEWING_KEY          required (64 hex)
//   LACE_MNEMONIC             required (BIP39 phrase)
//   DUST_E2E_AMOUNT           default '1000000' NIGHT atoms, sent to own address
//   DUST_E2E_TTL_OFFSET_MS    default 30000 (tx TTL 30s ahead; must expire before proving finishes)
//   E2E_PREWARM_TIMEOUT_MIN   default 240
//   E2E_JOB_POLL_INTERVAL_MS  default 5000

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
const AMOUNT = process.env.DUST_E2E_AMOUNT || '1000000';
const TTL_OFFSET_MS = parseInt(process.env.DUST_E2E_TTL_OFFSET_MS || '30000', 10);
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

/** Poll until the job reaches a terminal state; returns { status, result, errorCode, errorMessage }. */
async function pollJobTerminal(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
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
        if (status === 'succeeded' || status === 'failed') {
            process.stdout.write('\n');
            return { status, result: result ? JSON.parse(result) : {}, errorCode, errorMessage };
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function getBalance(sessionId, label) {
    // The read action answers 503 WALLET_SYNCING while a (restored) facade
    // catches up to tip; retry within a bounded window instead of failing.
    const deadline = Date.now() + 120_000;
    let r = await fetch(`${ENDPOINT}/getWalletBalance(sessionId=${sessionId})`);
    while (r.status === 503 && Date.now() < deadline) {
        process.stdout.write('~');
        await new Promise(res => setTimeout(res, 5000));
        r = await fetch(`${ENDPOINT}/getWalletBalance(sessionId=${sessionId})`);
    }
    if (!r.ok) fail(`getWalletBalance (${label}) → HTTP ${r.status}`);
    const b = await r.json();
    console.log(`OK   [${label}] dust=${b.dustBalance} dustUtxos=${b.dustUtxoCount} ` +
        `dustPending=${b.dustPendingCount}/${b.dustPendingValue} restores=${b.dustRestoreCount} ` +
        `night=${b.unshieldedNight} registered=${b.registeredNightUtxoCount}/${b.totalNightUtxoCount}`);
    return b;
}

async function waitForServer() {
    step('Waiting for NIGHTGATE to be reachable');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`);
            if (r.ok) { console.log('OK   server up'); return; }
        } catch { /* retry */ }
        await new Promise(res => setTimeout(res, 1000));
    }
    fail(`Server at ${URL_BASE} did not respond within 30s`);
}

(async () => {
    await waitForServer();

    step('1. connectWallet + connectWalletForSigning (prewarm)');
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet → HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet returned no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning → HTTP ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) {
        const pw = await pollJobTerminal(sessionId, r.body.prewarmJobId, 'prewarm');
        if (pw.status !== 'succeeded') fail(`prewarm failed: ${pw.errorCode}: ${pw.errorMessage}`);
    }

    step('2. deriveWalletInfo → own unshielded address');
    r = await post('/deriveWalletInfo', { mnemonic: MNEMONIC });
    const nightAddress = r.body?.nightAddress;
    if (!nightAddress) fail(`deriveWalletInfo returned no nightAddress: ${pretty(r.body)}`);
    console.log(`OK   nightAddress = ${nightAddress.slice(0, 32)}...`);

    step('3. getWalletBalance BEFORE');
    const before = await getBalance(sessionId, 'before');
    if (BigInt(before.dustBalance) === 0n) fail('dust balance is 0; register NIGHT for dust generation first');
    if (before.dustUtxoCount === 0) fail('no dust UTXO tracked; wallet not in the single-note shape this test needs');
    if (typeof before.dustRestoreCount !== 'number') fail('server does not report dustRestoreCount; needs @odatano/nightgate >= 0.15.2');

    step(`4. sendNight with a ttl only ${TTL_OFFSET_MS}ms ahead → expires during proving → must die pre-mempool`);
    const ttlIso = new Date(Date.now() + TTL_OFFSET_MS).toISOString();
    r = await post('/sendNight', { sessionId, receiverAddress: nightAddress, amount: AMOUNT, ttlIso });
    if (r.status !== 200 && r.status !== 201) fail(`sendNight(short-ttl) → HTTP ${r.status}: ${pretty(r.body)}`);
    const doomed = await pollJobTerminal(sessionId, r.body.jobId, 'doomed-send');
    if (doomed.status !== 'failed') {
        fail(`expected the short-ttl send to FAIL pre-mempool (proving finished under ${TTL_OFFSET_MS}ms? lower DUST_E2E_TTL_OFFSET_MS), got: ${pretty(doomed)}`);
    }
    console.log(`OK   doomed send failed as intended: ${doomed.errorCode}: ${String(doomed.errorMessage).slice(0, 140)}`);

    step('5. getWalletBalance AFTER the abort → restore lane MUST have run, wallet must NOT be wedged');
    const after = await getBalance(sessionId, 'after');
    // Hard gate: the guard lane itself must have fired. The SDK's own
    // fast-path revert can heal some aborts WITHOUT it (that is the path
    // that failed in the live incident), so a green balance alone proves
    // nothing about the protection.
    const restoresBefore = before.dustRestoreCount ?? 0;
    if (after.dustRestoreCount !== restoresBefore + 1) {
        fail(`restore lane did not run: dustRestoreCount ${restoresBefore} -> ${after.dustRestoreCount} ` +
            '(expected +1; the abort was healed by the SDK fast-path revert instead, or not classified pre-mempool)');
    }
    console.log(`OK   snapshot restore ran (dustRestoreCount ${restoresBefore} -> ${after.dustRestoreCount})`);
    if (after.dustUtxoCount === 0 && after.dustPendingCount === 0) {
        fail('WEDGED: dust UTXO gone and nothing pending — the restore did not protect the wallet');
    }
    if (BigInt(after.dustBalance) === 0n) {
        fail('WEDGED: dustBalance dropped to 0 after the pre-mempool abort');
    }
    console.log('OK   dust note survived the abort');

    step(`6. sendNight ${AMOUNT} atoms → own address (normal ttl) → must SUCCEED`);
    const tSend = Date.now();
    r = await post('/sendNight', { sessionId, receiverAddress: nightAddress, amount: AMOUNT });
    if (r.status !== 200 && r.status !== 201) fail(`sendNight → HTTP ${r.status}: ${pretty(r.body)}`);
    const send = await pollJobTerminal(sessionId, r.body.jobId, 'proof-send');
    if (send.status !== 'succeeded' || !send.result?.txId) {
        fail(`follow-up send did not succeed (wallet wedged?): ${pretty(send)}`);
    }
    console.log(`\nPASS  wallet survived a pre-mempool abort and kept working`);
    console.log(`      follow-up txId=${send.result.txId} (${((Date.now() - tSend) / 1000).toFixed(1)}s)`);
    await getBalance(sessionId, 'final');
})();
