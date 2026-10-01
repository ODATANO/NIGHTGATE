#!/usr/bin/env node
// Fetch a contract lineage's PROVER keys into the installed package.
//
// Prover keys are tens of megabytes each and ship neither in npm nor in git:
// a lineage package carries its module, verifier keys, zkir and a
// keys/manifest.json (sha256 + size per prover key), and names the release
// assets the keys come from (contract.json#zkAssetUrl). A running server
// fetches a missing key on first need; this CLI does the same ahead of time,
// for an install that will run offline or behind a firewall.
//
//   npx nightgate-fetch-keys attestation-vault-32
//   npx nightgate-fetch-keys @odatano/contract-attestation-vault-32
//   npx nightgate-fetch-keys attestation-vault-32 --from https://host/zk-config/attestation-vault-32
//
// `--from` takes any NIGHTGATE's /zk-config of that contract. Every downloaded
// key is verified against the manifest; a mismatch is never written. Prover
// keys are not part of the artifact generation digest, so fetching them
// changes nothing a job or evidence row was pinned to, and the server needs
// no restart.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveContractPackage, missingProverKeys, verifierCircuits } from '@odatano/contract-kit/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('-'));
const fromIdx = args.indexOf('--from');
const from = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

if (!target || args.includes('-h') || args.includes('--help')) {
    console.log('usage: nightgate-fetch-keys <contract|package> [--from <zk-config base url>]');
    console.log('       fetches the missing keys/*.prover of an installed contract lineage package');
    process.exit(target ? 0 : 1);
}

function resolveTarget(spec) {
    const candidates = spec.startsWith('@') ? [spec] : [`@odatano/contract-${spec}`, spec];
    const errors = [];
    for (const name of candidates) {
        for (const from of [process.cwd(), pkgRoot]) {
            try { return resolveContractPackage(name, from); } catch (e) { errors.push(`${name}: ${e.message}`); }
        }
    }
    console.error(`nightgate-fetch-keys: '${spec}' is not an installed contract package:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}

const resolved = resolveTarget(target);
const circuits = verifierCircuits(resolved.zkConfigPath);
const missing = missingProverKeys(resolved.zkConfigPath);
if (missing.length === 0) {
    console.log(`nightgate-fetch-keys: ${resolved.name}@${resolved.version} already has all ${circuits.length} prover keys, nothing to do`);
    process.exit(0);
}

const registration = from
    ? { zkConfigPath: resolved.zkConfigPath, package: { zkAssetUrl: from, zkAssetLayout: 'zk-config' } }
    : { zkConfigPath: resolved.zkConfigPath, package: resolved.manifest };
const env = { ...process.env };
if (from) delete env.NIGHTGATE_ZK_ASSET_URL;

console.log(`nightgate-fetch-keys: ${missing.length} of ${circuits.length} prover keys missing for ${resolved.name}@${resolved.version}`);
console.log(`  into: ${path.join(resolved.zkConfigPath, 'keys')}`);

// Build output of the server tree; a raw C:\ path needs a file:// URL.
const { ensureProverKeys } = await import(pathToFileURL(path.join(pkgRoot, 'srv', 'submission', 'prover-keys.js')).href);
try {
    const result = await ensureProverKeys(resolved.manifest.name, registration, { env, log: (m) => console.log(`  ${m}`) });
    console.log(`nightgate-fetch-keys: ${resolved.name} complete (${result.fetched.length} key(s) fetched from ${result.source}), all keys verified against the manifest.`);
    console.log('  The artifact generation digest is unchanged; a running server picks the keys up on the next job.');
} catch (e) {
    console.error(`nightgate-fetch-keys: ${e?.message ?? e}`);
    process.exit(1);
}
