// Live lane for the canonical anchor batch on a POPULATED vault:
// [attest, anchorContentRoot, bindPassport] in ONE transaction, both as a
// fresh bind and as a same-owner rebind (where bindPassport OVERWRITES an
// existing ledger cell).
//
// Two ledger behaviours meet here, and both need a populated vault to show up
// at all, which is why this runner prefills:
//   - expensive calls go LAST, since nothing behind them can be starved
//     (the 0.15.3 "cell update last" rule is this in its special case);
//   - the ledger's causality constraint: a call carrying a FALLIBLE
//     transcript must not be followed by one carrying a GUARANTEED
//     transcript, and which stage a call lands in is decided by its gas
//     cost, which grows with contract state. `attest` crosses over from
//     roughly the third attestation, which is why this runner prefills and
//     why the batch dies mid-series rather than immediately.
//
// The runner reports every job outcome verbatim; the DECISIVE evidence is the
// server's own stdout: the `[nightgate:batch-segments]` line carries each
// call's stage and gas budget (`attest=1158[f:6.04G]`), and the RPC-CORE line
// carries the node's real reject code. Run it against a server whose log you
// can read.
//
// Server (separate terminal): npm run dev
// Then:  npm run anchor-batch:e2e   (or REPRO_PREFILL=4 npm run anchor-batch:e2e)
//
// Inputs (env vars):
//   NIGHTGATE_URL       default http://localhost:4004
//   LACE_VIEWING_KEY    required (64 hex)
//   LACE_MNEMONIC       required (BIP39 phrase)
//   REPRO_VAULT         existing vault address; unset -> deploy a throwaway
//   REPRO_PREFILL       N anchor batches to populate a scratch vault first (default 0)
//   REPRO_VARIANT       bind-middle -> the known-failing order (see below)
//   E2E_PREWARM_TIMEOUT_MIN / E2E_JOB_POLL_INTERVAL_MS as in the other lanes

