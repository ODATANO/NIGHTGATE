// Drives the 0.4.0 browser DApp-connector HTTP surface against the REAL route
// handlers (src/connector-routes.js) mounted on a bare Express app — no cds
// lifecycle, no node, no chain. Exercises:
//   GET /contract-manifest                  — self-configuration manifest
//   GET /zk-config/<contract>/<dir>/<file>  — proving-artifact serving + ETag/304
// plus the security boundary (unknown contract / bad dir / bad filename -> 404)
// and the pinned-address + network passthrough (network reflects config).
//
// Run: npm run build   (compiles src/*.ts -> *.js in place)
//      node scripts/integration-test-connector-routes.mjs
//   or: npm run integration:connector-routes

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let failures = 0;
function ok(name, value, detail) {
    if (!value) { console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`); failures++; }
    else        console.log(`OK   ${name}`);
}

const PINNED_ADDRESS = '0200deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefcafe';

// --- Configure cds.env BEFORE importing the route module ------------------
// getNightgatePluginConfig() reads cds.env.requires.nightgate; the manifest
// route reads network + per-contract pinned address from it. Set it up so the
// manifest reflects an `undeployed` network and a pinned attestation-vault
// address — proving both passthroughs end-to-end.
const cds = (await import('@sap/cds')).default;
cds.env.requires ??= {};
cds.env.requires.nightgate = {
    contracts: { 'attestation-vault': { address: PINNED_ADDRESS } }
};
// cds lazily (re)loads .env into process.env on first cds.env access, which sets
// NIGHTGATE_NETWORK from the repo .env. Pin the network deterministically AFTER
// that load has happened (getConfiguredNightgateNetwork reads env first), so the
// manifest reflects `undeployed` regardless of the local .env.
process.env.NIGHTGATE_NETWORK = 'undeployed';

// --- Load the REAL compiled route handlers + registry ----------------------
const routesJsPath   = path.join(repoRoot, 'src/connector-routes.js');
const registryJsPath = path.join(repoRoot, 'srv/submission/contract-registry.js');
let routes, registry;
try {
    routes   = await import(pathToFileURL(routesJsPath).href);
    registry = await import(pathToFileURL(registryJsPath).href);
} catch (err) {
    console.error('FAIL could not load compiled modules. Run `npm run build` first.');
    console.error('     err:', err.message);
    process.exit(1);
}

// --- Register the same contracts the plugin config ships -------------------
const counterZk = path.join(repoRoot, 'contracts/counter/src/managed/counter');
const vaultZk   = path.join(repoRoot, 'contracts/attestation-vault/src/managed/attestation-vault');
registry.clearRegistry();
registry.registerContract('counter', {
    artifactPath: path.join(counterZk, 'contract/index.js'),
    privateStateId: 'counterPrivateState',
    zkConfigPath: counterZk
});
registry.registerContract('attestation-vault', {
    artifactPath: path.join(vaultZk, 'contract/index.js'),
    privateStateId: 'attestationVaultPrivateState',
    zkConfigPath: vaultZk
});

// --- Mount on a bare Express app + listen on an ephemeral port -------------
const app = express();
routes.mountZkConfigRoute(app);
routes.mountContractManifestRoute(app);
const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

try {
    // ---- /contract-manifest ----------------------------------------------
    const mRes = await fetch(`${base}/contract-manifest`);
    ok('manifest: HTTP 200', mRes.status === 200, `got ${mRes.status}`);
    const manifest = await mRes.json();
    ok('manifest: network reflects configured network (undeployed)', manifest.network === 'undeployed', manifest.network);
    ok('manifest: zkConfigBaseUrl present', manifest.zkConfigBaseUrl === `${base}/zk-config`, manifest.zkConfigBaseUrl);

    const byName = Object.fromEntries((manifest.contracts || []).map((c) => [c.name, c]));
    ok('manifest: counter listed', !!byName.counter);
    ok('manifest: attestation-vault listed', !!byName['attestation-vault']);

    const vault = byName['attestation-vault'] || {};
    ok('manifest: vault artifactRef set', vault.artifactRef === '@odatano/nightgate/browser/attestation-vault', vault.artifactRef);
    ok('manifest: counter has NO artifactRef (not browser-exported)', byName.counter && byName.counter.artifactRef === undefined);
    const vc = vault.circuits || [];
    for (const c of ['attest', 'commitValue', 'grantDisclosure', 'provePredicate', 'revokeDisclosure']) {
        ok(`manifest: vault circuit "${c}" present`, vc.includes(c));
    }
    ok('manifest: vault pinned address surfaced', Array.isArray(vault.addresses) && vault.addresses[0] === PINNED_ADDRESS, JSON.stringify(vault.addresses));
    ok('manifest: counter has no pinned address', byName.counter && byName.counter.addresses === undefined);
    ok('manifest: vault artifactHash is 64-hex', /^[0-9a-f]{64}$/.test(vault.artifactHash || ''), vault.artifactHash);

    // ---- /zk-config: real proving artifact -------------------------------
    const zkUrl = `${base}/zk-config/attestation-vault/keys/attest.verifier`;
    const z1 = await fetch(zkUrl);
    const body = await z1.arrayBuffer();
    const etag = z1.headers.get('etag');
    ok('zk-config: HTTP 200', z1.status === 200, `got ${z1.status}`);
    ok('zk-config: octet-stream content-type', z1.headers.get('content-type') === 'application/octet-stream', z1.headers.get('content-type'));
    ok('zk-config: immutable cache-control', /immutable/.test(z1.headers.get('cache-control') || ''), z1.headers.get('cache-control'));
    ok('zk-config: ETag present', !!etag, etag);
    ok('zk-config: non-empty body', body.byteLength > 0, `${body.byteLength} bytes`);

    // ---- conditional GET: matching ETag -> 304 ---------------------------
    const z304 = await fetch(zkUrl, { headers: { 'If-None-Match': etag } });
    ok('zk-config: matching ETag -> 304', z304.status === 304, `got ${z304.status}`);

    // ---- conditional GET: stale ETag -> 200 ------------------------------
    const zStale = await fetch(zkUrl, { headers: { 'If-None-Match': '"deadbeef"' } });
    ok('zk-config: stale ETag -> 200', zStale.status === 200, `got ${zStale.status}`);

    // ---- counter artifact also servable ----------------------------------
    const zCounter = await fetch(`${base}/zk-config/counter/keys/increment.verifier`);
    ok('zk-config: counter increment.verifier -> 200', zCounter.status === 200, `got ${zCounter.status}`);

    // ---- security boundary: 404s -----------------------------------------
    const sUnknown = await fetch(`${base}/zk-config/not-registered/keys/attest.verifier`);
    ok('security: unknown contract -> 404', sUnknown.status === 404, `got ${sUnknown.status}`);

    const sBadDir = await fetch(`${base}/zk-config/attestation-vault/secrets/attest.verifier`);
    ok('security: bad dir -> 404', sBadDir.status === 404, `got ${sBadDir.status}`);

    const sBadFile = await fetch(`${base}/zk-config/attestation-vault/keys/attest.txt`);
    ok('security: disallowed file extension -> 404', sBadFile.status === 404, `got ${sBadFile.status}`);

    const sMissing = await fetch(`${base}/zk-config/attestation-vault/keys/nosuchcircuit.verifier`);
    ok('security: missing artifact -> 404', sMissing.status === 404, `got ${sMissing.status}`);
} finally {
    await new Promise((resolve) => server.close(resolve));
}

console.log();
console.log(failures === 0
    ? 'Connector HTTP surface (manifest + zk-config) verified against the real route handlers.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
