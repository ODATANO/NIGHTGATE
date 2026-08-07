// Agent-layer end-to-end (v0.14.0: AgentGrants + prepareDocumentProof +
// attestAgentOutput), the full model-A lane from the agent-access-layer FR.
//
// Operator lane (normal auth): connectWallet → connectWalletForSigning →
// deployContract(attestation-vault) → createAgentGrant (allowlist:
// anchorDocument, issueFieldPredicateAttestationBatch, attestAgentOutput;
// maxJobsPerDay=3).
//
// Agent lane (ONLY the x-agent-token header changes):
//   NEGATIVE  sendNight → 403 (never grantable)
//   NEGATIVE  issueFieldPredicateAttestation → 403 (not on the allowlist)
//   NEGATIVE  anchorDocument with a foreign sessionId → 403 (grant pinning),
//             and the request consumes NO budget
//   POSITIVE  prepareDocumentProof (always allowed, no budget) → payloadHash,
//             contentRoot, per-field proofs
//   POSITIVE  anchorDocument WITHOUT sessionId in the body (the grant injects
//             it) → job succeeds                                   [budget 1/3]
//   POSITIVE  issueFieldPredicateAttestationBatch: contentRoot in-batch + 2
//             claims from the prepared fields → ONE tx             [budget 2/3]
//   VERIFY    per-claim crawler-free verifyPredicateState → verified=true
//   POSITIVE  attestAgentOutput → envelope re-hashed locally (blake2b-256)
//             must equal payloadHash; verifyAttestationState=true [budget 3/3]
//   NEGATIVE  4th write action → 429 (daily budget exhausted, no job started)
//   REVOKE    operator revokes the grant → agent request → 401
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC.
// Run:  node --env-file=.env scripts/run-agent-layer-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { createHash, randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';

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

const blake2b256Hex = (s) => bytesToHex(blake2b(Buffer.from(s, 'utf8'), { dkLen: 32 }));

