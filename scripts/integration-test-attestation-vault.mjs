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
    field_value(ctx)      { return [ctx.privateState, 0n]; },
    field_salt(ctx)       { return [ctx.privateState, zero32()]; },
    merkle_siblings(ctx)  { return [ctx.privateState, [zero32(), zero32(), zero32(), zero32()]]; },
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; },
    field_digest(ctx)     { return [ctx.privateState, zero32()]; },
    set_siblings(ctx)     { return [ctx.privateState, [zero32(), zero32(), zero32(), zero32(), zero32(), zero32()]]; },
    set_dirs(ctx)         { return [ctx.privateState, [true, true, true, true, true, true]]; },
    doc_schema(ctx)       { return [ctx.privateState, Array.from({ length: 16 }, () => ({ field_key: zero32(), kind: 2n, scale: 0n }))]; },
    doc_salt_a(ctx)       { return [ctx.privateState, zero32()]; },
    doc_salt_b(ctx)       { return [ctx.privateState, zero32()]; },
    doc_slots_a(ctx)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: zero32() }))]; },
    doc_slots_b(ctx)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: zero32() }))]; }
};
const instance = new ContractClass(stubWitnesses);
ok('artifact: attest circuit present',           typeof instance.circuits?.attest           === 'function');
ok('artifact: grantDisclosure circuit present',  typeof instance.circuits?.grantDisclosure  === 'function');
ok('artifact: revokeDisclosure circuit present', typeof instance.circuits?.revokeDisclosure === 'function');
// The commitment-only lane was REMOVED in 0.16.0 (overwritable commitment
// left stale claims verifiable); its circuits must be gone from the artifact.
ok('artifact: commitValue circuit removed',      instance.circuits?.commitValue === undefined);
ok('artifact: provePredicate circuit removed',   instance.circuits?.provePredicate === undefined);
ok('artifact: proveFieldPredicate circuit present', typeof instance.circuits?.proveFieldPredicate === 'function');
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
ok('factory: commitment witnesses are gone (lane removed 0.16.0)',
    built.attested_value === undefined && built.value_salt === undefined);

// ---- Check 4: witness factory pass-through + determinism -------------------
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
// assert: grantDisclosure / revokeDisclosure / bindPassport /
// anchorContentRoot).
const rt = await import('@midnight-ntwrk/compact-runtime');
const bytes32 = (fill) => new Uint8Array(32).fill(fill);

const ownerSecret = bytes32(0x11);
const attackerSecret = bytes32(0x22);
const makeWitnesses = (secretBytes) => ({
    local_secret_key(ctx) { return [ctx.privateState, secretBytes]; },
    field_value(ctx)      { return [ctx.privateState, 0n]; },
    field_salt(ctx)       { return [ctx.privateState, bytes32(0)]; },
    merkle_siblings(ctx)  { return [ctx.privateState, [bytes32(0), bytes32(0), bytes32(0), bytes32(0)]]; },
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; },
    field_digest(ctx)     { return [ctx.privateState, bytes32(0)]; },
    set_siblings(ctx)     { return [ctx.privateState, [bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)]]; },
    set_dirs(ctx)         { return [ctx.privateState, [true, true, true, true, true, true]]; },
    doc_schema(ctx)       { return [ctx.privateState, Array.from({ length: 16 }, () => ({ field_key: bytes32(0), kind: 2n, scale: 0n }))]; },
    doc_salt_a(ctx)       { return [ctx.privateState, bytes32(0)]; },
    doc_salt_b(ctx)       { return [ctx.privateState, bytes32(0)]; },
    doc_slots_a(ctx)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: bytes32(0) }))]; },
    doc_slots_b(ctx)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: bytes32(0) }))]; }
});
const ownerContract = new ContractClass(makeWitnesses(ownerSecret));
const attackerContract = new ContractClass(makeWitnesses(attackerSecret));

// 0.16.0: the constructor takes the registrar as a PUBLIC argument (a
// witness-backed constructor made the 13-circuit deploy exceed the node's
// block cost limits). The off-chain attester-id computation MUST match the
// in-circuit caller_id(): persistentHash<Bytes<32>>(secret).
const offchainAttesterId = (secretBytes) =>
    rt.persistentHash(new rt.CompactTypeBytes(32), secretBytes);
const ownerRegistrarId = offchainAttesterId(ownerSecret);

