// SPIKE (Phase 2 of expose-disclosure-grants): prove we can read the on-chain
// `disclosures` ledger Map back out via the compiled artifact's `ledger()`
// decoder, AND that the enumeration strategy works given the central
// constraint: the OUTER `disclosures` map is NOT iterable (member/lookup only),
// while sibling maps (attestation_owners) and the INNER per-payload map ARE.
//
// It drives the REAL Compact-emitted circuits locally (no chain / no proof
// server): attest -> grantDisclosure -> decode+enumerate -> revokeDisclosure
// -> decode again. If this passes, the production indexer (disclosure-indexer.ts)
// can mirror the exact decode/enumerate logic against publicDataProvider state.
//
// Run: node scripts/spike-disclosure-indexer.mjs

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

const rt = await import('@midnight-ntwrk/compact-runtime');
const mod = await import(pathToFileURL(artifactPath).href);
const Contract = mod.Contract;
const ledger = mod.ledger;

// ---- helpers --------------------------------------------------------------
const hex = (b) => Buffer.from(b).toString('hex');
const bytes32 = (fill) => new Uint8Array(32).fill(fill);

// Fixed attester secret; attest + grant must share it so the owner check passes.
const attesterSecret = bytes32(0x11);
const witnesses = {
    local_secret_key(ctx) { return [ctx.privateState, attesterSecret]; },
    attested_value(ctx)   { return [ctx.privateState, 0n]; },
    value_salt(ctx)       { return [ctx.privateState, bytes32(0) ]; },
    field_value(ctx)      { return [ctx.privateState, 0n]; },
    merkle_siblings(ctx)  { return [ctx.privateState, [bytes32(0), bytes32(0), bytes32(0), bytes32(0)]]; },
    merkle_dirs(ctx)      { return [ctx.privateState, [true, true, true, true]]; }
};

const instance = new Contract(witnesses);
ok('artifact: ledger fn', typeof ledger === 'function');
ok('artifact: grantDisclosure circuit', typeof instance.impureCircuits?.grantDisclosure === 'function');

// ---- build initial state + a circuit context ------------------------------
// coinPublicKey: 32-byte hex (value-shape only; we never prove/submit here).
const COIN_PK_HEX = '00'.repeat(32);
const ctorCtx = rt.createConstructorContext({}, COIN_PK_HEX);
const init = instance.initialState(ctorCtx);
ok('initialState: returns contract state', !!init?.currentContractState);

// Mirror the arg shape the emitted initialState uses for createCircuitContext.
let circuitCtx = rt.createCircuitContext(
    rt.dummyContractAddress(),
    ctorCtx.initialZswapLocalState.coinPublicKey,
    init.currentContractState.data,
    init.currentPrivateState
);

// ---- decode the EMPTY state + confirm the iterability asymmetry ------------
const led0 = ledger(circuitCtx.currentQueryContext.state);
ok('decode: disclosures present + empty', led0.disclosures?.isEmpty?.() === true);
ok('decode: attestation_owners iterable',
    typeof led0.attestation_owners?.[Symbol.iterator] === 'function');
ok('CONSTRAINT: outer disclosures NOT iterable (member/lookup only)',
    typeof led0.disclosures?.[Symbol.iterator] !== 'function',
    'if this ever flips, the indexer can iterate disclosures directly');

// ---- drive attest -> grantDisclosure --------------------------------------
const payloadHash = bytes32(0xaa);
const metadataHash = bytes32(0xbb);
const grantee = bytes32(0xcc);
const LEVEL = 1n;

function runCircuit(name, ...args) {
    const out = instance.impureCircuits[name](circuitCtx, ...args);
    circuitCtx = out.context; // thread the mutated context forward
    return out;
}

runCircuit('attest', payloadHash, metadataHash);
runCircuit('grantDisclosure', payloadHash, grantee, LEVEL);

const led1 = ledger(circuitCtx.currentQueryContext.state);
ok('grant: disclosures.member(payloadHash)', led1.disclosures.member(payloadHash) === true);

const inner = led1.disclosures.lookup(payloadHash);
ok('grant: inner map iterable', typeof inner?.[Symbol.iterator] === 'function');
ok('grant: inner has grantee', inner.member(grantee) === true);
ok('grant: level round-trips', inner.lookup(grantee) === LEVEL, `got ${inner.lookup(grantee)}`);

// ---- THE PRODUCTION ENUMERATION STRATEGY ----------------------------------
// Outer map not iterable -> enumerate payload hashes from attestation_owners
// (iterable, keyed by payload_hash), then drill into disclosures.lookup(ph).
function enumerateGrants(led) {
    const rows = [];
    for (const [phBytes] of led.attestation_owners) {
        if (!led.disclosures.member(phBytes)) continue;
        for (const [gBytes, levelBig] of led.disclosures.lookup(phBytes)) {
            rows.push({ payloadHash: hex(phBytes), grantee: hex(gBytes), level: Number(levelBig) });
        }
    }
    return rows;
}

const grants1 = enumerateGrants(led1);
ok('enumerate: finds exactly the one grant', grants1.length === 1, `got ${grants1.length}`);
ok('enumerate: row payloadHash matches', grants1[0]?.payloadHash === hex(payloadHash));
ok('enumerate: row grantee matches', grants1[0]?.grantee === hex(grantee));
ok('enumerate: row level matches', grants1[0]?.level === 1);

// ---- revoke -> re-decode --------------------------------------------------
runCircuit('revokeDisclosure', payloadHash, grantee);
const led2 = ledger(circuitCtx.currentQueryContext.state);
ok('revoke: grantee gone from inner map', led2.disclosures.lookup(payloadHash).member(grantee) === false);
ok('revoke: enumeration now empty', enumerateGrants(led2).length === 0);

console.log();
console.log(failures === 0
    ? 'SPIKE PASS — ledger() decode + attestation_owners-driven enumeration works; outer disclosures map is not iterable as expected.'
    : `${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
