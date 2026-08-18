// Live probe for the cross-server-fee-sponsoring prototype
// (docs/feature-requests/cross-server-fee-sponsoring.md).
//
// Proves the load-bearing unknown: a CALLER builds + signs + finalizes a
// contract call (phase 1), the fee-unpaid FinalizedTransaction survives a
// serialize -> deserialize round-trip, and a SEPARATE SPONSOR session balances
// dust onto it and submits (phase 2). Same worker here; a green run means the
// two phases can later be split across machines with only transport in between.
//
// Roles:
//   - sponsor: your funded, dust-registered wallet (LACE_* in .env). Pays dust.
//   - caller:  a FRESH throwaway wallet generated here. Holds nothing; the
//     attestation is bound to ITS attester id (that is the whole point:
//     the caller proves under its own identity, the sponsor only pays).
//
// Server (separate terminal): npm run dev   (with NIGHTGATE_SPONSORED_CALLER_SYNC=skip)
// Then:  NIGHTGATE_VAULT=<attestation-vault addr> node --env-file=.env scripts/run-cross-server-sponsor-probe-e2e.mjs
//
// If NIGHTGATE_VAULT is unset, the sponsor deploys a throwaway vault first.

import { randomBytes } from 'node:crypto';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const POLL_MS = 5000;
const hex = (n) => randomBytes(n).toString('hex');

function fail(m) { console.error(`\nFAIL ${m}`); process.exit(1); }
function step(n) { console.log(`\n--- ${n} ---`); }
if (!VK || !/^[0-9a-fA-F]{64}$/.test(VK)) fail('LACE_VIEWING_KEY (64 hex) required (the sponsor wallet)');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid phrase) required (the sponsor wallet)');

async function post(path, body, timeoutMs = 60 * 60 * 1000) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, body: j };
}
async function poll(sessionId, jobId, label) {
    for (;;) {
        const r = await post('/getJobStatus', { jobId, sessionId });
        const { status, result, errorCode, errorMessage } = r.body ?? {};
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed' || status === 'reconciliation_required') fail(`[${label}] ${status}: ${errorCode} :: ${errorMessage}`);
        process.stdout.write('.');
        await new Promise(res => setTimeout(res, POLL_MS));
    }
}

(async () => {
    step('Server reachable');
    for (let i = 0; ; i++) {
        try { if ((await fetch(`${URL_BASE}/api/v1/indexer/getHealth()`)).ok) break; } catch { /* retry */ }
        if (i > 30) fail('server not reachable'); await new Promise(r => setTimeout(r, 1000));
    }
    console.log('OK   server up');

    step('1. Sponsor wallet (funded)');
    let r = await post('/connectWallet', { viewingKey: VK });
    const sponsorSession = r.body?.sessionId; if (!sponsorSession) fail(`connectWallet sponsor: ${JSON.stringify(r.body)}`);
    r = await post('/connectWalletForSigning', { sessionId: sponsorSession, mnemonic: MNEMONIC });
    if (r.body?.prewarmJobId) { console.log('     syncing sponsor...'); await poll(sponsorSession, r.body.prewarmJobId, 'sponsor prewarm'); }
    console.log(`OK   sponsor session ${sponsorSession}`);

    step('2. Caller wallet (fresh, zero-funded, its own identity)');
    const callerSeed = hex(64);
    const info = (await post('/deriveWalletInfo', { seedHex: callerSeed })).body;
    if (!info?.viewingKey) fail(`deriveWalletInfo: ${JSON.stringify(info)}`);
    r = await post('/connectWallet', { viewingKey: info.viewingKey });
    const callerSession = r.body?.sessionId; if (!callerSession) fail(`connectWallet caller: ${JSON.stringify(r.body)}`);
    // prewarm:false: sponsored caller needs no sync (NIGHTGATE_SPONSORED_CALLER_SYNC=skip).
    await post('/connectWalletForSigning', { sessionId: callerSession, seedHex: callerSeed, prewarm: false });
    console.log(`OK   caller session ${callerSession}, attesterId ${String(info.attesterId).slice(0, 20)}…`);

    let vault = process.env.NIGHTGATE_VAULT || '';
    if (!vault) {
        step('3. Deploy a throwaway vault (sponsor)');
        r = await post('/deployContract', { compiledArtifactRef: 'attestation-vault', sessionId: sponsorSession, initialPrivateState: '{}' });
        if (r.status !== 200 && r.status !== 201) fail(`deploy: HTTP ${r.status} ${JSON.stringify(r.body)}`);
        const dep = await poll(sponsorSession, r.body.jobId, 'deploy');
        vault = dep.contractAddress;
    }
    console.log(`OK   vault ${vault}`);

    step('4a. buildSponsorable (PHASE 1): caller builds + signs + finalizes, no submit');
    const payloadHash = hex(32), metadataHash = hex(32);
    const built = await post('/buildSponsorable', {
        contractAddress: vault, circuit: 'attest', compiledArtifactRef: 'attestation-vault',
        sessionId: callerSession, args: JSON.stringify([payloadHash, metadataHash])
    });
    if (built.status !== 200 && built.status !== 201) fail(`buildSponsorable -> HTTP ${built.status}: ${JSON.stringify(built.body)}`);
    console.log(`     phase-1 job ${built.body.jobId}; polling (proving runs on the caller side)...`);
    const phase1 = await poll(callerSession, built.body.jobId, 'buildSponsorable');
    if (!phase1.finalizedTxB64) fail(`buildSponsorable returned no finalizedTxB64: ${JSON.stringify(phase1)}`);
    console.log(`OK   caller produced a fee-unpaid tx: ${phase1.serializedBytes} bytes (${phase1.finalizedTxB64.length} b64 chars)`);
    console.log('     ^ these bytes are all a remote sponsor needs; the caller keeps its key');

    step('4b. sponsorFinalizedTransaction (PHASE 2): sponsor pays dust + submits');
    const sponsored = await post('/sponsorFinalizedTransaction', {
        finalizedTxB64: phase1.finalizedTxB64, sponsorSessionId: sponsorSession
    });
    if (sponsored.status !== 200 && sponsored.status !== 201) fail(`sponsorFinalizedTransaction -> HTTP ${sponsored.status}: ${JSON.stringify(sponsored.body)}`);
    console.log(`     phase-2 job ${sponsored.body.jobId}; polling...`);
    // Phase-2 job is keyed by the SPONSOR session.
    const out = { ...await poll(sponsorSession, sponsored.body.jobId, 'sponsorFinalized'), serializedBytes: phase1.serializedBytes };
    console.log(`\nresult: ${JSON.stringify(out)}`);

    step('SUMMARY');
    if (out.txHash) {
        console.log(`OK   TWO-PHASE CROSS-SERVER SPONSORING WORKS`);
        console.log(`     phase 1 (caller): built + signed + finalized ${out.serializedBytes}-byte fee-unpaid tx`);
        console.log(`     phase 2 (sponsor): deserialized, policy-checked (circuits ${JSON.stringify(out.circuits)}), paid dust, submitted`);
        console.log(`     txHash ${out.txHash}`);
        console.log(`     attestation is under the CALLER's identity; the SPONSOR paid the dust`);
        console.log(`\n=> phase 1 can move to the caller's machine (txbuilder SDK); only phase 2 stays on our server.`);
        process.exit(0);
    }
    fail(`sponsoring did NOT complete: ${JSON.stringify(out)}`);
})();
