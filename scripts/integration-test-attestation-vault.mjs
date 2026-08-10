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
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; },
    field_digest(ctx)     { return [ctx.privateState, zero32()]; },
    set_siblings(ctx)     { return [ctx.privateState, [zero32(), zero32(), zero32(), zero32(), zero32(), zero32()]]; },
    set_dirs(ctx)         { return [ctx.privateState, [true, true, true, true, true, true]]; }
};
const instance = new ContractClass(stubWitnesses);
ok('artifact: attest circuit present',           typeof instance.circuits?.attest           === 'function');
ok('artifact: grantDisclosure circuit present',  typeof instance.circuits?.grantDisclosure  === 'function');
ok('artifact: revokeDisclosure circuit present', typeof instance.circuits?.revokeDisclosure === 'function');
// ZK-predicate circuits (on-chain model).
ok('artifact: commitValue circuit present',      typeof instance.circuits?.commitValue      === 'function');
ok('artifact: provePredicate circuit present',   typeof instance.circuits?.provePredicate   === 'function');
// Bytes claim circuits (0.15.0) + their pure leaf hashers.
ok('artifact: proveFieldEquality circuit present',   typeof instance.circuits?.proveFieldEquality   === 'function');
ok('artifact: proveFieldMembership circuit present', typeof instance.circuits?.proveFieldMembership === 'function');
ok('artifact: bytesLeafHash pure circuit exposed',   typeof mod.pureCircuits?.bytesLeafHash === 'function');
ok('artifact: setLeafHash pure circuit exposed',     typeof mod.pureCircuits?.setLeafHash === 'function');
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
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; },
    field_digest(ctx)     { return [ctx.privateState, bytes32(0)]; },
    set_siblings(ctx)     { return [ctx.privateState, [bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)]]; },
    set_dirs(ctx)         { return [ctx.privateState, [true, true, true, true, true, true]]; }
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

// ---- Check 8: bytes equality + set membership against REAL circuits --------
// Drives proveFieldEquality / proveFieldMembership locally over a content root
// and set root built by the PRODUCTION builders (document-proof.js + set-root.js)
// with the artifact's real pure circuits, then asserts the recorded claim keys
// byte-match the hand-built descriptors in predicate-state.js. This closes the
// off-chain/in-circuit parity loop without a chain.
const dp = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/document-proof.js')).href);
const sr = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/set-root.js')).href);
const ps = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/predicate-state.js')).href);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

const document = {
    chemistry: 'NMC811', origin: 'EEA', capacity: 42,
    // Adversarial fixture: the PRE-FIX padding label as a real field value.
    sneaky: 'nightgate/set-root/empty/v1'
};
const built8 = dp.buildDocumentContentRoot(document, [
    { field: 'chemistry', kind: 'bytes' },
    { field: 'origin', kind: 'bytes' },
    { field: 'capacity' },
    { field: 'sneaky', kind: 'bytes' }
], mod.pureCircuits);
const chem = built8.fields.find((f) => f.field === 'chemistry');
const origin = built8.fields.find((f) => f.field === 'origin');
ok('bytes: builder emitted digests for bytes fields', !!chem?.valueDigest && !!origin?.valueDigest);

const bytesPayload = bytes32(0xcd);
const bytesPayloadHex = Buffer.from(bytesPayload).toString('hex');
runCircuit(ownerContract, 'attest', bytesPayload, bytes32(0xce));
runCircuit(ownerContract, 'anchorContentRoot', bytesPayload, hexToBytes(built8.contentRoot));

// Equality: prove chemistry == digest('NMC811') via a bundle-built witness set.
const eqContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { siblings: chem.siblings, dirs: chem.dirs }
}));
let eqError = '';
try {
    runCircuit(eqContract, 'proveFieldEquality',
        bytesPayload, hexToBytes(chem.fieldKey), hexToBytes(chem.valueDigest));
} catch (err) {
    eqError = String(err?.message ?? err);
}
ok('bytes: proveFieldEquality accepts the anchored digest', eqError === '', eqError);

let eqWrongError = '';
try {
    runCircuit(eqContract, 'proveFieldEquality',
        bytesPayload, hexToBytes(chem.fieldKey), bytes32(0x01));
} catch (err) {
    eqWrongError = String(err?.message ?? err);
}
ok('bytes: proveFieldEquality rejects a wrong expected digest',
    eqWrongError.includes('field not in passport'), eqWrongError || 'did NOT throw');

