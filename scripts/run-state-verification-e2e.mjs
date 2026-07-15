// Crawler-free state-verification end-to-end.
//
// Proves every crawler-free surface confirms the on-chain EFFECT of a
// wallet-style direct submit, WITHOUT relying on the block crawler:
//   connectWallet → connectWalletForSigning (await prewarm) →
//   deployContract(attestation-vault) →
//   registerGranteeIdentity →
//   anchorDocument (attest payload) →
//   verifyAttestationState        (#2: poll until verified=true from live state) →
//   verifyDocument (+contractAddress)  (#3: state fallback, verified=true) →
//   issuePredicateAttestation → verifyPredicateAttestation (#3: state fallback) →
//   grantDisclosure → reindexDisclosures (#1) → GET DisclosureGrants active=true →
//   revokeDisclosure → reindexDisclosures (#1) → GET DisclosureGrants active=false
//
// To truly prove crawler-independence, run the server with the crawler disabled
// (cds.requires.nightgate.crawler.enabled: false); then the ONLY thing that can
// promote these reads to verified/active is queryContractState against live
// contract state. The script still passes with the crawler on (the state path is
// independent), but the point is that it needs no crawler and no local txHash.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004), LACE_VIEWING_KEY,
// LACE_MNEMONIC. Optional: STATE_CONTRACT_ADDRESS (reuse a deployed vault). Run:
//   node --env-file=.env scripts/run-state-verification-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { randomBytes } from 'node:crypto';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const REUSE_CONTRACT = (process.env.STATE_CONTRACT_ADDRESS || '').trim();
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);
// How long to wait for the indexer state to reflect a just-submitted effect.
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

