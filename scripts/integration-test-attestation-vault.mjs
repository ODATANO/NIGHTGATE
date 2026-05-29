// Drives end-to-end loading of the AttestationVault contract (T10-extended).
// Verifies:
//   1. The compiled artifact loads and exposes the three exported circuits
//      (attest, grantDisclosure, revokeDisclosure) plus the local_secret_key
//      witness slot on Witnesses<PS>.
//   2. CompiledContract.make + withWitnesses + withCompiledFileAssets composes
//      cleanly with a real witness built from a 32-byte session secret.
//   3. The witness factory returns deterministic [privateState, secret] tuples.
//
// This is the integration-side mirror of test/unit/contract-witnesses.test.ts
// — same shape of checks, but against the real Compact-emitted JS instead of
// a hand-rolled stub. Run: node scripts/integration-test-attestation-vault.mjs

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js');
const zkConfigPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault');

let failures = 0;
function ok(name, value, detail) {
    if (!value) {
        console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
        failures++;
    } else {
        console.log(`OK   ${name}`);
    }
}

// ---- Check 1: artifact shape ---------------------------------------------
const mod = await import(pathToFileURL(artifactPath).href);
const ContractClass = mod.Contract ?? mod.default ?? mod;
ok('artifact: Contract is constructor',   typeof ContractClass === 'function');
ok('artifact: ledger fn exposed',         typeof mod.ledger === 'function');
ok('artifact: pureCircuits exposed',      mod.pureCircuits !== undefined);

// Inspect a freshly-constructed Contract for the expected circuit shape.
// We use a stub witness here — the real one is plumbed by the worker.
const stubSecret = new Uint8Array(32);
const stubWitnesses = {
    local_secret_key(ctx) { return [ctx.privateState, stubSecret]; },
    attested_value(ctx)   { return [ctx.privateState, 0n]; },
    value_salt(ctx)       { return [ctx.privateState, new Uint8Array(32)]; }
};
const instance = new ContractClass(stubWitnesses);
ok('artifact: attest circuit present',           typeof instance.circuits?.attest           === 'function');
ok('artifact: grantDisclosure circuit present',  typeof instance.circuits?.grantDisclosure  === 'function');
ok('artifact: revokeDisclosure circuit present', typeof instance.circuits?.revokeDisclosure === 'function');
// ZK-predicate circuits (on-chain model).
ok('artifact: commitValue circuit present',      typeof instance.circuits?.commitValue      === 'function');
ok('artifact: provePredicate circuit present',   typeof instance.circuits?.provePredicate   === 'function');
ok('artifact: witness slot wired',                instance.witnesses === stubWitnesses);

// ---- Check 2: CompiledContract composition --------------------------------
let compactJs;
try {
    compactJs = await import('@midnight-ntwrk/compact-js');
} catch (err) {
    console.error('FAIL @midnight-ntwrk/compact-js failed to load:', err.message);
    process.exit(1);
}
const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
ok('compact-js: CompiledContract.make resolves', typeof CompiledContract?.make === 'function');

const composed = CompiledContract.make('attestation-vault', ContractClass).pipe(
    CompiledContract.withWitnesses(stubWitnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath)
);
ok('compose: pipe with witnesses + assets returns CompiledContract', composed != null);
ok('compose: assets path preserved',
    CompiledContract.getCompiledAssetsPath(composed) === zkConfigPath);

// ---- Check 3: real witness factory ----------------------------------------
// The TS source lives in srv/submission/contract-witnesses.ts; we test against
// the compiled .js. Falls back to a clear hint if `npm run build` was skipped.
const witnessJsPath = path.join(repoRoot, 'srv/submission/contract-witnesses.js');
let witnesses;
try {
    witnesses = await import(pathToFileURL(witnessJsPath).href);
} catch (err) {
    console.error('FAIL could not load contract-witnesses.js. Run `npm run build` first.');
    console.error('     err:', err.message);
    process.exit(1);
}

const seed = new Uint8Array(32).fill(0x77);
const secret = witnesses.deriveAttestationSecret(seed);
ok('factory: derived secret is 32 bytes', secret.byteLength === 32);

const built = witnesses.buildAttestationVaultWitnesses({ attestationSecret: secret });
ok('factory: built object has local_secret_key', typeof built.local_secret_key === 'function');
ok('factory: built object has attested_value',   typeof built.attested_value === 'function');
ok('factory: built object has value_salt',        typeof built.value_salt === 'function');

// ---- Check 4: per-call predicate witnesses (commitValue/provePredicate) ---
const predCtx = { privateState: { foo: 'bar' }, ledger: {}, contractAddress: 'addr-stub' };
const SALT_HEX = 'a'.repeat(64);
const predBuilt = witnesses.buildAttestationVaultWitnesses({
    attestationSecret: secret,
    witnessValues: { attestedValue: '47300', valueSalt: SALT_HEX }
});
const [, av] = predBuilt.attested_value(predCtx);
ok('predicate: attested_value returns the bigint value', av === 47300n, `got ${av}`);
const [, vs] = predBuilt.value_salt(predCtx);
ok('predicate: value_salt returns 32 bytes', vs instanceof Uint8Array && vs.byteLength === 32);
ok('predicate: value_salt round-trips the hex', Buffer.from(vs).toString('hex') === SALT_HEX);

// Witnesses must refuse to fabricate values when none were supplied.
let threwAV = false;
try { built.attested_value(predCtx); } catch { threwAV = true; }
ok('predicate: attested_value throws without witnessValues', threwAV);

// Malformed salt must fail fast at build time.
let threwSalt = false;
try { witnesses.buildAttestationVaultWitnesses({ attestationSecret: secret, witnessValues: { attestedValue: '1', valueSalt: 'zz' } }); } catch { threwSalt = true; }
ok('predicate: malformed salt rejected at build', threwSalt);

const fakeCtx = { privateState: { foo: 'bar' }, ledger: {}, contractAddress: 'addr-stub' };
const [psOut, secretOut] = built.local_secret_key(fakeCtx);
ok('factory: privateState passed through',
    psOut === fakeCtx.privateState);
ok('factory: secret returned by witness === derived secret',
    Buffer.from(secretOut).toString('hex') === Buffer.from(secret).toString('hex'));

// Determinism: two factory invocations on the same seed yield same secret
const builtAgain = witnesses.buildAttestationVaultWitnesses({
    attestationSecret: witnesses.deriveAttestationSecret(seed)
});
const [, secretAgain] = builtAgain.local_secret_key(fakeCtx);
ok('factory: deterministic across rebuilds',
    Buffer.from(secretAgain).toString('hex') === Buffer.from(secret).toString('hex'));

console.log();
console.log(failures === 0
    ? 'AttestationVault artifact + witness factory wire end-to-end.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