const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
const init = ownerContract.initialState(ctorCtx, ownerRegistrarId);
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

// In-circuit tier-range guard (0.16.0): level 3 must be rejected even for a
// direct contract caller (the service layer already 400s it).
let levelError = '';
try {
    runCircuit(ownerContract, 'grantDisclosure', payloadHash, bytes32(0xcd), 3n);
} catch (err) {
    levelError = String(err?.message ?? err);
}
ok('guard: grantDisclosure level 3 rejected in-circuit',
    levelError.includes('level out of range'), levelError || 'did NOT throw');

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
// The constructor arg was computed OFF-CHAIN; equality with the in-circuit
// attest() owner id proves the worker's deploy-time attester-id recompute
// (persistentHash<Bytes<32>>(secret)) is byte-identical to caller_id().
ok('registrar: off-chain attester-id recompute matches in-circuit caller_id',
    sameBytes(ownerRegistrarId, ownerId));

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
const seed8 = bytes32(0x42);
const built8 = dp.buildDocumentContentRoot(document, [
    { field: 'chemistry', kind: 'bytes' },
    { field: 'origin', kind: 'bytes' },
    { field: 'capacity' },
    { field: 'sneaky', kind: 'bytes' }
], mod.pureCircuits, seed8);
const chem = built8.fields.find((f) => f.field === 'chemistry');
const origin = built8.fields.find((f) => f.field === 'origin');
ok('bytes: builder emitted digests for bytes fields', !!chem?.valueDigest && !!origin?.valueDigest);

const bytesPayload = bytes32(0xcd);
const bytesPayloadHex = Buffer.from(bytesPayload).toString('hex');
runCircuit(ownerContract, 'attest', bytesPayload, bytes32(0xce));
runCircuit(ownerContract, 'anchorContentRoot', bytesPayload, hexToBytes(built8.contentRoot), hexToBytes(built8.schemaId));

// Equality: prove chemistry == digest('NMC811') via a bundle-built witness set.
const eqContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { fieldSalt: chem.salt, siblings: chem.siblings, dirs: chem.dirs }
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
        fieldDigest: origin.valueDigest, fieldSalt: origin.salt,
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

// In-circuit op-range guard (0.16.0): op 2 used to silently select the
// greaterOrEqual branch; it must now abort for a direct contract caller.
const capacity8 = built8.fields.find((f) => f.field === 'capacity');
const opContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { fieldValue: capacity8.value, fieldSalt: capacity8.salt, siblings: capacity8.siblings, dirs: capacity8.dirs }
}));
let opError = '';
try {
    runCircuit(opContract, 'proveFieldPredicate', bytesPayload, hexToBytes(capacity8.fieldKey), 1n, 2n);
} catch (err) {
    opError = String(err?.message ?? err);
}
ok('bytes: proveFieldPredicate op 2 rejected in-circuit',
    opError.includes('op out of range'), opError || 'did NOT throw');

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
        fieldSalt: sneaky.salt,
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
// descriptor recompute (crawler-free verification) expects them. 0.16.0:
// claim keys embed the payload's ATTESTATION EPOCH (attestation_seqs), read
// from the same ledger state, exactly as the crawler-free reader does.
const bytesLedger = mod.ledger(circuitCtx.currentQueryContext.state);
const epochOf10 = (led, payloadBytes) => led.attestation_seqs.lookup(payloadBytes);
const bytesEpoch = epochOf10(bytesLedger, bytesPayload);
const eqKey = await ps.computeFieldEqualityClaimKey(bytesPayloadHex, chem.fieldKey, chem.valueDigest, bytesEpoch);
ok('bytes: equality claim key recompute matches the circuit',
    bytesLedger.field_equality_results.member(hexToBytes(eqKey)) === true
    && bytesLedger.field_equality_results.lookup(hexToBytes(eqKey)) === true);
const memKey = await ps.computeFieldMembershipClaimKey(bytesPayloadHex, origin.fieldKey, memberPath.setRoot, bytesEpoch);
ok('bytes: membership claim key recompute matches the circuit',
    bytesLedger.field_membership_results.member(hexToBytes(memKey)) === true
    && bytesLedger.field_membership_results.lookup(hexToBytes(memKey)) === true);

