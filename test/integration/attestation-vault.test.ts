/**
 * The compiled attestation-vault artifact, driven locally: the REAL emitted
 * circuits run on compact-runtime against an in-memory ledger state (no chain,
 * no proofs, no proof server). Every scenario below pins a guard or a parity
 * rule the service layer relies on; the off-chain builders and claim-key
 * recomputes are the production modules under srv/submission.
 *
 * Each describe block starts from a freshly constructed contract state and
 * re-runs only the prerequisites it needs, so one failing scenario does not
 * hide the others.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll } from 'vitest';
import {
    buildAttestationVaultWitnesses,
    deriveAttestationSecret
} from '../../srv/submission/contract-witnesses';
import { buildDocumentContentRoot } from '../../srv/submission/document-proof';
import {
    canonicalSetDigests,
    membershipPathFor,
    MAX_SET_VALUES,
    SET_DEPTH
} from '../../srv/submission/set-root';
import {
    computeAttestCommitment,
    computeDocumentDiffClaimKey,
    computeDocumentIntegrityClaimKey,
    computeFieldEqualityClaimKey,
    computeFieldMembershipClaimKey
} from '../../srv/submission/predicate-state';
import { emptyLeafKeyHex } from '../../srv/submission/hashing';

const repoRoot = path.resolve(__dirname, '..', '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js');
const zkConfigPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault');

/** Fixed block time: lineage-3 commitments carry a block-time expiry. */
const BLOCK_TIME = 1_700_000_000;
const EXPIRY = BigInt(BLOCK_TIME + 3600);

const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const maskOf = (...slots: number[]) => Array.from({ length: 16 }, (_, i) => slots.includes(i));

/** Runs `fn` and returns the thrown message ('' when it did not throw). */
function failing(fn: () => unknown): string {
    try {
        fn();
        return '';
    } catch (err: any) {
        return String(err?.message ?? err) || 'threw';
    }
}

/** Hand-rolled witnesses with a fixed secret: what a direct wallet caller supplies. */
function makeWitnesses(secretBytes: Uint8Array) {
    const zero = () => bytes32(0);
    return {
        local_secret_key(ctx: any) { return [ctx.privateState, secretBytes]; },
        field_value(ctx: any)      { return [ctx.privateState, 0n]; },
        field_salt(ctx: any)       { return [ctx.privateState, zero()]; },
        merkle_siblings(ctx: any)  { return [ctx.privateState, [zero(), zero(), zero(), zero()]]; },
        merkle_dirs(ctx: any)      { return [ctx.privateState, [true, true, true, true]]; },
        field_digest(ctx: any)     { return [ctx.privateState, zero()]; },
        set_siblings(ctx: any)     { return [ctx.privateState, [zero(), zero(), zero(), zero(), zero(), zero()]]; },
        set_dirs(ctx: any)         { return [ctx.privateState, [true, true, true, true, true, true]]; },
        doc_schema(ctx: any)       { return [ctx.privateState, Array.from({ length: 16 }, () => ({ field_key: zero(), kind: 2n, scale: 0n }))]; },
        doc_salt_a(ctx: any)       { return [ctx.privateState, zero()]; },
        doc_salt_b(ctx: any)       { return [ctx.privateState, zero()]; },
        doc_slots_a(ctx: any)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: zero() }))]; },
        doc_slots_b(ctx: any)      { return [ctx.privateState, Array.from({ length: 16 }, () => ({ present: false, uint_value: 0n, value_digest: zero() }))]; }
    };
}

let mod: any;
let ContractClass: any;
let rt: any;

/** The constructor takes the registrar as a PUBLIC argument; the off-chain
 *  attester-id computation must match the in-circuit caller_id():
 *  persistentHash<Bytes<32>>(secret). */
const attesterIdOf = (secretBytes: Uint8Array): Uint8Array =>
    rt.persistentHash(new rt.CompactTypeBytes(32), secretBytes);

const ownerSecret = bytes32(0x11);
const attackerSecret = bytes32(0x22);

interface Vault {
    owner: any;
    attacker: any;
    registrarId: Uint8Array;
    run(contract: any, circuit: string, ...args: unknown[]): any;
    ledger(): any;
    setBlockTime(seconds: number): void;
}

