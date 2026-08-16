// Cross-root document proofs end-to-end (v0.16.0 proveDocumentComparison,
// mode 0 integrity / mode 1 diff).
//
// Walks: connectWallet → connectWalletForSigning (await prewarm sync) →
// deployContract(attestation-vault) → prepareDocumentProof for document v1
// AND a changed v2 (one value change + one dropped field) → anchorDocument
// for both → then:
//
//   POSITIVE  a) issueDocumentIntegrityAttestation with a mask covering
//             exactly the changed slots (anchors BOTH content roots in-flow),
//             verified crawler-free via verifyPredicateState.
//             b) issueDocumentDiffAttestation with k = actual difference
//             count, verified crawler-free.
//             c) ONE batch tx carrying a numeric claim on v1 + a documentDiff
//             claim (k=1) against v2: the proof-cart lane for the new kinds.
//   NEGATIVE  a) integrity with a mask that MISSES the dropped field → local
//             proving failure, nothing submitted, claim not on-chain.
//             b) diff with k = count+1 → local proving failure, claim not
//             on-chain.
//
// NOTE: proveDocumentComparison is the largest prover of the vault (~9.5 MB
// key since the transient-hash tree rework); it proves fine in wasm mode.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC.
// Run:  node --env-file=.env scripts/run-document-diff-e2e.mjs

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

// OData unbound-function call path. Numbers go unquoted, strings quoted.
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