// ---- Check 9: cross-root document proofs against REAL circuits (0.16.0) ----
// Drives proveDocumentComparison (mode 0 integrity / mode 1 diff) over SALTED
// content roots built by the PRODUCTION builder, then asserts the recorded
// claim keys byte-match the descriptor recomputes. Also pins the padding-key
// constant parity and the in-circuit schema binding (v4).
ok('crossroot: proveDocumentComparison circuit present', typeof instance.circuits?.proveDocumentComparison === 'function');
ok('crossroot: emptyLeafKey pure circuit exposed',       typeof mod.pureCircuits?.emptyLeafKey === 'function');
ok('crossroot: absentLeafHash pure circuit exposed',     typeof mod.pureCircuits?.absentLeafHash === 'function');
ok('crossroot: descriptorLeafHash pure circuit exposed', typeof mod.pureCircuits?.descriptorLeafHash === 'function');
ok('crossroot: slotSalt pure circuit exposed',           typeof mod.pureCircuits?.slotSalt === 'function');

// Padding-key constant parity: contract pad(32, ...) vs hashing.ts bytes.
const hashing = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/hashing.js')).href);
ok('crossroot: emptyLeafKey byte-parity with hashing.ts',
    Buffer.from(mod.pureCircuits.emptyLeafKey()).toString('hex') === hashing.emptyLeafKeyHex());

// Documents: B changes slot 0's value and DROPS slot 2 (presence change);
// slots 1 and 3 are identical. C reuses A's values under a DIFFERENT field
// name at slot 3 (its own schema; used for the schema-mismatch abort AND the
// forged-schema-label attack below).
const crossSpecs = [
    { field: 'energy' },
    { field: 'chemistry', kind: 'bytes' },
    { field: 'origin', kind: 'bytes' },
    { field: 'extra' }
];
const docA9 = { energy: 100, chemistry: 'NMC811', origin: 'EEA', extra: 7 };
const docB9 = { energy: 250, chemistry: 'NMC811', extra: 7 };
const builtA9 = dp.buildDocumentContentRoot(docA9, crossSpecs, mod.pureCircuits, bytes32(0xa1));
const builtB9 = dp.buildDocumentContentRoot(docB9, crossSpecs, mod.pureCircuits, bytes32(0xb1));
const builtC9 = dp.buildDocumentContentRoot(
    { energy: 100, chemistry: 'NMC811', origin: 'EEA', renamed: 7 },
    [crossSpecs[0], crossSpecs[1], crossSpecs[2], { field: 'renamed' }],
    mod.pureCircuits, bytes32(0xc1));
ok('crossroot: builder exports 16 leaves + schema + opening + schemaId',
    builtA9.leaves.length === 16 && builtA9.schema.length === 16
    && builtA9.opening.slots.length === 16 && /^[0-9a-f]{64}$/.test(builtA9.schemaId));
ok('crossroot: same specs yield the same schemaId regardless of values/presence/seed',
    builtA9.schemaId === builtB9.schemaId);
ok('crossroot: a different field list yields a different schemaId',
    builtA9.schemaId !== builtC9.schemaId);
ok('crossroot: absent specced field lands on the SALTED absent leaf',
    builtB9.leaves[2] === Buffer.from(mod.pureCircuits.absentLeafHash(
        hexToBytes(builtB9.schema[2].fieldKey), mod.pureCircuits.slotSalt(bytes32(0xb1), 2n)
    )).toString('hex'));
ok('crossroot: identical values under different seeds yield DIFFERENT leaves (dictionary resistance)',
    builtA9.leaves[1] !== builtB9.leaves[1] && builtA9.leaves[15] !== builtB9.leaves[15]);

const payloadA9 = bytes32(0xd1);
const payloadB9 = bytes32(0xd2);
const payloadC9 = bytes32(0xd3);
const payloadA9Hex = Buffer.from(payloadA9).toString('hex');
const payloadB9Hex = Buffer.from(payloadB9).toString('hex');
runCircuit(ownerContract, 'attest', payloadA9, bytes32(0xd4));
runCircuit(ownerContract, 'attest', payloadB9, bytes32(0xd5));
runCircuit(ownerContract, 'attest', payloadC9, bytes32(0xd6));
runCircuit(ownerContract, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId));
runCircuit(ownerContract, 'anchorContentRoot', payloadB9, hexToBytes(builtB9.contentRoot), hexToBytes(builtB9.schemaId));
runCircuit(ownerContract, 'anchorContentRoot', payloadC9, hexToBytes(builtC9.contentRoot), hexToBytes(builtC9.schemaId));