/** A fresh contract state deployed by the owner (registrar = owner id). */
function deployVault(): Vault {
    const owner = new ContractClass(makeWitnesses(ownerSecret));
    const attacker = new ContractClass(makeWitnesses(attackerSecret));
    const registrarId = attesterIdOf(ownerSecret);
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
        attacker,
        registrarId,
        run(contract, circuit, ...args) {
            const out = contract.impureCircuits[circuit](ctx, ...args);
            ctx = out.context; // thread the mutated context forward
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

beforeAll(async () => {
    mod = await import(pathToFileURL(artifactPath).href);
    ContractClass = mod.Contract ?? mod.default ?? mod;
    rt = await import('@midnight-ntwrk/compact-runtime');
});

describe('artifact shape', () => {
    let instance: any;
    const stubWitnesses = makeWitnesses(new Uint8Array(32));

    beforeAll(() => {
        instance = new ContractClass(stubWitnesses);
    });

    test('exports Contract, ledger and pureCircuits', () => {
        expect(typeof ContractClass).toBe('function');
        expect(typeof mod.ledger).toBe('function');
        expect(mod.pureCircuits).toBeDefined();
    });

    test('exposes the attestation and disclosure circuits', () => {
        expect(typeof instance.circuits?.attest).toBe('function');
        expect(typeof instance.circuits?.attestGuarded).toBe('function');
        expect(typeof instance.circuits?.grantDisclosure).toBe('function');
        expect(typeof instance.circuits?.revokeDisclosure).toBe('function');
    });

    test('the commitment-only lane is gone (an overwritable commitment left stale claims verifiable)', () => {
        expect(instance.circuits?.commitValue).toBeUndefined();
        expect(instance.circuits?.provePredicate).toBeUndefined();
    });

    test('exposes the field-bound proof circuits and their pure leaf hashers', () => {
        expect(typeof instance.circuits?.proveFieldPredicate).toBe('function');
        expect(typeof instance.circuits?.proveFieldEquality).toBe('function');
        expect(typeof instance.circuits?.proveFieldMembership).toBe('function');
        expect(typeof instance.circuits?.proveDocumentComparison).toBe('function');
        expect(typeof mod.pureCircuits?.bytesLeafHash).toBe('function');
        expect(typeof mod.pureCircuits?.setLeafHash).toBe('function');
        expect(typeof mod.pureCircuits?.emptyLeafKey).toBe('function');
        expect(typeof mod.pureCircuits?.absentLeafHash).toBe('function');
        expect(typeof mod.pureCircuits?.descriptorLeafHash).toBe('function');
        expect(typeof mod.pureCircuits?.slotSalt).toBe('function');
    });

    test('wires the witness object as given', () => {
        expect(instance.witnesses).toBe(stubWitnesses);
    });

    test('emptyLeafKey has byte parity with hashing.ts', () => {
        expect(toHex(mod.pureCircuits.emptyLeafKey())).toBe(emptyLeafKeyHex());
    });
});

describe('CompiledContract composition', () => {
    test('CompiledContract.make + withWitnesses + withCompiledFileAssets composes', async () => {
        const compactJs: any = await import('@midnight-ntwrk/compact-js');
        const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
        expect(typeof CompiledContract?.make).toBe('function');

        const composed = CompiledContract.make('attestation-vault', ContractClass).pipe(
            CompiledContract.withWitnesses(makeWitnesses(new Uint8Array(32))),
            CompiledContract.withCompiledFileAssets(zkConfigPath)
        );
        expect(composed).not.toBeNull();
        expect(CompiledContract.getCompiledAssetsPath(composed)).toBe(zkConfigPath);
    });
});

describe('witness factory', () => {
    const seed = new Uint8Array(32).fill(0x77);
    const fakeCtx = { privateState: { foo: 'bar' }, ledger: {}, contractAddress: 'addr-stub' };

    test('derives a 32-byte secret and builds local_secret_key without the removed commitment witnesses', () => {
        const secret = deriveAttestationSecret(seed);
        expect(secret.byteLength).toBe(32);
        const built = buildAttestationVaultWitnesses({ attestationSecret: secret });
        expect(typeof built.local_secret_key).toBe('function');
        expect(built.attested_value).toBeUndefined();
        expect(built.value_salt).toBeUndefined();
    });

    test('passes the private state through and returns the derived secret', () => {
        const secret = deriveAttestationSecret(seed);
        const built = buildAttestationVaultWitnesses({ attestationSecret: secret });
        const [psOut, secretOut] = built.local_secret_key(fakeCtx);
        expect(psOut).toBe(fakeCtx.privateState);
        expect(toHex(secretOut)).toBe(toHex(secret));
    });

    test('is deterministic across rebuilds on the same seed', () => {
        const secret = deriveAttestationSecret(seed);
        const builtAgain = buildAttestationVaultWitnesses({ attestationSecret: deriveAttestationSecret(seed) });
        const [, secretAgain] = builtAgain.local_secret_key(fakeCtx);
        expect(toHex(secretAgain)).toBe(toHex(secret));
    });
});

describe('attest ownership-takeover guard', () => {
    // Re-attesting a known payload_hash must throw instead of silently
    // replacing attestation_owners (a Map.insert overwrite would let the
    // attacker pass every owner-gated assert: grantDisclosure /
    // revokeDisclosure / bindPassport / anchorContentRoot).
    let v: Vault;
    const payloadHash = bytes32(0xaa);

    beforeAll(() => {
        v = deployVault();
        v.run(v.owner, 'attest', payloadHash, bytes32(0xbb));
        v.run(v.owner, 'grantDisclosure', payloadHash, bytes32(0xcc), 2n);
    });

    test('grantDisclosure level 3 is rejected in-circuit (tier range guard)', () => {
        expect(failing(() => v.run(v.owner, 'grantDisclosure', payloadHash, bytes32(0xcd), 3n)))
            .toContain('level out of range');
    });

    test('re-attest of an existing payload_hash is rejected', () => {
        expect(failing(() => v.run(v.attacker, 'attest', payloadHash, bytes32(0xdd))))
            .toContain('already attested');
    });

    test('a non-owner still fails an owner-gated circuit', () => {
        expect(failing(() => v.run(v.attacker, 'revokeDisclosure', payloadHash, bytes32(0xcc))))
            .toContain('not attester');
    });

    test('the grant made before the takeover attempt survives', () => {
        expect(v.ledger().disclosures.lookup(payloadHash).member(bytes32(0xcc))).toBe(true);
    });

    test('a fresh payload_hash still attests, also for a second attester', () => {
        expect(failing(() => v.run(v.attacker, 'attest', bytes32(0xee), bytes32(0xff)))).toBe('');
    });
});

describe('bindPassport rebind-takeover guard', () => {
    // Without the guard ANY attester could re-bind an already-bound passportId
    // onto their own attestation, hijacking the QR resolution. Same-owner
    // rebinding must stay allowed.
    let v: Vault;
    const payloadHash = bytes32(0xaa);
    const newPayloadHash = bytes32(0xab);
    const passportId = bytes32(0x77);

    beforeAll(() => {
        v = deployVault();
        v.run(v.owner, 'attest', payloadHash, bytes32(0xbb));
        v.run(v.attacker, 'attest', bytes32(0xee), bytes32(0xff));
    });

    test('the first bind by the attestation owner succeeds', () => {
        expect(failing(() => v.run(v.owner, 'bindPassport', passportId, payloadHash))).toBe('');
    });

    test('a foreign re-bind of a bound passportId is rejected and the binding is untouched', () => {
        expect(failing(() => v.run(v.attacker, 'bindPassport', passportId, bytes32(0xee))))
            .toContain('passport bound by another attester');
        expect(sameBytes(v.ledger().passport_bindings.lookup(passportId), payloadHash)).toBe(true);
    });

    test('the same owner may re-bind the passport to a newer attestation of their own', () => {
        expect(failing(() => {
            v.run(v.owner, 'attest', newPayloadHash, bytes32(0xbc));
            v.run(v.owner, 'bindPassport', passportId, newPayloadHash);
        })).toBe('');
        expect(sameBytes(v.ledger().passport_bindings.lookup(passportId), newPayloadHash)).toBe(true);
    });

    test('an unbound passportId still binds for any attester on their own hash', () => {
        expect(failing(() => v.run(v.attacker, 'bindPassport', bytes32(0x78), bytes32(0xee)))).toBe('');
    });
});

describe('registrar-gated passport pre-registration', () => {
    // registerPassport is registrar-only (the deployer identity, locked in by
    // the constructor). A registered passportId may only be bound by its
    // registered owner: blocks a foreign FIRST bind (squatting) and recovers
    // an already-squatted id by rebinding over the foreign binding.
    let v: Vault;
    let ownerId: Uint8Array;
    const payloadHash = bytes32(0xaa);
    const newPayloadHash = bytes32(0xab);

    beforeAll(() => {
        v = deployVault();
        v.run(v.owner, 'attest', payloadHash, bytes32(0xbb));
        v.run(v.owner, 'attest', newPayloadHash, bytes32(0xbc));
        v.run(v.attacker, 'attest', bytes32(0xee), bytes32(0xff));
        // 0x78 gets squatted (unregistered) by the attacker.
        v.run(v.attacker, 'bindPassport', bytes32(0x78), bytes32(0xee));
        ownerId = v.ledger().attestation_owners.lookup(payloadHash);
    });

    test('the constructor locked the deployer as registrar', () => {
        expect(sameBytes(v.ledger().registrar, ownerId)).toBe(true);
    });

    test('the off-chain attester-id recompute matches the in-circuit caller_id', () => {
        // The constructor arg was computed OFF-CHAIN; equality with the
        // in-circuit attest() owner id proves the worker's deploy-time
        // attester-id recompute is byte-identical to caller_id().
        expect(sameBytes(v.registrarId, ownerId)).toBe(true);
    });

    test('a non-registrar registerPassport is rejected', () => {
        expect(failing(() => v.run(v.attacker, 'registerPassport', bytes32(0x79), bytes32(0x01))))
            .toContain('not registrar');
    });

    test('pre-registration blocks a foreign FIRST bind of a still-unbound id', () => {
        v.run(v.owner, 'registerPassport', bytes32(0x79), ownerId);
        expect(failing(() => v.run(v.attacker, 'bindPassport', bytes32(0x79), bytes32(0xee))))
            .toContain('not passport owner');
    });

    test('the registered owner binds their id', () => {
        expect(failing(() => v.run(v.owner, 'bindPassport', bytes32(0x79), newPayloadHash))).toBe('');
    });

    test('the registered owner rebinds over a squatted binding', () => {
        // Registering the squatted id to the owner lets the owner rebind OVER
        // the attacker's binding, which the unregistered rebind guard alone forbids.
        v.run(v.owner, 'registerPassport', bytes32(0x78), ownerId);
        expect(failing(() => v.run(v.owner, 'bindPassport', bytes32(0x78), newPayloadHash))).toBe('');
        expect(sameBytes(v.ledger().passport_bindings.lookup(bytes32(0x78)), newPayloadHash)).toBe(true);
    });
});

describe('bytes equality + set membership', () => {
    // proveFieldEquality / proveFieldMembership over a content root and a set
    // root built by the PRODUCTION builders with the artifact's pure circuits;
    // the recorded claim keys must byte-match the crawler-free recompute.
    let v: Vault;
    let built8: any;
    let chem: any;
    let origin: any;
    let capacity8: any;
    let sneaky: any;
    let memberPath: any;
    const allowList = ['EEA', 'CH', 'NO'];
    const bytesPayload = bytes32(0xcd);
    const bytesPayloadHex = toHex(bytesPayload);

    beforeAll(() => {
        v = deployVault();
        const document = {
            chemistry: 'NMC811', origin: 'EEA', capacity: 42,
            // Adversarial fixture: the PRE-FIX padding label as a real field value.
            sneaky: 'nightgate/set-root/empty/v1'
        };
        built8 = buildDocumentContentRoot(document, [
            { field: 'chemistry', kind: 'bytes' },
            { field: 'origin', kind: 'bytes' },
            { field: 'capacity' },
            { field: 'sneaky', kind: 'bytes' }
        ], mod.pureCircuits, bytes32(0x42));
        chem = built8.fields.find((f: any) => f.field === 'chemistry');
        origin = built8.fields.find((f: any) => f.field === 'origin');
        capacity8 = built8.fields.find((f: any) => f.field === 'capacity');
        sneaky = built8.fields.find((f: any) => f.field === 'sneaky');
        memberPath = membershipPathFor(allowList, origin.valueDigest, mod.pureCircuits);
        v.run(v.owner, 'attest', bytesPayload, bytes32(0xce));
        v.run(v.owner, 'anchorContentRoot', bytesPayload, hexToBytes(built8.contentRoot), hexToBytes(built8.schemaId));
    });

    const eqContract = () => new ContractClass(buildAttestationVaultWitnesses({
        attestationSecret: ownerSecret,
        merkleProof: { fieldSalt: chem.salt, siblings: chem.siblings, dirs: chem.dirs }
    } as any));
    const memContract = () => new ContractClass(buildAttestationVaultWitnesses({
        attestationSecret: ownerSecret,
        merkleProof: {
            fieldDigest: origin.valueDigest, fieldSalt: origin.salt,
            siblings: origin.siblings, dirs: origin.dirs,
            setProof: { siblings: memberPath.setSiblings, dirs: memberPath.setDirs }
        }
    } as any));

    test('the builder emits digests for bytes fields', () => {
        expect(chem?.valueDigest).toBeTruthy();
        expect(origin?.valueDigest).toBeTruthy();
    });

    test('proveFieldEquality accepts the anchored digest', () => {
        expect(failing(() => v.run(eqContract(), 'proveFieldEquality',
            bytesPayload, hexToBytes(chem.fieldKey), hexToBytes(chem.valueDigest)))).toBe('');
    });

    test('proveFieldEquality rejects a wrong expected digest', () => {
        expect(failing(() => v.run(eqContract(), 'proveFieldEquality',
            bytesPayload, hexToBytes(chem.fieldKey), bytes32(0x01)))).toContain('field not in passport');
    });

    test('proveFieldMembership accepts a member with the canonical set root', () => {
        expect(memberPath).not.toBeNull();
        expect(failing(() => v.run(memContract(), 'proveFieldMembership',
            bytesPayload, hexToBytes(origin.fieldKey), hexToBytes(memberPath.setRoot)))).toBe('');
    });

    test('proveFieldMembership rejects a wrong set root', () => {
        expect(failing(() => v.run(memContract(), 'proveFieldMembership',
            bytesPayload, hexToBytes(origin.fieldKey), bytes32(0x02)))).toContain('value not in set');
    });

    test('proveFieldPredicate op 2 is rejected in-circuit (op range guard)', () => {
        // Without the guard, op 2 would select the greaterOrEqual branch.
        const opContract = new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: ownerSecret,
            merkleProof: { fieldValue: capacity8.value, fieldSalt: capacity8.salt, siblings: capacity8.siblings, dirs: capacity8.dirs }
        } as any));
        expect(failing(() => v.run(opContract, 'proveFieldPredicate', bytesPayload, hexToBytes(capacity8.fieldKey), 1n, 2n)))
            .toContain('op out of range');
    });

    test('ADVERSARIAL: the pre-fix padding label anchored as a real value is not provable via a padding-slot path', () => {
        // Rebuild the canonical tree levels, extract the first padding slot's
        // path, and drive the real circuit with the label's digest: the set
        // fold must fail.
        const setDigests = canonicalSetDigests(allowList);
        const padLeaves: Uint8Array[] = [];
        for (let i = 0; i < MAX_SET_VALUES; i++) {
            padLeaves.push(mod.pureCircuits.setLeafHash(hexToBytes(setDigests[i] ?? setDigests[setDigests.length - 1])));
        }
        const padLevels = [padLeaves];
        for (let d = 0; d < SET_DEPTH; d++) {
            const prev = padLevels[d];
            const next: Uint8Array[] = [];
            for (let i = 0; i < prev.length; i += 2) next.push(mod.pureCircuits.nodeHash(prev[i], prev[i + 1]));
            padLevels.push(next);
        }
        const padSlotPath = { siblings: [] as string[], dirs: [] as boolean[] };
        let padNode = setDigests.length; // first padding slot
        for (let d = 0; d < SET_DEPTH; d++) {
            const isLeft = padNode % 2 === 0;
            padSlotPath.siblings.push(toHex(padLevels[d][isLeft ? padNode + 1 : padNode - 1]));
            padSlotPath.dirs.push(isLeft);
            padNode = Math.floor(padNode / 2);
        }
        const attackContract = new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: ownerSecret,
            merkleProof: {
                fieldDigest: sneaky.valueDigest, // digest of the old padding label
                fieldSalt: sneaky.salt,
                siblings: sneaky.siblings, dirs: sneaky.dirs,
                setProof: { siblings: padSlotPath.siblings, dirs: padSlotPath.dirs }
            }
        } as any));
        expect(failing(() => v.run(attackContract, 'proveFieldMembership',
            bytesPayload, hexToBytes(sneaky.fieldKey), hexToBytes(memberPath.setRoot)))).toContain('value not in set');
    });

    test('the claim-key recomputes (with the attestation epoch) hit the recorded results', async () => {
        // Claim keys embed the payload's ATTESTATION EPOCH (attestation_seqs),
        // read from the same ledger state, exactly as the crawler-free reader does.
        const led = v.ledger();
        const epoch = led.attestation_seqs.lookup(bytesPayload);
        const eqKey = await computeFieldEqualityClaimKey(bytesPayloadHex, chem.fieldKey, chem.valueDigest, epoch);
        expect(led.field_equality_results.member(hexToBytes(eqKey))).toBe(true);
        expect(led.field_equality_results.lookup(hexToBytes(eqKey))).toBe(true);
        const memKey = await computeFieldMembershipClaimKey(bytesPayloadHex, origin.fieldKey, memberPath.setRoot, epoch);
        expect(led.field_membership_results.member(hexToBytes(memKey))).toBe(true);
        expect(led.field_membership_results.lookup(hexToBytes(memKey))).toBe(true);
    });
});

