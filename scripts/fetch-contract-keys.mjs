#!/usr/bin/env node
// Fetch a shipped contract's PROVER keys into the installed package.
//
// Why this exists: prover keys are tens of megabytes each and the npm
// registry rejects a tarball that carries them (413 at 204 MB). The package
// ships every contract's module, verifier keys, zkir and a keys/manifest.json
// (sha256 + size per prover key), but no prover key. A running server fetches
// a missing key on first need (NIGHTGATE_ZK_ASSET_URL, shipped contracts
// default to the release tag); this CLI does the same ahead of time, for an
// install that will run offline or behind a firewall.
//
// The default source is this release's own git tag on GitHub, whose layout
// is byte-for-byte the /zk-config layout, so `--from` also takes any
// NIGHTGATE that already has the keys:
//   npx nightgate-fetch-keys attestation-vault-32
//   npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
//
// Every downloaded key is verified against the manifest; a mismatch is
// deleted again. Prover keys are not part of the artifact generation digest,
// so fetching them changes nothing a job or evidence row was pinned to, and
// the server needs no restart.

import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const contract = args.find((a) => !a.startsWith('-'));
const fromIdx = args.indexOf('--from');
const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

if (!contract || args.includes('-h') || args.includes('--help')) {
    console.log('usage: nightgate-fetch-keys <contract> [--from <zk-config base url>]');
    console.log('       fetches the missing keys/*.prover + zkir/*.bzkir of a shipped contract');
    process.exit(contract ? 0 : 1);
}

const managed = path.join(pkgRoot, 'contracts', contract, 'src', 'managed', contract);
if (!existsSync(path.join(managed, 'keys'))) {
    console.error(`nightgate-fetch-keys: '${contract}' is not a contract shipped with this package (looked in ${managed})`);
    process.exit(1);
}

// The verifier keys ship in full, so they are the authoritative circuit list.
const circuits = readdirSync(path.join(managed, 'keys'))
    .filter((f) => f.endsWith('.verifier'))
    .map((f) => f.replace(/\.verifier$/, ''))
    .sort();
const missing = circuits.filter((c) => !existsSync(path.join(managed, 'keys', `${c}.prover`)));
if (missing.length === 0) {
    console.log(`nightgate-fetch-keys: '${contract}' already has all ${circuits.length} prover keys, nothing to do`);
    process.exit(0);
}

const base = from
    ?? `https://raw.githubusercontent.com/ODATANO/NIGHTGATE/v${pkg.version}/contracts/${contract}/src/managed/${contract}`;

console.log(`nightgate-fetch-keys: ${missing.length} of ${circuits.length} prover keys missing for '${contract}'`);
console.log(`  from: ${base}`);
console.log(`  into: ${path.join(managed, 'keys')}`);

// Windows: the ESM loader rejects a raw C:\... specifier, needs a file:// URL.
const { ensureZkAssets } = await import(pathToFileURL(path.join(pkgRoot, 'src', 'txbuilder', 'index.mjs')).href);
try {
    const result = await ensureZkAssets({
        zkConfigBaseUrl: base,
        cacheDir: managed,
        circuits: missing,
        verifierCircuits: circuits,
        onProgress: (p) => { if (p?.file) console.log(`  ${p.file} (${p.fetched}/${missing.length * 2})`); }
    });
    const still = missing.filter((c) => !existsSync(path.join(managed, 'keys', `${c}.prover`)));
    if (still.length > 0) {
        console.error(`nightgate-fetch-keys: source did not serve ${still.length} prover key(s): ${still.join(', ')}`);
        process.exit(1);
    }
    // Verify what landed against the shipped manifest; a key the source
    // altered or truncated must not stay on disk.
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(path.join(managed, 'keys', 'manifest.json'), 'utf8')); } catch { manifest = null; }
    if (!manifest?.prover) {
        console.error(`nightgate-fetch-keys: '${contract}' ships no keys/manifest.json; cannot verify the download`);
        process.exit(1);
    }
    const bad = [];
    for (const c of missing) {
        const file = path.join(managed, 'keys', `${c}.prover`);
        const body = readFileSync(file);
        const entry = manifest.prover[c];
        if (!entry || entry.bytes !== body.length || entry.sha256 !== createHash('sha256').update(body).digest('hex')) {
            rmSync(file, { force: true });
            bad.push(c);
        }
    }
    if (bad.length > 0) {
        console.error(`nightgate-fetch-keys: ${bad.length} downloaded key(s) did not match keys/manifest.json and were removed: ${bad.join(', ')}`);
        process.exit(1);
    }
    console.log(`nightgate-fetch-keys: '${contract}' complete${result?.fetched != null ? ` (${result.fetched} files fetched)` : ''}, all keys verified against the manifest.`);
    console.log('  The artifact generation digest is unchanged; a running server picks the keys up on the next job.');
} catch (e) {
    console.error(`nightgate-fetch-keys: ${e?.message ?? e}`);
    process.exit(1);
}
