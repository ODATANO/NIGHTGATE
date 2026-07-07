// SPIKE (OQ1 of onchain-state-verification-crawlerless): confirm the crawler-free
// state model can back the two new verify surfaces the FR proposes, by driving the
// REAL Compact-emitted AttestationVault circuits locally (no chain / no proof server):
//
//   #2 verifyAttestationState  — attest -> anchorContentRoot, then read
//        public_attestations / content_roots / attestation_owners by the KNOWN
//        payload_hash. All flat maps -> member/lookup, no enumeration, no helper.
//
//   #3 verifyPredicateAttestation (state fallback) — commitValue -> provePredicate,
//        then read predicate_results. This map is keyed by
//        claimKey = persistentHash<PredicateClaim>{payload_hash, threshold, op},
//        which the consumer does NOT hold. Question: can we recompute claimKey
//        off-chain (no Compact change), or must NIGHTGATE persist it at prove time?
//
// Run: node scripts/spike-state-verification.mjs

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js');

let failures = 0;
function ok(name, value, detail) {
    if (!value) { console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`); failures++; }
    else console.log(`OK   ${name}`);
}
const hex = (b) => Buffer.from(b).toString('hex');
const bytes32 = (fill) => new Uint8Array(32).fill(fill);

const rt = await import('@midnight-ntwrk/compact-runtime');
const mod = await import(pathToFileURL(artifactPath).href);
const Contract = mod.Contract;
const ledger = mod.ledger;

// Attester secret shared across attest/grant/commit/prove so the owner check passes.
const attesterSecret = bytes32(0x11);
// Real committed value + salt: provePredicate re-derives the commitment from these.
const attestedValue = 42n;
const valueSalt = bytes32(0x22);
// Field-predicate witnesses are mutable so we can set a real Merkle proof
// before calling proveFieldPredicate (see the field section below).
let wFieldValue = 0n;
let wSiblings = [bytes32(0), bytes32(0), bytes32(0), bytes32(0)];
let wDirs = [false, false, false, false];
const witnesses = {
    local_secret_key(ctx) { return [ctx.privateState, attesterSecret]; },
    attested_value(ctx)   { return [ctx.privateState, attestedValue]; },
    value_salt(ctx)       { return [ctx.privateState, valueSalt]; },
    field_value(ctx)      { return [ctx.privateState, wFieldValue]; },
    merkle_siblings(ctx)  { return [ctx.privateState, wSiblings]; },
    merkle_dirs(ctx)      { return [ctx.privateState, wDirs]; }
};

const instance = new Contract(witnesses);
ok('artifact: ledger fn', typeof ledger === 'function');
ok('artifact: provePredicate circuit', typeof instance.impureCircuits?.provePredicate === 'function');

const COIN_PK_HEX = '00'.repeat(32);
const ctorCtx = rt.createConstructorContext({}, COIN_PK_HEX);
const init = instance.initialState(ctorCtx);
let circuitCtx = rt.createCircuitContext(
    rt.dummyContractAddress(),
    ctorCtx.initialZswapLocalState.coinPublicKey,
    init.currentContractState.data,
    init.currentPrivateState
);
function runCircuit(name, ...args) {
    const out = instance.impureCircuits[name](circuitCtx, ...args);
    circuitCtx = out.context;
    return out;
}

const payloadHash  = bytes32(0xaa);
const metadataHash = bytes32(0xbb);
const contentRoot  = bytes32(0xdd);
const threshold    = 100n;
const OP_LE = 0n; // lessOrEqual: 42 <= 100 -> true

// ============================================================================
// PROPOSAL #2 — verifyAttestationState primitives (attestation + content root)
// ============================================================================
runCircuit('attest', payloadHash, metadataHash);
runCircuit('anchorContentRoot', payloadHash, contentRoot);

const ledA = ledger(circuitCtx.currentQueryContext.state);
ok('#2 attested: public_attestations.member(payloadHash)',
    ledA.public_attestations.member(payloadHash) === true);
ok('#2 absent:   member(unknown) === false',
    ledA.public_attestations.member(bytes32(0x99)) === false);
ok('#2 attesterId: attestation_owners.lookup(payloadHash) present',
    ledA.attestation_owners.member(payloadHash) === true);
ok('#2 contentRootOk: content_roots.lookup === anchored root',
    hex(ledA.content_roots.lookup(payloadHash)) === hex(contentRoot),
    `got ${hex(ledA.content_roots.lookup(payloadHash))}`);
ok('#2 contentRoot mismatch detectable',
    hex(ledA.content_roots.lookup(payloadHash)) !== hex(bytes32(0xee)));
// All of #2 is keyed by the KNOWN payloadHash -> pure member/lookup, no enumeration.

// ============================================================================
// PROPOSAL #3 — predicate result read + claimKey recomputation question
// ============================================================================
runCircuit('commitValue', payloadHash);
const ledC = ledger(circuitCtx.currentQueryContext.state);
ok('#3 value_commitments set after commitValue',
    ledC.value_commitments.member(payloadHash) === true);

runCircuit('provePredicate', payloadHash, threshold, OP_LE);
const ledP = ledger(circuitCtx.currentQueryContext.state);

// predicate_results is a flat Map<Bytes32,Boolean>. The .d.ts advertises an
// iterator; confirm it holds at runtime and capture the emitted claimKey.
let iterable = typeof ledP.predicate_results?.[Symbol.iterator] === 'function';
ok('#3 predicate_results iterable at runtime', iterable);

let emittedKeys = [];
if (iterable) {
    for (const [k, v] of ledP.predicate_results) emittedKeys.push({ key: hex(k), val: v });
}
ok('#3 exactly one predicate result recorded', emittedKeys.length === 1,
    `got ${emittedKeys.length}`);
ok('#3 recorded result is true', emittedKeys[0]?.val === true);
const onChainClaimKey = emittedKeys[0]?.key;
console.log(`     on-chain claimKey = ${onChainClaimKey}`);

// Can a consumer/handler RECOMPUTE claimKey from (payloadHash, threshold, op)
// with no Compact change? There is no exported pure circuit for it (only
// leafHash/nodeHash). Probe compact-runtime for a usable persistentHash of the
// PredicateClaim struct. If this reproduces onChainClaimKey, proposal #3 needs
// zero schema change; if not, NIGHTGATE must persist claimKey at prove time.
const rtHashNames = Object.keys(rt).filter(n => /hash|commit|persist/i.test(n));
console.log(`     compact-runtime hash-ish exports: ${rtHashNames.join(', ') || '(none)'}`);

// Reconstruct the PredicateClaim CompactType from PUBLIC compact-runtime
// constructors (the compiled artifact builds the identical _descriptor_7 this
// way: Bytes<32> ++ Uint<64> ++ Uint<8>) and recompute the claimKey off-chain.
// If this equals onChainClaimKey, proposal #3 needs NO Compact change and NO
// schema column — the handler recomputes the key from the stored
// (payloadHash, threshold, op) and does predicate_results.member(claimKey).
let recomputed = null;
try {
    const d_bytes32 = new rt.CompactTypeBytes(32);
    const d_u64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const d_u8  = new rt.CompactTypeUnsignedInteger(255n, 1);
    const predicateClaimType = {
        alignment() {
            return d_bytes32.alignment().concat(d_u64.alignment().concat(d_u8.alignment()));
        },
        toValue(v) {
            return d_bytes32.toValue(v.payload_hash)
                .concat(d_u64.toValue(v.threshold).concat(d_u8.toValue(v.op)));
        }
    };
    recomputed = hex(rt.persistentHash(predicateClaimType,
        { payload_hash: payloadHash, threshold, op: OP_LE }));
    console.log(`     recomputed claimKey = ${recomputed}`);
} catch (e) {
    console.log(`     recompute threw: ${e.message}`);
}
ok('#3 off-chain claimKey recompute MATCHES on-chain key (no Compact/schema change needed)',
    recomputed !== null && recomputed === onChainClaimKey,
    recomputed === null ? 'recompute failed' : `recomputed ${recomputed} vs on-chain ${onChainClaimKey}`);

// pureCircuits available for off-chain parity (used by field-predicate content roots)
ok('#3 pureCircuits.leafHash exported (field-root parity)',
    typeof mod.pureCircuits?.leafHash === 'function');

// ============================================================================
// PROPOSAL #3 (field-bound) — proveFieldPredicate result + claimKey recompute
// ============================================================================
// Build a real DEPTH=4 Merkle proof off-chain using the exported pureCircuits,
// anchor the resulting root, then prove a field predicate against it. The
// circuit stores the result in `field_predicate_results` keyed by
// persistentHash<FieldPredicateClaim>{payload_hash, field_key, threshold, op}.
const fieldKey = bytes32(0x55);
const fieldValue = 7n;
const fieldThreshold = 10n;         // 7 <= 10 -> true (op 0)
const sibs = [bytes32(0x01), bytes32(0x02), bytes32(0x03), bytes32(0x04)];
const dirs = [true, false, true, false]; // arbitrary path; we anchor the root we fold to

// Fold leaf -> root with the SAME hashing the circuit uses (pureCircuits).
const nodeHash = mod.pureCircuits.nodeHash;
const leafHash = mod.pureCircuits.leafHash;
const step = (node, sibling, goesLeft) => goesLeft ? nodeHash(node, sibling) : nodeHash(sibling, node);
let node = leafHash(fieldKey, fieldValue);
for (let i = 0; i < 4; i++) node = step(node, sibs[i], dirs[i]);
const fieldRoot = node;

// Set the field witnesses, anchor the folded root, then prove.
wFieldValue = fieldValue; wSiblings = sibs; wDirs = dirs;
runCircuit('anchorContentRoot', payloadHash, fieldRoot);
runCircuit('proveFieldPredicate', payloadHash, fieldKey, fieldThreshold, 0n);

const ledF = ledger(circuitCtx.currentQueryContext.state);
let fieldKeys = [];
if (typeof ledF.field_predicate_results?.[Symbol.iterator] === 'function') {
    for (const [k, v] of ledF.field_predicate_results) fieldKeys.push({ key: hex(k), val: v });
}
ok('#3f exactly one field-predicate result recorded', fieldKeys.length === 1, `got ${fieldKeys.length}`);
ok('#3f recorded field result is true', fieldKeys[0]?.val === true);
const onChainFieldClaimKey = fieldKeys[0]?.key;
console.log(`     on-chain fieldClaimKey = ${onChainFieldClaimKey}`);

// Recompute FieldPredicateClaim { payload_hash, field_key, threshold, op } —
// artifact's _descriptor_6: Bytes<32> ++ Bytes<32> ++ Uint<64> ++ Uint<8>.
let recomputedField = null;
try {
    const d_bytes32 = new rt.CompactTypeBytes(32);
    const d_u64 = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
    const d_u8  = new rt.CompactTypeUnsignedInteger(255n, 1);
    const fieldClaimType = {
        alignment() {
            return d_bytes32.alignment()
                .concat(d_bytes32.alignment().concat(d_u64.alignment().concat(d_u8.alignment())));
        },
        toValue(v) {
            return d_bytes32.toValue(v.payload_hash)
                .concat(d_bytes32.toValue(v.field_key)
                    .concat(d_u64.toValue(v.threshold).concat(d_u8.toValue(v.op))));
        }
    };
    recomputedField = hex(rt.persistentHash(fieldClaimType, {
        payload_hash: payloadHash, field_key: fieldKey, threshold: fieldThreshold, op: 0n
    }));
    console.log(`     recomputed fieldClaimKey = ${recomputedField}`);
} catch (e) {
    console.log(`     field recompute threw: ${e.message}`);
}
ok('#3f off-chain fieldClaimKey recompute MATCHES on-chain key',
    recomputedField !== null && recomputedField === onChainFieldClaimKey,
    recomputedField === null ? 'recompute failed' : `recomputed ${recomputedField} vs on-chain ${onChainFieldClaimKey}`);

console.log();
console.log(failures === 0
    ? 'SPIKE PASS — #2 fully readable by known payload_hash; #3 result map readable, claimKey handling flagged (see log).'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