/** Documents for the cross-root scenarios: B changes slot 0's value and DROPS
 *  slot 2 (presence change); slots 1 and 3 are identical. C reuses A's values
 *  under a DIFFERENT field name at slot 3 (its own schema). */
function buildCrossRootDocuments() {
    const crossSpecs: any[] = [
        { field: 'energy' },
        { field: 'chemistry', kind: 'bytes' },
        { field: 'origin', kind: 'bytes' },
        { field: 'extra' }
    ];
    const builtA = buildDocumentContentRoot({ energy: 100, chemistry: 'NMC811', origin: 'EEA', extra: 7 }, crossSpecs, mod.pureCircuits, bytes32(0xa1));
    const builtB = buildDocumentContentRoot({ energy: 250, chemistry: 'NMC811', extra: 7 }, crossSpecs, mod.pureCircuits, bytes32(0xb1));
    const builtC = buildDocumentContentRoot(
        { energy: 100, chemistry: 'NMC811', origin: 'EEA', renamed: 7 },
        [crossSpecs[0], crossSpecs[1], crossSpecs[2], { field: 'renamed' }],
        mod.pureCircuits, bytes32(0xc1));
    return { builtA, builtB, builtC };
}

describe('cross-root document proofs', () => {
    // proveDocumentComparison (mode 0 integrity / mode 1 diff) over SALTED
    // content roots built by the PRODUCTION builder; the recorded claim keys
    // must byte-match the descriptor recomputes, and the schema binding is
    // proven in-circuit.
    let v: Vault;
    let builtA9: any;
    let builtB9: any;
    let builtC9: any;
    const payloadA9 = bytes32(0xd1);
    const payloadB9 = bytes32(0xd2);
    const payloadC9 = bytes32(0xd3);

    const docPairContract = (openingB: any, secret: Uint8Array | undefined = ownerSecret) =>
        new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB } }
        } as any));

    beforeAll(() => {
        v = deployVault();
        ({ builtA: builtA9, builtB: builtB9, builtC: builtC9 } = buildCrossRootDocuments());
        v.run(v.owner, 'attest', payloadA9, bytes32(0xd4));
        v.run(v.owner, 'attest', payloadB9, bytes32(0xd5));
        v.run(v.owner, 'attest', payloadC9, bytes32(0xd6));
        v.run(v.owner, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId));
        v.run(v.owner, 'anchorContentRoot', payloadB9, hexToBytes(builtB9.contentRoot), hexToBytes(builtB9.schemaId));
        v.run(v.owner, 'anchorContentRoot', payloadC9, hexToBytes(builtC9.contentRoot), hexToBytes(builtC9.schemaId));
    });

    test('the builder exports 16 leaves + schema + opening + schemaId', () => {
        expect(builtA9.leaves.length).toBe(16);
        expect(builtA9.schema.length).toBe(16);
        expect(builtA9.opening.slots.length).toBe(16);
        expect(builtA9.schemaId).toMatch(/^[0-9a-f]{64}$/);
    });

    test('the same specs yield the same schemaId regardless of values, presence and seed', () => {
        expect(builtA9.schemaId).toBe(builtB9.schemaId);
    });

    test('a different field list yields a different schemaId', () => {
        expect(builtA9.schemaId).not.toBe(builtC9.schemaId);
    });

    test('an absent specced field lands on the SALTED absent leaf', () => {
        expect(builtB9.leaves[2]).toBe(toHex(mod.pureCircuits.absentLeafHash(
            hexToBytes(builtB9.schema[2].fieldKey), mod.pureCircuits.slotSalt(bytes32(0xb1), 2n)
        )));
    });

    test('identical values under different seeds yield DIFFERENT leaves (dictionary resistance)', () => {
        expect(builtA9.leaves[1]).not.toBe(builtB9.leaves[1]);
        expect(builtA9.leaves[15]).not.toBe(builtB9.leaves[15]);
    });

    test('anchoring is insert-once-or-identical: a different root is rejected', () => {
        expect(failing(() => v.run(v.owner, 'anchorContentRoot', payloadA9, hexToBytes(builtB9.contentRoot), hexToBytes(builtA9.schemaId))))
            .toContain('content root already anchored');
    });

    test('anchoring is insert-once-or-identical: a different schema is rejected', () => {
        expect(failing(() => v.run(v.owner, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtC9.schemaId))))
            .toContain('schema already anchored');
    });

    test('an identical re-anchor is a harmless no-op', () => {
        expect(failing(() => v.run(v.owner, 'anchorContentRoot', payloadA9, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId)))).toBe('');
    });

    test('unchanged-except accepts a mask covering exactly the changed slots', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 1n))).toBe('');
    });

    test.each([
        ['the all-ones mask', Array.from({ length: 16 }, () => true)],
        ['a mask freeing every real slot of a 4-field schema', maskOf(0, 1, 2, 3)]
    ])('VACUOUS integrity mask rejected in-circuit: %s', (_label, vacuousMask) => {
        // Server-side 400s alone would leave direct wallet callers able to
        // record an "everything may differ" claim.
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 0n, vacuousMask, 1n)))
            .toContain('mask must constrain at least one schema slot');
    });

    test('integrity mode rejects a non-neutral k (canonical inactive parameters)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 2n)))
            .toContain('k must be the neutral dummy');
    });

    test('diff mode rejects a non-neutral mask (canonical inactive parameters)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(0), 1n)))
            .toContain('mask must be the neutral dummy');
    });

    test('a presence change outside the mask is rejected', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0), 1n)))
            .toContain('slot changed outside allowed mask');
    });

    test('a tampered opening fails the anchored-root binding even inside the allowed mask', () => {
        const tamperedOpening = {
            saltSeed: builtB9.opening.saltSeed,
            slots: builtB9.opening.slots.map((s: any, i: number) => i === 0 ? { present: true, value: '123456' } : s)
        };
        expect(failing(() => v.run(docPairContract(tamperedOpening), 'proveDocumentComparison', payloadA9, payloadB9, 0n, maskOf(0, 2), 1n)))
            .toContain('doc B opening does not match anchored root');
    });

    test('a document cannot be compared with itself', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadA9, 0n, maskOf(), 1n)))
            .toContain('documents must differ');
    });

    test('k-differ accepts k = the actual difference count (value + absence)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 2n))).toBe('');
    });

    test('k above the actual difference count is rejected', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 3n)))
            .toContain('too few differing fields');
    });

    test('k = 0 is rejected before any folding', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 0n)))
            .toContain('k out of range');
    });

    test('an anchored schema mismatch aborts the comparison before any value is compared', () => {
        // C was anchored under a DIFFERENT field list (slot 3 renamed); the
        // witnessed shared schema (A's) cannot fold to C's anchored schema id.
        expect(failing(() => v.run(docPairContract(builtC9.opening), 'proveDocumentComparison', payloadA9, payloadC9, 1n, maskOf(), 1n)))
            .toContain('doc B schema mismatch');
    });

    test('ADVERSARIAL: a forged schema label cannot produce a diff claim', () => {
        // Anchor a document whose tree was built over a DIFFERENT field list,
        // but label it with A's schemaId. A plain schema-equality lookup
        // accepted this; the circuit recomputes the content root under the
        // witnessed shared schema, and the forged document's real opening
        // cannot fold to its anchored root.
        const payloadF9 = bytes32(0xd7);
        v.run(v.owner, 'attest', payloadF9, bytes32(0xd8));
        v.run(v.owner, 'anchorContentRoot', payloadF9, hexToBytes(builtC9.contentRoot), hexToBytes(builtA9.schemaId));
        expect(failing(() => v.run(docPairContract(builtC9.opening), 'proveDocumentComparison', payloadA9, payloadF9, 1n, maskOf(), 1n)))
            .toContain('doc B opening does not match anchored root');
    });

    test.each([
        { kind: 3n,   payloadA: 0xd9, payloadB: 0xda, metaA: 0xdb, metaB: 0xdc, seedA: 0xe1, seedB: 0xe2 },
        { kind: 255n, payloadA: 0xe5, payloadB: 0xe6, metaA: 0xe7, metaB: 0xe8, seedA: 0xe3, seedB: 0xe4 }
    ])('ADVERSARIAL: out-of-range descriptor kind $kind is rejected in-circuit', (c) => {
        // Descriptors are witness data. Without the canonical-slot guard an
        // out-of-range kind lands on the absent leaf in slotLeaf but compares
        // as a bytes field in slotDiff, so two all-absent roots could prove a
        // fabricated k=1 diff. The guard rejects the schema before any root math.
        // Built with RAW witness objects (a malicious client does not use our
        // validating helpers).
        const fold16 = (leaves: Uint8Array[]) => {
            let level = leaves;
            while (level.length > 1) {
                const next: Uint8Array[] = [];
                for (let i = 0; i < level.length; i += 2) next.push(mod.pureCircuits.nodeHash(level[i], level[i + 1]));
                level = next;
            }
            return level[0];
        };
        const evilKeys = Array.from({ length: 16 }, (_, i) => {
            const b = new Uint8Array(32); b[0] = 0xee; b[1] = Number(c.kind & 0xffn); b[2] = i; return b;
        });
        const evilRootFor = (seedByte: number) => fold16(evilKeys.map((k, i) =>
            mod.pureCircuits.absentLeafHash(k, mod.pureCircuits.slotSalt(bytes32(seedByte), BigInt(i)))));
        const evilSchemaId = fold16(evilKeys.map(k => mod.pureCircuits.descriptorLeafHash(k, c.kind, 0n)));
        const pA = bytes32(c.payloadA);
        const pB = bytes32(c.payloadB);
        v.run(v.owner, 'attest', pA, bytes32(c.metaA));
        v.run(v.owner, 'attest', pB, bytes32(c.metaB));
        v.run(v.owner, 'anchorContentRoot', pA, evilRootFor(c.seedA), evilSchemaId);
        v.run(v.owner, 'anchorContentRoot', pB, evilRootFor(c.seedB), evilSchemaId);
        const evilSlots = (fill: number) => Array.from({ length: 16 }, () =>
            ({ present: true, uint_value: 0n, value_digest: new Uint8Array(32).fill(fill) }));
        const evilContract = new ContractClass({
            ...buildAttestationVaultWitnesses({ attestationSecret: ownerSecret }),
            doc_schema:  (ctx: any) => [ctx.privateState, evilKeys.map(k => ({ field_key: k, kind: c.kind, scale: 0n }))],
            doc_salt_a:  (ctx: any) => [ctx.privateState, bytes32(c.seedA)],
            doc_salt_b:  (ctx: any) => [ctx.privateState, bytes32(c.seedB)],
            doc_slots_a: (ctx: any) => [ctx.privateState, evilSlots(0x11)],
            doc_slots_b: (ctx: any) => [ctx.privateState, evilSlots(0x22)]
        });
        expect(failing(() => v.run(evilContract, 'proveDocumentComparison', pA, pB, 1n, maskOf(), 1n)))
            .toContain('schema kind out of range');
    });

    test('a holder proves WITHOUT the attester secret (privilege separation)', () => {
        // The proof circuits never invoke local_secret_key.
        expect(failing(() => v.run(docPairContract(builtB9.opening, undefined), 'proveDocumentComparison', payloadA9, payloadB9, 1n, maskOf(), 1n))).toBe('');
    });

    test('the claim-key recomputes hit the recorded results and the reversed order does not', async () => {
        const led = v.ledger();
        const epochA9 = led.attestation_seqs.lookup(payloadA9);
        const epochB9 = led.attestation_seqs.lookup(payloadB9);
        const integKey = await computeDocumentIntegrityClaimKey(toHex(payloadA9), toHex(payloadB9), 0b101, epochA9, epochB9);
        expect(led.document_integrity_results.member(hexToBytes(integKey))).toBe(true);
        expect(led.document_integrity_results.lookup(hexToBytes(integKey))).toBe(true);
        const diffKey = await computeDocumentDiffClaimKey(toHex(payloadA9), toHex(payloadB9), 2, epochA9, epochB9);
        expect(led.document_diff_results.member(hexToBytes(diffKey))).toBe(true);
        expect(led.document_diff_results.lookup(hexToBytes(diffKey))).toBe(true);
        // (A, B) order is part of the claim.
        const reversedKey = await computeDocumentIntegrityClaimKey(toHex(payloadB9), toHex(payloadA9), 0b101, epochB9, epochA9);
        expect(led.document_integrity_results.member(hexToBytes(reversedKey))).toBe(false);
    });
});

