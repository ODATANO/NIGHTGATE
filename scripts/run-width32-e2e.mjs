// Live e2e for the 0.19 features: the 32-slot vault variant as a REGISTERED
// contract (attestation-vault-32, no config override) and the txbuilder's
// multi-call batch (buildSponsorable({ calls })).
//
// Walks:
//   1. server width check: /zk-config/attestation-vault-32 serves the 32er
//   2. connectWallet + connectWalletForSigning (LACE session = fee sponsor)
//   3. deployContract('attestation-vault-32') via the SERVER (the registrar
//      constructor arg now derives from the vault-family name prefix)
//   4. prepareDocumentProof via the SERVER action (24 real fields -> 32
//      slots, depth-5 paths) for documents A and B
//   5. TXBUILDER BATCH: [attest, anchorContentRoot] per document in ONE
//      transaction each (shared witness holder), sponsored via
//      sponsorFinalizedTransaction: one fee event per document pair, no
//      attest-counter race inside a pair. (A 4-call batch works on a young
//      vault too, but attest's gas class moves as the vault grows and the
//      causality pre-check then splits it anyway; two 2-call batches are
//      the stable shape.)
//   6. server-side issueFieldEqualityAttestation on the 32er (depth-5
//      inclusion path through the worker witness path)
//   7. txbuilder compare mode 1 (k of 32) + crawler-free verifyPredicateState
//   8. 32-bit mask pin: verifyPredicateState documentIntegrity with bit 31
//      set returns a CLEAN negative (CAP Integer passthrough)
//
// Inputs (env): NIGHTGATE_URL (default http://localhost:4004),
// LACE_VIEWING_KEY, LACE_MNEMONIC; indexer/node URLs from env or defaults.
// Server: standard config (`npm run serve`), which registers the 32er.
// Run: npm run width32:e2e

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bip39 from 'bip39';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const MANAGED = path.join(repoRoot, 'contracts/attestation-vault-32/src/managed/attestation-vault-32');

const BASE = process.env.NIGHTGATE_URL || 'http://localhost:4004';
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const READ_TIMEOUT_MS = parseInt(process.env.E2E_READ_TIMEOUT_MIN || '10', 10) * 60_000;

function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

if (!VK) fail('LACE_VIEWING_KEY env var is required');
if (!MNEMONIC || !bip39.validateMnemonic(MNEMONIC)) fail('LACE_MNEMONIC (valid BIP39 phrase) is required');

const { connect } = await import(pathToFileURL(path.join(repoRoot, 'src/sdk/client.mjs')).href);
const { createTxBuilder } = await import(pathToFileURL(path.join(repoRoot, 'src/txbuilder/index.mjs')).href);
const { prepareAttest, prepareAnchorContentRoot, prepareProveFieldsDiffer } =
    await import(pathToFileURL(path.join(repoRoot, 'src/browser/index.mjs')).href);
const artifact = await import(pathToFileURL(path.join(MANAGED, 'contract', 'index.js')).href);
const ContractClass = artifact.Contract ?? artifact.default;
const cfgMod = await import(pathToFileURL(path.join(repoRoot, 'srv/utils/nightgate-config.js')).href);

const NETWORK = process.env.NIGHTGATE_NETWORK || 'preprod';
const IHTTP = process.env.NIGHTGATE_INDEXER_HTTP_URL || cfgMod.DEFAULT_INDEXER_URLS?.[NETWORK]?.http;
const IWS = process.env.NIGHTGATE_INDEXER_WS_URL
    || (process.env.NIGHTGATE_INDEXER_HTTP_URL && cfgMod.deriveIndexerWsUrl
        ? cfgMod.deriveIndexerWsUrl(process.env.NIGHTGATE_INDEXER_HTTP_URL)
        : cfgMod.DEFAULT_INDEXER_URLS?.[NETWORK]?.ws);
const NODE = process.env.NIGHTGATE_NODE_URL || cfgMod.DEFAULT_NODE_URL;

const ng = connect({ baseUrl: BASE, timeoutMs: 60 * 60 * 1000 });