// Format an unbound OData v4 function call: strings single-quoted, GUIDs bare.
function fn(name, params) {
    const parts = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v.guid ? v.value : `'${v}'`}`);
    return `/${name}(${parts.join(',')})`;
}
const guid = (v) => ({ guid: true, value: v });

async function pollJob(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed') { process.stdout.write('\n'); fail(`[${label}] job failed: ${errorCode} — ${errorMessage}`); }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

// Poll a crawler-free verify function until its `verified` flag flips true.
async function pollVerify(path, label) {
    const deadline = Date.now() + READ_TIMEOUT_MS;
    let lastSeen = null;
    while (Date.now() < deadline) {
        const r = await get(path);
        if (r.status !== 200) fail(`GET ${path} → HTTP ${r.status}: ${pretty(r.body)}`);
        const tag = `verified=${r.body?.verified}`;
        if (tag !== lastSeen) { process.stdout.write(`\n     [${label}] ${tag}`); lastSeen = tag; }
        else process.stdout.write('.');
        if (r.body?.verified === true) { process.stdout.write('\n'); return r.body; }
        await new Promise(res => setTimeout(res, READ_POLL_MS));
    }
    fail(`[${label}] did not reach verified=true within ${READ_TIMEOUT_MS / 1000}s`);
}

// Reindex from live state, then read the grant row until a predicate holds.
async function reindexAndPollGrant(contractAddress, grantee, label, predicate) {
    const filter = encodeURIComponent(`contractAddress eq '${contractAddress.toLowerCase()}' and grantee eq '${grantee}'`);
    const deadline = Date.now() + READ_TIMEOUT_MS;
    let lastSeen = null;
    while (Date.now() < deadline) {
        // Crawler-free reconcile from live contract state, THEN read.
        const rr = await post('/reindexDisclosures', { contractAddress });
        if (rr.status !== 200) fail(`reindexDisclosures → HTTP ${rr.status}: ${pretty(rr.body)}`);
        const r = await get(`/DisclosureGrants?$filter=${filter}`);
        if (r.status !== 200) fail(`GET DisclosureGrants → HTTP ${r.status}: ${pretty(r.body)}`);
        const row = (r.body?.value || [])[0] || null;
        const tag = `active=${row?.active} (reindex active=${rr.body?.active})`;
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
    if (r.body?.prewarmJobId) { await pollJob(sessionId, r.body.prewarmJobId, 'prewarm'); console.log('OK   facade synced'); }
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

    step('4. registerGranteeIdentity — bind principal → granteeId');
    r = await post('/registerGranteeIdentity', { bindingInput: randomBytes(32).toString('hex'), scope: contractAddress });
    if (r.status >= 400) fail(`registerGranteeIdentity → ${r.status}: ${pretty(r.body)}`);
    const grantee = r.body?.granteeId;
    if (!grantee || !/^[0-9a-f]{64}$/.test(grantee)) fail(`no granteeId: ${pretty(r.body)}`);
    console.log(`OK   granteeId = ${grantee}`);

    const payloadHash = randomBytes(32).toString('hex');
    step(`5. anchorDocument → attest payload ${payloadHash.slice(0, 12)}…`);
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: 'file:///tmp/state-verify-demo.bin',
        metadata: '{"type":"state-verification-demo"}', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument → ${r.status}: ${pretty(r.body)}`);
    const documentId = r.body?.documentId;
    if (!documentId) fail(`anchorDocument returned no documentId: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'attest');
    console.log(`OK   payload attested (documentId=${documentId})`);

    step('6. verifyAttestationState — crawler-free (#2), poll until verified=true');
    const av = await pollVerify(fn('verifyAttestationState', { contractAddress, payloadHash }), 'verifyAttestationState');
    if (av.attested !== true) fail(`expected attested=true: ${pretty(av)}`);
    console.log(`OK   attestation confirmed from live state (attesterId=${(av.attesterId || '').slice(0, 12)}…)`);

    step('7. verifyDocument with contractAddress — crawler-free fallback (#3)');
    const vd = await pollVerify(
        fn('verifyDocument', { documentId: guid(documentId), providedSha256: payloadHash, contractAddress }),
        'verifyDocument');
    console.log(`OK   document verified via state fallback (anchoredTxHash=${(vd.anchoredTxHash || '').slice(0, 10)}…)`);

    step('8. issuePredicateAttestation (value=5 <= threshold=10)');
    r = await post('/issuePredicateAttestation', {
        payloadHash, value: '5', predicate: 'lessOrEqual', threshold: 10,
        unit: 'demo', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issuePredicateAttestation → ${r.status}: ${pretty(r.body)}`);
    const predicateAttestationId = r.body?.predicateAttestationId;
    if (!predicateAttestationId) fail(`no predicateAttestationId: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'predicate');
    console.log(`OK   predicate proven on-chain (predicateAttestationId=${predicateAttestationId})`);

    step('9. verifyPredicateAttestation — crawler-free fallback (#3)');
    await pollVerify(fn('verifyPredicateAttestation', { predicateAttestationId: guid(predicateAttestationId) }),
        'verifyPredicateAttestation');
    console.log('OK   predicate result confirmed from live state');

    step('10. grantDisclosure(level=1) → reindexDisclosures (#1) → active=true');
    r = await post('/grantDisclosure', { payloadHash, grantee, level: 1, sessionId, contractAddress });
    if (r.status >= 400) fail(`grantDisclosure → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'grant');
    const grantedRow = await reindexAndPollGrant(contractAddress, grantee, 'reindex+', row => row && row.active === true);
    if (grantedRow.level !== 1) fail(`expected level=1, got ${grantedRow.level}`);
    console.log('OK   grant reconciled from live state: active=true');

    step('11. revokeDisclosure → reindexDisclosures (#1) → active=false');
    r = await post('/revokeDisclosure', { payloadHash, grantee, sessionId, contractAddress });
    if (r.status >= 400) fail(`revokeDisclosure → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'revoke');
    await reindexAndPollGrant(contractAddress, grantee, 'reindex-', row => row && row.active === false);
    console.log('OK   revoke reconciled from live state: active=false');

    console.log('\nSTATE-VERIFICATION E2E PASSED (crawler-free).');
    console.log(`Contract:  ${contractAddress}`);
    console.log(`Grantee:   ${grantee}`);
    console.log(`Payload:   ${payloadHash}`);
    console.log('\nNote: run with cds.requires.nightgate.crawler.enabled=false for a true');
    console.log('criterion-6 check — every confirmation above came from queryContractState,');
    console.log('not from a locally-indexed txHash.');
})();
