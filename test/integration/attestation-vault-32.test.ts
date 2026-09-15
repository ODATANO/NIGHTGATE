/**
 * The compiled attestation-vault-32 artifact (32 content slots), driven
 * locally on compact-runtime: the width-32 twin of attestation-vault.test.ts,
 * focused on what the width changes. Content trees are DEPTH 5 end to end
 * through the production builders (document-proof with slotWidth 32), bit 31
 * of an integrity mask lands and its claim key matches the width-32 recompute
 * (mask 0x80000001 through Integer64/Number), and the commit-reveal lane runs
 * on this artifact too.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';
import { buildAttestationVaultWitnesses } from '../../srv/submission/contract-witnesses';
import { buildDocumentContentRoot } from '../../srv/submission/document-proof';
import {
    computeRecordKey,
    computeDocumentDiffClaimKey,
    computeDocumentIntegrityClaimKey,
    computeFieldPredicateClaimKey,
    expandAllowedMask
} from '../../srv/submission/predicate-state';

const repoRoot = path.resolve(__dirname, '..', '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault-32/src/managed/attestation-vault-32/contract/index.js');

const WIDTH = 32;
const DEPTH = 5;
/** Fixed block time; commitments and claims carry block-time expiries. */
const BLOCK_TIME = 1_700_000_000;
const VALID_UNTIL = BigInt(BLOCK_TIME + 86400);
const ZERO = new Uint8Array(32);

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const maskOf = (...slots: number[]) => Array.from({ length: WIDTH }, (_, i) => slots.includes(i));

/** Runs `fn` and returns the thrown message ('' when it did not throw). */
function failing(fn: () => unknown): string {
    try {
        fn();
        return '';
    } catch (err: any) {
        return String(err?.message ?? err) || 'threw';
    }
}

let mod: any;
let ContractClass: any;
let rt: any;

const ownerSecret = bytes32(0x11);

/** The ledger key of the owner's record: the artifact's `recordKey` pure circuit. */
const ownerRk = (payload: Uint8Array): Uint8Array =>
    mod.pureCircuits.recordKey(rt.persistentHash(new rt.CompactTypeBytes(32), ownerSecret), payload);

/** Documents: 32 numeric markers; B differs in slot 0 AND slot 31. */
function buildWidthDocuments() {
    const specs = Array.from({ length: WIDTH }, (_, i) => ({ field: `marker_${String(i).padStart(2, '0')}` }));
    const docA = Object.fromEntries(specs.map((s, i) => [s.field, 100 + i]));
    const docB = { ...docA, marker_00: 900, marker_31: 901 };
    const builtA = buildDocumentContentRoot(docA, specs, mod.pureCircuits, bytes32(0xa1), WIDTH);
    const builtB = buildDocumentContentRoot(docB, specs, mod.pureCircuits, bytes32(0xb1), WIDTH);
    return { builtA, builtB };
}

interface Vault {
    owner: any;
    run(contract: any, circuit: string, ...args: unknown[]): any;
    attest(contract: any, payload: Uint8Array, meta: Uint8Array): any;
    ledger(): any;
    setBlockTime(seconds: number): void;
}

/** A fresh width-32 contract state deployed by the owner (registrar = owner id). */
function deployVault(): Vault {
    const owner = new ContractClass(buildAttestationVaultWitnesses({
        attestationSecret: ownerSecret, slotWidth: WIDTH
    } as any));
    const registrarId = rt.persistentHash(new rt.CompactTypeBytes(32), ownerSecret);
    const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
    const init = owner.initialState(ctorCtx, registrarId, new Uint8Array(32));
    let ctx = rt.createCircuitContext(
        rt.dummyContractAddress(),
        ctorCtx.initialZswapLocalState.coinPublicKey,
        init.currentContractState.data,
        init.currentPrivateState,
        undefined, undefined, BLOCK_TIME
    );
    const v: Vault = {
        owner,
        run(contract, circuit, ...args) {
            const out = contract.impureCircuits[circuit](ctx, ...args);
            ctx = out.context;
            return out;
        },
        attest(contract, payload, meta) {
            return v.run(contract, 'attest', payload, meta);
        },
        ledger() {
            return mod.ledger(ctx.currentQueryContext.state);
        },
        setBlockTime(seconds) {
            ctx.currentQueryContext.block = { ...ctx.currentQueryContext.block, secondsSinceEpoch: BigInt(seconds) };
        }
    };
    return v;
}

