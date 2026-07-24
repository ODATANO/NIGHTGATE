// End-to-end deploy runner.
//
// Walks through: connectWallet → connectWalletForSigning → (await prewarm)
// → registerForDustGeneration (poll) → wait → deployContract (poll) against
// a running NIGHTGATE instance.
//
// Async-job model: registerForDustGeneration and deployContract
// return `{ jobId, status }` immediately. The actual result (txHash,
// registeredCount, contractAddress, ...) is fetched via getJobStatus polling.
// `pollJob` below handles that.
//
// Inputs (env vars):
//   NIGHTGATE_URL                  default http://localhost:4004
//   DEPLOY_E2E_ARTIFACT            default 'counter'; e.g. 'attestation-vault'
//                                  to exercise the 0.10.0 constructor (registrar)
//   LACE_VIEWING_KEY               required, Midnight Preprod viewing key from Lace
//   LACE_MNEMONIC                  required, BIP39 recovery phrase (12/24 words);
//                                  the server HD-derives per-role keys from it
//   DEPLOY_E2E_DUST_WAIT_SECONDS   default 90, how long to wait after registration
//   DEPLOY_E2E_SKIP_DUST_REG       set to 1 if DUST already registered in a prior run
//   E2E_PREWARM_TIMEOUT_MIN        default 240 (4h), cold sync upper bound
//   E2E_JOB_POLL_INTERVAL_MS       default 5000, getJobStatus poll cadence
//
// Run:
//   LACE_VIEWING_KEY="..." LACE_MNEMONIC="word1 word2 ..." node scripts/run-deploy-e2e.mjs

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

// Disable undici default headers/body timeouts. First-time facade sync from a
// fresh seed can take 15+ minutes (shielded chain scan from block 0). The
// default 5-minute headers timeout fires before the server can respond.
setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 30_000
}));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = process.env.LACE_MNEMONIC;
const DUST_WAIT_S = parseInt(process.env.DEPLOY_E2E_DUST_WAIT_SECONDS || '90', 10);
const SKIP_DUST = process.env.DEPLOY_E2E_SKIP_DUST_REG === '1';
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK) fail('LACE_VIEWING_KEY env var is required');

// The server now performs Midnight's per-role HD derivation from the mnemonic
// (see srv/utils/wallet-hd.ts), so we pass the BIP39 phrase straight through,
// no client-side seed truncation. Validate locally for a fast fail.
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC.trim())) {
    fail('LACE_MNEMONIC (a valid BIP39 phrase) is required');
}
const mnemonic = MNEMONIC.trim();

async function post(path, body, timeoutMs = 60 * 60 * 1000) {
    // First-time facade sync on a fresh seed can take MANY minutes (shielded
    // chain scan + dust scan from genesis). Override the default 5-min undici
    // headers timeout via a long AbortSignal.
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

/**
 * Poll `getJobStatus(jobId, sessionId)` until the job reaches `succeeded` or
 * `failed`. Returns the parsed `result` JSON on success; `fail()`s on failure
 * with the classified errorCode + errorMessage.
 *
 * `label` is shown in the progress line so the operator knows which job
 * (prewarm / dust-reg / deploy) the runner is currently waiting on.
 */
async function pollJob(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);

        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== lastStatus) {
            // Print on transition so the log shows pending → running → done.
            process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`);
            lastStatus = status;
        } else {
            process.stdout.write('.');
        }

        if (status === 'succeeded') {
            process.stdout.write('\n');
            return result ? JSON.parse(result) : {};
        }
        if (status === 'failed') {
            process.stdout.write('\n');
            fail(`[${label}] job ${jobId} failed: ${errorCode} — ${errorMessage}`);
        }

        await new Promise(r => setTimeout(r, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function waitForServer() {
    step('Waiting for NIGHTGATE to be reachable');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`);
            if (r.ok) {
                const body = await r.json();
                console.log(`OK   server up (mode=${body?.mode || 'unknown'})`);
                return;
            }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
    }
    fail(`Server at ${URL_BASE} did not respond within 30s`);
}

(async () => {
    await waitForServer();

    step('1. connectWallet (read-only session)');
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet → HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet returned no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning (mnemonic + kick off facade prewarm)');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic });
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning → HTTP ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   signing enabled: ${pretty(r.body)}`);

    // The session UPDATE is sync (signingEnabled=true above). The facade
    // pre-warm runs as a background job; wait for it before proceeding so
    // downstream actions don't pay the cold-sync cost on top of their own
    // (and so we can fail fast here if the prewarm itself errors).
    const prewarmJobId = r.body?.prewarmJobId;
    if (prewarmJobId) {
        step(`2b. Waiting for prewarm job ${prewarmJobId.slice(0, 8)} (cold sync can take hours on a fresh seed)`);
        await pollJob(sessionId, prewarmJobId, 'prewarm');
        console.log('OK   facade prewarm complete');
    } else {
        console.log('WARN no prewarmJobId returned — scheduling may have failed; first action will pay sync cost inline.');
    }

    if (!SKIP_DUST) {
        step('3. registerForDustGeneration (async job)');
        r = await post('/registerForDustGeneration', { sessionId, dustReceiverAddress: '' });
        if (r.status !== 200 && r.status !== 201) fail(`registerForDustGeneration → HTTP ${r.status}: ${pretty(r.body)}`);
        const regJobId = r.body?.jobId;
        if (!regJobId) fail(`registerForDustGeneration returned no jobId: ${pretty(r.body)}`);
        console.log(`OK   queued: ${pretty(r.body)}`);

        const regResult = await pollJob(sessionId, regJobId, 'dust-reg');
        console.log(`OK   result: ${pretty(regResult)}`);

        if (regResult.registeredCount > 0) {
            step(`4. Waiting ${DUST_WAIT_S}s for DUST to accrue (first generation is 1-2 min)`);
            for (let s = DUST_WAIT_S; s > 0; s -= 10) {
                process.stdout.write(`     ${s}s remaining...\r`);
                await new Promise(r => setTimeout(r, 10_000));
            }
            console.log('     done.                     ');
        } else {
            console.log('     no UTXOs needed registering; assuming DUST already accruing.');
        }
    }

    const artifact = process.env.DEPLOY_E2E_ARTIFACT || 'counter';
    step(`5. deployContract(${artifact}) (async job)`);
    r = await post('/deployContract', {
        compiledArtifactRef: artifact,
        sessionId,
        initialPrivateState: '{}'
    });
    if (r.status >= 400) {
        console.error(`FAIL deployContract → HTTP ${r.status}: ${pretty(r.body)}`);
        process.exit(2);
    }
    const deployJobId = r.body?.jobId;
    if (!deployJobId) fail(`deployContract returned no jobId: ${pretty(r.body)}`);
    console.log(`OK   queued: ${pretty(r.body)}`);

    const deployResult = await pollJob(sessionId, deployJobId, 'deploy');
    console.log(`OK   result: ${pretty(deployResult)}`);

    console.log('\nPASSED. Contract deployed.');
    console.log(`Submission ID:    ${deployResult.submissionId}`);
    console.log(`Tx hash:          ${deployResult.txHash}`);
    console.log(`Contract address: ${deployResult.contractAddress}`);
    console.log(`Lifecycle status: ${deployResult.status}`);
})();