const commitmentFor = async (payload: Uint8Array, meta: Uint8Array, nonce: Uint8Array) =>
    hexToBytes(await computeAttestCommitment(toHex(payload), toHex(meta), toHex(nonce)));

describe('guarded attest: commit-reveal takeover', () => {
    // attest() is FCFS and insert-once, so a mempool observer could permanently
    // claim a visible payload hash. attestGuarded closes it: commit an opaque,
    // caller-bound, EXPIRING commitment first, reveal later; the reveal
    // inherits the commitment's sequence and is final. The off-chain
    // computeAttestCommitment parity is proven implicitly: the reveal
    // recomputes the commitment in-circuit and must hit the committed entry.
    let v: Vault;
    let builtA9: any;
    let a9chem: any;
    let gCommitment: Uint8Array;
    let sniperEpoch: bigint;
    const gPayload = bytes32(0xf1);
    const gMeta = bytes32(0xf2);
    const gNonce = bytes32(0xf3);

    beforeAll(async () => {
        v = deployVault();
        ({ builtA: builtA9 } = buildCrossRootDocuments());
        a9chem = builtA9.fields.find((f: any) => f.field === 'chemistry');
        gCommitment = await commitmentFor(gPayload, gMeta, gNonce);
    });

    test('commit mode rejects non-dummy metadata', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(1), bytes32(0), EXPIRY)))
            .toContain('metadata must be the neutral dummy');
    });

    test('reveal mode rejects a non-dummy expiry', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, EXPIRY)))
            .toContain('expires_at must be the neutral dummy');
    });

    test('a reveal without a commitment is rejected', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, 0n)))
            .toContain('no matching commitment');
    });

    test('a commitment expiring in the past is refused at commit', () => {
        // The kernel block-time comparisons return booleans the circuit
        // asserts; the local runtime evaluates them against the query
        // context's block time.
        expect(failing(() => v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), BigInt(BLOCK_TIME - 1))))
            .toContain('commitment expiry must lie in the future');
    });

    test('a commitment more than 7 days ahead is refused at commit', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), BigInt(BLOCK_TIME + 8 * 86400))))
            .toContain('commitment expiry too far ahead');
    });

    test('a duplicate commitment by the SAME committer is rejected', () => {
        // The victim (owner) commits.
        v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), EXPIRY);
        expect(failing(() => v.run(v.owner, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), EXPIRY)))
            .toContain('commitment already recorded');
    });

    test('a copied commitment is a separate, inert record the copier cannot reveal', () => {
        // Copy-griefing: the attacker records the victim's commitment VALUE
        // under their own key; the victim's entry is untouched and the
        // attacker cannot reveal it without the nonce (a guessed nonce
        // recomputes a different commitment, whose key has no record).
        v.run(v.attacker, 'attestGuarded', 0n, gCommitment, bytes32(0), bytes32(0), EXPIRY);
        expect(failing(() => v.run(v.attacker, 'attestGuarded', 1n, gPayload, gMeta, bytes32(0xee), 0n)))
            .toContain('no matching commitment');
    });

    test('a sniper who front-runs the reveal owns the payload pre-reveal, with a verifying claim and a grant', async () => {
        // SNIPER: the attacker front-runs the reveal with a plain attest AND,
        // while they own the attestation, anchors a content root, PROVES a
        // claim against it and grants themselves disclosure level 2 (the full
        // abuse window the takeover must erase).
        v.run(v.attacker, 'attest', gPayload, bytes32(0xf4));
        v.run(v.attacker, 'anchorContentRoot', gPayload, hexToBytes(builtA9.contentRoot), hexToBytes(builtA9.schemaId));
        const sniperEqContract = new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: attackerSecret,
            merkleProof: { fieldSalt: a9chem.salt, siblings: a9chem.siblings, dirs: a9chem.dirs }
        } as any));
        v.run(sniperEqContract, 'proveFieldEquality', gPayload, hexToBytes(a9chem.fieldKey), hexToBytes(a9chem.valueDigest));
        v.run(v.attacker, 'grantDisclosure', gPayload, bytes32(0xf8), 2n);

        const led = v.ledger();
        sniperEpoch = led.attestation_seqs.lookup(gPayload);
        const sniperEraKey = await computeFieldEqualityClaimKey(toHex(gPayload), a9chem.fieldKey, a9chem.valueDigest, sniperEpoch);
        expect(sameBytes(led.attestation_owners.lookup(gPayload), attesterIdOf(attackerSecret))).toBe(true);
        expect(led.field_equality_results.member(hexToBytes(sniperEraKey))).toBe(true);
        // A plain attestation is not guarded.
        expect(led.guarded_attestations.member(gPayload)).toBe(false);
    });

    test('the reveal takes the sniped attestation over and erases the abuse window', async () => {
        // The commitment predates the snipe.
        v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, 0n);
        const led = v.ledger();
        expect(sameBytes(led.attestation_owners.lookup(gPayload), attesterIdOf(ownerSecret))).toBe(true);
        // The sniper-anchored content root + schema are removed.
        expect(led.content_roots.member(gPayload)).toBe(false);
        expect(led.content_schemas.member(gPayload)).toBe(false);
        // The epoch moved, so verifiers (which always recompute with the
        // CURRENT epoch) no longer reach the sniper-era claim entry.
        const recoveredEpoch = led.attestation_seqs.lookup(gPayload);
        expect(recoveredEpoch).not.toBe(sniperEpoch);
        const currentEraKey = await computeFieldEqualityClaimKey(toHex(gPayload), a9chem.fieldKey, a9chem.valueDigest, recoveredEpoch);
        expect(led.field_equality_results.member(hexToBytes(currentEraKey))).toBe(false);
        // The sniper's disclosure grant is gone.
        expect(led.disclosures.member(gPayload)).toBe(false);
        // The recovered attestation is guarded (final).
        expect(led.guarded_attestations.member(gPayload)).toBe(true);
    });

    test('the commitment was consumed by the reveal', () => {
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, gPayload, gMeta, gNonce, 0n)))
            .toContain('no matching commitment');
    });

    test('a NEWER commitment cannot re-take the recovered attestation (no ping-pong)', async () => {
        const aNonce = bytes32(0xf5);
        const aCommitment = await commitmentFor(gPayload, gMeta, aNonce);
        v.run(v.attacker, 'attestGuarded', 0n, aCommitment, bytes32(0), bytes32(0), EXPIRY);
        expect(failing(() => v.run(v.attacker, 'attestGuarded', 1n, gPayload, gMeta, aNonce, 0n)))
            .toContain('attestation is guarded');
    });

    test('a commitment NEWER than a plain attestation cannot take it over', async () => {
        const pPayload = bytes32(0xfd);
        const pNonce = bytes32(0xfe);
        const pCommitment = await commitmentFor(pPayload, gMeta, pNonce);
        v.run(v.owner, 'attest', pPayload, gMeta);
        v.run(v.attacker, 'attestGuarded', 0n, pCommitment, bytes32(0), bytes32(0), EXPIRY);
        expect(failing(() => v.run(v.attacker, 'attestGuarded', 1n, pPayload, gMeta, pNonce, 0n)))
            .toContain('attestation predates commitment');
    });
});

