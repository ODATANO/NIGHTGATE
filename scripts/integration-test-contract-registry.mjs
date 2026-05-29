// Drives contract-registry resolution against the real compiled counter contract.
// Two checks:
//   1. Plain dynamic import of the artifact works (proves the JS is loadable).
//   2. The production resolveContract path returns the Contract class ,
//      same code that srv/submission/handlers.ts hits at runtime.
//
// Run: node scripts/integration-test-contract-registry.mjs

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactAbsPath = path.join(repoRoot, 'contracts/counter/src/managed/counter/contract/index.js');
const zkConfigPath    = path.join(repoRoot, 'contracts/counter/src/managed/counter');

let failures = 0;
function ok(name, value) {
    if (!value) { console.error(`FAIL ${name}: ${value}`); failures++; }
    else        console.log(`OK   ${name}`);
}

// ---- Check 1: plain dynamic import ----------------------------------------
const directMod = await import(pathToFileURL(artifactAbsPath).href);
const directContract = directMod.Contract ?? directMod.default ?? directMod;
ok('plain import: Contract class loaded',     directContract);
ok('plain import: Contract is constructor',   typeof directContract === 'function');
ok('plain import: pureCircuits exposed',      directMod.pureCircuits !== undefined);
ok('plain import: ledger fn exposed',         typeof directMod.ledger === 'function');

// ---- Check 2: production resolveContract via the registry -----------------
// Build the .ts files first if needed. We import the compiled .js (in-place
// output via tsconfig.build.json). Falls back to a clear error if missing.
const registryJsPath = path.join(repoRoot, 'srv/submission/contract-registry.js');
let registry;
try {
    registry = await import(pathToFileURL(registryJsPath).href);
} catch (err) {
    console.error('FAIL could not load contract-registry.js. Run `npm run build` first to compile srv/*.ts');
    console.error('     err:', err.message);
    process.exit(1);
}

registry.clearRegistry();
registry.registerContract('counter', {
    artifactPath: artifactAbsPath,
    privateStateId: 'counterPrivateState',
    zkConfigPath
});

const resolved = await registry.resolveContract('counter');
ok('registry: resolveContract returns object', resolved);
ok('registry: privateStateId preserved',       resolved.privateStateId === 'counterPrivateState');
ok('registry: zkConfigPath preserved',         resolved.zkConfigPath === zkConfigPath);
ok('registry: artifactPath surfaced',          resolved.artifactPath === artifactAbsPath);
// Since Phase 2b, resolveContract returns a CompiledContract wrapper (object
// with the `@midnight-ntwrk/compact-js` shape), not the raw Contract class.
ok('registry: compiledContract resolves to a wrapper object',
    resolved.compiledContract && typeof resolved.compiledContract === 'object');

console.log();
console.log(failures === 0 ? 'Contract artifact resolves through the production registry path.' : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
