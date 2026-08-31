// Builds `@odatano/nightgate-tx` (packages/nightgate-tx) out of THIS tree.
//
// The slim package is the caller half of cross-server fee sponsoring on its
// own: build + prove + sign a Midnight contract transaction locally, hand the
// fee-unpaid bytes to a sponsor. It carries under 1 MB instead of the main
// package's 88 MB, because the 78 MB of prover keys are fetched from a public
// /zk-config at runtime (which is what the txbuilder does anyway, and what
// pins the artifact generation to the sponsor's deployed contract).
//
// There is NO second source tree: every file is copied from here, at the SAME
// relative path, so the relative requires inside them keep working untouched.
// Only the doc/identity strings are rewritten to the slim package name.
//
// Run AFTER `npm run build` (the .js twins of the two srv/ helpers are build
// output). `npm run check:slim` builds and then verifies the result.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile, mkdir, rm, access, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'nightgate-tx');
const VAULT = 'contracts/attestation-vault/src/managed/attestation-vault';
const VAULT32 = 'contracts/attestation-vault-32/src/managed/attestation-vault-32';

/**
 * Everything the slim package ships, as repo-relative paths. `required: false`
 * marks type twins that are nice to have but not load-bearing.
 */
const FILES = [
    // the SDK entry + hosted-endpoint client
    { path: 'src/sdk/index.mjs' },
    { path: 'src/sdk/index.d.ts' },
    { path: 'src/sdk/client.mjs' },
    { path: 'src/sdk/client.d.ts' },
    // the local builder + self-funded submission
    { path: 'src/txbuilder/index.mjs' },
    { path: 'src/txbuilder/index.d.ts' },
    { path: 'src/txbuilder/submit.mjs' },
    // the call/witness helpers (identical to @odatano/nightgate/browser)
    { path: 'src/browser/index.mjs' },
    { path: 'src/browser/index.d.ts' },
    { path: 'src/browser/attestation-vault-calls.mjs' },
    { path: 'src/browser/witnesses.mjs' },
    { path: 'src/browser/witnesses.d.ts' },
    { path: 'src/browser/private-state.mjs' },
    { path: 'src/browser/providers.mjs' },
    { path: 'src/browser/providers.d.mts' },
    { path: 'src/browser/zk-config.mjs' },
    // two helpers the builder requires by relative path (BUILD OUTPUT)
    { path: 'srv/utils/wallet-hd.js', buildOutput: true },
    { path: 'srv/utils/wallet-hd.d.ts', buildOutput: true },
    { path: 'srv/midnight/wasm-proof-provider.js', buildOutput: true },
    { path: 'srv/midnight/wasm-proof-provider.d.ts', buildOutput: true },
    // Batch path (0.19): buildSponsorable({ calls }) requires the scope +
    // segment-order helpers (dependency-clean, no CAP, no worker).
    { path: 'srv/midnight/batch-call-scope.js', buildOutput: true },
    { path: 'srv/midnight/batch-call-scope.d.ts', buildOutput: true },
    { path: 'srv/midnight/batch-segment-order.js', buildOutput: true },
    { path: 'srv/midnight/batch-segment-order.d.ts', buildOutput: true },
    // the canonical membership-set rule (already a public subpath of the main
    // package); both are @noble/hashes only, no CAP, no registry.
    { path: 'srv/submission/set-root.js', buildOutput: true },
    { path: 'srv/submission/set-root.d.ts', buildOutput: true },
    { path: 'srv/submission/hashing.js', buildOutput: true },
    { path: 'srv/submission/hashing.d.ts', buildOutput: true },
    // the compiled contract class. NOT keys/ or zkir/: those are the 78 MB the
    // builder fetches from the sponsor's /zk-config, generation-pinned.
    { path: `${VAULT}/contract/index.js` },
    { path: `${VAULT}/contract/index.d.ts` },
    // 32-slot width variant (0.19): same rule, module only, keys via /zk-config.
    { path: `${VAULT32}/contract/index.js` },
    { path: `${VAULT32}/contract/index.d.ts` },
    { path: 'LICENSE' }
];

