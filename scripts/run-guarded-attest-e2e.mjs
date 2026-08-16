// Guarded attest (commit-reveal) end-to-end (v0.16.0 attestGuarded).
//
// Walks: connectWallet → connectWalletForSigning (await prewarm sync) →
// deployContract(attestation-vault) → prepareAnchorCommitment →
// commitDocumentAnchor (mode 0, opaque commitment on-chain) →
// anchorDocument WITH nonce (mode 1 reveal) → verifyDocument, then:
//
//   NEGATIVE  a) REPLAYING the identical reveal fails (commitment is
//             consumed on success; the replay must not run the takeover
//             branch against the revealer's own attestation).
//             b) a reveal without any matching commitment fails.
//   CONTROL   c) plain anchorDocument (no nonce) still works.
//
// The full sniper-takeover semantics (front-run + epoch move + grant/claim
// erasure) is chain-agnostically pinned against the real artifact in
// `integration:attestation-vault`; this lane proves the commit-reveal wire
// (server actions, worker, proving, node acceptance) live.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC.
// Run:  node --env-file=.env scripts/run-guarded-attest-e2e.mjs

import crypto from 'node:crypto';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);
const READ_TIMEOUT_MS = parseInt(process.env.E2E_READ_TIMEOUT_MIN || '10', 10) * 60_000;
const READ_POLL_MS = 5000;

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK) fail('LACE_VIEWING_KEY env var is required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39 phrase) is required');