// P1 fix (0.16.0): anchoring is insert-once-or-identical. A re-anchor with a
// DIFFERENT root (or same root, different schema) must throw; an identical
// re-anchor stays a harmless no-op.
let reanchorRootError = '';
try {
    runCircuit(ownerContract, 'anchorContentRoot', payloadA9, hexToBytes(builtB9.contentRoot), hexToBytes(builtA9.schemaId));
} catch (err) {
    reanchorRootError = String(err?.message ?? err);
}
ok('crossroot: re-anchor with a different root rejected',
    reanchorRootError.includes('content root already anchored'), reanchorRootError || 'did NOT throw');
let reanchorSchemaError = '';
try {
    runCircuit(ownerContract, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtC9.schemaId));
} catch (err) {
    reanchorSchemaError = String(err?.message ?? err);
}
ok('crossroot: re-anchor with a different schema rejected',
    reanchorSchemaError.includes('schema already anchored'), reanchorSchemaError || 'did NOT throw');
let reanchorSameError = '';
try {
    runCircuit(ownerContract, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId));
} catch (err) {
    reanchorSameError = String(err?.message ?? err);
}
ok('crossroot: identical re-anchor is a no-op', reanchorSameError === '', reanchorSameError);

const maskOf = (...slots) => Array.from({ length: 16 }, (_, i) => slots.includes(i));

// Integrity positive: mask covering exactly the changed slots {0, 2}.
const integContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: builtB9.opening } }
}));
let integError = '';
try {
    runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 1n);
} catch (err) {
    integError = String(err?.message ?? err);
}
ok('crossroot: unchanged-except accepts a mask covering the changed slots', integError === '', integError);

// Non-vacuity, in-circuit (server-side 400s alone would leave direct wallet
// callers able to record an "everything may differ" claim): the all-ones
// mask AND any mask freeing every REAL slot of a shorter schema (here the
// 4-field crossSpecs schema: mask 0b1111) must be rejected.
for (const [label, vacuousMask] of [
    ['all-ones mask', Array.from({ length: 16 }, () => true)],
    ['mask freeing every real slot of a 4-field schema', maskOf(0, 1, 2, 3)]
]) {
    let vacuousError = '';
    try {
        runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadB9, 0n, vacuousMask, 1n);
    } catch (err) {
        vacuousError = String(err?.message ?? err);
    }
    ok(`crossroot: VACUOUS integrity mask rejected in-circuit (${label})`,
        vacuousError.includes('mask must constrain at least one schema slot'), vacuousError || 'did NOT throw');
}

// Canonical inactive parameters (0.16.0): the other mode's argument must ride
// as its fixed neutral dummy, in-circuit.
let dummyKError = '';
try {
    runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 2n);
} catch (err) {
    dummyKError = String(err?.message ?? err);
}
ok('crossroot: integrity mode rejects a non-neutral k',
    dummyKError.includes('k must be the neutral dummy'), dummyKError || 'did NOT throw');
let dummyMaskError = '';
try {
    runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(0), 1n);
} catch (err) {
    dummyMaskError = String(err?.message ?? err);
}
ok('crossroot: diff mode rejects a non-neutral mask',
    dummyMaskError.includes('mask must be the neutral dummy'), dummyMaskError || 'did NOT throw');

// Integrity negative 1: mask misses the presence change at slot 2.
let integMissError = '';
try {
    runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0), 1n);
} catch (err) {
    integMissError = String(err?.message ?? err);
}
ok('crossroot: presence change outside the mask rejected',
    integMissError.includes('slot changed outside allowed mask'), integMissError || 'did NOT throw');

// Integrity negative 2: a tampered OPENING (value swapped) fails the
// in-circuit root recompute, even inside the allowed mask.
const tamperedOpening = {
    saltSeed: builtB9.opening.saltSeed,
    slots: builtB9.opening.slots.map((s, i) => i === 0 ? { present: true, value: '123456' } : s)
};
const tamperContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: tamperedOpening } }
}));
let tamperError = '';
try {
    runCircuit(tamperContract, 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 1n);
} catch (err) {
    tamperError = String(err?.message ?? err);
}
ok('crossroot: tampered opening fails the anchored-root binding',
    tamperError.includes('doc B opening does not match anchored root'), tamperError || 'did NOT throw');