describe('guarded attest: the reveal itself cannot be front-run', () => {
    // The reveal inherits the commitment's sequence and a revealed attestation
    // is final, so a commit that lands between the legitimate commit and its
    // reveal is never older than the attestation and cannot take it over.
    let v: Vault;
    let ownerCommitSeq: bigint;
    const l3Payload = bytes32(0xf5);
    const l3Meta = bytes32(0xf6);
    const l3Nonce = bytes32(0xf7);
    const l3SnipeNonce = bytes32(0xf9);

    beforeAll(async () => {
        v = deployVault();
        v.run(v.owner, 'attestGuarded', 0n, await commitmentFor(l3Payload, l3Meta, l3Nonce), bytes32(0), bytes32(0), EXPIRY);
        ownerCommitSeq = v.ledger().attest_seq_next - 1n;
        // The attacker sees the payload in the reveal's mempool and commits
        // their own (metadata/nonce of their choosing) BEFORE the reveal lands.
        v.run(v.attacker, 'attestGuarded', 0n, await commitmentFor(l3Payload, l3Meta, l3SnipeNonce), bytes32(0), bytes32(0), EXPIRY);
        v.run(v.owner, 'attestGuarded', 1n, l3Payload, l3Meta, l3Nonce, 0n);
    });

    test('a fresh reveal inherits the COMMITMENT sequence as its epoch', () => {
        expect(v.ledger().attestation_seqs.lookup(l3Payload)).toBe(ownerCommitSeq);
    });

    test('the attacker commit that front-ran the reveal cannot take over and the owner keeps the attestation', () => {
        expect(failing(() => v.run(v.attacker, 'attestGuarded', 1n, l3Payload, l3Meta, l3SnipeNonce, 0n)))
            .toContain('attestation is guarded');
        expect(sameBytes(v.ledger().attestation_owners.lookup(l3Payload), attesterIdOf(ownerSecret))).toBe(true);
    });

    test('a self-reveal against an own attestation changes nothing and consumes its commitment', async () => {
        const l3SelfNonce = bytes32(0xfa);
        v.run(v.owner, 'attestGuarded', 0n, await commitmentFor(l3Payload, l3Meta, l3SelfNonce), bytes32(0), bytes32(0), EXPIRY);
        v.run(v.owner, 'attestGuarded', 1n, l3Payload, l3Meta, l3SelfNonce, 0n);
        const led = v.ledger();
        expect(led.attestation_seqs.lookup(l3Payload)).toBe(ownerCommitSeq);
        expect(sameBytes(led.attestation_owners.lookup(l3Payload), attesterIdOf(ownerSecret))).toBe(true);
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, l3Payload, l3Meta, l3SelfNonce, 0n)))
            .toContain('no matching commitment');
    });
});

