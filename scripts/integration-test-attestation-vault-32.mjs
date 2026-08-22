// Offline integration of the REAL compiled attestation-vault-32 artifact
// (0.19): the width-32 twin of integration-test-attestation-vault.mjs,
// focused on what the width changes. No chain, no proofs; the circuits run
// locally on compact-runtime.
//
// Pins:
//   1. The artifact loads, exposes the same circuit set, and its content
//      trees are DEPTH 5 (32 slots) end to end through the production
//      builders (document-proof.js with slotWidth 32).
//   2. Bit 31: an integrity proof over a mask with the top bit set lands,
//      and the recorded claim key byte-matches the server's crawler-free
//      recompute with width 32 (mask 0x80000001 through Integer64/Number).
//   3. Diff mode (k of 32) claim-key parity, and the negatives (mask
//      missing a changed slot, k above the actual difference count) throw.
//
// Run: node scripts/integration-test-attestation-vault-32.mjs
// Needs `npm run build` (imports the compiled srv/*.js twins).

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault-32/src/managed/attestation-vault-32/contract/index.js');

let failures = 0;
function ok(name, value, detail) {
    if (!value) {
        console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
        failures++;
    } else {
        console.log(`OK   ${name}`);
    }
}

const WIDTH = 32;
const DEPTH = 5;

const mod = await import(pathToFileURL(artifactPath).href);
const ContractClass = mod.Contract ?? mod.default ?? mod;
ok('artifact: Contract is constructor', typeof ContractClass === 'function');
ok('artifact: pureCircuits exposed', mod.pureCircuits !== undefined);

const rt = await import('@midnight-ntwrk/compact-runtime');
const dp = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/document-proof.js')).href);
const ps = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/predicate-state.js')).href);
const witnesses = await import(pathToFileURL(path.join(repoRoot, 'srv/submission/contract-witnesses.js')).href);

const bytes32 = (fill) => new Uint8Array(32).fill(fill);
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// ---- Documents: 32 numeric markers; B differs in slot 0 AND slot 31 --------
const specs = Array.from({ length: WIDTH }, (_, i) => ({ field: `marker_${String(i).padStart(2, '0')}` }));
const docA = Object.fromEntries(specs.map((s, i) => [s.field, 100 + i]));
const docB = { ...docA, marker_00: 900, marker_31: 901 };

const builtA = dp.buildDocumentContentRoot(docA, specs, mod.pureCircuits, bytes32(0xa1), WIDTH);
const builtB = dp.buildDocumentContentRoot(docB, specs, mod.pureCircuits, bytes32(0xb1), WIDTH);
ok('width: builder emits 32 leaves, 32 schema slots, 32 opening slots',
    builtA.leaves.length === WIDTH && builtA.schema.length === WIDTH && builtA.opening.slots.length === WIDTH);
ok('width: inclusion paths are DEPTH 5',
    builtA.fields.every((f) => f.siblings.length === DEPTH && f.dirs.length === DEPTH));
ok('width: both documents share one schemaId', builtA.schemaId === builtB.schemaId);

// Server-side mask helper parity for bit 31 (the JS-bitwise edge).
const expanded = ps.expandAllowedMask(0x80000001, WIDTH);
ok('width: expandAllowedMask(0x80000001, 32) frees exactly slots 0 and 31',
    expanded.length === WIDTH && expanded[0] === true && expanded[31] === true
    && expanded.slice(1, 31).every((b) => b === false));

// ---- Local ledger: attest + anchor both documents --------------------------
const ownerSecret = bytes32(0x11);
const ownerContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret, slotWidth: WIDTH
}));
const registrarId = rt.persistentHash(new rt.CompactTypeBytes(32), ownerSecret);
const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
const init = ownerContract.initialState(ctorCtx, registrarId);
let circuitCtx = rt.createCircuitContext(
    rt.dummyContractAddress(),
    ctorCtx.initialZswapLocalState.coinPublicKey,
    init.currentContractState.data,
    init.currentPrivateState
);
function runCircuit(contract, name, ...args) {
    const out = contract.impureCircuits[name](circuitCtx, ...args);
    circuitCtx = out.context;
    return out;
}