// P1 fix (0.16.0): a document cannot be compared with itself, in-circuit.
let selfError = '';
try {
    runCircuit(integContract, 'proveDocumentComparison', payloadA9, payloadA9, 0n, maskOf(), 1n);
} catch (err) {
    selfError = String(err?.message ?? err);
}
ok('crossroot: A vs A rejected in-circuit',
    selfError.includes('documents must differ'), selfError || 'did NOT throw');

// Diff positive at exactly k = count = 2 (slot 0 value diff + slot 2 absence).
const diffContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: builtB9.opening } }
}));
let diffError = '';
try {
    runCircuit(diffContract, 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 2n);
} catch (err) {
    diffError = String(err?.message ?? err);
}
ok('crossroot: k-differ accepts k = actual difference count (value + absence)', diffError === '', diffError);

// Diff negative: k = count + 1 fails in-circuit.
let diffTooFewError = '';
try {
    runCircuit(diffContract, 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 3n);
} catch (err) {
    diffTooFewError = String(err?.message ?? err);
}
ok('crossroot: k above the actual difference count rejected',
    diffTooFewError.includes('too few differing fields'), diffTooFewError || 'did NOT throw');

// Diff bounds: k = 0 rejected before any folding.
let diffZeroError = '';
try {
    runCircuit(diffContract, 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 0n);
} catch (err) {
    diffZeroError = String(err?.message ?? err);
}
ok('crossroot: k = 0 rejected', diffZeroError.includes('k out of range'), diffZeroError || 'did NOT throw');

// Schema misalignment: C was anchored under a DIFFERENT field list (slot 3
// renamed). The witnessed shared schema (A''s) cannot fold to C''s anchored
// schema id, so the comparison aborts before any value is compared.
const alignContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: builtC9.opening } }
}));
let alignError = '';
try {
    runCircuit(alignContract, 'proveDocumentComparison', payloadA9, payloadC9, 1n, maskOf(), 1n);
} catch (err) {
    alignError = String(err?.message ?? err);
}
ok('crossroot: anchored schema mismatch aborts the comparison',
    alignError.includes('doc B schema mismatch'), alignError || 'did NOT throw');

// ADVERSARIAL (schema-forgery repro): anchor a document whose tree was built
// over a DIFFERENT field list, but label it with A''s schemaId. In v3 the
// plain schema-equality lookup accepted this; in v4 the circuit recomputes
// the content root under the witnessed shared schema, and the forged
// document''s real opening cannot fold to its anchored root.
const payloadF9 = bytes32(0xd7);
runCircuit(ownerContract, 'attest', payloadF9, bytes32(0xd8));
runCircuit(ownerContract, 'anchorContentRoot', payloadF9, hexToBytes(builtC9.contentRoot), hexToBytes(builtA9.schemaId));
const forgeContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret,
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: builtC9.opening } }
}));
let forgeError = '';
try {
    runCircuit(forgeContract, 'proveDocumentComparison', payloadA9, payloadF9, 1n, maskOf(), 1n);
} catch (err) {
    forgeError = String(err?.message ?? err);
}
ok('crossroot: ADVERSARIAL forged schema label cannot produce a diff claim',
    forgeError.includes('doc B opening does not match anchored root'), forgeError || 'did NOT throw');

