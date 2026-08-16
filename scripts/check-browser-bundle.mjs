// Guards the `@odatano/nightgate/browser` surface.
//
// 1. Static check: no Node-only / server imports in src/browser/*.mjs.
// 2. Smoke import: the ESM entry loads in Node and its exports work.
//
// Run: node scripts/check-browser-bundle.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserDir = join(__dirname, '..', 'src', 'browser');

// Bare specifiers that must never appear in the browser surface.
const FORBIDDEN = [
    /^node:/,
    /^(fs|path|os|crypto|worker_threads|child_process|net|tls|http|https|stream|util|events|buffer|dns|zlib)$/,
    /^@sap\/cds/,
    /^express$/, /^undici$/, /^ws$/, /^@cap-js\//,
    /\/srv\//  // reaching into the server tree
];
const importRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

let failures = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); failures++; };

console.log('[browser-bundle] static import scan of src/browser/*.mjs');
const files = readdirSync(browserDir).filter(f => f.endsWith('.mjs'));
if (files.length === 0) fail('no .mjs files found in src/browser');
for (const f of files) {
    const src = readFileSync(join(browserDir, f), 'utf8');
    let m;
    const specs = new Set();
    while ((m = importRe.exec(src)) !== null) specs.add(m[1] || m[2]);
    for (const spec of specs) {
        if (FORBIDDEN.some(re => re.test(spec))) fail(`${f}: forbidden import '${spec}'`);
        else console.log(`    ${f} → ${spec} (ok)`);
    }
}

