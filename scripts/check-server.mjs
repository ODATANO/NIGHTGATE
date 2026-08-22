#!/usr/bin/env node
// Quick health check against a running NIGHTGATE server (local or hosted).
//
// Usage: node --env-file=.env scripts/check-server.mjs [baseUrl]
// Env:   NIGHTGATE_URL                 default http://localhost:4004; argv wins
//        NIGHTGATE_HTTP_USER/_PASSWORD basic auth of a hosted server
//        NIGHTGATE_SPONSOR_SESSION_ID  optional; adds dust/balance + sync checks
//
// Exit 0 = everything green, 1 = at least one FAIL.

const BASE = (process.argv[2] || process.env.NIGHTGATE_URL || 'http://localhost:4004').replace(/\/$/, '');
const SPONSOR = process.env.NIGHTGATE_SPONSOR_SESSION_ID || '';
const headers = { accept: 'application/json' };
if (process.env.NIGHTGATE_HTTP_USER) {
  headers.authorization = 'Basic ' + Buffer
    .from(`${process.env.NIGHTGATE_HTTP_USER}:${process.env.NIGHTGATE_HTTP_PASSWORD || ''}`)
    .toString('base64');
}

let failed = false;
const ok = (label, detail) => console.log(`  OK    ${label}${detail ? `  ${detail}` : ''}`);
const warn = (label, detail) => console.log(`  WARN  ${label}${detail ? `  ${detail}` : ''}`);
const fail = (label, detail) => { failed = true; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`); };

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
  return body;
}

console.log(`nightgate check: ${BASE}`);

try {
  const live = await get('/api/v1/indexer/getLiveness()');
  ok('liveness', `up ${Math.round(live.uptime / 60)} min, instance ${live.instanceId}`);
} catch (e) {
  fail('liveness', e.message);
  console.log('server unreachable, skipping the rest');
  process.exit(1);
}

try {
  const r = await get('/api/v1/indexer/getReadiness()');
  const checks = Object.entries(r.checks || {}).map(([k, v]) => `${k}=${v ? 'ok' : 'DOWN'}`).join(' ');
  const line = `${checks}${r.crawlerEnabled === false ? ' (crawler disabled)' : ''}`;
  r.ready ? ok('readiness', line) : fail('readiness', line);
  for (const w of r.runtimeWarnings || []) warn('runtime', w);
} catch (e) {
  fail('readiness', e.message);
}

try {
  const h = await get('/api/v1/indexer/getHealth()');
  const line = `chain ${h.chainHeight}, indexed ${h.indexedHeight}, lag ${h.lag}, ${h.syncStatus}`;
  Number(h.lag) > 50 ? warn('indexer', line) : ok('indexer', line);
} catch (e) {
  warn('indexer health', e.message);
}

if (SPONSOR) {
  try {
    const b = await get(`/api/v1/nightgate/getWalletBalance(sessionId=${SPONSOR})`);
    const night = (Number(b.unshieldedNight) / 1e6).toFixed(2);
    const line = `${night} NIGHT, dust ${b.dustBalance}, backings ${b.registeredNightUtxoCount}, ` +
      `dust utxos ${b.dustUtxoCount} (${b.dustPendingCount} pending)`;
    if (b.dustUtxoCount === 0) fail('sponsor wallet', `${line}  <- no free dust, sponsoring will stall`);
    else if (b.dustPendingCount > 0) warn('sponsor wallet', line);
    else ok('sponsor wallet', line);
  } catch (e) {
    fail('sponsor wallet', e.message);
  }

  try {
    const s = await get(`/api/v1/nightgate/getWalletSyncProgress(sessionId=${SPONSOR})`);
    if (!s.known) warn('sponsor sync', 'no snapshot yet');
    else {
      const line = `caughtUp=${s.caughtUp}, behind ${s.behindEvents} events, connected=${s.isConnected}`;
      s.caughtUp && s.isConnected ? ok('sponsor sync', line)
        : s.isConnected ? warn('sponsor sync', line)
        : fail('sponsor sync', line);
    }
  } catch (e) {
    warn('sponsor sync', e.message);
  }
} else {
  console.log('  --    sponsor checks skipped (set NIGHTGATE_SPONSOR_SESSION_ID)');
}

process.exit(failed ? 1 : 0);
