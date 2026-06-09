// Revoke-only experiment for Custom error 117 (NotNormalized / unspendable dust).
//
// Hypothesis (Midnight forum 1164): dust is unspendable when its merkle roots
// fell out of the node's ~1h root_history (stale/idle wallet), even though
// dust.balance(now) is large. The FIRST submission right after a genuinely
// fresh sync should still have fresh roots and succeed. So: prewarm (fresh
// sync) → revoke an EXISTING on-chain grant IMMEDIATELY, with no other ops in
// between, minimizing the sync→submit gap.
//
// Target grant defaults to the run-1 grant (on-chain, active=true). Override
// via REVOKE_* env. Run: node --env-file=.env scripts/run-revoke-only.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = 5000;

const CONTRACT = process.env.REVOKE_CONTRACT || '29d47194fabe8e9444a5a462b5270897e23b8ede5e395627d6cd00243b65ff93';
const PAYLOAD  = process.env.REVOKE_PAYLOAD  || 'a3979aa37a3cd64b2460b6ddcea4dd02cf3195fe3bfd44af13db1d0168a2ac47';
const GRANTEE  = process.env.REVOKE_GRANTEE  || '41fd4711dddd116b116a5a49919fdd4b0b48ef6b937788eec3160b8390f3a5b9';

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
async function get(path) {
    const r = await fetch(`${ENDPOINT}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
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
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed') { process.stdout.write('\n'); return { failed: true, errorCode, errorMessage }; }
        await new Promise(r => setTimeout(r, JOB_POLL_MS));
    }
    fail(`[${label}] timed out`);
}

(async () => {
    console.log(`Target grant: contract=${CONTRACT.slice(0,12)}… payload=${PAYLOAD.slice(0,12)}… grantee=${GRANTEE.slice(0,12)}…`);

    step('1. connectWallet');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (+ await prewarm = fresh sync)');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status >= 400) fail(`connectWalletForSigning → ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) {
        const pw = await pollJob(sessionId, r.body.prewarmJobId, 'prewarm');
        if (pw?.failed) {
            console.log(`\nWARN prewarm FAILED — ${pw.errorCode} — ${pw.errorMessage}`);
            console.log('     Sync did NOT reach tip (likely WS drop). Revoke will probably time out or 117.');
            console.log('     Proceeding anyway to record the failure mode...');
        } else {
            console.log('OK   facade synced to tip (roots should be fresh)');
        }
    } else {
        console.log('WARN no prewarmJobId');
    }

    step('3. revokeDisclosure — IMMEDIATELY, first & only contract op');
    const t0 = Date.now();
    r = await post('/revokeDisclosure', { payloadHash: PAYLOAD, grantee: GRANTEE, sessionId, contractAddress: CONTRACT });
    if (r.status >= 400) fail(`revokeDisclosure → ${r.status}: ${pretty(r.body)}`);
    console.log(`(submitted ${((Date.now()-t0)/1000).toFixed(1)}s after sync)`);
    const res = await pollJob(sessionId, r.body.jobId, 'revoke');

    if (res.failed) {
        console.log(`\nRESULT: revoke FAILED — ${res.errorCode} — ${res.errorMessage}`);
        if (/117|NotNormalized/i.test(`${res.errorCode} ${res.errorMessage}`)) {
            console.log('=> Still 117 even as the first op after a fresh sync → NIGHTGATE waitForSyncedState');
            console.log('   does NOT refresh dust roots (it no-ops once latched). Confirms the worker');
            console.log('   resync fix (#1) is genuinely needed; a stale restored state has pruned roots.');
        }
        process.exit(1);
    }

    console.log(`\nRESULT: revoke SUCCEEDED on-chain — tx ${res.txHash}`);
    step('4. confirm DisclosureGrants.active flipped to false');
    const filter = encodeURIComponent(`contractAddress eq '${CONTRACT}' and grantee eq '${GRANTEE}'`);
    const gr = await get(`/DisclosureGrants?$filter=${filter}`);
    const row = (gr.body?.value || [])[0];
    console.log(`   active = ${row?.active}  revokedTxHash = ${row?.revokedTxHash || '(pending index)'}`);
    console.log('\nREVOKE-ONLY EXPERIMENT PASSED — first-op-after-fresh-sync clears 117.');
})();
