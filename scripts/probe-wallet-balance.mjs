// One-shot wallet-balance probe: connectWallet → connectWalletForSigning
// (await prewarm) → getWalletBalance. Prints the real spendable dust/NIGHT the
// wallet sees, to diagnose Custom error 117 (NotNormalized / empty dust actions).
//
// Run: node --env-file=.env scripts/probe-wallet-balance.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const POLL_MS = 5000;

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
        if (r.status !== 200) fail(`getJobStatus → ${r.status}: ${pretty(r.body)}`);
        const { status, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return; }
        if (status === 'failed') fail(`[${label}] ${errorCode} — ${errorMessage}`);
        await new Promise(r => setTimeout(r, POLL_MS));
    }
    fail(`[${label}] timed out`);
}

(async () => {
    step('1. connectWallet');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (+ await prewarm)');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status >= 400) fail(`connectWalletForSigning → ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) await pollJob(sessionId, r.body.prewarmJobId, 'prewarm');
    console.log('OK   facade synced');

    step('3. getWalletBalance');
    // getWalletBalance is an OData FUNCTION → HTTP GET (not a POST action).
    const gr = await fetch(`${ENDPOINT}/getWalletBalance(sessionId=${sessionId})`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5 * 60 * 1000)
    });
    const gt = await gr.text();
    r = { status: gr.status, body: gt ? JSON.parse(gt) : null };
    if (r.status >= 400) fail(`getWalletBalance → ${r.status}: ${pretty(r.body)}`);
    console.log('WALLET BALANCE:');
    console.log(pretty(r.body));
    console.log('\nKey fields for Custom-error-117 diagnosis:');
    console.log(`  dustBalance              = ${r.body?.dustBalance}`);
    console.log(`  registeredNightUtxoCount = ${r.body?.registeredNightUtxoCount}`);
    console.log(`  totalNightUtxoCount      = ${r.body?.totalNightUtxoCount}`);
    console.log(`  unshieldedNight          = ${r.body?.unshieldedNight}`);
    console.log(`  shieldedNight            = ${r.body?.shieldedNight}`);
    console.log('\n(If registered NIGHT exists but dustBalance is ~0 / no spendable dust output,');
    console.log(' that confirms the empty-dust-actions cause of Custom error 117.)');
})();
