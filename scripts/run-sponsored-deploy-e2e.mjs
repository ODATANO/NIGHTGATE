// Live lane for the sponsored deploy: a caller builds, proves and signs a
// contract deploy with its own key (txbuilder `buildDeploySponsorable`), a grant
// with `allowDeploy` lets the sponsor pay the dust, the landed address joins the
// grant's `deployedContracts`, a follow-up call on it is sponsored under the same
// token, and a second deploy under the grant is refused before broadcast.
//
// Server: `npm run serve` with NIGHTGATE_SPONSOR_ALLOW_DEPLOY=true.
// Env: LACE_* (the sponsor wallet), NIGHTGATE_INDEXER_HTTP_URL, NIGHTGATE_NODE_URL,
//      NIGHTGATE_URL (default http://localhost:4004), NIGHTGATE_HTTP_USER/_PASSWORD,
//      DEPLOY_E2E_ARTIFACT (default 'counter').
// Prints GRANT_TOKEN=... at the end; the burst lane can reuse it via
// NIGHTGATE_AGENT_TOKEN=<token> NIGHTGATE_SPONSOR_SESSION_ID=<sponsor>.
//
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';
import { createTxBuilder } from '../src/txbuilder/index.mjs';
import { connect } from '../src/sdk/client.mjs';

const require = createRequire(import.meta.url);
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const VK = process.env.LACE_VIEWING_KEY;
const MN = (process.env.LACE_MNEMONIC || '').trim();
const IHTTP = process.env.NIGHTGATE_INDEXER_HTTP_URL;
const NODE = process.env.NIGHTGATE_NODE_URL;
const ARTIFACT = process.env.DEPLOY_E2E_ARTIFACT || 'counter';
const EXTRA_CONTRACTS = (process.env.NIGHTGATE_GRANT_CONTRACTS || '').split(',').map(s => s.trim()).filter(Boolean);

function fail(m) { console.error(`\nFAIL ${m}`); process.exit(1); }
function step(n) { console.log(`\n--- ${n} ---`); }
if (!VK || !MN || !bip39.validateMnemonic(MN)) fail('LACE_VIEWING_KEY + LACE_MNEMONIC are required (the SPONSOR wallet)');
if (!IHTTP || !NODE) fail('NIGHTGATE_INDEXER_HTTP_URL + NIGHTGATE_NODE_URL are required');
const { deriveIndexerWsUrl } = require('../srv/utils/nightgate-config.js');
const IWS = process.env.NIGHTGATE_INDEXER_WS_URL || deriveIndexerWsUrl(IHTTP);
const auth = { username: process.env.NIGHTGATE_HTTP_USER, password: process.env.NIGHTGATE_HTTP_PASSWORD };
const artifactModule = ARTIFACT === 'counter'
    ? '../contracts/counter/src/managed/counter/contract/index.js'
    : `../contracts/${ARTIFACT}/src/managed/${ARTIFACT}/contract/index.js`;
const { Contract } = await import(artifactModule);

const operator = connect({ baseUrl: BASE, timeoutMs: 60 * 60 * 1000, ...auth });

step('0. Sponsor session (the funded wallet) + prewarm');
const { sessionId: sponsor } = await operator.connectWallet({ viewingKey: VK });
const conn = await operator.connectWalletForSigning({ sessionId: sponsor, mnemonic: MN });
if (conn.prewarmJobId) { console.log('     syncing sponsor...'); await operator.waitForJob({ jobId: conn.prewarmJobId, sessionId: sponsor }); }
console.log(`OK   sponsor ready (${sponsor})`);

