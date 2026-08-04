// Packaging guard: every declared export must be resolvable AND actually published.
//
// Why this exists: `src/browser/providers.d.mts` declared types for the deep specifier
// `@odatano/nightgate/browser/providers.mjs` while (a) that subpath was missing from
// `package.json#exports`, so Node and every bundler reject it with ERR_PACKAGE_PATH_NOT_EXPORTED,
// and (b) the `files` list covered `*.d.ts` but not `*.d.mts`, so the declaration would not have
// been in the tarball at all. Both are invisible in the repo — everything resolves fine from
// source — and only surface in a consumer's install. So the check runs against the REAL tarball
// contents (`npm pack --dry-run`), not against the working tree.
//
// Checks, per exports target (including every `types` condition):
//   1. the file exists on disk,
//   2. the file is included in the published tarball.
//
// Run: npm run check:exports
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let failed = false;

/** Collect every file path referenced by the exports map, with the subpath that referenced it. */
function collectTargets(node, subpath, out) {
    if (typeof node === 'string') {
        out.push({ subpath, target: node });
        return;
    }
    if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            // Nested subpaths start with '.', condition keys ('types', 'import', 'default') do not.
            collectTargets(value, key.startsWith('.') && key !== '.' ? `${subpath}${key.slice(1)}` : subpath, out);
        }
    }
}

const targets = [];
collectTargets(pkg.exports ?? {}, '.', targets);

// `npm pack --dry-run --json` reports exactly what would ship, `files` globs already applied.
let packed;
try {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
    });
    packed = new Set(JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, '/')));
} catch (e) {
    console.error(`check-package-exports: could not run "npm pack --dry-run": ${e.message}`);
    process.exit(1);
}

for (const { subpath, target } of targets) {
    const rel = target.replace(/^\.\//, '');
    if (!existsSync(rel)) {
        console.error(`check-package-exports: exports["${subpath}"] -> ${target} does not exist on disk.`);
        failed = true;
        continue;
    }
    if (!packed.has(rel)) {
        console.error(
            `check-package-exports: exports["${subpath}"] -> ${target} exists but is NOT published ` +
                `(no "files" entry matches it). Consumers would get ERR_MODULE_NOT_FOUND or untyped imports.`,
        );
        failed = true;
    }
}

if (failed) process.exit(1);
console.log(`check-package-exports: ok (${targets.length} export targets, all present and published)`);
