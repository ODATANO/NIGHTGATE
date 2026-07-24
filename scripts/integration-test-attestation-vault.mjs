// Drives end-to-end loading of the AttestationVault contract.
// Verifies:
//   1. The compiled artifact loads and exposes the three exported circuits
//      (attest, grantDisclosure, revokeDisclosure) plus the local_secret_key
//      witness slot on Witnesses<PS>.
//   2. CompiledContract.make + withWitnesses + withCompiledFileAssets composes
//      cleanly with a real witness built from a 32-byte session secret.
//   3. The witness factory returns deterministic [privateState, secret] tuples.
//
// This is the integration-side mirror of test/unit/contract-witnesses.test.ts:
// same shape of checks, but against the real Compact-emitted JS instead of
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
// We use a stub witness here; the real one is plumbed by the worker.
const stubSecret = new Uint8Array(32);
const zero32 = () => new Uint8Array(32);
const stubWitnesses = {
    local_secret_key(ctx) { return [ctx.privateState, stubSecret]; },
    attested_value(ctx)   { return [ctx.privateState, 0n]; },
    value_salt(ctx)       { return [ctx.privateState, zero32()]; },
    field_value(ctx)      { return [ctx.privateState, 0n]; },
    merkle_siblings(ctx)  { return [ctx.privateState, [zero32(), zero32(), zero32(), zero32()]]; },
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; }
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

// ---- Check 5: attest ownership-takeover guard ------------------------------
// Drives the REAL emitted circuits locally (compact-runtime, no chain/proofs).
// Regression for the Map.insert-overwrite takeover: re-attesting a known
// payload_hash must throw "already attested" instead of silently replacing
// attestation_owners (which would let the attacker pass every owner-gated
// assert: grantDisclosure / revokeDisclosure / commitValue / bindPassport /
// anchorContentRoot).
const rt = await import('@midnight-ntwrk/compact-runtime');
const bytes32 = (fill) => new Uint8Array(32).fill(fill);

const ownerSecret = bytes32(0x11);
const attackerSecret = bytes32(0x22);
const makeWitnesses = (secretBytes) => ({
    local_secret_key(ctx) { return [ctx.privateState, secretBytes]; },
    attested_value(ctx)   { return [ctx.privateState, 0n]; },
    value_salt(ctx)       { return [ctx.privateState, bytes32(0)]; },
    field_value(ctx)      { return [ctx.privateState, 0n]; },
    merkle_siblings(ctx)  { return [ctx.privateState, [bytes32(0), bytes32(0), bytes32(0), bytes32(0)]]; },
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; }
});
const ownerContract = new ContractClass(makeWitnesses(ownerSecret));
const attackerContract = new ContractClass(makeWitnesses(attackerSecret));

const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
const init = ownerContract.initialState(ctorCtx);
let circuitCtx = rt.createCircuitContext(
    rt.dummyContractAddress(),
    ctorCtx.initialZswapLocalState.coinPublicKey,
    init.currentContractState.data,
    init.currentPrivateState
);
function runCircuit(contract, name, ...args) {
    const out = contract.impureCircuits[name](circuitCtx, ...args);
    circuitCtx = out.context; // thread the mutated context forward
    return out;
}

const payloadHash = bytes32(0xaa);
runCircuit(ownerContract, 'attest', payloadHash, bytes32(0xbb));
runCircuit(ownerContract, 'grantDisclosure', payloadHash, bytes32(0xcc), 2n);

let reAttestError = '';
try {
    runCircuit(attackerContract, 'attest', payloadHash, bytes32(0xdd));
} catch (err) {
    reAttestError = String(err?.message ?? err);
}
ok('guard: re-attest of existing payload_hash rejected',
    reAttestError.includes('already attested'), reAttestError || 'did NOT throw');

let takeoverError = '';
try {
    runCircuit(attackerContract, 'revokeDisclosure', payloadHash, bytes32(0xcc));
} catch (err) {
    takeoverError = String(err?.message ?? err);
}
ok('guard: non-owner still fails owner-gated circuit',
    takeoverError.includes('not attester'), takeoverError || 'did NOT throw');

const ownerLedger = mod.ledger(circuitCtx.currentQueryContext.state);
ok('guard: grant made before the takeover attempt survives',
    ownerLedger.disclosures.lookup(payloadHash).member(bytes32(0xcc)) === true);

// Fresh hashes still attest normally (incl. a second attester on their own hash).
let freshError = '';
try {
    runCircuit(attackerContract, 'attest', bytes32(0xee), bytes32(0xff));
} catch (err) {
    freshError = String(err?.message ?? err);
}
ok('guard: fresh payload_hash still attests', freshError === '', freshError);