step('1. Grant with the DEPLOY right (maxDeploys 1) for the sponsor session');
async function post(path, body) {
    const r = await fetch(`${BASE}/api/v1/nightgate${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64') },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (r.status >= 400) fail(`${path} -> HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
}
const grant = await post('/createAgentGrant', {
    sessionId: sponsor,
    allowedActions: ['sponsorUnboundTransaction', 'sponsorFinalizedTransaction'],
    sponsorSessionId: sponsor,
    allowedContracts: EXTRA_CONTRACTS,
    allowDeploy: true,
    maxDeploys: 1,
    agentLabel: 'e2e-sponsored-deploy'
});
if (!grant?.token) fail(`createAgentGrant: ${JSON.stringify(grant)}`);
console.log(`OK   grant ${grant.grantId} allowDeploy=${grant.allowDeploy} maxDeploys=${grant.maxDeploys}`);
const agent = connect({ baseUrl: BASE, timeoutMs: 60 * 60 * 1000, agentToken: grant.token, ...auth });

step(`2. LOCAL builder for '${ARTIFACT}' (throwaway caller key; prover keys from the sponsor's /zk-config)`);
const t0 = Date.now();
const builder = await createTxBuilder({
    seedHex: randomBytes(64).toString('hex'),
    networkId: process.env.NIGHTGATE_NETWORK || 'preprod',
    indexerHttpUrl: IHTTP, indexerWsUrl: IWS, nodeUrl: NODE,
    zkConfigBaseUrl: `${BASE}/zk-config/${ARTIFACT}`,
    contractClass: Contract,
    contractName: ARTIFACT,
    privateStateId: ARTIFACT,
    cacheDir: join(tmpdir(), 'nightgate-sponsored-deploy-e2e', ARTIFACT)
});
console.log(`OK   builder ready in ${((Date.now() - t0) / 1000).toFixed(1)}s (${builder.zkAssets.fetched} fetched, ${builder.zkAssets.cached} cached, ${builder.zkAssets.source ?? 'remote'})`);

step('3. Build + prove + sign the DEPLOY locally (unbound handover), ship only the bytes');
const t1 = Date.now();
const built = await builder.buildDeploySponsorable({ initialPrivateState: {}, bind: false });
console.log(`OK   deploy built in ${((Date.now() - t1) / 1000).toFixed(1)}s: ${built.serializedBytes} bytes, contractAddress ${built.contractAddress}`);
if (!built.contractAddress) fail('buildDeploySponsorable returned no contractAddress');

const job = await agent.sponsorUnbound({ unboundTxB64: built.unboundTxB64, sponsorSessionId: sponsor });
console.log(`     sponsor job ${job.jobId}`);
const out = await agent.waitForJob({ jobId: job.jobId, sessionId: job.sessionId ?? sponsor });
console.log(`OK   deploy LANDED tx ${String(out.txHash).slice(0, 16)} circuits=${JSON.stringify(out.circuits)} deployed=${JSON.stringify(out.deployed)}`);
if (!Array.isArray(out.deployed) || out.deployed[0] !== built.contractAddress) fail(`job result does not name the deployed address (${JSON.stringify(out.deployed)} vs ${built.contractAddress})`);

step('4. The landed address is sponsorable under the SAME token at once (deployedContracts joins the policy)');
const call = { circuitId: 'increment', args: [] };
const t2 = Date.now();
const callTx = await builder.buildSponsorable({ contractAddress: built.contractAddress, call, witnesses: {}, bind: false });
console.log(`     increment built in ${((Date.now() - t2) / 1000).toFixed(1)}s: ${callTx.serializedBytes} bytes`);
const job2 = await agent.sponsorUnbound({ unboundTxB64: callTx.unboundTxB64, sponsorSessionId: sponsor });
const out2 = await agent.waitForJob({ jobId: job2.jobId, sessionId: job2.sessionId ?? sponsor });
console.log(`OK   increment LANDED tx ${String(out2.txHash).slice(0, 16)} on ${String(out2.contractAddress).slice(0, 16)}`);
if (out2.contractAddress !== built.contractAddress) fail('follow-up call landed on a different address');

step('5. Deploy budget exhausted: a SECOND deploy under the grant is refused before broadcast');
const second = await builder.buildDeploySponsorable({ initialPrivateState: {}, bind: false });
let refused = null;
try {
    const j3 = await agent.sponsorUnbound({ unboundTxB64: second.unboundTxB64, sponsorSessionId: sponsor });
    const o3 = await agent.waitForJob({ jobId: j3.jobId, sessionId: j3.sessionId ?? sponsor });
    fail(`second deploy was sponsored (${JSON.stringify(o3).slice(0, 200)}); the budget did not hold`);
} catch (e) {
    refused = String(e?.message || e);
}
if (!/deploy budget|allowDeploy|exhausted|not broadcasting|non-call action/i.test(refused)) fail(`second deploy failed for the wrong reason: ${refused.slice(0, 300)}`);
console.log(`OK   refused: ${refused.slice(0, 160)}`);

await builder.close();
console.log('\n=== SPONSORED DEPLOY LANE PASSED ===');
console.log(`GRANT_TOKEN=${grant.token}`);
console.log(`SPONSOR_SESSION=${sponsor}`);
console.log(`DEPLOYED=${built.contractAddress}`);
process.exit(0);
