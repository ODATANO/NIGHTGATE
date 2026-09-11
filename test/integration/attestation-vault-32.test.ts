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
    computeAttestCommitment,
    computeDocumentDiffClaimKey,
    computeDocumentIntegrityClaimKey,
    expandAllowedMask
} from '../../srv/submission/predicate-state';

const repoRoot = path.resolve(__dirname, '..', '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault-32/src/managed/attestation-vault-32/contract/index.js');

const WIDTH = 32;
const DEPTH = 5;
/** Fixed block time: commitments carry a block-time expiry. */
const BLOCK_TIME = 1_700_000_000;
const EXPIRY = BigInt(BLOCK_TIME + 3600);

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

const commitmentFor = async (payload: Uint8Array, meta: Uint8Array, nonce: Uint8Array) =>
    hexToBytes(await computeAttestCommitment(toHex(payload), toHex(meta), toHex(nonce)));

let mod: any;
let ContractClass: any;
let rt: any;

const ownerSecret = bytes32(0x11);

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
    const init = owner.initialState(ctorCtx, registrarId);
    let ctx = rt.createCircuitContext(
        rt.dummyContractAddress(),
        ctorCtx.initialZswapLocalState.coinPublicKey,
        init.currentContractState.data,
        init.currentPrivateState,
        undefined, undefined, BLOCK_TIME
    );
    return {
        owner,
        run(contract, circuit, ...args) {
            const out = contract.impureCircuits[circuit](ctx, ...args);
            ctx = out.context;
            return out;
        },
        ledger() {
            return mod.ledger(ctx.currentQueryContext.state);
        },
        setBlockTime(seconds) {
            ctx.currentQueryContext.block = { ...ctx.currentQueryContext.block, secondsSinceEpoch: BigInt(seconds) };
        }
    };
}

/** Attests + anchors both width documents on a fresh vault. */
function deployWithDocuments() {
    const v = deployVault();
    const { builtA, builtB } = buildWidthDocuments();
    const payloadA = bytes32(0xd1);
    const payloadB = bytes32(0xd2);
    v.run(v.owner, 'attest', payloadA, bytes32(0xd4));
    v.run(v.owner, 'attest', payloadB, bytes32(0xd5));
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

    test('the artifact loads with Contract and pureCircuits', () => {
        expect(typeof ContractClass).toBe('function');
        expect(mod.pureCircuits).toBeDefined();
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

    beforeAll(() => {
        d = deployWithDocuments();
    });

    test('proveFieldPredicate lands over the depth-5 path', () => {
        const marker7: any = d.builtA.fields.find((f: any) => f.field === 'marker_07');
        const eqContract = new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: ownerSecret, slotWidth: WIDTH,
            merkleProof: {
                fieldValue: String(marker7.value), fieldSalt: marker7.salt,
                siblings: marker7.siblings, dirs: marker7.dirs
            }
        } as any));
        expect(failing(() => d.v.run(eqContract, 'proveFieldPredicate', d.payloadA, hexToBytes(marker7.fieldKey), 1000000n, 0n))).toBe('');
    });

    test('an integrity proof with bit 31 set lands (slots 0 + 31 differ)', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', d.payloadA, d.payloadB, 0n, maskOf(0, 31), 1n))).toBe('');
    });

    test('an integrity mask missing the changed slot 31 is rejected in-circuit', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', d.payloadA, d.payloadB, 0n, maskOf(0), 1n))).not.toBe('');
    });

    test('a diff proof k=2 of 32 lands', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', d.payloadA, d.payloadB, 1n, maskOf(), 2n))).toBe('');
    });

    test('a diff proof k=3 is rejected (only 2 slots differ)', () => {
        expect(failing(() => d.v.run(d.docPairContract, 'proveDocumentComparison', d.payloadA, d.payloadB, 1n, maskOf(), 3n))).not.toBe('');
    });

    test('the integrity claim key (mask 0x80000001, width 32) recompute matches the circuit', async () => {
        const led = d.v.ledger();
        const epochA = led.attestation_seqs.lookup(d.payloadA);
        const epochB = led.attestation_seqs.lookup(d.payloadB);
        const integKey = await computeDocumentIntegrityClaimKey(toHex(d.payloadA), toHex(d.payloadB), 0x80000001, epochA, epochB, WIDTH);
        expect(led.document_integrity_results.member(hexToBytes(integKey))).toBe(true);
        expect(led.document_integrity_results.lookup(hexToBytes(integKey))).toBe(true);
    });

    test('a width-16 recompute is a DIFFERENT key (width is part of the claim shape)', async () => {
        const led = d.v.ledger();
        const epochA = led.attestation_seqs.lookup(d.payloadA);
        const epochB = led.attestation_seqs.lookup(d.payloadB);
        const integKey16 = await computeDocumentIntegrityClaimKey(toHex(d.payloadA), toHex(d.payloadB), 0x80000001 & 0xffff, epochA, epochB, 16);
        expect(led.document_integrity_results.member(hexToBytes(integKey16))).toBe(false);
    });

    test('the diff claim key recompute matches the circuit', async () => {
        const led = d.v.ledger();
        const epochA = led.attestation_seqs.lookup(d.payloadA);
        const epochB = led.attestation_seqs.lookup(d.payloadB);
        const diffKey = await computeDocumentDiffClaimKey(toHex(d.payloadA), toHex(d.payloadB), 2, epochA, epochB);
        expect(led.document_diff_results.member(hexToBytes(diffKey))).toBe(true);
        expect(led.document_diff_results.lookup(hexToBytes(diffKey))).toBe(true);
    });
});

describe('guarded commit-reveal on the width-32 artifact', () => {
    let v: Vault;
    let gCommitment: Uint8Array;
    const gPayload = bytes32(0xe1);
    const gMeta = bytes32(0xe2);
    const gNonce = bytes32(0xe3);

    beforeAll(async () => {
        v = deployVault();
        gCommitment = await commitmentFor(gPayload, gMeta, gNonce);
    });

    test('a commitment expiring in the past is refused at commit', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), BigInt(BLOCK_TIME - 1))))
            .toContain('commitment expiry must lie in the future');
    });

    test('a reveal without the nonce is refused', () => {
        v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), EXPIRY);
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, bytes32(0xe4), 0n)))
            .toContain('no matching commitment');
    });

    test('commit-reveal attests, guarded, with epoch = commitment sequence', () => {
        const seqBefore = v.ledger().attest_seq_next;
        v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, 0n);
        const led = v.ledger();
        expect(led.public_attestations.member(gPayload)).toBe(true);
        expect(led.guarded_attestations.member(gPayload)).toBe(true);
        expect(led.attestation_seqs.lookup(gPayload) < seqBefore).toBe(true);
    });

    test('the commitment was consumed by the reveal', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, 0n)))
            .toContain('no matching commitment');
    });

    test('a reveal after the commitment expired is refused', async () => {
        const xPayload = bytes32(0xe5);
        const xNonce = bytes32(0xe6);
        v.run(v.owner, 'attestGuarded', 0n, await commitmentFor(xPayload, gMeta, xNonce), bytes32(0), bytes32(0), BigInt(BLOCK_TIME + 100));
        v.setBlockTime(BLOCK_TIME + 101);
        try {
            expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, xPayload, gMeta, xNonce, 0n)))
                .toContain('commitment expired');
        } finally {
            v.setBlockTime(BLOCK_TIME);
        }
    });
});