step('1. Server width check (attestation-vault-32 registered)');
{
    const deadline = Date.now() + 30_000;
    for (;;) {
        try { await ng.getHealth(); break; }
        catch { if (Date.now() > deadline) fail(`Server at ${BASE} did not respond within 30s`); await new Promise(r => setTimeout(r, 1000)); }
    }
    const localZkir = statSync(path.join(MANAGED, 'zkir', 'proveDocumentComparison.bzkir')).size;
    const res = await fetch(`${BASE}/zk-config/attestation-vault-32/zkir/proveDocumentComparison.bzkir`);
    if (!res.ok) fail(`GET /zk-config/attestation-vault-32/... -> HTTP ${res.status}: is the server running THIS tree's build?`);
    const served = (await res.arrayBuffer()).byteLength;
    if (served !== localZkir) fail(`served 32er zkir ${served} B != local ${localZkir} B`);
    console.log(`OK   /zk-config/attestation-vault-32 serves the width-32 artifact (${served} B)`);
}

step('2. connectWallet + connectWalletForSigning (sponsor = LACE session)');
const { sessionId } = await ng.connectWallet({ viewingKey: VK });
const signing = await ng.connectWalletForSigning({ sessionId, mnemonic: MNEMONIC });
if (signing.prewarmJobId) {
    console.log('     syncing sponsor wallet...');
    await ng.waitForJob({ jobId: signing.prewarmJobId, sessionId });
}
console.log(`OK   sessionId = ${sessionId}`);

step("3. deployContract('attestation-vault-32') via the server");
const tDeploy = Date.now();
let deployed;
for (let attempt = 1; ; attempt++) {
    try {
        deployed = await ng.deployContract({ compiledArtifactRef: 'attestation-vault-32', sessionId, initialPrivateState: '{}' });
        break;
    } catch (e) {
        const msg = String(e?.errorMessage ?? e?.message ?? e);
        if (attempt < 3 && /1010|Custom error: 170/.test(msg)) {
            console.log(`     deploy attempt ${attempt} transient node reject, retrying in 60s...`);
            await new Promise(r => setTimeout(r, 60_000));
            continue;
        }
        throw e;
    }
}
const contractAddress = deployed.contractAddress;
if (!contractAddress) fail(`deploy returned no contractAddress: ${JSON.stringify(deployed)}`);
console.log(`OK   ${contractAddress} (${secs(Date.now() - tDeploy)})`);

step('4. prepareDocumentProof via SERVER action: 24 fields -> 32 slots');
const stamp = `width32-e2e-${randomBytes(4).toString('hex')}`;
const PROOF_FIELDS = [];
for (let i = 0; i < 23; i++) PROOF_FIELDS.push({ field: `marker_${String(i).padStart(2, '0')}`, kind: 'bytes' });
PROOF_FIELDS.push({ field: 'yieldIndex' });
const docA = { panel: stamp, yieldIndex: 104.2 };
for (let i = 0; i < 23; i++) docA[`marker_${String(i).padStart(2, '0')}`] = `${170 + i}/${182 + (i % 7)}`;
const docB = { ...docA };
const CHANGED = 6;
for (let i = 0; i < CHANGED; i++) docB[`marker_${String(i).padStart(2, '0')}`] = `${199 + i}/${201 + i}`;

async function prepare(document, label) {
    const r = await ng.prepareDocumentProof({
        documentJson: JSON.stringify(document),
        proofFieldsJson: JSON.stringify(PROOF_FIELDS),
        compiledArtifactRef: 'attestation-vault-32'
    });
    const out = {
        payloadHash: r.payloadHash, contentRoot: r.contentRoot, schemaId: r.schemaId,
        schema: JSON.parse(r.schema), fields: JSON.parse(r.fields), opening: JSON.parse(r.opening)
    };
    if (out.schema.length !== 32) fail(`prepare(${label}): schema has ${out.schema.length} slots, expected 32`);
    if (out.opening.slots.length !== 32) fail(`prepare(${label}): opening has ${out.opening.slots.length} slots`);
    if (out.fields[0].siblings.length !== 5) fail(`prepare(${label}): inclusion path depth ${out.fields[0].siblings.length}, expected 5`);
    return out;
}
const A = await prepare(docA, 'A');
const B = await prepare(docB, 'B');
if (A.schemaId !== B.schemaId) fail('same proofFields list must yield one schemaId');
console.log(`OK   A ${A.payloadHash.slice(0, 12)}..., B ${B.payloadHash.slice(0, 12)}..., 32 slots, depth-5 paths`);