async function pollVerify(p, label, { expectTrue = true, timeoutMs = READ_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = null;
    while (Date.now() < deadline) {
        const r = await get(p);
        if (r.status !== 200) fail(`GET ${p} → HTTP ${r.status}: ${pretty(r.body)}`);
        const tag = `verified=${r.body?.verified}`;
        if (tag !== lastSeen) { process.stdout.write(`\n     [${label}] ${tag}`); lastSeen = tag; }
        else process.stdout.write('.');
        if (r.body?.verified === true) {
            process.stdout.write('\n');
            if (!expectTrue) fail(`[${label}] expected verified=false but state says true`);
            return r.body;
        }
        if (!expectTrue) { process.stdout.write('\n'); return r.body; } // one read is enough for a negative
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

// Both documents MUST use the same ordered proofFields list: slot alignment
// is positional (part of the claim's semantics).
const PROOF_FIELDS = [
    { field: 'chemistry', kind: 'bytes' },
    { field: 'origin', kind: 'bytes' },
    { field: 'capacityKwh' }
];

async function prepare(document, label) {
    const r = await post('/prepareDocumentProof', {
        documentJson: JSON.stringify(document),
        proofFieldsJson: JSON.stringify(PROOF_FIELDS)
    });
    if (r.status >= 400) fail(`prepareDocumentProof(${label}) → ${r.status}: ${pretty(r.body)}`);
    return {
        payloadHash: r.body.payloadHash,
        contentRoot: r.body.contentRoot,
        schemaId: r.body.schemaId,
        schema: JSON.parse(r.body.schema),
        fields: JSON.parse(r.body.fields),
        leaves: JSON.parse(r.body.leaves),
        opening: JSON.parse(r.body.opening)
    };
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

    step('4. prepareDocumentProof for v1 and a changed v2 (same field order)');
    const stamp = `document-diff-e2e-${Date.now()}`;
    // v2: capacity changes (slot 2) and origin is DROPPED (slot 1 presence
    // change); chemistry (slot 0) stays identical.
    const docV1 = { chemistry: 'NMC811', origin: 'EEA', capacityKwh: 120, batch: stamp };
    const docV2 = { chemistry: 'NMC811', capacityKwh: 135, batch: stamp };
    const v1 = await prepare(docV1, 'v1');
    const v2 = await prepare(docV2, 'v2');
    if (v1.leaves.length !== 16 || v1.schema.length !== 16 || v1.opening.slots.length !== 16) fail('prepare(v1) did not export 16 leaves + schema + opening');
    if (!/^[0-9a-f]{64}$/.test(v1.schemaId || '')) fail(`prepare(v1) did not export a schemaId: ${pretty(v1.schemaId)}`);
    if (v1.schemaId !== v2.schemaId) fail('same proofFields list must yield the same schemaId for both versions');
    if (v1.leaves[1] === v2.leaves[1]) fail('slot 1 (origin dropped) should be leaf-different across versions');
    // v4 salted leaves: even identical values yield different leaf hashes across seeds.
    if (v1.leaves[0] === v2.leaves[0]) fail('salted leaves must differ across documents even for identical values');
    // Changed slots: 1 (presence) + 2 (value) -> mask 0b110 = 6, count 2.
    const ALLOWED_MASK = 6;
    const DIFF_COUNT = 2;
    console.log(`OK   v1 = ${v1.payloadHash.slice(0, 12)}…, v2 = ${v2.payloadHash.slice(0, 12)}…`);

    step('5. anchorDocument for BOTH versions (session owns both payloads)');
    for (const [doc, label] of [[v1, 'v1'], [v2, 'v2']]) {
        r = await post('/anchorDocument', {
            sha256: doc.payloadHash, storageRef: `file:///tmp/${stamp}-${label}.json`,
            metadata: `{"type":"document-diff-e2e","version":"${label}"}`, sessionId, contractAddress
        });
        if (r.status >= 400) fail(`anchorDocument(${label}) → ${r.status}: ${pretty(r.body)}`);
        await pollJob(sessionId, r.body.jobId, `attest-${label}`);
    }
    console.log('OK   both payloads attested');

    step('6. issueDocumentIntegrityAttestation (anchors both roots in-flow, mask covers the changes)');
    r = await post('/issueDocumentIntegrityAttestation', {
        payloadHashA: v1.payloadHash, payloadHashB: v2.payloadHash,
        allowedMask: ALLOWED_MASK,
        schemaJson: JSON.stringify(v1.schema), openingAJson: JSON.stringify(v1.opening), openingBJson: JSON.stringify(v2.opening),
        contentRootA: v1.contentRoot, contentRootB: v2.contentRoot, schemaId: v1.schemaId,
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueDocumentIntegrityAttestation → ${r.status}: ${pretty(r.body)}`);
    const integRes = await pollJob(sessionId, r.body.jobId, 'integrity');
    if (integRes?.claim?.allowedMask !== ALLOWED_MASK) fail(`integrity claim mask mismatch: ${pretty(integRes)}`);
    console.log(`OK   unchanged-except proven in tx ${integRes.proof.proofValue.slice(0, 16)}…`);

    step('7. Crawler-free verifyPredicateState (documentIntegrity)');
    const integVerify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash: v1.payloadHash, payloadHashB: v2.payloadHash,
        predicate: 'documentIntegrity', allowedMask: ALLOWED_MASK
    }), 'integrity');
    if (integVerify.proven !== true) fail(`integrity: expected proven=true: ${pretty(integVerify)}`);
    console.log('OK   integrity claim verified from live state');

    step('8. issueDocumentDiffAttestation (k = actual difference count; roots already anchored)');
    r = await post('/issueDocumentDiffAttestation', {
        payloadHashA: v1.payloadHash, payloadHashB: v2.payloadHash,
        k: DIFF_COUNT,
        schemaJson: JSON.stringify(v1.schema), openingAJson: JSON.stringify(v1.opening), openingBJson: JSON.stringify(v2.opening),
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueDocumentDiffAttestation → ${r.status}: ${pretty(r.body)}`);
    const diffRes = await pollJob(sessionId, r.body.jobId, 'diff');
    if (diffRes?.claim?.k !== DIFF_COUNT) fail(`diff claim k mismatch: ${pretty(diffRes)}`);
    console.log(`OK   ${DIFF_COUNT}-of-16 distinctness proven in tx ${diffRes.proof.proofValue.slice(0, 16)}…`);

    step('9. Crawler-free verifyPredicateState (documentDiff)');
    const diffVerify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash: v1.payloadHash, payloadHashB: v2.payloadHash,
        predicate: 'documentDiff', k: DIFF_COUNT
    }), 'diff');
    if (diffVerify.proven !== true) fail(`diff: expected proven=true: ${pretty(diffVerify)}`);
    console.log('OK   diff claim verified from live state');

    step('10. Batch lane: numeric claim on v1 + documentDiff (k=1) in ONE tx');
    const capacity = v1.fields.find(f => f.field === 'capacityKwh') || fail('capacityKwh field missing');
    const batchClaims = [
        {   // numeric: capacity (120 kWh x1000) >= 100000
            fieldKey: capacity.fieldKey, value: capacity.value, salt: capacity.salt,
            siblings: capacity.siblings, dirs: capacity.dirs,
            predicate: 'greaterOrEqual', threshold: '100000', unit: 'mkWh'
        },
        {   // fresh diff tuple (k=1 differs from step 8's k=2)
            predicate: 'documentDiff', payloadHashB: v2.payloadHash, k: 1,
            schema: v1.schema, openingA: v1.opening, openingB: v2.opening
        }
    ];
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash: v1.payloadHash, claimsJson: JSON.stringify(batchClaims), sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueFieldPredicateAttestationBatch → ${r.status}: ${pretty(r.body)}`);
    const batchRes = await pollJob(sessionId, r.body.jobId, 'batch+');
    const batchTx = batchRes?.proof?.proofValue;
    if (!batchTx) fail(`batch result has no proof.proofValue: ${pretty(batchRes)}`);
    const k1Verify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash: v1.payloadHash, payloadHashB: v2.payloadHash,
        predicate: 'documentDiff', k: 1
    }), 'batch-diff');
    if (k1Verify.proven !== true) fail(`batch diff: expected proven=true: ${pretty(k1Verify)}`);
    console.log(`OK   ONE tx for numeric + documentDiff: ${batchTx.slice(0, 16)}…`);

    step('11. NEGATIVE a: mask missing the dropped field → local proving abort');
    r = await post('/issueDocumentIntegrityAttestation', {
        payloadHashA: v1.payloadHash, payloadHashB: v2.payloadHash,
        allowedMask: 4, // covers only the capacity change, NOT the dropped origin
        schemaJson: JSON.stringify(v1.schema), openingAJson: JSON.stringify(v1.opening), openingBJson: JSON.stringify(v2.opening),
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`negative integrity submit → ${r.status}: ${pretty(r.body)}`);
    const negInteg = await pollJob(sessionId, r.body.jobId, 'integrity-', { expect: 'fail' });
    if (!negInteg.failed) fail('negative integrity did not fail');
    const negIntegMsg = `${negInteg.errorCode ?? ''} ${negInteg.errorMessage ?? ''}`.trim();
    if (/timed out|stalled|sync/i.test(negIntegMsg)) {
        fail(`negative integrity failed on a SYNC issue, not the mask: ${negIntegMsg} :: re-run when the public indexer is healthy`);
    }
    const ghostInteg = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash: v1.payloadHash, payloadHashB: v2.payloadHash,
        predicate: 'documentIntegrity', allowedMask: 4
    }), 'ghost-integrity', { expectTrue: false });
    if (ghostInteg.verified === true) fail('aborted integrity proof leaked a claim on-chain');
    console.log(`OK   presence change outside the mask rejected locally: ${negIntegMsg}`);

    step('12. NEGATIVE b: k above the actual count → local proving abort');
    r = await post('/issueDocumentDiffAttestation', {
        payloadHashA: v1.payloadHash, payloadHashB: v2.payloadHash,
        k: DIFF_COUNT + 1,
        schemaJson: JSON.stringify(v1.schema), openingAJson: JSON.stringify(v1.opening), openingBJson: JSON.stringify(v2.opening),
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`negative diff submit → ${r.status}: ${pretty(r.body)}`);
    const negDiff = await pollJob(sessionId, r.body.jobId, 'diff-', { expect: 'fail' });
    if (!negDiff.failed) fail('negative diff did not fail');
    const negDiffMsg = `${negDiff.errorCode ?? ''} ${negDiff.errorMessage ?? ''}`.trim();
    if (/timed out|stalled|sync/i.test(negDiffMsg)) {
        fail(`negative diff failed on a SYNC issue, not the count: ${negDiffMsg} :: re-run when the public indexer is healthy`);
    }
    const ghostDiff = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash: v1.payloadHash, payloadHashB: v2.payloadHash,
        predicate: 'documentDiff', k: DIFF_COUNT + 1
    }), 'ghost-diff', { expectTrue: false });
    if (ghostDiff.verified === true) fail('aborted diff proof leaked a claim on-chain');
    console.log(`OK   too-high k rejected locally: ${negDiffMsg}`);

    console.log('\nDOCUMENT DIFF E2E PASSED.');
    console.log(`Contract:      ${contractAddress}`);
    console.log(`Integrity tx:  ${integRes.proof.proofValue}`);
    console.log(`Diff tx:       ${diffRes.proof.proofValue}`);
    console.log(`Batch tx:      ${batchTx}`);
    console.log(`Payload v1:    ${v1.payloadHash}`);
    console.log(`Payload v2:    ${v2.payloadHash}`);
})();