console.log('[browser-bundle] smoke import of ./src/browser/index.mjs');
try {
    const mod = await import('../src/browser/index.mjs');
    for (const name of [
        'deriveAttestationSecret', 'generateAttestationSecret', 'sealAttestationSecret',
        'openAttestationSecret', 'buildAttestationVaultWitnesses', 'CONTRACTS',
        'FetchZkConfigProvider', 'InMemoryPrivateStateProvider', 'createNightgateConnectorProviders',
        'prepareRevokeDisclosure', 'prepareGrantDisclosure', 'prepareAttest'
    ]) {
        if (mod[name] === undefined) fail(`missing export: ${name}`);
    }
    // The signature-as-secret footgun must STAY removed (0.16.0): a signature
    // over a fixed public message is shareable evidence, not key material.
    for (const name of ['deriveAttestationSecretFromSignature', 'ATTESTER_SECRET_MESSAGE']) {
        if (mod[name] !== undefined) fail(`removed export resurfaced: ${name}`);
    }
    // Functional smoke: derive a 32-byte secret and build witnesses.
    const secret = mod.deriveAttestationSecret(new Uint8Array(32).fill(7));
    if (!(secret instanceof Uint8Array) || secret.length !== 32) fail('deriveAttestationSecret did not return 32 bytes');
    // Random-secret + seal/open roundtrip (WebCrypto AES-GCM).
    const rndSecret = mod.generateAttestationSecret();
    if (!(rndSecret instanceof Uint8Array) || rndSecret.length !== 32) fail('generateAttestationSecret did not return 32 bytes');
    const unlock = new Uint8Array(64).fill(9);
    const sealed = await mod.sealAttestationSecret(rndSecret, unlock);
    if (sealed.v !== 1 || !/^[0-9a-f]+$/.test(sealed.cipher)) fail('sealAttestationSecret blob malformed');
    const reopened = await mod.openAttestationSecret(sealed, unlock);
    if (Buffer.compare(Buffer.from(reopened), Buffer.from(rndSecret)) !== 0) fail('seal/open roundtrip mismatch');
    let wrongUnlockThrew = false;
    try { await mod.openAttestationSecret(sealed, new Uint8Array(64).fill(8)); } catch { wrongUnlockThrew = true; }
    if (!wrongUnlockThrew) fail('openAttestationSecret accepted wrong unlock material');
    const w = mod.buildAttestationVaultWitnesses({ attestationSecret: secret });
    const [, out] = w.local_secret_key({ privateState: null });
    if (!(out instanceof Uint8Array) || out.length !== 32) fail('local_secret_key witness wrong shape');
    if (!mod.CONTRACTS['attestation-vault']) fail('CONTRACTS missing attestation-vault');

    // Vacuous integrity masks must be rejected CLIENT-SIDE too (the circuit
    // rejects them in-circuit; the helper gives a clean local error): a mask
    // freeing every real (non-padding) slot says nothing.
    const vacSchema = Array.from({ length: 16 }, (_, i) => ({ fieldKey: 'aa'.repeat(32), kind: i < 2 ? 0 : 2, scale: '0' }));
    const vacOpening = { saltSeed: 'bb'.repeat(32), slots: Array.from({ length: 16 }, () => ({ present: false })) };
    const vacPair = { schema: vacSchema, openingA: vacOpening, openingB: vacOpening };
    let vacThrew = false;
    try {
        mod.prepareProveFieldsUnchangedExcept({ payloadHashA: 'cc'.repeat(32), payloadHashB: 'dd'.repeat(32), allowedMask: 0b11, docPair: vacPair });
    } catch (e) { vacThrew = /vacuous/.test(String(e && e.message)); }
    if (!vacThrew) fail('prepareProveFieldsUnchangedExcept accepted a VACUOUS mask (frees every real slot)');
    let vacAllOnes = false;
    try {
        mod.prepareProveFieldsUnchangedExcept({ payloadHashA: 'cc'.repeat(32), payloadHashB: 'dd'.repeat(32), allowedMask: 0xffff, docPair: vacPair });
    } catch (e) { vacAllOnes = /vacuous/.test(String(e && e.message)); }
    if (!vacAllOnes) fail('prepareProveFieldsUnchangedExcept accepted the all-ones mask');
    const nonVac = mod.prepareProveFieldsUnchangedExcept({ payloadHashA: 'cc'.repeat(32), payloadHashB: 'dd'.repeat(32), allowedMask: 0b10, docPair: vacPair });
    if (nonVac.circuitId !== 'proveDocumentComparison') fail('prepareProveFieldsUnchangedExcept broken for a non-vacuous mask');

    // FetchZkConfigProvider with an injected fetch (no network).
    const fakeFetch = async (url) => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const zk = new mod.FetchZkConfigProvider('http://x/zk-config/attestation-vault', fakeFetch);
    const pk = await zk.getProverKey('revokeDisclosure');
    if (!(pk instanceof Uint8Array) || pk.length !== 3) fail('FetchZkConfigProvider.getProverKey wrong shape');
    if (typeof zk.asKeyMaterialProvider().getProverKey !== 'function') fail('asKeyMaterialProvider missing');

    // InMemoryPrivateStateProvider basic ops.
    const psp = new mod.InMemoryPrivateStateProvider();
    await psp.set('id', { a: 1 });
    if ((await psp.get('id')).a !== 1) fail('InMemoryPrivateStateProvider get/set broken');
    await psp.remove('id');
    if ((await psp.get('id')) !== null) fail('InMemoryPrivateStateProvider remove broken');

    // prepareRevokeDisclosure shape.
    const call = mod.prepareRevokeDisclosure({ payloadHash: 'ab'.repeat(32), grantee: 'cd'.repeat(32), attestationSecret: secret });
    if (call.circuitId !== 'revokeDisclosure' || call.args.length !== 2 || !(call.args[0] instanceof Uint8Array) || call.args[0].length !== 32) fail('prepareRevokeDisclosure wrong shape');
    if (typeof call.witnesses.local_secret_key !== 'function') fail('prepareRevokeDisclosure witnesses missing');

    console.log('    exports + functional smoke ok');
} catch (e) {
    fail(`smoke import threw: ${e && e.stack || e}`);
}

if (failures > 0) { console.error(`\n[browser-bundle] FAILED (${failures})`); process.exit(1); }
console.log('\n[browser-bundle] OK');