// ADVERSARIAL (invalid-kind repro): descriptors are witness data. An
// out-of-range kind used to land on the absent leaf in slotLeaf but compare
// as a bytes field in slotDiff, so TWO ALL-ABSENT roots could prove a
// fabricated k=1 diff. The canonical-slot guard must reject the schema
// before any root math. Built with RAW witness objects (a malicious client
// does not use our validating helpers).
const fold16Local = (leaves) => {
    let level = leaves;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(mod.pureCircuits.nodeHash(level[i], level[i + 1]));
        level = next;
    }
    return level[0];
};
const evilCases = [
    { kind: 3n,   payloadA: 0xd9, payloadB: 0xda, metaA: 0xdb, metaB: 0xdc, seedA: 0xe1, seedB: 0xe2 },
    { kind: 255n, payloadA: 0xe5, payloadB: 0xe6, metaA: 0xe7, metaB: 0xe8, seedA: 0xe3, seedB: 0xe4 }
];
for (const c of evilCases) {
    const evilKeys = Array.from({ length: 16 }, (_, i) => {
        const b = new Uint8Array(32); b[0] = 0xee; b[1] = Number(c.kind & 0xffn); b[2] = i; return b;
    });
    const evilRootFor = (seedByte) => fold16Local(evilKeys.map((k, i) =>
        mod.pureCircuits.absentLeafHash(k, mod.pureCircuits.slotSalt(bytes32(seedByte), BigInt(i)))));
    const evilSchemaId = fold16Local(evilKeys.map(k => mod.pureCircuits.descriptorLeafHash(k, c.kind, 0n)));
    const pA = bytes32(c.payloadA); const pB = bytes32(c.payloadB);
    runCircuit(ownerContract, 'attest', pA, bytes32(c.metaA));
    runCircuit(ownerContract, 'attest', pB, bytes32(c.metaB));
    runCircuit(ownerContract, 'anchorContentRoot', pA, evilRootFor(c.seedA), evilSchemaId);
    runCircuit(ownerContract, 'anchorContentRoot', pB, evilRootFor(c.seedB), evilSchemaId);
    const evilSlots = (fill) => Array.from({ length: 16 }, () =>
        ({ present: true, uint_value: 0n, value_digest: new Uint8Array(32).fill(fill) }));
    const evilContract = new ContractClass({
        ...witnesses.buildAttestationVaultWitnesses({ attestationSecret: ownerSecret }),
        doc_schema:  (ctx) => [ctx.privateState, evilKeys.map(k => ({ field_key: k, kind: c.kind, scale: 0n }))],
        doc_salt_a:  (ctx) => [ctx.privateState, bytes32(c.seedA)],
        doc_salt_b:  (ctx) => [ctx.privateState, bytes32(c.seedB)],
        doc_slots_a: (ctx) => [ctx.privateState, evilSlots(0x11)],
        doc_slots_b: (ctx) => [ctx.privateState, evilSlots(0x22)]
    });
    let evilError = '';
    try {
        runCircuit(evilContract, 'proveDocumentComparison', pA, pB, 1n, maskOf(), 1n);
    } catch (err) {
        evilError = String(err?.message ?? err);
    }
    ok(`crossroot: ADVERSARIAL out-of-range descriptor kind ${c.kind} rejected in-circuit`,
        evilError.includes('schema kind out of range'), evilError || 'did NOT throw (SOUNDNESS BUG)');
}

// Privilege separation (0.16.0): the proof circuits never invoke
// local_secret_key, so a HOLDER without the owner secret can prove against
// anchored roots.
const holderContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB: builtB9.opening } }
}));
let holderError = '';
try {
    runCircuit(holderContract, 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 1n);
} catch (err) {
    holderError = String(err?.message ?? err);
}
ok('crossroot: holder proves WITHOUT the attester secret (privilege separation)', holderError === '', holderError);

// Claim-key parity: recomputed keys hit the recorded results, and the
// REVERSED document order does not (order is part of the claim).
const crossLedger = mod.ledger(circuitCtx.currentQueryContext.state);
const epochA9 = crossLedger.attestation_seqs.lookup(payloadA9);
const epochB9 = crossLedger.attestation_seqs.lookup(payloadB9);
const integKey = await ps.computeDocumentIntegrityClaimKey(payloadA9Hex, payloadB9Hex, 0b101, epochA9, epochB9);
ok('crossroot: integrity claim key recompute matches the circuit',
    crossLedger.document_integrity_results.member(hexToBytes(integKey)) === true
    && crossLedger.document_integrity_results.lookup(hexToBytes(integKey)) === true);
const diffKey = await ps.computeDocumentDiffClaimKey(payloadA9Hex, payloadB9Hex, 2, epochA9, epochB9);
ok('crossroot: diff claim key recompute matches the circuit',
    crossLedger.document_diff_results.member(hexToBytes(diffKey)) === true
    && crossLedger.document_diff_results.lookup(hexToBytes(diffKey)) === true);
const reversedKey = await ps.computeDocumentIntegrityClaimKey(payloadB9Hex, payloadA9Hex, 0b101, epochB9, epochA9);
ok('crossroot: reversed (B, A) order is a DIFFERENT claim key',
    crossLedger.document_integrity_results.member(hexToBytes(reversedKey)) === false);

