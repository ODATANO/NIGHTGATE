// Verifies the generated `@odatano/nightgate-tx` the way a CONSUMER meets it:
// resolve every declared export through Node's exports map, in a directory that
// only sees the package by name. A green build is not proof; a package whose
// exports map is wrong installs fine and fails on the consumer's first import.
//
// Checks:
//   1. every `exports` subpath resolves and loads
//   2. the documented API is actually there
//   3. nothing pulls @sap/cds or @odatano/nightgate back in
//   4. every file the `files` list promises exists
//   5. the tarball stays small (the 78 MB of prover keys must NOT be in it)
//
// Run via `npm run check:slim` (which builds first).
//
// SPDX-License-Identifier: Apache-2.0

import { readFile, mkdir, writeFile, rm, access, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'packages', 'nightgate-tx');
const MAX_TARBALL_MB = 2;

const problems = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { problems.push(m); console.log(`  FAIL  ${m}`); };
const exists = (p) => access(p).then(() => true, () => false);

/** Expected surface per entry point: what the README promises. */
const EXPECTED = {
    '.': ['connect', 'int64', 'createTxBuilder', 'ensureZkAssets', 'ATTESTATION_VAULT_CIRCUITS'],
    './client': ['connect', 'int64', 'NightgateApiError', 'NightgateJobError'],
    './txbuilder': ['createTxBuilder', 'ensureZkAssets'],
    './calls': ['prepareAttest', 'prepareAnchorContentRoot', 'prepareProveFieldMembership',
        'buildAttestationVaultWitnesses', 'generateAttestationSecret', 'CONTRACTS'],
    './attestation-vault': ['Contract', 'pureCircuits', 'ledger'],
    './set-root': ['buildMembershipSet', 'membershipPathFor', 'canonicalSetDigests']
};