describe('guarded attest: expiry, uncontested reveal, replay', () => {
    let v: Vault;
    let builtB9: any;
    const gMeta = bytes32(0xf2);

    beforeAll(() => {
        v = deployVault();
        ({ builtB: builtB9 } = buildCrossRootDocuments());
    });

    test('a reveal after the commitment expired is refused', async () => {
        const payload = bytes32(0xfb);
        const nonce = bytes32(0xfc);
        v.run(v.owner, 'attestGuarded', 0n, await commitmentFor(payload, gMeta, nonce), bytes32(0), bytes32(0), BigInt(BLOCK_TIME + 100));
        v.setBlockTime(BLOCK_TIME + 101);
        try {
            expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, payload, gMeta, nonce, 0n)))
                .toContain('commitment expired');
        } finally {
            v.setBlockTime(BLOCK_TIME);
        }
    });

    test('an uncontested commit-reveal attests', async () => {
        const payload = bytes32(0xf6);
        const nonce = bytes32(0xf7);
        v.run(v.owner, 'attestGuarded', 0n, await commitmentFor(payload, gMeta, nonce), bytes32(0), bytes32(0), EXPIRY);
        v.run(v.owner, 'attestGuarded', 1n, payload, gMeta, nonce, 0n);
        const led = v.ledger();
        expect(led.public_attestations.member(payload)).toBe(true);
        expect(sameBytes(led.attestation_owners.lookup(payload), attesterIdOf(ownerSecret))).toBe(true);
    });

    test('replaying a successful reveal is rejected and the meanwhile-anchored root survives', () => {
        // Commitments are CONSUMED on success. Without that, a second
        // identical reveal would satisfy rec.seq < attestation_seq, run the
        // takeover branch against the revealer's OWN attestation and delete
        // the meanwhile-anchored root, re-opening insert-once.
        const payload = bytes32(0xf6);
        const nonce = bytes32(0xf7);
        v.run(v.owner, 'anchorContentRoot', payload, hexToBytes(builtB9.contentRoot), hexToBytes(builtB9.schemaId));
        expect(failing(() => v.run(v.owner, 'attestGuarded', 1n, payload, gMeta, nonce, 0n)))
            .toContain('no matching commitment');
        expect(v.ledger().content_roots.member(payload)).toBe(true);
    });
});
