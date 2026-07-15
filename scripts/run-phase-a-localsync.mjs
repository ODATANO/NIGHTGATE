// Phase A of the hybrid-sync experiment.
//
// Goal: sync the wallet FULLY against the LOCAL docker indexer (clean stream,
// no 8469 gap) up to the local indexer's head, and let NIGHTGATE persist the
// serialized wallet state to WalletSyncStates. NO revoke here: the local
// indexer is not at chain tip, so a submit would fail dust-validity (170).
//
// Phase B (separate run): point NIGHTGATE_INDEXER_* at the PUBLIC indexer
// (which IS at tip), restore this state, continue head->tip, then revoke.
//
// Run the server first:
//   NIGHTGATE_DUST_COLD_START=true \
//   NIGHTGATE_INDEXER_HTTP_URL=http://localhost:8088/api/v4/graphql \
//   NIGHTGATE_INDEXER_WS_URL=ws://localhost:8088/api/v4/graphql/ws \
//   npx cds serve all
// Then: node --env-file=.env scripts/run-phase-a-localsync.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '600', 10) * 60_000;
const JOB_POLL_MS = 5000;

function fail(m) { console.error(`FAIL ${m}`); process.exit(1); }
function step(n) { console.log(`\n--- ${n} ---`); }
const pretty = o => JSON.stringify(o, null, 2);

if (!VK) fail('LACE_VIEWING_KEY required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39) required');

async function post(path, body) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60 * 60 * 1000)
    });
    const t = await r.text();
    let p; try { p = t ? JSON.parse(t) : null; } catch { p = t; }
    return { status: r.status, body: p };
}
async function pollJob(sessionId, jobId, label) {
    const deadline = Date.now() + PREWARM_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus -> ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed') { process.stdout.write('\n'); return { failed: true, errorCode, errorMessage }; }
        await new Promise(r => setTimeout(r, JOB_POLL_MS));
    }
    fail(`[${label}] timed out after ${PREWARM_TIMEOUT_MS / 60000} min`);
}

(async () => {
    console.log('PHASE A — full wallet sync against LOCAL indexer (no revoke)');

    step('1. connectWallet');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (+ await prewarm = full sync to local head)');
    const t0 = Date.now();
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status >= 400) fail(`connectWalletForSigning -> ${r.status}: ${pretty(r.body)}`);
    if (!r.body?.prewarmJobId) { console.log('WARN no prewarmJobId — wallet may already be synced'); process.exit(0); }

    const pw = await pollJob(sessionId, r.body.prewarmJobId, 'prewarm');
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (pw?.failed) {
        console.log(`\nPHASE A FAILED after ${mins} min — ${pw.errorCode} — ${pw.errorMessage}`);
        process.exit(1);
    }
    console.log(`\nPHASE A DONE after ${mins} min — wallet synced to local head, state persisted to WalletSyncStates.`);
    console.log('Next: stop server, switch NIGHTGATE_INDEXER_* to the PUBLIC indexer (dust cold-start OFF), restart, run the revoke.');
    process.exit(0);
})();