// ---- Check 6: bindPassport rebind-takeover guard ---------------------------
// Sibling of check 5 on passport_bindings: without the guard, ANY attester
// (the attacker owns 0xee from check 5) could re-bind an already-bound
// passportId onto their own attestation, hijacking the QR resolution.
// Same-owner rebinding must stay allowed.
const passportId = bytes32(0x77);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

let bindError = '';
try {
    runCircuit(ownerContract, 'bindPassport', passportId, payloadHash);
} catch (err) {
    bindError = String(err?.message ?? err);
}
ok('bind guard: first bind by attestation owner succeeds', bindError === '', bindError);

let hijackError = '';
try {
    runCircuit(attackerContract, 'bindPassport', passportId, bytes32(0xee));
} catch (err) {
    hijackError = String(err?.message ?? err);
}
ok('bind guard: foreign re-bind of a bound passportId rejected',
    hijackError.includes('passport bound by another attester'), hijackError || 'did NOT throw');

const boundLedger = mod.ledger(circuitCtx.currentQueryContext.state);
ok('bind guard: binding still points at the owner attestation',
    sameBytes(boundLedger.passport_bindings.lookup(passportId), payloadHash));

// Same owner may re-bind the passport to a NEWER attestation of their own.
const newPayloadHash = bytes32(0xab);
let rebindError = '';
try {
    runCircuit(ownerContract, 'attest', newPayloadHash, bytes32(0xbc));
    runCircuit(ownerContract, 'bindPassport', passportId, newPayloadHash);
} catch (err) {
    rebindError = String(err?.message ?? err);
}
ok('bind guard: same-owner rebind still allowed', rebindError === '', rebindError);

const rebindLedger = mod.ledger(circuitCtx.currentQueryContext.state);
ok('bind guard: rebind updated the binding',
    sameBytes(rebindLedger.passport_bindings.lookup(passportId), newPayloadHash));

// An unbound passportId binds normally for any attester on their OWN hash.
let attackerOwnBindError = '';
try {
    runCircuit(attackerContract, 'bindPassport', bytes32(0x78), bytes32(0xee));
} catch (err) {
    attackerOwnBindError = String(err?.message ?? err);
}
ok('bind guard: unbound passportId still binds', attackerOwnBindError === '', attackerOwnBindError);

// ---- Check 7: registrar-gated passport pre-registration --------------------
// registerPassport is registrar-only (the deployer identity, locked in by the
// constructor). A registered passportId may only be bound by its registered
// owner: blocks a foreign FIRST bind (squatting) and recovers an already-
// squatted id by rebinding over the foreign binding.
const regLedger = mod.ledger(circuitCtx.currentQueryContext.state);
const ownerId = regLedger.attestation_owners.lookup(payloadHash);
ok('registrar: constructor locked deployer as registrar',
    sameBytes(regLedger.registrar, ownerId));

let notRegistrarError = '';
try {
    runCircuit(attackerContract, 'registerPassport', bytes32(0x79), bytes32(0x01));
} catch (err) {
    notRegistrarError = String(err?.message ?? err);
}
ok('registrar: non-registrar registerPassport rejected',
    notRegistrarError.includes('not registrar'), notRegistrarError || 'did NOT throw');

// Pre-registration blocks a foreign FIRST bind of a still-unbound id.
runCircuit(ownerContract, 'registerPassport', bytes32(0x79), ownerId);
let preRegError = '';
try {
    runCircuit(attackerContract, 'bindPassport', bytes32(0x79), bytes32(0xee));
} catch (err) {
    preRegError = String(err?.message ?? err);
}
ok('registrar: foreign first bind of a registered id rejected',
    preRegError.includes('not passport owner'), preRegError || 'did NOT throw');

let regBindError = '';
try {
    runCircuit(ownerContract, 'bindPassport', bytes32(0x79), newPayloadHash);
} catch (err) {
    regBindError = String(err?.message ?? err);
}
ok('registrar: registered owner binds their id', regBindError === '', regBindError);

// Squatter recovery: 0x78 was squatted (unregistered) by the attacker in
// check 6. Registering it to the owner lets the owner rebind OVER the
// attacker's binding, which the unregistered rebind guard alone forbids.
runCircuit(ownerContract, 'registerPassport', bytes32(0x78), ownerId);
let recoveryError = '';
try {
    runCircuit(ownerContract, 'bindPassport', bytes32(0x78), newPayloadHash);
} catch (err) {
    recoveryError = String(err?.message ?? err);
}
ok('registrar: registered owner rebinds over a squatted binding',
    recoveryError === '', recoveryError);
const recoveredLedger = mod.ledger(circuitCtx.currentQueryContext.state);
ok('registrar: recovery updated the binding',
    sameBytes(recoveredLedger.passport_bindings.lookup(bytes32(0x78)), newPayloadHash));

console.log();
console.log(failures === 0
    ? 'AttestationVault artifact + witness factory wire end-to-end.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
