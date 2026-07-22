// ZK predicate attestation end-to-end (on-chain-verified model).
//
// Walks: connectWallet → connectWalletForSigning (await prewarm sync) →
// deployContract(attestation-vault) → anchorDocument (attest a payload so it
// has an on-chain owner) → issuePredicateAttestation:
//   POSITIVE  value=47300 lessOrEqual 50000  → job SUCCEEDS (predicate holds)
//   NEGATIVE  value=51    lessOrEqual 50      → job FAILS    (predicate false)
//
// The on-chain model = a successful provePredicate tx IS the verified proof
// (the ledger only includes it if the in-circuit commitment + predicate asserts
// pass). So the job outcome is the acceptance signal. `verifyPredicateAttestation`
// (DB-backed) additionally needs the crawler to have indexed the tx; with the
// crawler disabled during sync it is reported but not asserted.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004), LACE_VIEWING_KEY,
// LACE_MNEMONIC. Run:  node --env-file=.env scripts/run-predicate-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { randomBytes } from 'node:crypto';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK) fail('LACE_VIEWING_KEY env var is required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39 phrase) is required');

async function post(path, body, timeoutMs = 60 * 60 * 1000) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

// Poll a job. `expect`: 'succeed' (default) fail()s on job failure; 'fail'
// returns the failure payload and fail()s if it unexpectedly succeeds.
async function pollJob(sessionId, jobId, label, { expect = 'succeed', timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`); last = status; }
        else process.stdout.write('.');

        if (status === 'succeeded') {
            process.stdout.write('\n');
            if (expect === 'fail') fail(`[${label}] expected job to FAIL but it succeeded: ${result}`);
            return result ? JSON.parse(result) : {};
        }
        if (status === 'failed') {
            process.stdout.write('\n');
            if (expect === 'fail') { console.log(`     [${label}] failed as expected: ${errorCode} — ${errorMessage}`); return { failed: true, errorCode, errorMessage }; }
            fail(`[${label}] job failed: ${errorCode} — ${errorMessage}`);
        }
        if (status === 'reconciliation_required') {
            process.stdout.write('\n');
            if (expect === 'fail') { console.log(`     [${label}] reconciliation_required (terminal) — accepted as non-success: ${errorCode} — ${errorMessage}`); return { failed: true, reconciliation: true, errorCode, errorMessage }; }
            fail(`[${label}] job entered reconciliation_required: ${errorCode} — ${errorMessage}`);
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function waitForServer() {
    step('Waiting for NIGHTGATE');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try { const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`); if (r.ok) { console.log('OK   server up'); return; } } catch {}
        await new Promise(res => setTimeout(res, 1000));
    }
    fail(`Server at ${URL_BASE} did not respond within 30s`);
}

(async () => {
    await waitForServer();

    step('1. connectWallet');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (+ await prewarm sync-to-tip)');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status >= 400) fail(`connectWalletForSigning → ${r.status}: ${pretty(r.body)}`);
    const prewarmJobId = r.body?.prewarmJobId;
    if (prewarmJobId) { await pollJob(sessionId, prewarmJobId, 'prewarm'); console.log('OK   facade synced'); }
    else console.log('WARN no prewarmJobId');

    step('3. deployContract(attestation-vault)');
    r = await post('/deployContract', { compiledArtifactRef: 'attestation-vault', sessionId, initialPrivateState: '{}' });
    if (r.status >= 400) fail(`deployContract → ${r.status}: ${pretty(r.body)}`);
    const deployRes = await pollJob(sessionId, r.body.jobId, 'deploy');
    const contractAddress = deployRes.contractAddress;
    if (!contractAddress) fail(`deploy returned no contractAddress: ${pretty(deployRes)}`);
    console.log(`OK   contractAddress = ${contractAddress}`);

    // A payload must be attested (on-chain owner) before commitValue/provePredicate.
    const payloadHash = randomBytes(32).toString('hex');
    step(`4. anchorDocument → attest payload ${payloadHash.slice(0, 12)}…`);
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: 'file:///tmp/predicate-demo.bin',
        metadata: '{"type":"battery-passport-demo"}', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'attest');
    console.log('OK   payload attested');

    // MODE: 'full' (default) runs positive then negative. 'negative' skips the
    // positive so the negative provePredicate lands as an EARLY call: the
    // public indexer's graphql-ws subscription degrades over a long session,
    // and later calls can hang in the SDK's balance/submit; keeping the
    // negative early dodges that so it reaches the predicate assert.
    const MODE = (process.env.PREDICATE_E2E_MODE || 'full').toLowerCase();
    let posId = null;
    if (MODE !== 'negative') {
        step('5. issuePredicateAttestation — POSITIVE (47300 ≤ 50000 → should SUCCEED)');
        r = await post('/issuePredicateAttestation', {
            payloadHash, value: '47300', predicate: 'lessOrEqual', threshold: 50000,
            unit: 'kgCO2e/kWh', sessionId, contractAddress
        });
        if (r.status >= 400) fail(`issuePredicateAttestation(+) → ${r.status}: ${pretty(r.body)}`);
        posId = r.body.predicateAttestationId;
        const posRes = await pollJob(sessionId, r.body.jobId, 'prove+');
        console.log(`OK   positive proof accepted on-chain: ${pretty(posRes.proof ?? posRes)}`);
    } else {
        console.log('\n(MODE=negative: skipping the positive case)');
    }

    step('6. issuePredicateAttestation — NEGATIVE (51 ≤ 50 → should FAIL)');
    r = await post('/issuePredicateAttestation', {
        payloadHash, value: '51', predicate: 'lessOrEqual', threshold: 50,
        unit: 'kgCO2e/kWh', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issuePredicateAttestation(-) → ${r.status}: ${pretty(r.body)}`);
    const negRes = await pollJob(sessionId, r.body.jobId, 'prove-', { expect: 'fail' });
    if (!negRes.failed) fail('negative case did not fail');
    const negMsg = `${negRes.errorCode ?? ''} ${negRes.errorMessage ?? ''}`.trim();
    if (/timed out|stalled|sync/i.test(negMsg)) {
        // A dropped indexer subscription failed the job before it could reach
        // the predicate assert. That's infra flakiness, NOT a demonstration of
        // predicate enforcement. Don't count it as a pass.
        fail(`negative case failed on a SYNC issue, not a predicate rejection: ${negMsg} — re-run when the public indexer is healthy`);
    }
    console.log(`OK   negative proof rejected as expected (predicate false): ${negMsg}`);

    if (posId) {
        step('7. verifyPredicateAttestation (positive) — reported (needs crawler for SUCCESS)');
        r = await post('/verifyPredicateAttestation', { predicateAttestationId: posId });
        console.log(`     verify → ${pretty(r.body)}`);
        console.log('     (verified:true requires the crawler to have indexed the tx; informational here.)');
    }

    console.log('\nPREDICATE E2E PASSED.');
    console.log(`Contract:        ${contractAddress}`);
    console.log(`Mode:            ${MODE}`);
})();