const payloadA = bytes32(0xd1);
const payloadB = bytes32(0xd2);
const payloadAHex = Buffer.from(payloadA).toString('hex');
const payloadBHex = Buffer.from(payloadB).toString('hex');
runCircuit(ownerContract, 'attest', payloadA, bytes32(0xd4));
runCircuit(ownerContract, 'attest', payloadB, bytes32(0xd5));
runCircuit(ownerContract, 'anchorContentRoot', payloadA, hexToBytes(builtA.contentRoot), hexToBytes(builtA.schemaId));
runCircuit(ownerContract, 'anchorContentRoot', payloadB, hexToBytes(builtB.contentRoot), hexToBytes(builtB.schemaId));

// ---- Depth-5 single-field proof against the real circuit -------------------
const marker7 = builtA.fields.find((f) => f.field === 'marker_07');
const eqContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret, slotWidth: WIDTH,
    merkleProof: {
        fieldValue: String(marker7.value), fieldSalt: marker7.salt,
        siblings: marker7.siblings, dirs: marker7.dirs
    }
}));
let predError = '';
try {
    runCircuit(eqContract, 'proveFieldPredicate', payloadA, hexToBytes(marker7.fieldKey), 1000000n, 0n);
} catch (err) {
    predError = String(err?.message ?? err);
}
ok('width: proveFieldPredicate lands over the depth-5 path', predError === '', predError);

// ---- Integrity with bit 31 (mask 0x80000001) -------------------------------
const maskOf = (...slots) => Array.from({ length: WIDTH }, (_, i) => slots.includes(i));
const docPairContract = new ContractClass(witnesses.buildAttestationVaultWitnesses({
    attestationSecret: ownerSecret, slotWidth: WIDTH,
    merkleProof: { docPair: { schema: builtA.schema, openingA: builtA.opening, openingB: builtB.opening } }
}));
let integError = '';
try {
    runCircuit(docPairContract, 'proveDocumentComparison', payloadA, payloadB, 0n, maskOf(0, 31), 1n);
} catch (err) {
    integError = String(err?.message ?? err);
}
ok('width: integrity proof with bit 31 set lands (slots 0 + 31 differ)', integError === '', integError);

// Negative: a mask missing the changed slot 31 must fail in-circuit.
let missError = '';
try {
    runCircuit(docPairContract, 'proveDocumentComparison', payloadA, payloadB, 0n, maskOf(0), 1n);
} catch (err) {
    missError = String(err?.message ?? err);
}
ok('width: integrity mask missing changed slot 31 rejected', missError !== '', 'did NOT throw');

// ---- Diff k of 32 ----------------------------------------------------------
let diffError = '';
try {
    runCircuit(docPairContract, 'proveDocumentComparison', payloadA, payloadB, 1n, maskOf(), 2n);
} catch (err) {
    diffError = String(err?.message ?? err);
}
ok('width: diff proof k=2 of 32 lands', diffError === '', diffError);
let diffTooHighError = '';
try {
    runCircuit(docPairContract, 'proveDocumentComparison', payloadA, payloadB, 1n, maskOf(), 3n);
} catch (err) {
    diffTooHighError = String(err?.message ?? err);
}
ok('width: diff proof k=3 rejected (only 2 slots differ)', diffTooHighError !== '', 'did NOT throw');

// ---- Claim-key parity with the WIDTH-32 recompute --------------------------
const led = mod.ledger(circuitCtx.currentQueryContext.state);
const epochA = led.attestation_seqs.lookup(payloadA);
const epochB = led.attestation_seqs.lookup(payloadB);
const integKey = await ps.computeDocumentIntegrityClaimKey(payloadAHex, payloadBHex, 0x80000001, epochA, epochB, WIDTH);
ok('width: integrity claim key (mask 0x80000001, width 32) recompute matches the circuit',
    led.document_integrity_results.member(hexToBytes(integKey)) === true
    && led.document_integrity_results.lookup(hexToBytes(integKey)) === true);
const integKey16 = await ps.computeDocumentIntegrityClaimKey(payloadAHex, payloadBHex, 0x80000001 & 0xffff, epochA, epochB, 16);
ok('width: a width-16 recompute is a DIFFERENT key (width is part of the claim shape)',
    led.document_integrity_results.member(hexToBytes(integKey16)) === false);
const diffKey = await ps.computeDocumentDiffClaimKey(payloadAHex, payloadBHex, 2, epochA, epochB);
ok('width: diff claim key recompute matches the circuit',
    led.document_diff_results.member(hexToBytes(diffKey)) === true
    && led.document_diff_results.lookup(hexToBytes(diffKey)) === true);

if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nintegration-test-attestation-vault-32: ALL OK');