// ---- Check 10: guarded attest (commit-reveal + sniper takeover, 0.16.0) ----
// attest() is FCFS and insert-once, so a mempool observer could permanently
// claim a visible payload hash. attestGuarded closes it: commit an opaque
// commitment first, reveal later; sequencing lets a reveal whose commitment
// PREDATES a snipe take the attestation over. The off-chain
// computeAttestCommitment parity is proven implicitly: the reveal recomputes
// the commitment in-circuit and must hit the committed entry.
ok('guarded: attestGuarded circuit present', typeof instance.circuits?.attestGuarded === 'function');

const gPayload = bytes32(0xf1);
const gMeta = bytes32(0xf2);
const gNonce = bytes32(0xf3);
const gPayloadHex = Buffer.from(gPayload).toString('hex');
const gMetaHex = Buffer.from(gMeta).toString('hex');
const gCommitment = hexToBytes(await ps.computeAttestCommitment(gPayloadHex, gMetaHex, Buffer.from(gNonce).toString('hex')));

let commitDummyError = '';
try {
    runCircuit(ownerContract, 'attestGuarded', 0n, gCommitment, bytes32(1), bytes32(0));
} catch (err) {
    commitDummyError = String(err?.message ?? err);
}
ok('guarded: commit mode rejects non-dummy metadata',
    commitDummyError.includes('metadata must be the neutral dummy'), commitDummyError || 'did NOT throw');

let noCommitError = '';
try {
    runCircuit(ownerContract, 'attestGuarded', 1n, gPayload, gMeta, gNonce);
} catch (err) {
    noCommitError = String(err?.message ?? err);
}
ok('guarded: reveal without a commitment rejected',
    noCommitError.includes('no matching commitment'), noCommitError || 'did NOT throw');

// Victim (owner) commits.
runCircuit(ownerContract, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0));
let dupCommitError = '';
try {
    runCircuit(ownerContract, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0));
} catch (err) {
    dupCommitError = String(err?.message ?? err);
}
ok('guarded: duplicate commitment rejected',
    dupCommitError.includes('commitment already recorded'), dupCommitError || 'did NOT throw');

// SNIPER: the attacker front-runs the reveal with a plain attest AND, while
// they own the attestation, anchors a content root, PROVES a claim against
// it and grants themselves disclosure level 2 (the full abuse window the
// takeover must erase).
runCircuit(attackerContract, 'attest', gPayload, bytes32(0xf4));
runCircuit(attackerContract, 'anchorContentRoot', gPayload, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId));
const a9chem = builtA9.fields.find((f) => f.field === 'chemistry');
const sniperEqContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: attackerSecret,
    merkleProof: { fieldSalt: a9chem.salt, siblings: a9chem.siblings, dirs: a9chem.dirs }
}));
runCircuit(sniperEqContract, 'proveFieldEquality', gPayload, hexToBytes(a9chem.fieldKey), hexToBytes(a9chem.valueDigest));
const sniperGrantee = bytes32(0xf8);
runCircuit(attackerContract, 'grantDisclosure', gPayload, sniperGrantee, 2n);
let led10 = mod.ledger(circuitCtx.currentQueryContext.state);
const attackerId10 = offchainAttesterId(attackerSecret);
const ownerId10 = offchainAttesterId(ownerSecret);
const sniperEpoch = led10.attestation_seqs.lookup(gPayload);
const gPayloadHexFull = Buffer.from(gPayload).toString('hex');
const sniperEraKey = await ps.computeFieldEqualityClaimKey(gPayloadHexFull, a9chem.fieldKey, a9chem.valueDigest, sniperEpoch);
ok('guarded: sniper owns the payload pre-reveal',
    Buffer.compare(Buffer.from(led10.attestation_owners.lookup(gPayload)), Buffer.from(attackerId10)) === 0);
ok('guarded: sniper claim verifies pre-takeover (under the sniper epoch)',
    led10.field_equality_results.member(hexToBytes(sniperEraKey)) === true);

let notCommitterError = '';
try {
    runCircuit(attackerContract, 'attestGuarded', 1n, gPayload, gMeta, gNonce);
} catch (err) {
    notCommitterError = String(err?.message ?? err);
}
ok('guarded: reveal by a non-committer rejected',
    notCommitterError.includes('not committer'), notCommitterError || 'did NOT throw');