import { randomBytes } from 'node:crypto';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const PREFILL = parseInt(process.env.REPRO_PREFILL || '0', 10);
const PREWARM_TIMEOUT_MS = parseInt(process.env.E2E_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const JOB_POLL_MS = parseInt(process.env.E2E_JOB_POLL_INTERVAL_MS || '5000', 10);

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const hex32 = () => randomBytes(32).toString('hex');

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

async function pollJobTerminal(sessionId, jobId, label, { timeoutMs = PREWARM_TIMEOUT_MS, intervalMs = JOB_POLL_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    while (Date.now() < deadline) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        if (r.status !== 200) fail(`getJobStatus(${jobId}) → HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, chainStatus, result, errorCode, errorMessage } = r.body;
        if (status !== lastStatus) {
            process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`);
            lastStatus = status;
        } else {
            process.stdout.write('.');
        }
        if (status === 'succeeded' || status === 'failed') {
            process.stdout.write('\n');
            return {
                ok: status === 'succeeded' && chainStatus !== 'failure',
                status, chainStatus,
                result: result ? JSON.parse(result) : {},
                errorCode, errorMessage
            };
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function submitBatch(sessionId, vault, label, calls) {
    const r = await post('/submitContractCallBatch', {
        contractAddress: vault,
        calls: JSON.stringify(calls),
        compiledArtifactRef: 'attestation-vault',
        sessionId
    });
    if (r.status !== 200 && r.status !== 201) fail(`${label}: submitContractCallBatch → HTTP ${r.status}: ${pretty(r.body)}`);
    const res = await pollJobTerminal(sessionId, r.body.jobId, label);
    console.log(res.ok
        ? `OK   ${label}: SUCCESS tx=${String(res.result?.txHash ?? '').slice(0, 16)}…`
        : `>>   ${label}: FAILED ${res.errorCode ?? ''}: ${String(res.errorMessage ?? '').slice(0, 200)}`);
    return res;
}

async function submitSingle(sessionId, vault, label, circuit, args) {
    const r = await post('/submitContractCall', {
        contractAddress: vault,
        circuit,
        args: JSON.stringify(args),
        compiledArtifactRef: 'attestation-vault',
        sessionId
    });
    if (r.status !== 200 && r.status !== 201) fail(`${label}: submitContractCall → HTTP ${r.status}: ${pretty(r.body)}`);
    const res = await pollJobTerminal(sessionId, r.body.jobId, label);
    console.log(res.ok
        ? `OK   ${label}: SUCCESS tx=${String(res.result?.txHash ?? '').slice(0, 16)}…`
        : `>>   ${label}: FAILED ${res.errorCode ?? ''}: ${String(res.errorMessage ?? '').slice(0, 200)}`);
    return res;
}

// The batch defaults to [attest, anchorContentRoot, bindPassport]:
// dependency-valid (both bind and anchor only need attest) and it puts the
// costliest call of a rebind (the UPDATING bindPassport) last, where nothing
// behind it can be starved. REPRO_VARIANT=bind-middle restores the original
// order [attest, bindPassport, anchorContentRoot], which fails earlier because
// the update then has a call behind it.
const BIND_MIDDLE = process.env.REPRO_VARIANT === 'bind-middle';
const freshBindCalls = (pid) => {
    const h = hex32();
    const attest = { circuit: 'attest', args: [h, hex32()] };
    const bind = { circuit: 'bindPassport', args: [pid, h] };
    // schemaId is the third argument since 0.16.0 (roots are anchored together
    // with the schema they were built under).
    const anchor = { circuit: 'anchorContentRoot', args: [h, hex32(), hex32()] };
    return BIND_MIDDLE ? [attest, bind, anchor] : [attest, anchor, bind];
};

(async () => {
    step('Waiting for NIGHTGATE to be reachable');
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            const r = await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`);
            if (r.ok) { console.log('OK   server up'); break; }
        } catch { /* retry */ }
        if (Date.now() > deadline) fail(`Server at ${URL_BASE} did not respond within 30s`);
        await new Promise(res => setTimeout(res, 1000));
    }

    step('1. connect + prewarm');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet: ${pretty(r.body)}`);
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.body?.prewarmJobId) {
        const pw = await pollJobTerminal(sessionId, r.body.prewarmJobId, 'prewarm');
        if (!pw.ok) fail(`prewarm failed: ${pw.errorCode}: ${pw.errorMessage}`);
    }
    console.log(`OK   session ${sessionId}`);

    let vault = process.env.REPRO_VAULT || '';
    if (!vault) {
        step('2. deploy throwaway vault');
        r = await post('/deployContract', { compiledArtifactRef: 'attestation-vault', sessionId, initialPrivateState: '{}' });
        if (r.status !== 200 && r.status !== 201) fail(`deployContract → HTTP ${r.status}: ${pretty(r.body)}`);
        const dep = await pollJobTerminal(sessionId, r.body.jobId, 'deploy');
        if (!dep.ok) fail(`deploy failed: ${dep.errorCode}: ${dep.errorMessage}`);
        vault = dep.result?.contractAddress ?? '';
    }
    console.log(`OK   vault: ${vault}`);
    if (!vault) fail('no vault address');

    if (PREFILL > 0) {
        step(`3. prefill: ${PREFILL} fresh-bind batches to populate the vault`);
        for (let i = 0; i < PREFILL; i++) {
            const res = await submitBatch(sessionId, vault, `prefill ${i + 1}/${PREFILL}`, freshBindCalls(hex32()));
            if (!res.ok) fail(`prefill ${i + 1} failed; aborting`);
        }
    }

    const pid = hex32();
    step('4. batch A: fresh bind (attest+anchorContentRoot+bindPassport, new pid)');
    const a = await submitBatch(sessionId, vault, 'batch A (fresh bind)', freshBindCalls(pid));
    if (!a.ok) fail('fresh bind failed; vault or wallet unhealthy, aborting');

    step('5. batch B: SAME-OWNER REBIND (same pid, new hash) - the failing shape');
    const b = await submitBatch(sessionId, vault, 'batch B (rebind)', freshBindCalls(pid));

    if (!b.ok && process.env.REPRO_SKIP_CONTROLS !== '1') {
        step('6. controls');
        const h3 = hex32();
        const c1 = await submitSingle(sessionId, vault, 'control attest single', 'attest', [h3, hex32()]);
        if (c1.ok) {
            await submitSingle(sessionId, vault, 'control REBIND single (no batch)', 'bindPassport', [pid, h3]);
        }
        await submitBatch(sessionId, vault, 'control fresh-bind batch (new pid)', freshBindCalls(hex32()));
    }

    step('SUMMARY');
    console.log(`vault=${vault}`);
    console.log(`batch A (fresh bind): ${a.ok ? 'SUCCESS' : 'FAILED'}`);
    console.log(`batch B (rebind):     ${b.ok ? 'SUCCESS' : 'FAILED ' + (b.errorCode ?? '')}`);
    console.log('Now read the SERVER log: the RPC-CORE reject line for batch B carries the real Substrate code (1010 Custom error NNN vs 1014 priority).');
})();