async function post(p, body, headers = {}, timeoutMs = 60 * 60 * 1000) {
    const r = await fetch(`${ENDPOINT}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

async function get(p, headers = {}) {
    const r = await fetch(`${ENDPOINT}${p}`, { headers, signal: AbortSignal.timeout(120_000) });
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

async function pollJob(sessionId, jobId, label, { headers = {}, timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId }, headers);
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed' || status === 'reconciliation_required') {
            process.stdout.write('\n');
            fail(`[${label}] job ${status}: ${errorCode} — ${errorMessage}`);
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function pollVerify(p, label, { headers = {}, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = null;
    while (Date.now() < deadline) {
        const r = await get(p, headers);
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

function expectStatus(r, want, label) {
    if (r.status !== want) fail(`${label}: expected HTTP ${want}, got ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   ${label} → ${want}`);
}

(async () => {
    await waitForServer();

    // ---- Operator lane -----------------------------------------------------

    step('1. connectWallet (operator)');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (+ await prewarm sync-to-tip)');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status >= 400) fail(`connectWalletForSigning → ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) { await pollJob(sessionId, r.body.prewarmJobId, 'prewarm'); console.log('OK   facade synced'); }

    step('3. deployContract(attestation-vault)');
    r = await post('/deployContract', { compiledArtifactRef: 'attestation-vault', sessionId, initialPrivateState: '{}' });
    if (r.status >= 400) fail(`deployContract → ${r.status}: ${pretty(r.body)}`);
    const contractAddress = (await pollJob(sessionId, r.body.jobId, 'deploy')).contractAddress;
    if (!contractAddress) fail('deploy returned no contractAddress');
    console.log(`OK   contractAddress = ${contractAddress}`);

    step('4. createAgentGrant (allowlist + budget 3/day)');
    r = await post('/createAgentGrant', {
        sessionId,
        allowedActions: ['anchorDocument', 'issueFieldPredicateAttestationBatch', 'attestAgentOutput'],
        maxJobsPerDay: 3,
        agentLabel: 'e2e-doc-bot'
    });
    if (r.status >= 400) fail(`createAgentGrant → ${r.status}: ${pretty(r.body)}`);
    const { grantId, token } = r.body;
    if (!grantId || !/^ngat_[0-9a-f]{64}$/.test(token ?? '')) fail(`unexpected grant response: ${pretty(r.body)}`);
    console.log(`OK   grantId = ${grantId}, token = ${token.slice(0, 12)}…`);

    const agent = { 'x-agent-token': token };

    // ---- Agent lane: negatives before any spend ----------------------------

    step('5. NEGATIVE: never-grantable + non-allowlisted + foreign session');
    expectStatus(await post('/sendNight', { sessionId, receiverAddress: 'x', amount: '1' }, agent),
        403, 'sendNight with agent token');
    expectStatus(await post('/issueFieldPredicateAttestation', { payloadHash: 'a'.repeat(64), sessionId }, agent),
        403, 'issueFieldPredicateAttestation (not allowlisted)');
    expectStatus(await post('/anchorDocument', {
        sha256: randomBytes(32).toString('hex'), storageRef: 'file:///tmp/x',
        sessionId: '00000000-0000-0000-0000-000000000001', contractAddress
    }, agent), 403, 'anchorDocument with foreign sessionId');

    // ---- Agent lane: the productive flow ------------------------------------

    step('6. prepareDocumentProof (agent, always allowed, no budget)');
    const CONTRACT_DOC = {
        contractId: 'supply-agreement-4711',
        supplier: 'ACME Batteries GmbH',
        contractValueEur: 250000,
        expiryDays: 240,
        warrantyYears: 8
    };
    const PROOF_FIELDS = [{ field: 'contractValueEur' }, { field: 'expiryDays' }];
    r = await post('/prepareDocumentProof', {
        documentJson: JSON.stringify(CONTRACT_DOC),
        proofFieldsJson: JSON.stringify(PROOF_FIELDS)
    }, agent);
    if (r.status >= 400) fail(`prepareDocumentProof → ${r.status}: ${pretty(r.body)}`);
    const { payloadHash, canonicalDocument, contentRoot } = r.body;
    const fields = JSON.parse(r.body.fields);
    if (blake2b256Hex(canonicalDocument) !== payloadHash) fail('payloadHash does not re-hash from canonicalDocument');
    if (fields.length !== 2) fail(`expected 2 prepared fields, got ${fields.length}`);
    console.log(`OK   payloadHash = ${payloadHash.slice(0, 12)}…, contentRoot = ${contentRoot.slice(0, 12)}…, re-hash matches`);

    step('7. anchorDocument (agent, sessionId INJECTED by the grant)  [budget 1/3]');
    r = await post('/anchorDocument', {
        sha256: payloadHash,
        storageRef: 'file:///tmp/agent-layer-e2e-contract.json',
        metadata: '{"type":"agent-layer-e2e"}',
        contractAddress
        // no sessionId on purpose: the grant must inject its own
    }, agent);
    if (r.status >= 400) fail(`anchorDocument(agent) → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'attest', { headers: agent });
    console.log('OK   contract document anchored by the agent');

    step('8. issueFieldPredicateAttestationBatch (agent): root in-batch + 2 claims  [budget 2/3]');
    // Claims over the PREPARED fields: value <= / >= thresholds in the SAME
    // x1000 scale prepareDocumentProof used.
    const claims = [
        { ...pick(fields, 'contractValueEur'), predicate: 'lessOrEqual', threshold: String(300000 * 1000), unit: 'EUR' },
        { ...pick(fields, 'expiryDays'), predicate: 'greaterOrEqual', threshold: String(180 * 1000), unit: 'days' }
    ];
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash, contentRoot,
        claimsJson: JSON.stringify(claims),
        contractAddress
        // again no sessionId: injected
    }, agent);
    if (r.status >= 400) fail(`issueFieldPredicateAttestationBatch(agent) → ${r.status}: ${pretty(r.body)}`);
    const batchRes = await pollJob(sessionId, r.body.jobId, 'batch', { headers: agent });
    const batchTx = batchRes?.proof?.proofValue;
    if (!batchTx) fail(`batch result has no txHash: ${pretty(batchRes)}`);
    console.log(`OK   ONE tx for root + 2 proofs: ${batchTx.slice(0, 16)}…`);

    step('9. Per-claim crawler-free verification (agent)');
    for (const c of claims) {
        const v = await pollVerify(fn('verifyPredicateState', {
            contractAddress, payloadHash,
            predicate: c.predicate, threshold: Number(c.threshold), fieldKey: c.fieldKey
        }), c.unit, { headers: agent });
        if (v.proven !== true) fail(`claim ${c.unit}: expected proven=true: ${pretty(v)}`);
    }
    console.log('OK   both claims verified from live state, content undisclosed');

    step('10. attestAgentOutput (agent)  [budget 3/3]');
    const outputHash = createHash('sha256').update('e2e agent report v1').digest('hex');
    r = await post('/attestAgentOutput', {
        agentId: 'agent://e2e-doc-bot',
        inputHash: payloadHash,
        outputHash,
        modelId: 'claude-fable-5',
        contractAddress
    }, agent);
    if (r.status >= 400) fail(`attestAgentOutput → ${r.status}: ${pretty(r.body)}`);
    const provPayloadHash = r.body.payloadHash;
    const envelopeJson = r.body.envelopeJson;
    if (blake2b256Hex(envelopeJson) !== provPayloadHash) fail('envelope does not re-hash to payloadHash');
    await pollJob(sessionId, r.body.jobId, 'provenance', { headers: agent });
    const prov = await pollVerify(fn('verifyAttestationState', {
        contractAddress, payloadHash: provPayloadHash
    }), 'provenance', { headers: agent });
    if (prov.attested !== true) fail(`provenance anchor not attested: ${pretty(prov)}`);
    console.log(`OK   provenance envelope anchored + third-party verifiable (${provPayloadHash.slice(0, 12)}…)`);

    step('11. NEGATIVE: 4th write action → 429 budget exhausted');
    r = await post('/anchorDocument', {
        sha256: randomBytes(32).toString('hex'), storageRef: 'file:///tmp/over-budget', contractAddress
    }, agent);
    expectStatus(r, 429, 'anchorDocument beyond maxJobsPerDay');

    step('12. revokeAgentGrant (operator) → agent gets 401');
    r = await post('/revokeAgentGrant', { grantId });
    if (r.status >= 400 || r.body?.revoked !== true) fail(`revokeAgentGrant → ${r.status}: ${pretty(r.body)}`);
    expectStatus(await get(fn('verifyAttestationState', { contractAddress, payloadHash }), agent),
        401, 'read with revoked token');

    console.log('\nAGENT-LAYER E2E PASSED.');
    console.log(`Contract:    ${contractAddress}`);
    console.log(`Document:    ${payloadHash}`);
    console.log(`Batch tx:    ${batchTx}`);
    console.log(`Provenance:  ${provPayloadHash}`);
})();

function pick(fields, name) {
    const f = fields.find(x => x.field === name);
    if (!f) fail(`prepared fields miss '${name}'`);
    return { fieldKey: f.fieldKey, value: f.value, siblings: f.siblings, dirs: f.dirs };
}