/** Doc + identity strings that must name the slim package, not NIGHTGATE. */
const REWRITES = [
    [/@odatano\/nightgate\/browser\/attestation-vault/g, '@odatano/nightgate-tx/attestation-vault'],
    [/@odatano\/nightgate\/txbuilder/g, '@odatano/nightgate-tx/txbuilder'],
    [/@odatano\/nightgate\/client/g, '@odatano/nightgate-tx/client'],
    [/@odatano\/nightgate\/browser/g, '@odatano/nightgate-tx/calls'],
    [/@odatano\/nightgate\/set-root/g, '@odatano/nightgate-tx/set-root']
];

const exists = (p) => access(p).then(() => true, () => false);

async function dirSize(dir) {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        // A local dev link (example/node_modules) points back at this package.
        if (entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
    }
    return total;
}

async function main() {
    const pkg = JSON.parse(await readFile(join(OUT, 'package.json'), 'utf8'));

    // Wipe only the GENERATED trees; package.json and README are tracked files.
    for (const d of ['src', 'srv', 'contracts']) await rm(join(OUT, d), { recursive: true, force: true });
    await rm(join(OUT, 'LICENSE'), { force: true });

    let copied = 0, bytes = 0, rewritten = 0;
    const missingBuildOutput = [];
    for (const { path, buildOutput } of FILES) {
        const from = join(ROOT, path);
        if (!(await exists(from))) {
            if (buildOutput) { missingBuildOutput.push(path); continue; }
            throw new Error(`build-slim-package: missing source file ${path}`);
        }
        const to = join(OUT, path);
        await mkdir(dirname(to), { recursive: true });

        if (/\.(mjs|js|ts|mts)$/.test(path)) {
            let text = await readFile(from, 'utf8');
            const before = text;
            for (const [re, to_] of REWRITES) text = text.replace(re, to_);
            if (text !== before) rewritten++;
            await writeFile(to, text);
            bytes += Buffer.byteLength(text);
        } else {
            const buf = await readFile(from);
            await writeFile(to, buf);
            bytes += buf.length;
        }
        copied++;
    }

    // The compiled contract class is ESM while this package is commonjs. Node
    // decides that per nearest package.json, so the contract tree needs its own
    // `"type": "module"` marker (the main package ships the contract's real
    // package.json for exactly this reason).
    for (const vault of ['attestation-vault', 'attestation-vault-32']) {
        const marker = join(OUT, 'contracts', vault, 'package.json');
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, JSON.stringify({
            name: `@odatano/nightgate-tx-contract-${vault}`,
            type: 'module',
            main: `src/managed/${vault}/contract/index.js`
        }, null, 4) + String.fromCharCode(10));
        copied++;
    }

    if (missingBuildOutput.length) {
        throw new Error(
            'build-slim-package: these are BUILD OUTPUT and are missing; run `npm run build` first:\n  - '
            + missingBuildOutput.join('\n  - ')
        );
    }

    // A stale `@odatano/nightgate` reference would send consumers to a package
    // they deliberately did not install.
    const leftovers = [];
    for (const { path } of FILES) {
        if (!/\.(mjs|js|ts|mts)$/.test(path)) continue;
        const text = await readFile(join(OUT, path), 'utf8');
        if (/@odatano\/nightgate(?!-tx)/.test(text)) leftovers.push(path);
        // Only a real import counts; `src/browser/index.mjs` documents in a
        // comment that it deliberately does NOT touch CAP.
        if (/(from|require\()\s*['"]@sap\/cds/.test(text)) leftovers.push(`${path} (imports @sap/cds)`);
    }
    if (leftovers.length) {
        throw new Error('build-slim-package: unrewritten references:\n  - ' + leftovers.join('\n  - '));
    }

    const total = await dirSize(OUT);
    console.log(`build-slim-package: ${pkg.name}@${pkg.version}`);
    console.log(`  ${copied} files copied (${rewritten} with rewritten package names)`);
    console.log(`  payload ${(bytes / 1024).toFixed(0)} KB, package dir ${(total / 1024).toFixed(0)} KB`);
    console.log(`  out: ${relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
