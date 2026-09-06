#!/usr/bin/env node
// Writes (or checks) keys/manifest.json for every shipped contract: sha256 and
// size of each prover key. The tarball ships the manifest and no prover key;
// the server fetches a missing key on first need and verifies it against the
// manifest (srv/submission/prover-keys.ts). The manifest is part of the
// artifact generation digest, the prover keys are not.
//
//   node scripts/write-key-manifest.mjs                  # write for every shipped contract
//   node scripts/write-key-manifest.mjs --check          # fail when a manifest is missing or stale
//   node scripts/write-key-manifest.mjs --check --require-keys   # also fail when a prover key is absent (image build)
//
// Run it after recompiling a contract, before committing the managed tree.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIPPED_CONTRACTS = ['counter', 'attestation-vault', 'attestation-vault-32', 'shielded-token'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function keysDirOf(contract, root = repoRoot) {
    return path.join(root, 'contracts', contract, 'src', 'managed', contract, 'keys');
}

export function buildManifest(keysDir) {
    const prover = {};
    for (const f of readdirSync(keysDir).filter(f => f.endsWith('.prover')).sort()) {
        const body = readFileSync(path.join(keysDir, f));
        prover[f.replace(/\.prover$/, '')] = { sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length };
    }
    return { version: 1, prover };
}

export function renderManifest(manifest) {
    return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * Problems with the shipped manifests: missing, stale against the prover
 * keys on disk, a verifier circuit without an entry, an entry without a
 * verifier, and (with requireKeys) a prover key that is not on disk.
 */
export function checkManifests({ requireKeys = false, root = repoRoot } = {}) {
    const problems = [];
    for (const contract of SHIPPED_CONTRACTS) {
        const keysDir = keysDirOf(contract, root);
        if (!existsSync(keysDir)) { problems.push(`${contract}: no keys directory at ${keysDir}`); continue; }
        const manifestPath = path.join(keysDir, 'manifest.json');
        if (!existsSync(manifestPath)) { problems.push(`${contract}: keys/manifest.json is missing (run: node scripts/write-key-manifest.mjs)`); continue; }
        let manifest;
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { problems.push(`${contract}: keys/manifest.json is not JSON: ${e.message}`); continue; }
        if (manifest?.version !== 1 || typeof manifest.prover !== 'object') { problems.push(`${contract}: keys/manifest.json has an unknown shape`); continue; }
        const circuits = readdirSync(keysDir).filter(f => f.endsWith('.verifier')).map(f => f.replace(/\.verifier$/, '')).sort();
        for (const c of circuits) {
            const entry = manifest.prover[c];
            if (!entry) { problems.push(`${contract}: circuit '${c}' has a verifier key but no manifest entry (stale manifest)`); continue; }
            const proverPath = path.join(keysDir, `${c}.prover`);
            if (!existsSync(proverPath)) {
                if (requireKeys) problems.push(`${contract}: prover key '${c}' is not on disk`);
                continue;
            }
            const body = readFileSync(proverPath);
            const sha256 = createHash('sha256').update(body).digest('hex');
            if (entry.sha256 !== sha256 || entry.bytes !== body.length) problems.push(`${contract}: manifest entry '${c}' does not match the prover key on disk (stale manifest)`);
        }
        for (const c of Object.keys(manifest.prover)) {
            if (!circuits.includes(c)) problems.push(`${contract}: manifest lists '${c}' but no verifier key exists for it`);
        }
    }
    return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
        const problems = checkManifests({ requireKeys: args.includes('--require-keys') });
        if (problems.length) {
            for (const p of problems) console.error(`write-key-manifest: ${p}`);
            process.exit(1);
        }
        console.log(`write-key-manifest: ${SHIPPED_CONTRACTS.length} manifests up to date`);
    } else {
        for (const contract of SHIPPED_CONTRACTS) {
            const keysDir = keysDirOf(contract);
            if (!existsSync(keysDir)) { console.error(`write-key-manifest: ${contract}: no keys directory at ${keysDir}`); process.exit(1); }
            const manifest = buildManifest(keysDir);
            const count = Object.keys(manifest.prover).length;
            const verifiers = readdirSync(keysDir).filter(f => f.endsWith('.verifier')).length;
            if (count !== verifiers) { console.error(`write-key-manifest: ${contract}: ${count} prover keys for ${verifiers} verifier keys; fetch or compile the missing ones before writing the manifest`); process.exit(1); }
            writeFileSync(path.join(keysDir, 'manifest.json'), renderManifest(manifest));
            console.log(`write-key-manifest: ${contract}: ${count} prover key(s)`);
        }
    }
}