// Membership: origin ('EEA') is in the allow-list; wrong set root rejected.
const allowList = ['EEA', 'CH', 'NO'];
const memberPath = sr.membershipPathFor(allowList, origin.valueDigest, mod.pureCircuits);
ok('bytes: membershipPathFor finds the member', memberPath !== null);
const memContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: {
        fieldDigest: origin.valueDigest,
        siblings: origin.siblings, dirs: origin.dirs,
        setProof: { siblings: memberPath.setSiblings, dirs: memberPath.setDirs }
    }
}));
let memError = '';
try {
    runCircuit(memContract, 'proveFieldMembership',
        bytesPayload, hexToBytes(origin.fieldKey), hexToBytes(memberPath.setRoot));
} catch (err) {
    memError = String(err?.message ?? err);
}
ok('bytes: proveFieldMembership accepts a member with the canonical set root', memError === '', memError);

let memWrongError = '';
try {
    runCircuit(memContract, 'proveFieldMembership',
        bytesPayload, hexToBytes(origin.fieldKey), bytes32(0x02));
} catch (err) {
    memWrongError = String(err?.message ?? err);
}
ok('bytes: proveFieldMembership rejects a wrong set root',
    memWrongError.includes('value not in set'), memWrongError || 'did NOT throw');

// ADVERSARIAL: the pre-fix padding label, anchored as a REAL field value,
// must NOT be provable as a member via a padding-slot path. Rebuild the
// canonical tree levels, extract the first padding slot's path, and drive
// the real circuit with the label's digest: the set fold must fail.
const sneaky = built8.fields.find((f) => f.field === 'sneaky');
const setDigests = sr.canonicalSetDigests(allowList);
const padLeaves = [];
for (let i = 0; i < sr.MAX_SET_VALUES; i++) {
    padLeaves.push(mod.pureCircuits.setLeafHash(hexToBytes(setDigests[i] ?? setDigests[setDigests.length - 1])));
}
const padLevels = [padLeaves];
for (let d = 0; d < sr.SET_DEPTH; d++) {
    const prev = padLevels[d];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(mod.pureCircuits.nodeHash(prev[i], prev[i + 1]));
    padLevels.push(next);
}
const padSlotPath = { siblings: [], dirs: [] };
let padNode = setDigests.length; // first padding slot
for (let d = 0; d < sr.SET_DEPTH; d++) {
    const isLeft = padNode % 2 === 0;
    padSlotPath.siblings.push(Buffer.from(padLevels[d][isLeft ? padNode + 1 : padNode - 1]).toString('hex'));
    padSlotPath.dirs.push(isLeft);
    padNode = Math.floor(padNode / 2);
}
const attackContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: {
        fieldDigest: sneaky.valueDigest, // digest of the old padding label
        siblings: sneaky.siblings, dirs: sneaky.dirs,
        setProof: { siblings: padSlotPath.siblings, dirs: padSlotPath.dirs }
    }
}));
let padAttackError = '';
try {
    runCircuit(attackContract, 'proveFieldMembership',
        bytesPayload, hexToBytes(sneaky.fieldKey), hexToBytes(memberPath.setRoot));
} catch (err) {
    padAttackError = String(err?.message ?? err);
}
ok('bytes: ADVERSARIAL padding-label digest rejected via padding-slot path',
    padAttackError.includes('value not in set'), padAttackError || 'did NOT throw');

// Claim-key parity: the ledger entries must sit exactly where the hand-built
// descriptor recompute (crawler-free verification) expects them.
const bytesLedger = mod.ledger(circuitCtx.currentQueryContext.state);
const eqKey = await ps.computeFieldEqualityClaimKey(bytesPayloadHex, chem.fieldKey, chem.valueDigest);
ok('bytes: equality claim key recompute matches the circuit',
    bytesLedger.field_equality_results.member(hexToBytes(eqKey)) === true
    && bytesLedger.field_equality_results.lookup(hexToBytes(eqKey)) === true);
const memKey = await ps.computeFieldMembershipClaimKey(bytesPayloadHex, origin.fieldKey, memberPath.setRoot);
ok('bytes: membership claim key recompute matches the circuit',
    bytesLedger.field_membership_results.member(hexToBytes(memKey)) === true
    && bytesLedger.field_membership_results.lookup(hexToBytes(memKey)) === true);

console.log();
console.log(failures === 0
    ? 'AttestationVault artifact + witness factory wire end-to-end.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
