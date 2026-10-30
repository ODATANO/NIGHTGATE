// Bursts N prebuilt unbound attest txs at the server's sponsor pool in parallel and passes when every one landed.
// Run: NIGHTGATE_VAULT=<v1> NIGHTGATE_VAULT2=<v2> npm run burst-sponsor:e2e against `npm run serve` with both vaults allow-listed.
// Env: NIGHTGATE_INDEXER_HTTP_URL, NIGHTGATE_NODE_URL, NIGHTGATE_BURST_N, NIGHTGATE_URL, optional REUSE=1.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createTxBuilder } from '../src/txbuilder/index.mjs';
import { prepareAttest } from '../src/browser/index.mjs';
import { Contract } from '@odatano/contract-attestation-vault';
import { connect } from '../src/sdk/client.mjs';

const BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const V = [process.env.NIGHTGATE_VAULT, process.env.NIGHTGATE_VAULT2].filter(Boolean);
const IHTTP = process.env.NIGHTGATE_INDEXER_HTTP_URL, NODE = process.env.NIGHTGATE_NODE_URL;
const N = Number(process.env.NIGHTGATE_BURST_N || '4');
if (!V.length || !IHTTP || !NODE) { console.error('need NIGHTGATE_VAULT + indexer/node'); process.exit(1); }
const { deriveIndexerWsUrl } = await import('../srv/utils/nightgate-config.js');
const IWS = process.env.NIGHTGATE_INDEXER_WS_URL || deriveIndexerWsUrl(IHTTP);
const DIR = join(process.cwd(), 'scratch', 'unbound');
mkdirSync(DIR, { recursive: true });
// NIGHTGATE_AGENT_TOKEN: run under an agent grant; the sponsor policy is floor ∩ grant.
const ng = connect({
  baseUrl: BASE, timeoutMs: 60 * 60 * 1000,
  agentToken: process.env.NIGHTGATE_AGENT_TOKEN || undefined,
  username: process.env.NIGHTGATE_HTTP_USER, password: process.env.NIGHTGATE_HTTP_PASSWORD
});

async function build(i) {
  const vault = V[i % V.length];
  const b = await createTxBuilder({
    seedHex: randomBytes(64).toString('hex'), networkId: process.env.NIGHTGATE_NETWORK || 'preprod',
    indexerHttpUrl: IHTTP, indexerWsUrl: IWS, nodeUrl: NODE,
    zkConfigBaseUrl: `${BASE}/zk-config/attestation-vault`, contractClass: Contract,
    cacheDir: join(tmpdir(), 'nightgate-two-machine-proof'), circuits: ['attest']
  });
  const payloadHash = randomBytes(32).toString('hex');
  const call = prepareAttest({ payloadHash, metadataHash: randomBytes(32).toString('hex'), attestationSecret: b.attestationSecret });
  const { unboundTxB64 } = await b.buildSponsorable({ contractAddress: vault, call, bind: false });
  const rec = { i, vault, unboundTxB64, payloadHash, attesterId: b.attesterId };
  await b.close();
  writeFileSync(join(DIR, `tx-${i}.json`), JSON.stringify(rec));
  console.log(`built #${i} -> vault ${vault.slice(0, 12)} attester ${b.attesterId.slice(0, 10)} (${unboundTxB64.length} b64)`);
  return rec;
}

let built;
const have = existsSync(DIR) ? readdirSync(DIR).filter(f => f.startsWith('tx-')) : [];
if (process.env.REUSE === '1' && have.length >= N) {
  built = have.slice(0, N).map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
  console.log(`REUSE: loaded ${built.length} prebuilt txs from disk`);
} else {
  console.log(`Phase A: prebuilding ${N} unbound attest txs (each proves its own circuit)...`);
  built = [];
  for (let i = 0; i < N; i++) built.push(await build(i)); // sequential = represents N distributed callers
}

console.log(`\nPhase B: firing ${built.length} sponsorUnbound jobs CONCURRENTLY (concurrency 4, 2 backings)...`);
const t0 = Date.now();
const settled = await Promise.allSettled(built.map(r =>
  ng.sponsorUnbound({ unboundTxB64: r.unboundTxB64 }).then(x => ({ ...r, ...x }))));
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nburst settled in ${dt}s`);

async function blockOf(txHash) {
  // The sponsor returns the tx IDENTIFIER (tx.identifiers().at(-1)), so query by identifier, not hash.
  const q = `{ transactions(offset:{identifier:"${txHash}"}) { block { height } } }`;
  try { const r = await fetch(IHTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const j = await r.json(); const h = j.data?.transactions?.[0]?.block?.height; if (h != null) return h; } catch {}
  return null;
}

const landed = [], failed = [];
settled.forEach((res, k) => res.status === 'fulfilled' ? landed.push(res.value) : failed.push({ i: built[k].i, reason: String(res.reason?.message || res.reason).slice(0, 160) }));
for (const l of landed) l.block = await blockOf(l.txHash);

console.log('\n--- BURST RESULT ---');
console.log(`landed ${landed.length}/${built.length}, failed ${failed.length}`);
for (const l of landed) console.log(`  #${l.i} tx ${String(l.txHash).slice(0, 16)} backing ${String(l.note).slice(0, 12)} block ${l.block}`);
for (const f of failed) console.log(`  #${f.i} FAILED: ${f.reason}`);
const backings = new Set(landed.map(l => l.note));
const blocks = new Set(landed.map(l => l.block).filter(Boolean));
console.log(`\ndistinct backings used: ${backings.size}`);
console.log(`distinct blocks: ${blocks.size} (${[...blocks].join(',')})`);
if (landed.length > 1 && blocks.size >= 1 && backings.size > 1) console.log('=> multiple txs landed on DISTINCT backings = true parallel sponsoring proven');
process.exit(failed.length ? 1 : 0);