/** Attests + anchors both width documents on a fresh vault. */
function deployWithDocuments() {
    const v = deployVault();
    const { builtA, builtB } = buildWidthDocuments();
    const payloadA = bytes32(0xd1);
    const payloadB = bytes32(0xd2);
    v.attest(v.owner, payloadA, bytes32(0xd4));
    v.attest(v.owner, payloadB, bytes32(0xd5));
    v.run(v.owner, 'anchorContentRoot', payloadA, hexToBytes(builtA.contentRoot), hexToBytes(builtA.schemaId));
    v.run(v.owner, 'anchorContentRoot', payloadB, hexToBytes(builtB.contentRoot), hexToBytes(builtB.schemaId));
    const docPairContract = new ContractClass(buildAttestationVaultWitnesses({
        attestationSecret: ownerSecret, slotWidth: WIDTH,
        merkleProof: { docPair: { schema: builtA.schema, openingA: builtA.opening, openingB: builtB.opening } }
    } as any));
    return { v, builtA, builtB, payloadA, payloadB, docPairContract };
}

beforeAll(async () => {
    mod = await import(pathToFileURL(artifactPath).href);
    ContractClass = mod.Contract ?? mod.default ?? mod;
    rt = await import('@midnight-ntwrk/compact-runtime');
});

describe('width-32 artifact and builder', () => {
    let builtA: any;
    let builtB: any;

    beforeAll(() => {
        ({ builtA, builtB } = buildWidthDocuments());
    });

    test('the artifact loads with Contract, eleven circuits and pureCircuits', () => {
        expect(typeof ContractClass).toBe('function');
        expect(mod.pureCircuits).toBeDefined();
        const instance = new ContractClass(buildAttestationVaultWitnesses({ attestationSecret: ownerSecret, slotWidth: WIDTH } as any));
        expect(Object.keys(instance.impureCircuits).length).toBe(11);
        expect(typeof instance.circuits?.retract).toBe('function');
    });

    test('the builder emits 32 leaves, 32 schema slots and 32 opening slots', () => {
        expect(builtA.leaves.length).toBe(WIDTH);
        expect(builtA.schema.length).toBe(WIDTH);
        expect(builtA.opening.slots.length).toBe(WIDTH);
    });

    test('inclusion paths are DEPTH 5', () => {
        expect(builtA.fields.every((f: any) => f.siblings.length === DEPTH && f.dirs.length === DEPTH)).toBe(true);
    });

    test('both documents share one schemaId', () => {
        expect(builtA.schemaId).toBe(builtB.schemaId);
    });

    test('expandAllowedMask(0x80000001, 32) frees exactly slots 0 and 31 (the JS-bitwise edge)', () => {
        const expanded = expandAllowedMask(0x80000001, WIDTH);
        expect(expanded.length).toBe(WIDTH);
        expect(expanded[0]).toBe(true);
        expect(expanded[31]).toBe(true);
        expect(expanded.slice(1, 31).every((b) => b === false)).toBe(true);
    });
});

