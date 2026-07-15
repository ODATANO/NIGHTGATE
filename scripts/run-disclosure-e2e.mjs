// Disclosure-grants end-to-end.
//
// Walks the full on-chain entitlement lifecycle against a LIVE deployed
// AttestationVault, exercising every disclosure-grants surface:
//   connectWallet → connectWalletForSigning (await prewarm) →
//   deployContract(attestation-vault) →
//   registerGranteeIdentity        (principal → granteeId) →
//   anchorDocument (attest a payload so it has an on-chain owner) →
//   grantDisclosure(level=1)       (write) →
//   GET DisclosureGrants           (read: poll until active=true) →
//   revokeDisclosure               (write) →
//   GET DisclosureGrants           (read: poll until active=false)
//
// Why this is the meaningful live check: the gate itself (attachDisclosureRole
// with contractAddress) is what a CONSUMER wires into a specific read, so the
// allowed/403 assertion lives in the consumer (NIGHTPASS) and is covered at
// unit level here (test/unit/disclosure-role.test.ts → "on-chain ACL"). What
// only a live run can prove is the READ-BACK path: that the post-submit
// reindex's publicDataProvider.queryContractState(addr) feeds ledger() and the
// non-iterable-outer-map enumeration the SAME way the in-process spike showed
// (scripts/spike-disclosure-indexer.mjs). When `active` flips to true after the
// grant and false after the revoke, that path is confirmed against the chain.
//
// We tie the on-chain grantee to the registered identity by granting to the
// EXACT granteeId that registerGranteeIdentity returns (the server's
// deriveGranteeId is deterministic), so write-side and read-side ids match
// regardless of the configured binding kind.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004), LACE_VIEWING_KEY,
// LACE_MNEMONIC. Optional: DISCLOSURE_CONTRACT_ADDRESS (reuse an already
// deployed vault and skip the deploy step). Run:
//   node --env-file=.env scripts/run-disclosure-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { randomBytes } from 'node:crypto';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const REUSE_CONTRACT = (process.env.DISCLOSURE_CONTRACT_ADDRESS || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);
// How long to wait for the indexer to reflect a grant/revoke in DisclosureGrants.
const READ_TIMEOUT_MS = parseInt(process.env.E2E_READ_TIMEOUT_MIN || '10', 10) * 60_000;
const READ_POLL_MS = parseInt(process.env.E2E_READ_POLL_INTERVAL_MS || '5000', 10);

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

async function get(path, timeoutMs = 60_000) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

// Poll a background job to completion.
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
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

// Poll the DisclosureGrants OData read until a predicate holds (or timeout).
async function pollGrantRow(contractAddress, grantee, label, predicate) {
    const filter = encodeURIComponent(`contractAddress eq '${contractAddress}' and grantee eq '${grantee}'`);
    const deadline = Date.now() + READ_TIMEOUT_MS;
    let lastSeen = null;
    while (Date.now() < deadline) {
        const r = await get(`/DisclosureGrants?$filter=${filter}`);
        if (r.status !== 200) fail(`GET DisclosureGrants → HTTP ${r.status}: ${pretty(r.body)}`);
        const row = (r.body?.value || [])[0] || null;
        const tag = row ? `active=${row.active} level=${row.level} tx=${(row.grantedTxHash || '').slice(0, 8)}` : 'no-row';
        if (tag !== lastSeen) { process.stdout.write(`\n     [${label}] ${tag}`); lastSeen = tag; }
        else process.stdout.write('.');
        if (predicate(row)) { process.stdout.write('\n'); return row; }
        await new Promise(res => setTimeout(res, READ_POLL_MS));
    }
    fail(`[${label}] DisclosureGrants did not reach expected state within ${READ_TIMEOUT_MS / 1000}s`);
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

    let contractAddress = REUSE_CONTRACT;
    if (contractAddress) {
        console.log(`\n--- 3. (reusing AttestationVault ${contractAddress}) ---`);
    } else {
        step('3. deployContract(attestation-vault)');
        r = await post('/deployContract', { compiledArtifactRef: 'attestation-vault', sessionId, initialPrivateState: '{}' });
        if (r.status >= 400) fail(`deployContract → ${r.status}: ${pretty(r.body)}`);
        const deployRes = await pollJob(sessionId, r.body.jobId, 'deploy');
        contractAddress = deployRes.contractAddress;
        if (!contractAddress) fail(`deploy returned no contractAddress: ${pretty(deployRes)}`);
        console.log(`OK   contractAddress = ${contractAddress}`);
    }

    step('4. registerGranteeIdentity (Phase 0) — bind a principal → granteeId');
    // bindingInput is hex so it is valid under the default 'wallet' binding;
    // we grant to whatever granteeId the server derives, tying write↔read.
    const bindingInput = randomBytes(32).toString('hex');
    r = await post('/registerGranteeIdentity', { bindingInput, scope: contractAddress });
    if (r.status >= 400) fail(`registerGranteeIdentity → ${r.status}: ${pretty(r.body)}`);
    const grantee = r.body?.granteeId;
    if (!grantee || !/^[0-9a-f]{64}$/.test(grantee)) fail(`registerGranteeIdentity returned no granteeId: ${pretty(r.body)}`);
    console.log(`OK   granteeId = ${grantee} (binding=${r.body.bindingKind})`);

    const payloadHash = randomBytes(32).toString('hex');
    step(`5. anchorDocument → attest payload ${payloadHash.slice(0, 12)}… (on-chain owner for grant)`);
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: 'file:///tmp/disclosure-demo.bin',
        metadata: '{"type":"battery-passport-demo"}', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'attest');
    console.log('OK   payload attested');

    step('6. grantDisclosure(level=1 / legitimate-interest)');
    r = await post('/grantDisclosure', { payloadHash, grantee, level: 1, sessionId, contractAddress });
    if (r.status >= 400) fail(`grantDisclosure → ${r.status}: ${pretty(r.body)}`);
    const grantRes = await pollJob(sessionId, r.body.jobId, 'grant');
    console.log(`OK   grant tx accepted on-chain: ${grantRes.txHash}`);

    step('7. GET DisclosureGrants — poll until chain-confirmed active=true (validates live ledger read-back)');
    const grantedRow = await pollGrantRow(contractAddress, grantee, 'read+', row => row && row.active === true);
    if (grantedRow.level !== 1) fail(`expected level=1, got ${grantedRow.level}`);
    if (!grantedRow.grantedTxHash) fail('grantedTxHash not recorded on the indexed row');
    console.log(`OK   on-chain grant indexed: active=true level=${grantedRow.level}`);

    step('8. revokeDisclosure');
    r = await post('/revokeDisclosure', { payloadHash, grantee, sessionId, contractAddress });
    if (r.status >= 400) fail(`revokeDisclosure → ${r.status}: ${pretty(r.body)}`);
    const revokeRes = await pollJob(sessionId, r.body.jobId, 'revoke');
    console.log(`OK   revoke tx accepted on-chain: ${revokeRes.txHash}`);

    step('9. GET DisclosureGrants — poll until active=false (revoke reflected)');
    await pollGrantRow(contractAddress, grantee, 'read-', row => row && row.active === false);
    console.log('OK   grant deactivated after revoke');

    console.log('\nDISCLOSURE E2E PASSED.');
    console.log(`Contract:  ${contractAddress}`);
    console.log(`Grantee:   ${grantee}`);
    console.log(`Payload:   ${payloadHash}`);
    console.log('\nNote: the read GATE (attachDisclosureRole) is consumer-wired; its');
    console.log('allowed/403 behavior is covered in test/unit/disclosure-role.test.ts.');
})();
