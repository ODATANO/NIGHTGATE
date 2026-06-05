// Kicks off the wallet sync against a running NIGHTGATE server.
//
//   1. POST /connectWallet            → returns sessionId
//   2. POST /connectWalletForSigning  → starts the facade pre-warm in the worker
//
// After step 2 the worker begins the shielded chain scan. Watch the server log
// for `[worker] facade started ...` and the recurring `[facade-persist] saved ...`
// lines.
//
// Run:
//   npm run sync:start          (uses --env-file=.env from package.json)
//   node --env-file=.env scripts/start-wallet-sync.mjs
//
// Required env vars (set in .env):
//   LACE_VIEWING_KEY            64-char hex
//   LACE_MNEMONIC               BIP39 recovery phrase (server HD-derives keys)
// Optional:
//   NIGHTGATE_URL               default http://localhost:4004

import { Agent, setGlobalDispatcher } from 'undici';

// connectWalletForSigning pre-warms the facade fire-and-forget, so the HTTP
// response is fast. We still bump the default headers timeout for safety.
setGlobalDispatcher(new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 30_000
}));

const URL_BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const ENDPOINT = `${URL_BASE}/api/v1/nightgate`;
const VK       = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK)       fail('LACE_VIEWING_KEY env var is required (set in .env)');
if (!MNEMONIC) fail('LACE_MNEMONIC env var is required (set in .env)');
if (!/^[0-9a-fA-F]{64}$/.test(VK)) fail('LACE_VIEWING_KEY must be 64 hex chars');

async function post(path, body) {
    const r = await fetch(`${ENDPOINT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

(async () => {
    step(`1. connectWallet → ${URL_BASE}`);
    let r = await post('/connectWallet', { viewingKey: VK });
    if (r.status !== 200 && r.status !== 201) fail(`HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`No sessionId in response: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('2. connectWalletForSigning → kicks off facade pre-warm');
    r = await post('/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC });
    if (r.status !== 200 && r.status !== 201) fail(`HTTP ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   ${pretty(r.body)}`);

    console.log('\nSync kicked off. Watch the server log for:');
    console.log('  [worker] facade started for ...');
    console.log('  [facade-persist] saved <sid> sh=N un=N du=N   (every ~30 s)');
    console.log('\nProgress check (separate terminal):');
    console.log('  sqlite3 db/midnight.db "SELECT length(shieldedStateBlob) AS sh, length(dustStateBlob) AS du, updatedAt FROM midnight_WalletSyncStates"');
    console.log(`\nSession to reuse: ${sessionId}`);
})();