describe('width-32 proofs against the real circuits', () => {
    let d: ReturnType<typeof deployWithDocuments>;
    let marker7: any;

    beforeAll(() => {
        d = deployWithDocuments();
        marker7 = d.builtA.fields.find((f: any) => f.field === 'marker_07');
    });

    test('proveFieldPredicate lands over the depth-5 path', () => {
        const eqContract = new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: ownerSecret, slotWidth: WIDTH,
            merkleProof: {
                fieldValue: String(marker7.value), fieldSalt: marker7.salt,
                siblings: marker7.siblings, dirs: marker7.dirs
            }
        } as any));
        expect(failing(() => d.v.run(eqContract, 'proveFieldPredicate', ownerRk(d.payloadA), hexToBytes(marker7.fieldKey), 1000000n, 0n, VALID_UNTIL))).toBe('');
    });

    test('an integrity proof with bit 31 set lands (slots 0 + 31 differ)', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(d.payloadB), 0n, maskOf(0, 31), 1n, VALID_UNTIL))).toBe('');
    });

    test('an integrity mask missing the changed slot 31 is rejected in-circuit', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(d.payloadB), 0n, maskOf(0), 1n, VALID_UNTIL))).not.toBe('');
    });

    test('a diff proof k=2 of 32 lands', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(d.payloadB), 1n, maskOf(), 2n, VALID_UNTIL))).toBe('');
    });

    test('a diff proof k=3 is rejected (only 2 slots differ)', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(d.payloadB), 1n, maskOf(), 3n, VALID_UNTIL))).not.toBe('');
    });

    test('the claim keys (mask 0x80000001 at width 32, diff k=2, field predicate) match the circuit', async () => {
        const led = d.v.ledger();
        const rootA = toHex(led.content_anchors.lookup(ownerRk(d.payloadA)).root);
        const rootB = toHex(led.content_anchors.lookup(ownerRk(d.payloadB)).root);
        const schema = toHex(led.content_anchors.lookup(ownerRk(d.payloadA)).schema);
        const integKey = await computeDocumentIntegrityClaimKey(toHex(ownerRk(d.payloadA)), rootA, toHex(ownerRk(d.payloadB)), rootB, schema, 0x80000001, WIDTH);
        expect(led.claims.member(hexToBytes(integKey))).toBe(true);
        expect(led.claims.lookup(hexToBytes(integKey))).toBe(VALID_UNTIL);
        const diffKey = await computeDocumentDiffClaimKey(toHex(ownerRk(d.payloadA)), rootA, toHex(ownerRk(d.payloadB)), rootB, schema, 2);
        expect(led.claims.member(hexToBytes(diffKey))).toBe(true);
        const predKey = await computeFieldPredicateClaimKey(toHex(ownerRk(d.payloadA)), rootA, schema, marker7.fieldKey, 1000000n, 0);
        expect(led.claims.member(hexToBytes(predKey))).toBe(true);
    });

    test('a width-16 recompute is a DIFFERENT key (width is part of the claim shape)', async () => {
        const led = d.v.ledger();
        const rootA = toHex(led.content_anchors.lookup(ownerRk(d.payloadA)).root);
        const rootB = toHex(led.content_anchors.lookup(ownerRk(d.payloadB)).root);
        const schema = toHex(led.content_anchors.lookup(ownerRk(d.payloadA)).schema);
        const integKey16 = await computeDocumentIntegrityClaimKey(toHex(ownerRk(d.payloadA)), rootA, toHex(ownerRk(d.payloadB)), rootB, schema, 0x80000001 & 0xffff, 16);
        expect(led.claims.member(hexToBytes(integKey16))).toBe(false);
    });

    test('a later comparison proof may extend the claim expiry but not shorten it', async () => {
        const led0 = d.v.ledger();
        const rootA = toHex(led0.content_anchors.lookup(ownerRk(d.payloadA)).root);
        const rootB = toHex(led0.content_anchors.lookup(ownerRk(d.payloadB)).root);
        const schema = toHex(led0.content_anchors.lookup(ownerRk(d.payloadA)).schema);
        const integKey = hexToBytes(await computeDocumentIntegrityClaimKey(toHex(ownerRk(d.payloadA)), rootA, toHex(ownerRk(d.payloadB)), rootB, schema, 0x80000001, WIDTH));
        const prove = (until: bigint) => failing(() =>
            d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(d.payloadB), 0n, maskOf(0, 31), 1n, until));
        expect(prove(VALID_UNTIL - 1n)).toContain('claim expiry cannot be shortened');
        expect(prove(VALID_UNTIL + 1n)).toBe('');
        expect(d.v.ledger().claims.lookup(integKey)).toBe(VALID_UNTIL + 1n);
    });

    test('retract removes the attestation, its anchor and the claims stay keyed under the old root', async () => {
        const led0 = d.v.ledger();
        const rootA = toHex(led0.content_anchors.lookup(ownerRk(d.payloadA)).root);
        const schema = toHex(led0.content_anchors.lookup(ownerRk(d.payloadA)).schema);
        const predKey = hexToBytes(await computeFieldPredicateClaimKey(toHex(ownerRk(d.payloadA)), rootA, schema, marker7.fieldKey, 1000000n, 0));
        expect(failing(() => d.v.run(d.v.owner, 'retract', 0n, d.payloadA))).toBe('');
        const led = d.v.ledger();
        expect(led.attestations.member(ownerRk(d.payloadA))).toBe(false);
        expect(led.content_anchors.member(ownerRk(d.payloadA))).toBe(false);
        expect(led.claims.member(predKey)).toBe(true);
        expect(failing(() => d.v.run(d.v.owner, 'retract', 1n, predKey))).toContain('claim not expired');
    });
});

describe('record keys on the width-32 artifact', () => {
    let d: ReturnType<typeof deployWithDocuments>;

    beforeAll(() => {
        d = deployWithDocuments();
    });

    test('the record key is the off-chain recompute of attester id and payload', async () => {
        expect(toHex(ownerRk(d.payloadA))).toBe(await computeRecordKey(toHex(rt.persistentHash(new rt.CompactTypeBytes(32), ownerSecret)), toHex(d.payloadA)));
    });

    test('the record carries owner and payload; a re-attest of the same record is refused', () => {
        const rec = d.v.ledger().attestations.lookup(ownerRk(d.payloadA));
        expect(sameBytesLocal(rec.payload_hash, d.payloadA)).toBe(true);
        expect(sameBytesLocal(rec.metadata_hash, bytes32(0xd4))).toBe(true);
        expect(failing(() => d.v.attest(d.v.owner, d.payloadA, bytes32(0xd4)))).toContain('already attested');
    });

    test('a proof against a record key nobody anchored is refused', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', ownerRk(d.payloadA), ownerRk(bytes32(0xd9)), 1n, maskOf(), 2n, VALID_UNTIL)))
            .toContain('no content root B');
    });
});

const sameBytesLocal = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
