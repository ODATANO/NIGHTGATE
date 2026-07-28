// Contract-path companion to run-wasm-proving-e2e.mjs: with the server under
// NIGHTGATE_PROVING_MODE=wasm, deploy the counter contract and call
// increment(). In wasm mode BOTH sides prove in-process: the contract
// circuit through srv/midnight/wasm-proof-provider.ts (zkir over the
// contract's local key material) and the wallet-side finalize through the
// facade's WASM prover; no proof server is contacted. Run the server with a
// dead NIGHTGATE_PROOF_SERVER_URL for the strongest form of the check.
//
// Server (separate terminal):
//   NIGHTGATE_PROVING_MODE=wasm NIGHTGATE_PROOF_SERVER_URL=http://127.0.0.1:9999 npm run dev
// Then:
//   node --env-file=.env scripts/run-wasm-contract-e2e.mjs
//   (or: npm run wasm-contract:e2e)
//
// Inputs (env vars): same as run-wasm-proving-e2e.mjs, plus
//   WASM_E2E_ARTIFACT        default 'counter'
//   WASM_E2E_CIRCUIT         default 'increment'

import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 30_000
}));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const ARTIFACT = process.env.WASM_E2E_ARTIFACT || 'counter';
const CIRCUIT = process.env.WASM_E2E_CIRCUIT || 'increment';
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK || !/^[0-9a-fA-F]{64}$/.test(VK)) fail('LACE_VIEWING_KEY (64 hex) is required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39 phrase) is required');

async function post(path, body, timeoutMs = 60 * 60 * 1000) {
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

async function pollJob(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== lastStatus) {
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
            fail(`[${label}] job ${jobId} failed: ${errorCode}: ${errorMessage}`);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

(async () => {
    step('Waiting for NIGHTGATE to be reachable');
    {
        const deadline = Date.now() + 30_000;
        let up = false;
        while (Date.now() < deadline && !up) {
            try {
                const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`);
                up = r.ok;
            } catch { /* retry */ }
            if (!up) await new Promise(r => setTimeout(r, 1000));
        }
        if (!up) fail(`Server at ${URL_BASE} did not respond within 30s`);
        console.log('OK   server up');
    }

    step('1. connectWallet + connectWalletForSigning (prewarm)');
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet → HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning → HTTP ${r.status}: ${pretty(r.body)}`);
    if (r.body?.prewarmJobId) await pollJob(sessionId, r.body.prewarmJobId, 'prewarm');
    console.log('OK   prewarm done');

    step(`2. deployContract(${ARTIFACT})`);
    const tDeploy = Date.now();
    r = await post('/deployContract', { compiledArtifactRef: ARTIFACT, sessionId, initialPrivateState: '{}' });
    if (r.status >= 400) fail(`deployContract → HTTP ${r.status}: ${pretty(r.body)}`);
    const deployResult = await pollJob(sessionId, r.body.jobId, 'deploy');
    const deploySecs = ((Date.now() - tDeploy) / 1000).toFixed(1);
    const contractAddress = deployResult?.contractAddress;
    if (!contractAddress) fail(`deploy succeeded but no contractAddress: ${pretty(deployResult)}`);
    console.log(`OK   deployed in ${deploySecs}s: ${contractAddress}`);
    console.log(`     txHash=${deployResult.txHash}`);

    step(`3. submitContractCall ${ARTIFACT}.${CIRCUIT}()`);
    const tCall = Date.now();
    r = await post('/submitContractCall', {
        contractAddress,
        circuit: CIRCUIT,
        compiledArtifactRef: ARTIFACT,
        sessionId,
        args: '[]'
    });
    if (r.status >= 400) fail(`submitContractCall → HTTP ${r.status}: ${pretty(r.body)}`);
    const callResult = await pollJob(sessionId, r.body.jobId, 'call');
    const callSecs = ((Date.now() - tCall) / 1000).toFixed(1);
    if (!callResult?.txHash) fail(`call succeeded but no txHash: ${pretty(callResult)}`);

    console.log(`\nPASS  contract=${contractAddress}`);
    console.log(`      deploy txHash=${deployResult.txHash} (${deploySecs}s)`);
    console.log(`      ${CIRCUIT}() txHash=${callResult.txHash} (${callSecs}s)`);
    console.log('\nCheck the server log for "proving mode: wasm" and');
    console.log('"contract proving: in-process (wasm)".');
})();
