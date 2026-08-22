#!/usr/bin/env node
// Fetch a shipped contract's PROVER keys into the installed package.
//
// Why this exists: prover keys are tens of megabytes each and the npm
// registry rejects a tarball that carries every width variant's full set
// (413 at 204 MB). The package therefore ships the width-32 vault with its
// contract module, verifier keys and zkir, but WITHOUT its 113 MB of prover
// keys. Deploying and crawler-free verification work without them; PROVING
// its circuits (and serving them over /zk-config) needs them on disk.
//
// The default source is this release's own git tag on GitHub, whose layout
// is byte-for-byte the /zk-config layout, so `--from` also takes any
// NIGHTGATE that already has the keys:
//   npx nightgate-fetch-keys attestation-vault-32
//   npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
//
// Run it BEFORE the first proof: the keys are part of the artifact
// GENERATION digest, so adding them changes what this contract resolves to
// and evidence recorded beforehand fails the generation guard by design.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
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
    console.log(`nightgate-fetch-keys: '${contract}' complete${result?.fetched != null ? ` (${result.fetched} files fetched)` : ''}.`);
    console.log("  This changed the contract's artifact generation digest; evidence recorded before now");
    console.log('  will fail the generation guard, which is intended. Restart the server to pick it up.');
} catch (e) {
    console.error(`nightgate-fetch-keys: ${e?.message ?? e}`);
    process.exit(1);
}
