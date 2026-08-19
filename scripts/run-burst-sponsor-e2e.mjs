// Live lane for parallel sponsoring (0.18): prebuild N UNBOUND attest txs (each
// caller proves its OWN circuit locally via the txbuilder SDK), then BURST them
// concurrently at ONE sponsor wallet and report which backings paid and in which
// blocks the txs landed. Decouples caller build time from sponsor throughput.
//
// Server: `npm run serve` (NOT cds watch) with the vaults allow-listed:
//   NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS=<vault1>,<vault2>
//   NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS=attest
//   NIGHTGATE_SPONSORED_CALLER_SYNC=skip
// Two vaults keep same-contract writes apart (those still conflict at the ledger).
// Set NIGHTGATE_NOTE_LEASE_MS=0 on the SERVER to force two sponsorings onto the
// same dust note and watch the dust-race rebuild-retry heal the loser.
//
// Then: NIGHTGATE_VAULT=<v1> NIGHTGATE_VAULT2=<v2> npm run burst-sponsor:e2e
// Env: LACE_* (the sponsor wallet; connected + prewarmed by this script) OR
//      NIGHTGATE_SPONSOR_SESSION_ID (an existing sponsor session or the platform
//      pool sentinel 00000000-0000-0000-0000-706f6f6c0000; no wallet connect, this
//      is the shape an external caller uses against a hosted server),
//      NIGHTGATE_INDEXER_HTTP_URL, NIGHTGATE_NODE_URL, NIGHTGATE_BURST_N (default 4),
//      REUSE=1 (reuse prebuilt txs from scratch/unbound, only within their 30 min
//      TTL), NIGHTGATE_URL (default http://localhost:4004), NIGHTGATE_HTTP_USER /
//      NIGHTGATE_HTTP_PASSWORD (basic auth of a hosted server).
// Passes when every burst member landed.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import bip39 from 'bip39';
import { createTxBuilder } from '../src/txbuilder/index.mjs';
import { prepareAttest } from '../src/browser/index.mjs';
import { Contract } from '../contracts/attestation-vault/src/managed/attestation-vault/contract/index.js';
import { connect } from '../src/sdk/client.mjs';

const BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const V = [process.env.NIGHTGATE_VAULT, process.env.NIGHTGATE_VAULT2].filter(Boolean);
const VK = process.env.LACE_VIEWING_KEY, MN = (process.env.LACE_MNEMONIC || '').trim();
const SPONSOR = process.env.NIGHTGATE_SPONSOR_SESSION_ID || '';
const IHTTP = process.env.NIGHTGATE_INDEXER_HTTP_URL, NODE = process.env.NIGHTGATE_NODE_URL;
const N = Number(process.env.NIGHTGATE_BURST_N || '4');
const haveWallet = !!VK && !!MN && bip39.validateMnemonic(MN);
if (!V.length || (!SPONSOR && !haveWallet) || !IHTTP || !NODE) { console.error('need NIGHTGATE_VAULT + (LACE_* or NIGHTGATE_SPONSOR_SESSION_ID) + indexer/node'); process.exit(1); }
const { deriveIndexerWsUrl } = await import('../srv/utils/nightgate-config.js');
const IWS = process.env.NIGHTGATE_INDEXER_WS_URL || deriveIndexerWsUrl(IHTTP);
const DIR = join(process.cwd(), 'scratch', 'unbound');
mkdirSync(DIR, { recursive: true });
const ng = connect({
  baseUrl: BASE, timeoutMs: 60 * 60 * 1000,
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

let sessionId = SPONSOR;
if (!sessionId) {
  ({ sessionId } = await ng.connectWallet({ viewingKey: VK }));
  const conn = await ng.connectWalletForSigning({ sessionId, mnemonic: MN });
  if (conn.prewarmJobId) { console.log('syncing sponsor...'); await ng.waitForJob({ jobId: conn.prewarmJobId, sessionId }); }
}
console.log('sponsor:', sessionId);

console.log(`\nPhase B: firing ${built.length} sponsorUnbound jobs CONCURRENTLY (concurrency 4, 2 backings)...`);
const t0 = Date.now();
const settled = await Promise.allSettled(built.map(r =>
  ng.sponsorUnbound({ unboundTxB64: r.unboundTxB64, sponsorSessionId: sessionId }).then(x => ({ ...r, ...x }))));
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