step('5. TXBUILDER BATCH: attest+anchor per document, ONE tx each');
// Proving mode: 'server' (native, fast) whenever a LOCAL proof server is
// configured (it receives the witnesses, so only ever your own); force wasm
// with NIGHTGATE_E2E_PROVING=wasm.
const PROOF_URL = process.env.NIGHTGATE_PROOF_SERVER_URL;
const E2E_PROVING = process.env.NIGHTGATE_E2E_PROVING === 'wasm' ? 'wasm' : (PROOF_URL ? 'server' : 'wasm');
const b = await createTxBuilder({
    seedHex: randomBytes(64).toString('hex'), networkId: NETWORK,
    indexerHttpUrl: IHTTP, indexerWsUrl: IWS, nodeUrl: NODE,
    zkConfigBaseUrl: `${BASE}/zk-config/attestation-vault-32`,
    contractClass: ContractClass, contractName: 'attestation-vault-32',
    cacheDir: MANAGED,
    circuits: ['attest', 'anchorContentRoot', 'proveDocumentComparison'],
    ...(E2E_PROVING === 'server' ? { provingMode: 'server', proofServerUrl: PROOF_URL } : {})
});
console.log(`     attester ${b.attesterId.slice(0, 12)}..., proving: ${b.provingMode}`);

// `build` is a zero-arg async function returning { finalizedTxB64 }. On a
// 104/170/196 node reject the tx was built against a state the node has
// moved past; resubmitting the SAME bytes sticks (104 lore), so the retry
// REBUILDS against fresh contract state before sponsoring again.
async function sponsorWithRetry(label, build) {
    let built = await build();
    for (let attempt = 1, jobRetries = 0; ; attempt++) {
        try {
            const res = await ng.sponsorFinalized({ finalizedTxB64: built.finalizedTxB64, sponsorSessionId: sessionId, idempotencyKey: `${stamp}-${label}-${jobRetries}` });
            console.log(`     [${label}] sponsored, tx ${String(res.txHash ?? '').slice(0, 16)}...`);
            return res;
        } catch (e) {
            const msg = String(e?.errorMessage ?? e?.cause?.code ?? e?.message ?? e);
            if (attempt < 6 && /fetch failed|ECONNRESET|socket/i.test(msg)) { await new Promise(r => setTimeout(r, 10_000)); continue; }
            if (jobRetries < 2 && /1010\/(104|170|196)|Custom error: (104|170|196)/.test(msg)) {
                jobRetries++;
                console.log(`     [${label}] node reject against stale state, REBUILDING (retry ${jobRetries}) in 45s...`);
                await new Promise(r => setTimeout(r, 45_000));
                built = await build();
                continue;
            }
            throw e;
        }
    }
}

