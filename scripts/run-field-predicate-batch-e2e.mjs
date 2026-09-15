// Field-predicate BATCH end-to-end (issueFieldPredicateAttestationBatch).
//
// Walks: connectWallet → connectWalletForSigning (await prewarm sync) →
// deployContract(attestation-vault) → prepareDocumentProof (salted content
// tree built by the server with the artifact's pure circuits) → anchorDocument
// (attest the document's payload hash so the session owns the record) → then:
//
//   POSITIVE  ONE batch: contentRoot anchored IN-BATCH (call 0) + 3 field
//             claims (+1 exact duplicate that must be dropped server-side).
//             Expect: job SUCCEEDS, ONE txHash for everything,
//             droppedDuplicates=1, and every claim independently
//             verified=true via crawler-free verifyPredicateState.
//   NEGATIVE  second batch (root already anchored, no contentRoot): one TRUE
//             claim + one FALSE claim. Expect: job FAILS at local circuit
//             execution ("predicate false"-class error, NOT a sync issue) and
//             the accompanying TRUE claim did NOT land on-chain (atomic
//             abort, nothing submitted).
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC.
// Run:  node --env-file=.env scripts/run-field-predicate-batch-e2e.mjs

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
            if (expect === 'fail') { console.log(`     [${label}] failed as expected: ${errorCode} - ${errorMessage}`); return { failed: true, errorCode, errorMessage }; }
            fail(`[${label}] job failed: ${errorCode} - ${errorMessage}`);
        }
        if (status === 'reconciliation_required') {
            process.stdout.write('\n');
            if (expect === 'fail') { console.log(`     [${label}] reconciliation_required (terminal) - accepted as non-success: ${errorCode} - ${errorMessage}`); return { failed: true, reconciliation: true, errorCode, errorMessage }; }
            fail(`[${label}] job entered reconciliation_required: ${errorCode} - ${errorMessage}`);
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

// ---- Off-chain content-root tree ------------------------------------------
// Depth-4 tree, 16 leaves; unused leaves are a fixed empty leaf. Hashing goes
// through the contract's EXPORTED pureCircuits so the off-chain root is
// byte-identical to the in-circuit fold.

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

    step('4. prepareDocumentProof (three numeric fields, salted leaves)');
    const document = { carbonFootprint: 47.3, capacityKwh: 120, recycledPct: 0.85, batch: `field-batch-e2e-${Date.now()}` };
    r = await post('/prepareDocumentProof', {
        documentJson: JSON.stringify(document),
        proofFieldsJson: JSON.stringify([{ field: 'carbonFootprint' }, { field: 'capacityKwh' }, { field: 'recycledPct' }])
    });
    if (r.status >= 400) fail(`prepareDocumentProof → ${r.status}: ${pretty(r.body)}`);
    const payloadHash = r.body.payloadHash;
    const contentRoot = r.body.contentRoot;
    const schemaId = r.body.schemaId;
    const prepared = JSON.parse(r.body.fields);
    // value = scaled integer (x1000): 47300 / 120000 / 850
    const FIELDS = ['carbonFootprint', 'capacityKwh', 'recycledPct'].map(name =>
        prepared.find(f => f.field === name) || fail(`prepared field '${name}' missing`));
    if (FIELDS[0].value !== '47300' || FIELDS[1].value !== '120000' || FIELDS[2].value !== '850') fail(`unexpected scaled values: ${pretty(FIELDS)}`);
    console.log(`OK   payloadHash = ${payloadHash.slice(0, 12)}…, contentRoot = ${contentRoot.slice(0, 16)}…`);

    step(`5. anchorDocument → attest payload ${payloadHash.slice(0, 12)}…`);
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: 'file:///tmp/field-batch-demo.bin',
        metadata: '{"type":"field-predicate-batch-e2e"}', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument → ${r.status}: ${pretty(r.body)}`);
    const attesterId = r.body.attesterId;
    await pollJob(sessionId, r.body.jobId, 'attest');
    console.log(`OK   payload attested (attester ${String(attesterId).slice(0, 12)}…)`);

    const claimFor = (idx, predicate, threshold) => {
        const f = FIELDS[idx];
        return {
            fieldKey: f.fieldKey, value: f.value, salt: f.salt,
            siblings: f.siblings, dirs: f.dirs, predicate,
            threshold: String(threshold),
            unit: 'e2e-unit'
        };
    };
    const claims = [
        claimFor(0, 'lessOrEqual', 50000),
        claimFor(1, 'greaterOrEqual', 100000),
        claimFor(2, 'greaterOrEqual', 500),
        claimFor(0, 'lessOrEqual', 50000) // exact duplicate: must be dropped
    ];

    step('6. issueFieldPredicateAttestationBatch - POSITIVE (anchor in-batch + 3 claims + 1 dup)');
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash, contentRoot, schemaId,
        claimsJson: JSON.stringify(claims),
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueFieldPredicateAttestationBatch(+) → ${r.status}: ${pretty(r.body)}`);
    if (r.body.droppedDuplicates !== 1) fail(`expected droppedDuplicates=1, got ${r.body.droppedDuplicates}`);
    const respClaims = JSON.parse(r.body.claims);
    if (respClaims.length !== 3) fail(`expected 3 accepted claims, got ${respClaims.length}`);
    console.log(`OK   accepted 3 claims, dropped 1 duplicate; jobId=${r.body.jobId}`);

    const batchRes = await pollJob(sessionId, r.body.jobId, 'batch+');
    const txHash = batchRes?.proof?.proofValue;
    if (!txHash) fail(`batch result has no proof.proofValue txHash: ${pretty(batchRes)}`);
    if (!Array.isArray(batchRes.claims) || batchRes.claims.length !== 3) fail(`batch result claims malformed: ${pretty(batchRes)}`);
    console.log(`OK   ONE tx for anchor + 3 proofs: ${txHash.slice(0, 16)}…`);

    step('7. Per-claim crawler-free verification (verifyPredicateState)');
    for (const [i, c] of [[0, claims[0]], [1, claims[1]], [2, claims[2]]]) {
        const v = await pollVerify(fn('verifyPredicateState', {
            contractAddress, attesterId, payloadHash,
            predicate: c.predicate, threshold: Number(c.threshold), fieldKey: c.fieldKey
        }), `claim${i}`);
        if (v.proven !== true) fail(`claim${i}: expected proven=true: ${pretty(v)}`);
    }
    console.log('OK   all 3 claims independently verified from live state');

    step('8. issueFieldPredicateAttestationBatch - NEGATIVE (1 true + 1 FALSE claim → whole batch must abort)');
    const negClaims = [
        claimFor(1, 'lessOrEqual', 200000),  // true on its own (120000 <= 200000)
        claimFor(0, 'lessOrEqual', 100)      // FALSE (47300 <= 100)
    ];
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash, claimsJson: JSON.stringify(negClaims), sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueFieldPredicateAttestationBatch(-) → ${r.status}: ${pretty(r.body)}`);
    const negRes = await pollJob(sessionId, r.body.jobId, 'batch-', { expect: 'fail' });
    if (!negRes.failed) fail('negative batch did not fail');
    const negMsg = `${negRes.errorCode ?? ''} ${negRes.errorMessage ?? ''}`.trim();
    if (/timed out|stalled|sync/i.test(negMsg)) {
        fail(`negative batch failed on a SYNC issue, not a predicate rejection: ${negMsg} - re-run when the public indexer is healthy`);
    }
    console.log(`OK   negative batch rejected during local execution: ${negMsg}`);

    step('9. Atomicity: the TRUE claim of the aborted batch must NOT be on-chain');
    const ghost = await pollVerify(fn('verifyPredicateState', {
        contractAddress, attesterId, payloadHash,
        predicate: negClaims[0].predicate, threshold: Number(negClaims[0].threshold), fieldKey: negClaims[0].fieldKey
    }), 'ghost-claim', { expectTrue: false });
    if (ghost.verified === true) fail('aborted batch leaked a claim on-chain (atomicity violated)');
    console.log('OK   nothing from the aborted batch reached the chain');

    console.log('\nFIELD-PREDICATE BATCH E2E PASSED.');
    console.log(`Contract:   ${contractAddress}`);
    console.log(`Batch tx:   ${txHash}`);
    console.log(`Payload:    ${payloadHash}`);
})();