async function post(p, body, timeoutMs = 60 * 60 * 1000) {
    const r = await fetch(`${ENDPOINT}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

async function get(p) {
    const r = await fetch(`${ENDPOINT}${p}`, { signal: AbortSignal.timeout(120_000) });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

function fn(name, params) {
    const parts = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v : `'${v}'`}`);
    return `/${name}(${parts.join(',')})`;
}

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
            if (expect === 'fail') { console.log(`     [${label}] failed as expected: ${errorCode} :: ${errorMessage}`); return { failed: true, errorCode, errorMessage }; }
            fail(`[${label}] job failed: ${errorCode} :: ${errorMessage}`);
        }
        if (status === 'reconciliation_required') {
            process.stdout.write('\n');
            if (expect === 'fail') { console.log(`     [${label}] reconciliation_required (terminal) :: accepted as non-success: ${errorCode} :: ${errorMessage}`); return { failed: true, reconciliation: true, errorCode, errorMessage }; }
            fail(`[${label}] job entered reconciliation_required: ${errorCode} :: ${errorMessage}`);
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function pollVerify(p, label, { timeoutMs = READ_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = null;
    while (Date.now() < deadline) {
        const r = await get(p);
        if (r.status !== 200) fail(`GET ${p} → HTTP ${r.status}: ${pretty(r.body)}`);
        const tag = `verified=${r.body?.verified}`;
        if (tag !== lastSeen) { process.stdout.write(`\n     [${label}] ${tag}`); lastSeen = tag; }
        else process.stdout.write('.');
        if (r.body?.verified === true) { process.stdout.write('\n'); return r.body; }
        await new Promise(res => setTimeout(res, READ_POLL_MS));
    }
    fail(`[${label}] did not reach verified=true within ${timeoutMs / 1000}s`);
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

    const stamp = `guarded-attest-e2e-${Date.now()}`;
    const payloadHash = crypto.createHash('sha256').update(`${stamp}-guarded`).digest('hex');
    const metadata = `{"type":"guarded-attest-e2e","stamp":"${stamp}"}`;

    step('4. prepareAnchorCommitment (compute-only; nonce stays secret until reveal)');
    r = await post('/prepareAnchorCommitment', { sha256: payloadHash, metadata });
    if (r.status >= 400) fail(`prepareAnchorCommitment → ${r.status}: ${pretty(r.body)}`);
    const { commitment, nonce, metadataHash } = r.body;
    if (!/^[0-9a-f]{64}$/.test(commitment || '') || !/^[0-9a-f]{64}$/.test(nonce || '')) {
        fail(`prepareAnchorCommitment returned malformed commitment/nonce: ${pretty(r.body)}`);
    }
    console.log(`OK   commitment = ${commitment.slice(0, 16)}…, metadataHash = ${metadataHash.slice(0, 16)}…`);

    step('5. commitDocumentAnchor (attestGuarded mode 0: opaque commitment on-chain)');
    r = await post('/commitDocumentAnchor', { commitment, sessionId, contractAddress });
    if (r.status >= 400) fail(`commitDocumentAnchor → ${r.status}: ${pretty(r.body)}`);
    const commitRes = await pollJob(sessionId, r.body.jobId, 'commit');
    console.log(`OK   commitment recorded in tx ${String(commitRes.txHash).slice(0, 16)}…`);

    step('6. anchorDocument WITH nonce (attestGuarded mode 1: reveal)');
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: `file:///tmp/${stamp}.json`,
        metadata, sessionId, contractAddress, nonce
    });
    if (r.status >= 400) fail(`anchorDocument(reveal) → ${r.status}: ${pretty(r.body)}`);
    const revealDocumentId = r.body.documentId;
    const revealRes = await pollJob(sessionId, r.body.jobId, 'reveal');
    console.log(`OK   revealed + attested in tx ${String(revealRes.txHash).slice(0, 16)}…`);

    step('7. verifyDocument (crawler-free, recorded vault/artifact/network binding)');
    const verify = await pollVerify(fn('verifyDocument', { documentId: revealDocumentId, providedSha256: payloadHash }), 'verify');
    console.log(`OK   verified=true (anchoredTxHash ${String(verify.anchoredTxHash).slice(0, 16)}…)`);

    step('8. NEGATIVE: replaying the identical reveal must fail (commitment consumed)');
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: `file:///tmp/${stamp}-replay.json`,
        metadata, sessionId, contractAddress, nonce
    });
    if (r.status >= 400) fail(`anchorDocument(replay) request itself rejected (${r.status}); expected an async job failure: ${pretty(r.body)}`);
    const replay = await pollJob(sessionId, r.body.jobId, 'replay', { expect: 'fail' });
    if (!/no matching commitment/i.test(String(replay.errorMessage))) {
        console.log(`WARN replay failed with a different message than expected: ${replay.errorCode} :: ${replay.errorMessage}`);
    }
    console.log('OK   reveal replay rejected; insert-once holds');

    step('9. NEGATIVE: reveal without any matching commitment must fail');
    const payload2 = crypto.createHash('sha256').update(`${stamp}-uncommitted`).digest('hex');
    const bogusNonce = crypto.randomBytes(32).toString('hex');
    r = await post('/anchorDocument', {
        sha256: payload2, storageRef: `file:///tmp/${stamp}-nocommit.json`,
        metadata, sessionId, contractAddress, nonce: bogusNonce
    });
    if (r.status >= 400) fail(`anchorDocument(no-commit) request itself rejected (${r.status}): ${pretty(r.body)}`);
    const noCommit = await pollJob(sessionId, r.body.jobId, 'no-commit', { expect: 'fail' });
    if (!/no matching commitment/i.test(String(noCommit.errorMessage))) {
        console.log(`WARN no-commit reveal failed with a different message than expected: ${noCommit.errorCode} :: ${noCommit.errorMessage}`);
    }
    console.log('OK   commitment-less reveal rejected');

    step('10. CONTROL: plain anchorDocument (no nonce) still works');
    const payload3 = crypto.createHash('sha256').update(`${stamp}-plain`).digest('hex');
    r = await post('/anchorDocument', {
        sha256: payload3, storageRef: `file:///tmp/${stamp}-plain.json`,
        metadata, sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument(plain) → ${r.status}: ${pretty(r.body)}`);
    const plainRes = await pollJob(sessionId, r.body.jobId, 'plain');
    console.log(`OK   plain attest in tx ${String(plainRes.txHash).slice(0, 16)}…`);

    console.log(`\nALL GUARDED-ATTEST CHECKS PASSED`);
    console.log(`vaultAddress=${contractAddress}`);
    process.exit(0);
})().catch(err => fail(String(err?.stack || err)));
