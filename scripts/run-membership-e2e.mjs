// Bytes equality + set membership end-to-end (v0.15.0 proveFieldEquality /
// proveFieldMembership).
//
// Walks: connectWallet → connectWalletForSigning (await prewarm sync) →
// deployContract(attestation-vault) → prepareDocumentProof over a MIXED
// document (two bytes fields + one numeric field) → anchorDocument →
// issueFieldEqualityAttestation (anchors the content root, proves
// chemistry == digest('NMC811')) → prepareMembershipSet (canonical set root
// + inclusion path, verifier lane cross-checked) → then:
//
//   POSITIVE  ONE mixed batch: numeric claim + membership claim (allowedValues
//             lane) + an exact duplicate of the equality claim (dropped
//             server-side). Expect: job SUCCEEDS, ONE txHash,
//             droppedDuplicates=1, and every claim kind independently
//             verified via crawler-free verifyPredicateState.
//   NEGATIVE  a) membership issue with a value NOT in the allow-list → 400
//             before any job. b) batch of one fresh TRUE numeric claim + a
//             membership claim whose set path belongs to a DIFFERENT list →
//             local proving failure ("value not in set"-class), atomic abort,
//             the true claim did NOT land on-chain.
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC.
// Run:  node --env-file=.env scripts/run-membership-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
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
const blake2b256Hex = (s) => bytesToHex(blake2b(Buffer.from(s, 'utf8'), { dkLen: 32 }));

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

    step('4. prepareDocumentProof (mixed uint + bytes fields)');
    const document = {
        chemistry: 'NMC811',
        origin: 'EEA',
        capacityKwh: 120,
        batch: `membership-e2e-${Date.now()}`
    };
    r = await post('/prepareDocumentProof', {
        documentJson: JSON.stringify(document),
        proofFieldsJson: JSON.stringify([
            { field: 'chemistry', kind: 'bytes' },
            { field: 'origin', kind: 'bytes' },
            { field: 'capacityKwh' }
        ])
    });
    if (r.status >= 400) fail(`prepareDocumentProof → ${r.status}: ${pretty(r.body)}`);
    const payloadHash = r.body.payloadHash;
    const contentRoot = r.body.contentRoot;
    const schemaId = r.body.schemaId;
    const fields = JSON.parse(r.body.fields);
    const pick = (name) => fields.find(f => f.field === name) || fail(`prepared field '${name}' missing`);
    const chem = pick('chemistry');
    const origin = pick('origin');
    const capacity = pick('capacityKwh');
    if (chem.kind !== 'bytes' || chem.valueDigest !== blake2b256Hex('NMC811')) {
        fail(`chemistry field not a bytes leaf with the expected digest: ${pretty(chem)}`);
    }
    if (capacity.kind !== 'uint' || capacity.value !== '120000') fail(`capacity field unexpected: ${pretty(capacity)}`);
    console.log(`OK   payloadHash = ${payloadHash.slice(0, 12)}…, contentRoot = ${contentRoot.slice(0, 12)}…`);

    step('5. anchorDocument (attest the payload so the session owns it)');
    r = await post('/anchorDocument', {
        sha256: payloadHash, storageRef: 'file:///tmp/membership-demo.json',
        metadata: '{"type":"membership-e2e"}', sessionId, contractAddress
    });
    if (r.status >= 400) fail(`anchorDocument → ${r.status}: ${pretty(r.body)}`);
    await pollJob(sessionId, r.body.jobId, 'attest');
    console.log('OK   payload attested');

    step('6. issueFieldEqualityAttestation (anchors root in-flow, proves chemistry == NMC811)');
    r = await post('/issueFieldEqualityAttestation', {
        payloadHash, fieldKey: chem.fieldKey,
        expectedValue: 'NMC811',
        fieldSalt: chem.salt,
        contentRoot, schemaId,
        siblingsJson: JSON.stringify(chem.siblings),
        dirsJson: JSON.stringify(chem.dirs),
        sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueFieldEqualityAttestation → ${r.status}: ${pretty(r.body)}`);
    const eqRes = await pollJob(sessionId, r.body.jobId, 'equality');
    if (eqRes?.claim?.expectedDigest !== chem.valueDigest) fail(`equality claim digest mismatch: ${pretty(eqRes)}`);
    console.log(`OK   equality proven in tx ${eqRes.proof.proofValue.slice(0, 16)}…`);

    step('7. Crawler-free verifyPredicateState (bytesEquality)');
    const eqVerify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash, fieldKey: chem.fieldKey,
        predicate: 'bytesEquality', expectedDigest: chem.valueDigest
    }), 'equality');
    if (eqVerify.proven !== true) fail(`equality: expected proven=true: ${pretty(eqVerify)}`);
    console.log('OK   equality claim verified from live state');

    step('8. prepareMembershipSet (canonical root + path; verifier lane cross-check)');
    const ALLOWED = ['EEA', 'CH', 'NO', 'UK'];
    r = await post('/prepareMembershipSet', { allowedValuesJson: JSON.stringify(ALLOWED), value: 'EEA' });
    if (r.status >= 400) fail(`prepareMembershipSet → ${r.status}: ${pretty(r.body)}`);
    const setRoot = r.body.setRoot;
    if (r.body.memberCount !== 4) fail(`expected memberCount=4: ${pretty(r.body)}`);
    const verifierLane = await post('/prepareMembershipSet', { allowedValuesJson: JSON.stringify([...ALLOWED].reverse()) });
    if (verifierLane.body?.setRoot !== setRoot) fail('canonical set root differs between permuted lists');
    console.log(`OK   setRoot = ${setRoot.slice(0, 16)}… (canonical across permutations)`);

    step('9. Mixed batch: numeric + membership + duplicate equality (dropped)');
    const batchClaims = [
        {   // numeric: capacity (120 kWh x1000) >= 100000
            fieldKey: capacity.fieldKey, value: capacity.value, salt: capacity.salt,
            siblings: capacity.siblings, dirs: capacity.dirs,
            predicate: 'greaterOrEqual', threshold: '100000', unit: 'mkWh'
        },
        {   // membership via the allowedValues lane (server builds root + path)
            fieldKey: origin.fieldKey, value: 'EEA', salt: origin.salt,
            allowedValues: ALLOWED,
            siblings: origin.siblings, dirs: origin.dirs,
            predicate: 'setMembership'
        },
        {   // exact duplicate of the step-6 equality claim: must be dropped
            fieldKey: chem.fieldKey, expectedDigest: chem.valueDigest, salt: chem.salt,
            siblings: chem.siblings, dirs: chem.dirs,
            predicate: 'bytesEquality'
        },
        {   // and the SAME equality claim again: proves per-kind dedup
            fieldKey: chem.fieldKey, expectedValue: 'NMC811', salt: chem.salt,
            siblings: chem.siblings, dirs: chem.dirs,
            predicate: 'bytesEquality'
        }
    ];
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash, claimsJson: JSON.stringify(batchClaims), sessionId, contractAddress
    });
    if (r.status >= 400) fail(`issueFieldPredicateAttestationBatch → ${r.status}: ${pretty(r.body)}`);
    if (r.body.droppedDuplicates !== 1) fail(`expected droppedDuplicates=1, got ${r.body.droppedDuplicates}`);
    const accepted = JSON.parse(r.body.claims);
    if (accepted.length !== 3) fail(`expected 3 accepted claims, got ${accepted.length}`);
    const batchRes = await pollJob(sessionId, r.body.jobId, 'batch+');
    const batchTx = batchRes?.proof?.proofValue;
    if (!batchTx) fail(`batch result has no proof.proofValue: ${pretty(batchRes)}`);
    console.log(`OK   ONE tx for numeric + membership + equality: ${batchTx.slice(0, 16)}…`);

    step('10. Per-claim crawler-free verification (all three kinds)');
    const numVerify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash, fieldKey: capacity.fieldKey,
        predicate: 'greaterOrEqual', threshold: 100000
    }), 'numeric');
    if (numVerify.proven !== true) fail(`numeric: expected proven=true: ${pretty(numVerify)}`);
    const memVerify = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash, fieldKey: origin.fieldKey,
        predicate: 'setMembership', setRoot
    }), 'membership');
    if (memVerify.proven !== true) fail(`membership: expected proven=true: ${pretty(memVerify)}`);
    console.log('OK   numeric + membership + (step 7) equality all verified from live state');

    step('11. NEGATIVE a: value outside the allow-list → 400, no job');
    r = await post('/issueFieldMembershipAttestation', {
        payloadHash, fieldKey: origin.fieldKey, value: 'US',
        fieldSalt: origin.salt,
        allowedValuesJson: JSON.stringify(ALLOWED),
        siblingsJson: JSON.stringify(origin.siblings),
        dirsJson: JSON.stringify(origin.dirs),
        sessionId, contractAddress
    });
    if (r.status !== 400) fail(`expected 400 for a non-member value, got ${r.status}: ${pretty(r.body)}`);
    console.log('OK   non-member rejected up-front (no proving budget spent)');

    step('12. NEGATIVE b: set path from a DIFFERENT list → local proving abort, atomic');
    const otherList = ['CH', 'NO'];
    const otherPath = await post('/prepareMembershipSet', { allowedValuesJson: JSON.stringify(otherList), value: 'CH' });
    if (otherPath.status >= 400) fail(`prepareMembershipSet(other) → ${otherPath.status}`);
    const freshNumeric = {
        fieldKey: capacity.fieldKey, value: capacity.value, salt: capacity.salt,
        siblings: capacity.siblings, dirs: capacity.dirs,
        predicate: 'greaterOrEqual', threshold: '50000', unit: 'mkWh' // fresh claim key
    };
    const wrongMembership = {
        fieldKey: origin.fieldKey, valueDigest: origin.valueDigest, salt: origin.salt, // digest('EEA')
        setRoot: otherPath.body.setRoot,                            // root over [CH, NO]
        setSiblings: JSON.parse(otherPath.body.setSiblingsJson),    // path of 'CH', not 'EEA'
        setDirs: JSON.parse(otherPath.body.setDirsJson),
        siblings: origin.siblings, dirs: origin.dirs,
        predicate: 'setMembership'
    };
    r = await post('/issueFieldPredicateAttestationBatch', {
        payloadHash, claimsJson: JSON.stringify([freshNumeric, wrongMembership]), sessionId, contractAddress
    });
    if (r.status >= 400) fail(`negative batch submit → ${r.status}: ${pretty(r.body)}`);
    const negRes = await pollJob(sessionId, r.body.jobId, 'batch-', { expect: 'fail' });
    if (!negRes.failed) fail('negative batch did not fail');
    const negMsg = `${negRes.errorCode ?? ''} ${negRes.errorMessage ?? ''}`.trim();
    if (/timed out|stalled|sync/i.test(negMsg)) {
        fail(`negative batch failed on a SYNC issue, not a membership rejection: ${negMsg} :: re-run when the public indexer is healthy`);
    }
    console.log(`OK   wrong-set membership rejected during local execution: ${negMsg}`);

    step('13. Atomicity: the fresh TRUE claim of the aborted batch must NOT be on-chain');
    const ghost = await pollVerify(fn('verifyPredicateState', {
        contractAddress, payloadHash, fieldKey: capacity.fieldKey,
        predicate: 'greaterOrEqual', threshold: 50000
    }), 'ghost-claim', { expectTrue: false });
    if (ghost.verified === true) fail('aborted batch leaked a claim on-chain (atomicity violated)');
    console.log('OK   nothing from the aborted batch reached the chain');

    console.log('\nMEMBERSHIP E2E PASSED.');
    console.log(`Contract:     ${contractAddress}`);
    console.log(`Equality tx:  ${eqRes.proof.proofValue}`);
    console.log(`Batch tx:     ${batchTx}`);
    console.log(`Payload:      ${payloadHash}`);
    console.log(`Set root:     ${setRoot}`);
})();