// Victim reveals: TAKEOVER (the commitment predates the snipe).
runCircuit(ownerContract, 'attestGuarded', 1n, gPayload, gMeta, gNonce);
led10 = mod.ledger(circuitCtx.currentQueryContext.state);
ok('guarded: reveal takes the sniped attestation over',
    Buffer.compare(Buffer.from(led10.attestation_owners.lookup(gPayload)), Buffer.from(ownerId10)) === 0);
ok('guarded: takeover removed the sniper-anchored content root + schema',
    led10.content_roots.member(gPayload) === false && led10.content_schemas.member(gPayload) === false);
// The sniper's abuse window is fully erased: the epoch moved (so verifiers,
// which always recompute with the CURRENT epoch, no longer reach the
// sniper-era claim entry) and the disclosure grant is gone.
const recoveredEpoch = led10.attestation_seqs.lookup(gPayload);
ok('guarded: takeover moved the attestation epoch', recoveredEpoch !== sniperEpoch);
const currentEraKey = await ps.computeFieldEqualityClaimKey(gPayloadHexFull, a9chem.fieldKey, a9chem.valueDigest, recoveredEpoch);
ok('guarded: sniper claim NO LONGER verifies after the takeover (current epoch misses)',
    led10.field_equality_results.member(hexToBytes(currentEraKey)) === false);
ok('guarded: sniper disclosure grant removed by the takeover',
    led10.disclosures.member(gPayload) === false);

// No ping-pong: a commitment made AFTER the snipe (newer seq) cannot re-take.
const aNonce = bytes32(0xf5);
const aCommitment = hexToBytes(await ps.computeAttestCommitment(gPayloadHex, gMetaHex, Buffer.from(aNonce).toString('hex')));
runCircuit(attackerContract, 'attestGuarded', 0n, aCommitment, bytes32(0), bytes32(0));
let pingPongError = '';
try {
    runCircuit(attackerContract, 'attestGuarded', 1n, gPayload, gMeta, aNonce);
} catch (err) {
    pingPongError = String(err?.message ?? err);
}
ok('guarded: a NEWER commitment cannot re-take the attestation',
    pingPongError.includes('attestation predates commitment'), pingPongError || 'did NOT throw');

// Uncontested commit-reveal attests normally.
const hPayload = bytes32(0xf6);
const hNonce = bytes32(0xf7);
const hCommitment = hexToBytes(await ps.computeAttestCommitment(Buffer.from(hPayload).toString('hex'), gMetaHex, Buffer.from(hNonce).toString('hex')));
runCircuit(ownerContract, 'attestGuarded', 0n, hCommitment, bytes32(0), bytes32(0));
runCircuit(ownerContract, 'attestGuarded', 1n, hPayload, gMeta, hNonce);
led10 = mod.ledger(circuitCtx.currentQueryContext.state);
ok('guarded: uncontested commit-reveal attests',
    led10.public_attestations.member(hPayload) === true
    && Buffer.compare(Buffer.from(led10.attestation_owners.lookup(hPayload)), Buffer.from(ownerId10)) === 0);

// REPLAY (P1 repro): commitments are CONSUMED on success. Without that, this
// second identical reveal would satisfy rec.seq < attestation_seq, run the
// takeover branch against the revealer's OWN attestation and delete the
// meanwhile-anchored root, re-opening insert-once.
runCircuit(ownerContract, 'anchorContentRoot', hPayload, hexToBytes(builtB9.contentRoot), hexToBytes(builtB9.schemaId));
let replayError = '';
try {
    runCircuit(ownerContract, 'attestGuarded', 1n, hPayload, gMeta, hNonce);
} catch (err) {
    replayError = String(err?.message ?? err);
}
ok('guarded: replaying a successful reveal rejected (commitment consumed)',
    replayError.includes('no matching commitment'), replayError || 'did NOT throw (INSERT-ONCE BYPASS)');
led10 = mod.ledger(circuitCtx.currentQueryContext.state);
ok('guarded: the anchored root survived the replay attempt',
    led10.content_roots.member(hPayload) === true);

console.log();
console.log(failures === 0
    ? 'AttestationVault artifact + witness factory wire end-to-end.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