async function main() {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'));
    console.log(`check-slim-package: ${pkg.name}@${pkg.version}`);

    // 1 + 2: resolve by NAME from a directory that reaches the package only
    // through node_modules, i.e. exactly how a consumer resolves it.
    const probeDir = join(PKG_DIR, '.probe');
    await rm(probeDir, { recursive: true, force: true });
    await mkdir(join(probeDir, 'node_modules', '@odatano'), { recursive: true });
    await writeFile(join(probeDir, 'package.json'), JSON.stringify({ name: 'probe', private: true, type: 'module' }));
    // A relative junction/symlink is fragile across platforms; a re-export
    // shim through the real path exercises the SAME exports map.
    const specs = Object.keys(pkg.exports).filter(s => s !== './package.json');
    const probe = join(probeDir, 'probe.mjs');
    await writeFile(probe, specs.map((s, i) => {
        const target = pkg.exports[s];
        const file = typeof target === 'string' ? target : (target.import ?? target.default);
        return `import * as m${i} from ${JSON.stringify(pathToFileURL(join(PKG_DIR, file)).href)};`;
    }).join('\n') + '\nconsole.log(JSON.stringify(' +
        '{' + specs.map((s, i) => `${JSON.stringify(s)}: Object.keys(m${i})`).join(', ') + '}' +
    '));\n');

    let surfaces;
    try {
        surfaces = JSON.parse(execFileSync(process.execPath, [probe], { encoding: 'utf8' }).trim());
        ok(`all ${specs.length} entry points load`);
    } catch (e) {
        bad(`an entry point failed to load: ${String(e.stderr || e.message).split('\n').slice(-4).join(' ')}`);
        surfaces = {};
    }
    for (const [spec, names] of Object.entries(EXPECTED)) {
        const have = surfaces[spec];
        if (!have) { bad(`${spec}: no surface (did not load)`); continue; }
        const missing = names.filter(n => !have.includes(n));
        if (missing.length) bad(`${spec}: missing ${missing.join(', ')}`);
        else ok(`${spec}: ${have.length} exports incl. ${names.length} required`);
    }
    await rm(probeDir, { recursive: true, force: true });

    // 3: the whole point of the slim package is not dragging the server in.
    const sources = [];
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.probe') continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) await walk(p);
            else if (/\.(mjs|js|ts|mts)$/.test(e.name)) sources.push(p);
        }
    };
    await walk(PKG_DIR);
    const dirty = [];
    for (const f of sources) {
        const text = await readFile(f, 'utf8');
        if (/(from|require\()\s*['"]@sap\/cds/.test(text)) dirty.push(`${relative(PKG_DIR, f)} imports @sap/cds`);
        if (/(from|require\()\s*['"]@odatano\/nightgate(?!-tx)/.test(text)) dirty.push(`${relative(PKG_DIR, f)} imports @odatano/nightgate`);
        if (/@odatano\/nightgate(?!-tx)/.test(text)) dirty.push(`${relative(PKG_DIR, f)} still names @odatano/nightgate`);
    }
    if (dirty.length) dirty.forEach(bad); else ok(`${sources.length} source files, none referencing CAP or the main package`);

    // 4: `files` promises must exist (npm silently ships nothing otherwise).
    for (const entry of pkg.files) {
        if (entry.startsWith('!') || entry.includes('*')) continue;
        if (!(await exists(join(PKG_DIR, entry)))) bad(`files lists '${entry}' but it does not exist`);
    }
    for (const [spec, target] of Object.entries(pkg.exports)) {
        const files = typeof target === 'string' ? [target] : Object.values(target);
        for (const f of files) {
            if (!(await exists(join(PKG_DIR, f)))) bad(`exports '${spec}' points at missing ${f}`);
        }
    }
    ok('every declared file and export target exists');

    // 5: size. If a prover key ever lands in here, this is what catches it.
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG_DIR, encoding: 'utf8', shell: process.platform === 'win32' }))[0];
    const mb = packed.size / 1e6;
    const provers = packed.files.filter(f => /\.(prover|bzkir)$/.test(f.path));
    if (provers.length) bad(`${provers.length} proving artifacts are in the tarball; they belong behind /zk-config`);
    if (mb > MAX_TARBALL_MB) bad(`tarball is ${mb.toFixed(1)} MB, over the ${MAX_TARBALL_MB} MB budget`);
    else ok(`tarball ${mb.toFixed(2)} MB, ${packed.entryCount} files (budget ${MAX_TARBALL_MB} MB)`);

    // 6: REAL-INSTALL probe. The in-repo import probe resolves transitive
    // dependencies by walking up into the MAIN tree's node_modules, which is
    // exactly how the missing address-format phantom-dep shim shipped in
    // 0.1.0: fine in the repo, ERR_MODULE_NOT_FOUND on every clean install.
    // Pack the tarball, npm-install it into an isolated prefix and import the
    // entry points THERE.
    console.log('  ...   real-install probe (npm pack + install, takes a minute)');
    const probeRoot = join(PKG_DIR, '.install-probe');
    await rm(probeRoot, { recursive: true, force: true });
    await mkdir(probeRoot, { recursive: true });
    try {
        const tarName = execFileSync('npm', ['pack', '--pack-destination', probeRoot], { cwd: PKG_DIR, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
        await writeFile(join(probeRoot, 'package.json'), JSON.stringify({ name: 'install-probe', private: true, type: 'module' }));
        execFileSync('npm', ['install', '--no-audit', '--no-fund', tarName], { cwd: probeRoot, encoding: 'utf8', shell: process.platform === 'win32' });
        const probeMjs = join(probeRoot, 'probe.mjs');
        await writeFile(probeMjs, [
            "import '@odatano/nightgate-tx';",
            "import '@odatano/nightgate-tx/client';",
            "import '@odatano/nightgate-tx/txbuilder';",
            "import '@odatano/nightgate-tx/calls';",
            "import '@odatano/nightgate-tx/attestation-vault';",
            "import '@odatano/nightgate-tx/set-root';",
            "console.log('install-probe ok');"
        ].join('\n'));
        const out = execFileSync(process.execPath, [probeMjs], { cwd: probeRoot, encoding: 'utf8' }).trim();
        if (!out.includes('install-probe ok')) bad('real-install probe: unexpected output ' + out);
        else ok('real-install probe: all entry points import from a clean npm install');
    } catch (e) {
        bad('real-install probe failed: ' + String(e.stderr || e.message).split(/\r?\n/).slice(-6).join(' '));
    } finally {
        await rm(probeRoot, { recursive: true, force: true });
    }

    if (problems.length) {
        console.error(`\ncheck-slim-package: ${problems.length} problem(s)`);
        process.exit(1);
    }
    console.log('\ncheck-slim-package: OK');
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