// One 2-call batch per document: attest + anchor land in ONE tx (one fee
// event, no attest-counter race between the pair). A 4-call batch also
// lands on a young vault, but attest's gas class moves as the vault grows
// and the causality pre-check then splits it anyway; the 2-call pair is
// the shape that stays valid longest.
for (const [doc, label] of [[A, 'A'], [B, 'B']]) {
    await sponsorWithRetry(`batch-${label}`, async () => {
        const t0 = Date.now();
        const built = await b.buildSponsorable({
            contractAddress,
            calls: [
                prepareAttest({ payloadHash: doc.payloadHash, metadataHash: doc.payloadHash, attestationSecret: b.attestationSecret }),
                prepareAnchorContentRoot({ payloadHash: doc.payloadHash, contentRoot: doc.contentRoot, schemaId: doc.schemaId, attestationSecret: b.attestationSecret })
            ]
        });
        console.log(`     [batch-${label}] attest+anchor built + proven in ${secs(Date.now() - t0)} (${built.serializedBytes} B, ONE tx)`);
        return built;
    });
}
for (const [doc, label] of [[A, 'A'], [B, 'B']]) {
    const deadline = Date.now() + READ_TIMEOUT_MS;
    for (;;) {
        const v = await ng.verifyAttestation({
            contractAddress, payloadHash: doc.payloadHash,
            contentRoot: doc.contentRoot, schemaId: doc.schemaId, compiledArtifactRef: 'attestation-vault-32'
        }).catch(() => null);
        if (v?.attested === true && v?.contentRootOk === true && v?.schemaOk === true) break;
        if (Date.now() > deadline) fail(`doc ${label} not attested+anchored on chain within the read timeout`);
        await new Promise(r => setTimeout(r, 5000));
    }
}
console.log('OK   both documents attested AND anchored, one batched tx per document');

step('6. Server-side issueFieldEqualityAttestation on the 32er (depth-5 path)');
const marker0 = A.fields.find(f => f.field === 'marker_00') || fail('marker_00 missing from prepared fields');
const eq = await ng.proveFieldEquality({
    payloadHash: A.payloadHash, fieldKey: marker0.fieldKey,
    expectedValue: docA.marker_00, fieldSalt: marker0.salt,
    siblingsJson: JSON.stringify(marker0.siblings), dirsJson: JSON.stringify(marker0.dirs),
    sessionId, contractAddress, compiledArtifactRef: 'attestation-vault-32'
});
if (!eq?.proof?.proofValue && !eq?.claim) fail(`equality job returned no proof: ${JSON.stringify(eq)}`);
console.log(`OK   equality proven server-side, tx ${String(eq.proof?.proofValue ?? '').slice(0, 16)}...`);

step(`7. txbuilder compare mode 1 (k=${CHANGED} of 32) + crawler-free verify`);
await sponsorWithRetry('compare', async () => {
    const t1 = Date.now();
    const compare = await b.buildSponsorable({
        contractAddress,
        call: prepareProveFieldsDiffer({
            payloadHashA: A.payloadHash, payloadHashB: B.payloadHash, k: CHANGED,
            docPair: { schema: A.schema, openingA: A.opening, openingB: B.opening },
            slotWidth: 32
        })
    });
    console.log(`     compare built + proven in ${secs(Date.now() - t1)}`);
    return compare;
});
{
    const deadline = Date.now() + READ_TIMEOUT_MS;
    for (;;) {
        const v = await ng.verifyPredicate({
            contractAddress, payloadHash: A.payloadHash, payloadHashB: B.payloadHash,
            predicate: 'documentDiff', k: CHANGED, compiledArtifactRef: 'attestation-vault-32'
        }).catch(() => null);
        if (v?.verified === true) { console.log('OK   diff claim verified crawler-free (width 32)'); break; }
        if (Date.now() > deadline) fail('diff claim did not verify within the read timeout');
        await new Promise(r => setTimeout(r, 5000));
    }
}

step('8. 32-bit mask pin: verifyPredicateState integrity with bit 31 set');
{
    // No such claim exists: the point is that a mask above Int31 passes the
    // OData layer and the width-32 handler bounds, yielding a CLEAN negative.
    const v = await ng.verifyPredicate({
        contractAddress, payloadHash: A.payloadHash, payloadHashB: B.payloadHash,
        predicate: 'documentIntegrity', allowedMask: 0x80000001, compiledArtifactRef: 'attestation-vault-32'
    });
    if (v?.verified !== false) fail(`expected clean verified:false, got ${JSON.stringify(v)}`);
    console.log('OK   mask 0x80000001 accepted through OData + width-32 bounds, clean negative');
}

await b.close();

console.log('\nWIDTH-32 + TXBUILDER-BATCH E2E PASSED.');
console.log(`Contract:   ${contractAddress}`);
console.log(`Payload A:  ${A.payloadHash}`);
console.log(`Payload B:  ${B.payloadHash}`);
process.exit(0);
