// Builds @odatano/nightgate-tx into packages/nightgate-tx by copying files from this tree at the same relative paths.
// Run after `npm run build`: node scripts/build-slim-package.mjs (`npm run check:slim` builds and verifies)
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile, mkdir, rm, access, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'nightgate-tx');

// Repo-relative paths the slim package ships; `required: false` marks optional type twins.
const FILES = [
    // the SDK entry + hosted-endpoint client
    { path: 'src/sdk/index.mjs' },
    { path: 'src/sdk/index.d.ts' },
    { path: 'src/sdk/client.mjs' },
    { path: 'src/sdk/client.d.ts' },
    { path: 'src/sdk/receipt.mjs' },
    // the local builder + self-funded submission
    { path: 'src/txbuilder/index.mjs' },
    { path: 'src/txbuilder/index.d.ts' },
    { path: 'src/txbuilder/internals.mjs' },
    { path: 'src/txbuilder/submit.mjs' },
    { path: 'src/txbuilder/api-provider.mjs' },
    { path: 'src/txbuilder/swap.mjs' },
    { path: 'src/txbuilder/unshielded.mjs' },
    { path: 'src/txbuilder/prover-material.mjs' },
    { path: 'src/txbuilder/wallet-tx.mjs' },
    { path: 'src/txbuilder/holder.mjs' },
    { path: 'src/txbuilder/holder.d.mts' },
    { path: 'src/txbuilder/factory.mjs' },
    { path: 'src/txbuilder/factory.d.mts' },
    // the call and witness helpers, implemented in @odatano/contract-kit, and the vault contracts
    { path: 'src/browser/attestation-vault.mjs' },
    { path: 'src/browser/attestation-vault.d.mts' },
    { path: 'src/browser/attestation-vault-32.mjs' },
    { path: 'src/browser/attestation-vault-32.d.mts' },
    { path: 'src/browser/index.mjs' },
    { path: 'src/browser/index.d.ts' },
    { path: 'src/browser/attestation-vault-calls.mjs' },
    { path: 'src/browser/witnesses.mjs' },
    { path: 'src/browser/witnesses.d.ts' },
    { path: 'src/browser/witnesses.d.mts' },
    { path: 'src/browser/hex.mjs' },
    { path: 'src/browser/hex.d.mts' },
    { path: 'src/browser/private-state.mjs' },
    { path: 'src/browser/providers.mjs' },
    { path: 'src/browser/providers.d.mts' },
    { path: 'src/browser/contract.mjs' },
    { path: 'src/browser/contract.d.mts' },
    // helpers the builder requires by relative path (BUILD OUTPUT)
    { path: 'srv/utils/wallet-hd.js', buildOutput: true },
    { path: 'srv/utils/wallet-hd.d.ts', buildOutput: true },
    { path: 'srv/utils/indexer-url.js', buildOutput: true },
    { path: 'srv/utils/indexer-url.d.ts', buildOutput: true },
    { path: 'srv/utils/hex-patterns.js', buildOutput: true },
    { path: 'srv/utils/hex-patterns.d.ts', buildOutput: true },
    { path: 'srv/utils/indexer-graphql.js', buildOutput: true },
    { path: 'srv/utils/indexer-graphql.d.ts', buildOutput: true },
    { path: 'srv/utils/runtime-version.js', buildOutput: true },
    { path: 'srv/utils/runtime-version.d.ts', buildOutput: true },
    { path: 'srv/utils/fetch-body.js', buildOutput: true },
    { path: 'srv/utils/fetch-body.d.ts', buildOutput: true },
    // offer files and addresses (bech32m); @scure/base only
    { path: 'srv/utils/bech32m.js', buildOutput: true },
    { path: 'srv/utils/bech32m.d.ts', buildOutput: true },
    { path: 'srv/utils/offer-file.js', buildOutput: true },
    { path: 'srv/utils/offer-file.d.ts', buildOutput: true },
    { path: 'srv/utils/midnight-address.js', buildOutput: true },
    { path: 'srv/utils/midnight-address.d.ts', buildOutput: true },
    // errorMessage(), imported by offer-file; the function itself lives in src/shared
    { path: 'srv/utils/errors.js', buildOutput: true },
    { path: 'srv/utils/errors.d.ts', buildOutput: true },
    { path: 'src/shared/error-message.mjs', buildOutput: true },
    { path: 'src/shared/error-message.d.mts', buildOutput: true },
    { path: 'srv/midnight/runtime-config.js', buildOutput: true },
    { path: 'srv/midnight/runtime-config.d.ts', buildOutput: true },
    { path: 'srv/midnight/wasm-proof-provider.js', buildOutput: true },
    { path: 'srv/midnight/wasm-proof-provider.d.ts', buildOutput: true },
    // Batch path: the scope runner, the segment order and the gas check.
    // The builder and the browser runner load the same files.
    { path: 'src/shared/batch-call-scope.mjs', buildOutput: true },
    { path: 'src/shared/batch-call-scope.d.mts', buildOutput: true },
    { path: 'src/shared/batch-segment-order.mjs', buildOutput: true },
    { path: 'src/shared/batch-segment-order.d.mts', buildOutput: true },
    { path: 'src/shared/batch-gas-preflight.mjs', buildOutput: true },
    { path: 'src/shared/batch-gas-preflight.d.mts', buildOutput: true },
    // the canonical membership-set rule, a re-export of @odatano/contract-kit
    { path: 'srv/submission/set-root.js', buildOutput: true },
    { path: 'srv/submission/set-root.d.ts', buildOutput: true },
    { path: 'LICENSE' }
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

    let copied = 0, bytes = 0;
    const missingBuildOutput = [];
    for (const { path, buildOutput } of FILES) {
        const from = join(ROOT, path);
        if (!(await exists(from))) {
            if (buildOutput) { missingBuildOutput.push(path); continue; }
            throw new Error(`build-slim-package: missing source file ${path}`);
        }
        const to = join(OUT, path);
        await mkdir(dirname(to), { recursive: true });

        const buf = await readFile(from);
        await writeFile(to, buf);
        bytes += buf.length;
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
        throw new Error('build-slim-package: files that name @odatano/nightgate or import CAP:\n  - ' + leftovers.join('\n  - '));
    }

    const total = await dirSize(OUT);
    console.log(`build-slim-package: ${pkg.name}@${pkg.version}`);
    console.log(`  ${copied} files copied`);
    console.log(`  payload ${(bytes / 1024).toFixed(0)} KB, package dir ${(total / 1024).toFixed(0)} KB`);
    console.log(`  out: ${relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
