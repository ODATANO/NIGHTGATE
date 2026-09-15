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
    computeRecordKey,
    computeDocumentDiffClaimKey,
    computeDocumentIntegrityClaimKey,
    computeFieldEqualityClaimKey,
    computeFieldMembershipClaimKey,
    computeFieldPredicateClaimKey
} from '../../srv/submission/predicate-state';
import { emptyLeafKeyHex } from '../../srv/submission/hashing';

const repoRoot = path.resolve(__dirname, '..', '..');
const artifactPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault/contract/index.js');
const zkConfigPath = path.join(repoRoot,
    'contracts/attestation-vault/src/managed/attestation-vault');

/** Fixed block time; claims carry block-time expiries. */
const BLOCK_TIME = 1_700_000_000;
const VALID_UNTIL = BigInt(BLOCK_TIME + 86400);
const ZERO = new Uint8Array(32);

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

/** The ledger key of an attester's record: the artifact's `recordKey` pure circuit. */
const ownerRk = (payload: Uint8Array): Uint8Array => mod.pureCircuits.recordKey(attesterIdOf(ownerSecret), payload);
const attackerRk = (payload: Uint8Array): Uint8Array => mod.pureCircuits.recordKey(attesterIdOf(attackerSecret), payload);

const ownerSecret = bytes32(0x11);
const attackerSecret = bytes32(0x22);

interface Vault {
    owner: any;
    attacker: any;
    recovery: any;
    registrarId: Uint8Array;
    recoveryId: Uint8Array;
    run(contract: any, circuit: string, ...args: unknown[]): any;
    attest(contract: any, payload: Uint8Array, meta: Uint8Array): any;
    ledger(): any;
    setBlockTime(seconds: number): void;
}

const recoverySecret = bytes32(0x33);

/** A fresh contract state deployed by the owner (registrar = owner id, recovery = a third identity). */
function deployVault(): Vault {
    const owner = new ContractClass(makeWitnesses(ownerSecret));
    const attacker = new ContractClass(makeWitnesses(attackerSecret));
    const recovery = new ContractClass(makeWitnesses(recoverySecret));
    const registrarId = attesterIdOf(ownerSecret);
    const recoveryId = attesterIdOf(recoverySecret);
    const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
    const init = owner.initialState(ctorCtx, registrarId, recoveryId);
    let ctx = rt.createCircuitContext(
        rt.dummyContractAddress(),
        ctorCtx.initialZswapLocalState.coinPublicKey,
        init.currentContractState.data,
        init.currentPrivateState,
        undefined, undefined, BLOCK_TIME
    );
    const v: Vault = {
        owner,
        attacker,
        recovery,
        registrarId,
        recoveryId,
        run(contract, circuit, ...args) {
            const out = contract.impureCircuits[circuit](ctx, ...args);
            ctx = out.context; // thread the mutated context forward
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

    test('exposes the eleven exported circuits', () => {
        for (const name of ['attest', 'retract', 'grantDisclosure', 'revokeDisclosure', 'registerDocument', 'bindDocument',
            'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison']) {
            expect(typeof instance.circuits?.[name], name).toBe('function');
        }
        expect(Object.keys(instance.impureCircuits).length).toBe(11);
    });

    test('the constructor takes registrar and recovery as public arguments', () => {
        const v = deployVault();
        const led = v.ledger();
        expect(sameBytes(led.registrar, v.registrarId)).toBe(true);
        expect(sameBytes(led.recovery, v.recoveryId)).toBe(true);
    });

    test('exposes no commitment-only circuits (an overwritable commitment would leave stale claims verifiable)', () => {
        expect(instance.circuits?.commitValue).toBeUndefined();
        expect(instance.circuits?.provePredicate).toBeUndefined();
        expect(instance.circuits?.registerPassport).toBeUndefined();
        expect(instance.circuits?.bindPassport).toBeUndefined();
        expect(instance.circuits?.attestGuarded).toBeUndefined();
    });

    test('exposes the pure leaf hashers', () => {
        for (const name of ['leafHash', 'nodeHash', 'bytesLeafHash', 'absentLeafHash', 'setLeafHash', 'descriptorLeafHash', 'slotSalt', 'emptyLeafKey', 'recordKey']) {
            expect(typeof mod.pureCircuits?.[name], name).toBe('function');
        }
    });

    test('wires the witness object as given', () => {
        expect(instance.witnesses).toBe(stubWitnesses);
    });

    test('emptyLeafKey has byte parity with hashing.ts', () => {
        expect(toHex(mod.pureCircuits.emptyLeafKey())).toBe(emptyLeafKeyHex());
    });

    test('the hashed structs are separated by their type tag, not only by arity', () => {
        // Same field-element sequence, different tag: no two leaf families
        // collide with a node.
        const k = bytes32(0x31);
        const s = bytes32(0x32);
        expect(toHex(mod.pureCircuits.absentLeafHash(k, s))).not.toBe(toHex(mod.pureCircuits.nodeHash(k, s)));
        expect(toHex(mod.pureCircuits.descriptorLeafHash(k, 0n, 0n))).not.toBe(toHex(mod.pureCircuits.nodeHash(k, ZERO)));
        expect(toHex(mod.pureCircuits.setLeafHash(k))).not.toBe(toHex(mod.pureCircuits.absentLeafHash(k, ZERO)));
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

    test('derives a 32-byte secret and builds local_secret_key without commitment witnesses', () => {
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

describe('attest: ownership guard', () => {
    let v: Vault;
    const payloadHash = bytes32(0xaa);

    beforeAll(() => {
        v = deployVault();
        v.attest(v.owner, payloadHash, bytes32(0xbb));
        v.run(v.owner, 'grantDisclosure', payloadHash, bytes32(0xcc), 2n);
    });

    test('records owner, payload, metadata and no binding under the record key', () => {
        const rec = v.ledger().attestations.lookup(ownerRk(payloadHash));
        expect(sameBytes(rec.payload_hash, payloadHash)).toBe(true);
        expect(sameBytes(rec.owner, attesterIdOf(ownerSecret))).toBe(true);
        expect(sameBytes(rec.metadata_hash, bytes32(0xbb))).toBe(true);
        expect(sameBytes(rec.document_id, ZERO)).toBe(true);
    });

    test('grantDisclosure level 3 is rejected in-circuit (tier range guard)', () => {
        expect(failing(() => v.run(v.owner, 'grantDisclosure', payloadHash, bytes32(0xcd), 3n)))
            .toContain('level out of range');
    });

    test('the same attester cannot record a payload twice', () => {
        expect(failing(() => v.attest(v.owner, payloadHash, bytes32(0xdd))))
            .toContain('already attested');
    });

    test('another identity cannot touch the record: an owner-gated circuit finds no attestation of its own', () => {
        expect(failing(() => v.run(v.attacker, 'revokeDisclosure', payloadHash, bytes32(0xcc))))
            .toContain('no attestation');
        expect(failing(() => v.run(v.attacker, 'anchorContentRoot', payloadHash, bytes32(0x01), bytes32(0x02))))
            .toContain('no attestation');
        expect(failing(() => v.run(v.attacker, 'retract', 0n, payloadHash))).toContain('no attestation');
    });

    test('the same payload attested by another identity is a separate record; the first one is untouched', () => {
        expect(failing(() => v.attest(v.attacker, payloadHash, bytes32(0xdd)))).toBe('');
        const led = v.ledger();
        expect(sameBytes(led.attestations.lookup(ownerRk(payloadHash)).metadata_hash, bytes32(0xbb))).toBe(true);
        expect(sameBytes(led.attestations.lookup(attackerRk(payloadHash)).metadata_hash, bytes32(0xdd))).toBe(true);
        expect(led.disclosures.lookup(ownerRk(payloadHash)).member(bytes32(0xcc))).toBe(true);
        expect(led.disclosures.member(attackerRk(payloadHash))).toBe(false);
    });

    test('a fresh payload_hash still attests, also for a second attester', () => {
        expect(failing(() => v.attest(v.attacker, bytes32(0xee), bytes32(0xff)))).toBe('');
    });

    test('revoking on a record without disclosures is refused', () => {
        expect(failing(() => v.run(v.attacker, 'revokeDisclosure', bytes32(0xee), bytes32(0xcc))))
            .toContain('no disclosures');
    });
});

describe('bindDocument: rebind guard and one-to-one pairing', () => {
    let v: Vault;
    const payloadHash = bytes32(0xaa);
    const newPayloadHash = bytes32(0xab);
    const documentId = bytes32(0x77);

    beforeAll(() => {
        v = deployVault();
        v.attest(v.owner, payloadHash, bytes32(0xbb));
        v.attest(v.attacker, bytes32(0xee), bytes32(0xff));
    });

    test('a zero document id is refused', () => {
        expect(failing(() => v.run(v.owner, 'bindDocument', ZERO, payloadHash))).toContain('document id must not be zero');
    });

    test('the first bind by the attestation owner succeeds and is recorded on both sides', () => {
        expect(failing(() => v.run(v.owner, 'bindDocument', documentId, payloadHash))).toBe('');
        const led = v.ledger();
        expect(sameBytes(led.document_bindings.lookup(documentId), ownerRk(payloadHash))).toBe(true);
        expect(sameBytes(led.attestations.lookup(ownerRk(payloadHash)).document_id, documentId)).toBe(true);
    });

    test('a foreign re-bind of a bound id is rejected and the binding is untouched', () => {
        expect(failing(() => v.run(v.attacker, 'bindDocument', documentId, bytes32(0xee))))
            .toContain('document bound by another attester');
        expect(sameBytes(v.ledger().document_bindings.lookup(documentId), ownerRk(payloadHash))).toBe(true);
    });

    test('the same owner may re-bind the id to a newer attestation of their own; the old payload loses its id', () => {
        expect(failing(() => {
            v.attest(v.owner, newPayloadHash, bytes32(0xbc));
            v.run(v.owner, 'bindDocument', documentId, newPayloadHash);
        })).toBe('');
        const led = v.ledger();
        expect(sameBytes(led.document_bindings.lookup(documentId), ownerRk(newPayloadHash))).toBe(true);
        expect(sameBytes(led.attestations.lookup(ownerRk(newPayloadHash)).document_id, documentId)).toBe(true);
        expect(sameBytes(led.attestations.lookup(ownerRk(payloadHash)).document_id, ZERO)).toBe(true);
    });

    test('binding a payload under a second id releases its first id', () => {
        const otherId = bytes32(0x79);
        v.run(v.owner, 'bindDocument', otherId, newPayloadHash);
        const led = v.ledger();
        expect(led.document_bindings.member(documentId)).toBe(false);
        expect(sameBytes(led.document_bindings.lookup(otherId), ownerRk(newPayloadHash))).toBe(true);
        expect(sameBytes(led.attestations.lookup(ownerRk(newPayloadHash)).document_id, otherId)).toBe(true);
    });

    test('an unbound id still binds for any attester on their own hash', () => {
        expect(failing(() => v.run(v.attacker, 'bindDocument', bytes32(0x78), bytes32(0xee)))).toBe('');
    });
});

describe('registerDocument: registrar-gated ids, unregister, registrar transfer', () => {
    let v: Vault;
    let ownerId: Uint8Array;
    const payloadHash = bytes32(0xaa);
    const newPayloadHash = bytes32(0xab);

    beforeAll(() => {
        v = deployVault();
        v.attest(v.owner, payloadHash, bytes32(0xbb));
        v.attest(v.owner, newPayloadHash, bytes32(0xbc));
        v.attest(v.attacker, bytes32(0xee), bytes32(0xff));
        // 0x78 gets squatted (unregistered) by the attacker.
        v.run(v.attacker, 'bindDocument', bytes32(0x78), bytes32(0xee));
        ownerId = v.ledger().attestations.lookup(ownerRk(payloadHash)).owner;
    });

    test('the constructor locked the deployer as registrar', () => {
        expect(sameBytes(v.ledger().registrar, ownerId)).toBe(true);
    });

    test('the off-chain attester-id recompute matches the in-circuit caller_id', () => {
        expect(sameBytes(v.registrarId, ownerId)).toBe(true);
    });

    test('a non-registrar registerDocument is rejected', () => {
        expect(failing(() => v.run(v.attacker, 'registerDocument', 0n, bytes32(0x79), bytes32(0x01))))
            .toContain('not registrar');
    });

    test('pre-registration blocks a foreign FIRST bind of a still-unbound id', () => {
        v.run(v.owner, 'registerDocument', 0n, bytes32(0x79), ownerId);
        expect(failing(() => v.run(v.attacker, 'bindDocument', bytes32(0x79), bytes32(0xee))))
            .toContain('not document owner');
    });

    test('the registered owner binds their id', () => {
        expect(failing(() => v.run(v.owner, 'bindDocument', bytes32(0x79), newPayloadHash))).toBe('');
    });

    test('registering a squatted id releases the squatter\'s binding at once; the registered owner then binds', () => {
        expect(v.ledger().document_bindings.member(bytes32(0x78))).toBe(true);
        v.run(v.owner, 'registerDocument', 0n, bytes32(0x78), ownerId);
        const led = v.ledger();
        expect(led.document_bindings.member(bytes32(0x78))).toBe(false);
        expect(sameBytes(led.attestations.lookup(attackerRk(bytes32(0xee))).document_id, ZERO)).toBe(true);
        expect(failing(() => v.run(v.owner, 'bindDocument', bytes32(0x78), newPayloadHash))).toBe('');
        expect(sameBytes(v.ledger().document_bindings.lookup(bytes32(0x78)), ownerRk(newPayloadHash))).toBe(true);
    });

    test('re-registering an id to its bound owner keeps the binding', () => {
        v.run(v.owner, 'registerDocument', 0n, bytes32(0x78), ownerId);
        expect(sameBytes(v.ledger().document_bindings.lookup(bytes32(0x78)), ownerRk(newPayloadHash))).toBe(true);
    });

    test('unregister (mode 1) removes the registration and takes no owner', () => {
        expect(failing(() => v.run(v.owner, 'registerDocument', 1n, bytes32(0x79), ownerId)))
            .toContain('owner must be the neutral dummy');
        expect(failing(() => v.run(v.owner, 'registerDocument', 1n, bytes32(0x7a), ZERO)))
            .toContain('id not registered');
        v.run(v.owner, 'registerDocument', 1n, bytes32(0x79), ZERO);
        expect(v.ledger().document_owners.member(bytes32(0x79))).toBe(false);
    });

    test('transfer (mode 2) hands the registrar role over and takes no id', () => {
        const attackerId = attesterIdOf(attackerSecret);
        expect(failing(() => v.run(v.owner, 'registerDocument', 2n, bytes32(0x01), attackerId)))
            .toContain('id must be the neutral dummy');
        expect(failing(() => v.run(v.owner, 'registerDocument', 2n, ZERO, ZERO)))
            .toContain('registrar must not be zero');
        v.run(v.owner, 'registerDocument', 2n, ZERO, attackerId);
        expect(sameBytes(v.ledger().registrar, attackerId)).toBe(true);
        expect(failing(() => v.run(v.owner, 'registerDocument', 0n, bytes32(0x7b), ownerId))).toContain('not registrar');
        expect(failing(() => v.run(v.attacker, 'registerDocument', 0n, bytes32(0x7b), attackerId))).toBe('');
    });

    test('the constructor locked the recovery identity; only it runs modes 3 and 4', () => {
        const attackerId = attesterIdOf(attackerSecret);
        expect(sameBytes(v.ledger().recovery, v.recoveryId)).toBe(true);
        expect(failing(() => v.run(v.attacker, 'registerDocument', 3n, ZERO, ownerId))).toContain('not recovery');
        expect(failing(() => v.run(v.owner, 'registerDocument', 3n, ZERO, ownerId))).toContain('not recovery');
        expect(failing(() => v.run(v.recovery, 'registerDocument', 3n, bytes32(0x01), ownerId))).toContain('id must be the neutral dummy');
        expect(failing(() => v.run(v.recovery, 'registerDocument', 3n, ZERO, ZERO))).toContain('identity must not be zero');
        // The registrar role was handed to the attacker above; recovery takes it back.
        v.run(v.recovery, 'registerDocument', 3n, ZERO, ownerId);
        expect(sameBytes(v.ledger().registrar, ownerId)).toBe(true);
        expect(failing(() => v.run(v.attacker, 'registerDocument', 0n, bytes32(0x7c), attackerId))).toContain('not registrar');
        expect(failing(() => v.run(v.owner, 'registerDocument', 0n, bytes32(0x7c), ownerId))).toBe('');
        // Recovery cannot touch ids and the registrar cannot touch recovery.
        expect(failing(() => v.run(v.recovery, 'registerDocument', 0n, bytes32(0x7d), ownerId))).toContain('not registrar');
        expect(failing(() => v.run(v.owner, 'registerDocument', 4n, ZERO, ownerId))).toContain('not recovery');
        // Mode 4 rotates the recovery identity; the old one is powerless afterwards.
        v.run(v.recovery, 'registerDocument', 4n, ZERO, attackerId);
        expect(sameBytes(v.ledger().recovery, attackerId)).toBe(true);
        expect(failing(() => v.run(v.recovery, 'registerDocument', 3n, ZERO, ownerId))).toContain('not recovery');
        expect(failing(() => v.run(v.attacker, 'registerDocument', 4n, ZERO, v.recoveryId))).toBe('');
    });

    test('mode 5 is out of range', () => {
        expect(failing(() => v.run(v.attacker, 'registerDocument', 5n, ZERO, ZERO))).toContain('mode out of range');
    });

    test('a zero recovery identity disables modes 3 and 4', () => {
        const owner = new ContractClass(makeWitnesses(ownerSecret));
        const ctorCtx = rt.createConstructorContext({}, '00'.repeat(32));
        const init = owner.initialState(ctorCtx, attesterIdOf(ownerSecret), ZERO);
        const ctx = rt.createCircuitContext(rt.dummyContractAddress(), ctorCtx.initialZswapLocalState.coinPublicKey,
            init.currentContractState.data, init.currentPrivateState, undefined, undefined, BLOCK_TIME);
        expect(failing(() => owner.impureCircuits.registerDocument(ctx, 3n, ZERO, attesterIdOf(attackerSecret)))).toContain('not recovery');
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
    const bytesRk = () => ownerRk(bytesPayload);
    const bytesRkHex = () => toHex(bytesRk());

    beforeAll(() => {
        v = deployVault();
        const document = {
            chemistry: 'NMC811', origin: 'EEA', capacity: 42,
            // Adversarial fixture: a plausible padding label as a real field value.
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
        v.attest(v.owner, bytesPayload, bytes32(0xce));
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
    const capContract = () => new ContractClass(buildAttestationVaultWitnesses({
        attestationSecret: ownerSecret,
        merkleProof: { fieldValue: capacity8.value, fieldSalt: capacity8.salt, siblings: capacity8.siblings, dirs: capacity8.dirs }
    } as any));

    test('the builder emits digests for bytes fields', () => {
        expect(chem?.valueDigest).toBeTruthy();
        expect(origin?.valueDigest).toBeTruthy();
    });

    test('proveFieldEquality accepts the anchored digest', () => {
        expect(failing(() => v.run(eqContract(), 'proveFieldEquality',
            bytesRk(), hexToBytes(chem.fieldKey), hexToBytes(chem.valueDigest), VALID_UNTIL))).toBe('');
    });

    test('proveFieldEquality rejects a wrong expected digest', () => {
        expect(failing(() => v.run(eqContract(), 'proveFieldEquality',
            bytesRk(), hexToBytes(chem.fieldKey), bytes32(0x01), VALID_UNTIL))).toContain('field not in document');
    });

    test('proveFieldMembership accepts a member with the canonical set root', () => {
        expect(memberPath).not.toBeNull();
        expect(failing(() => v.run(memContract(), 'proveFieldMembership',
            bytesRk(), hexToBytes(origin.fieldKey), hexToBytes(memberPath.setRoot), VALID_UNTIL))).toBe('');
    });

    test('proveFieldMembership rejects a wrong set root', () => {
        expect(failing(() => v.run(memContract(), 'proveFieldMembership',
            bytesRk(), hexToBytes(origin.fieldKey), bytes32(0x02), VALID_UNTIL))).toContain('value not in set');
    });

    test('proveFieldPredicate records a numeric claim and rejects op 2 in-circuit', () => {
        expect(failing(() => v.run(capContract(), 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 40n, 1n, VALID_UNTIL))).toBe('');
        expect(failing(() => v.run(capContract(), 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 1n, 2n, VALID_UNTIL)))
            .toContain('op out of range');
    });

    test('a claim expiry in the past or beyond five years is rejected in-circuit', () => {
        expect(failing(() => v.run(capContract(), 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 40n, 1n, BigInt(BLOCK_TIME))))
            .toContain('expiry must lie in the future');
        // The bound is exclusive: valid_until - cap must lie before the block time.
        expect(failing(() => v.run(capContract(), 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 40n, 1n, BigInt(BLOCK_TIME + 157680000))))
            .toContain('expiry too far ahead');
        expect(failing(() => v.run(capContract(), 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 40n, 1n, BigInt(BLOCK_TIME + 157679999)))).toBe('');
    });

    test('ADVERSARIAL: a padding label anchored as a real value is not provable via a padding-slot path', () => {
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
                fieldDigest: sneaky.valueDigest, // digest of the padding label
                fieldSalt: sneaky.salt,
                siblings: sneaky.siblings, dirs: sneaky.dirs,
                setProof: { siblings: padSlotPath.siblings, dirs: padSlotPath.dirs }
            }
        } as any));
        expect(failing(() => v.run(attackContract, 'proveFieldMembership',
            bytesRk(), hexToBytes(sneaky.fieldKey), hexToBytes(memberPath.setRoot), VALID_UNTIL))).toContain('value not in set');
    });

    test('the claim-key recomputes (with the anchored root and schema) hit the recorded claims and carry valid_until', async () => {
        const led = v.ledger();
        const anchor = led.content_anchors.lookup(bytesRk());
        const root = toHex(anchor.root);
        const schema = toHex(anchor.schema);
        expect(root).toBe(built8.contentRoot);
        expect(schema).toBe(built8.schemaId);
        const eqKey = await computeFieldEqualityClaimKey(bytesRkHex(), root, schema, chem.fieldKey, chem.valueDigest);
        expect(led.claims.member(hexToBytes(eqKey))).toBe(true);
        expect(led.claims.lookup(hexToBytes(eqKey))).toBe(VALID_UNTIL);
        const memKey = await computeFieldMembershipClaimKey(bytesRkHex(), root, schema, origin.fieldKey, memberPath.setRoot);
        expect(led.claims.member(hexToBytes(memKey))).toBe(true);
        const predKey = await computeFieldPredicateClaimKey(bytesRkHex(), root, schema, capacity8.fieldKey, 40n, 1);
        expect(led.claims.member(hexToBytes(predKey))).toBe(true);
        // A key computed with a different root or schema misses.
        const otherRootKey = await computeFieldEqualityClaimKey(bytesRkHex(), toHex(bytes32(0x99)), schema, chem.fieldKey, chem.valueDigest);
        expect(led.claims.member(hexToBytes(otherRootKey))).toBe(false);
        const otherSchemaKey = await computeFieldEqualityClaimKey(bytesRkHex(), root, toHex(bytes32(0x98)), chem.fieldKey, chem.valueDigest);
        expect(led.claims.member(hexToBytes(otherSchemaKey))).toBe(false);
    });

    test('a later proof of the same claim keeps or extends the expiry, never shortens it (any holder of the opening may prove)', async () => {
        // The lifetime test above left the claim at cap-1, the longest expiry a
        // proof at this block time can record.
        const root = toHex(v.ledger().content_anchors.lookup(bytesRk()).root);
        const predKey = hexToBytes(await computeFieldPredicateClaimKey(bytesRkHex(), root, built8.schemaId, capacity8.fieldKey, 40n, 1));
        const current = v.ledger().claims.lookup(predKey) as bigint;
        expect(current).toBe(BigInt(BLOCK_TIME + 157679999));
        const attackerCap = () => new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: attackerSecret,
            merkleProof: { fieldValue: capacity8.value, fieldSalt: capacity8.salt, siblings: capacity8.siblings, dirs: capacity8.dirs }
        } as any));
        const prove = (contract: any, until: bigint) =>
            failing(() => v.run(contract, 'proveFieldPredicate', bytesRk(), hexToBytes(capacity8.fieldKey), 40n, 1n, until));
        expect(prove(attackerCap(), current - 1n)).toContain('claim expiry cannot be shortened');
        expect(prove(attackerCap(), BigInt(BLOCK_TIME + 1))).toContain('claim expiry cannot be shortened');
        expect(prove(attackerCap(), current)).toBe('');
        expect(v.ledger().claims.lookup(predKey)).toBe(current);
        // Once the claim expired, a proof at the later block time extends it.
        v.setBlockTime(Number(current) + 1);
        try {
            expect(prove(capContract(), current)).toContain('expiry must lie in the future');
            expect(prove(capContract(), current + 86400n)).toBe('');
            expect(v.ledger().claims.lookup(predKey)).toBe(current + 86400n);
        } finally {
            v.setBlockTime(BLOCK_TIME);
        }
    });

    test('retract mode 1 removes a claim only once it expired', async () => {
        const led = v.ledger();
        const root = toHex(led.content_anchors.lookup(bytesRk()).root);
        const eqKey = hexToBytes(await computeFieldEqualityClaimKey(bytesRkHex(), root, built8.schemaId, chem.fieldKey, chem.valueDigest));
        expect(failing(() => v.run(v.attacker, 'retract', 1n, eqKey))).toContain('claim not expired');
        expect(failing(() => v.run(v.attacker, 'retract', 1n, bytes32(0x55)))).toContain('no claim');
        v.setBlockTime(Number(VALID_UNTIL) + 1);
        try {
            expect(failing(() => v.run(v.attacker, 'retract', 1n, eqKey))).toBe('');
        } finally {
            v.setBlockTime(BLOCK_TIME);
        }
        expect(v.ledger().claims.member(eqKey)).toBe(false);
    });

    test('retract mode 0 is owner-only and removes attestation, anchor and disclosures', () => {
        v.run(v.owner, 'grantDisclosure', bytesPayload, bytes32(0xc1), 1n);
        v.run(v.owner, 'bindDocument', bytes32(0xc2), bytesPayload);
        expect(failing(() => v.run(v.attacker, 'retract', 0n, bytesPayload))).toContain('no attestation');
        expect(failing(() => v.run(v.owner, 'retract', 0n, bytesPayload))).toBe('');
        const led = v.ledger();
        expect(led.attestations.member(bytesRk())).toBe(false);
        expect(led.content_anchors.member(bytesRk())).toBe(false);
        expect(led.disclosures.member(bytesRk())).toBe(false);
        expect(led.document_bindings.member(bytes32(0xc2))).toBe(false);
        expect(failing(() => v.run(v.owner, 'retract', 0n, bytesPayload))).toContain('no attestation');
    });

    test('after a retract the payload attests again, and the old claims need the same root under the same record', async () => {
        expect(failing(() => v.attest(v.owner, bytesPayload, bytes32(0xce)))).toBe('');
        const led = v.ledger();
        // The membership claim recorded under the old root stays in the map
        // until purged, and resolves only if the same root is anchored again.
        const memKey = await computeFieldMembershipClaimKey(bytesRkHex(), built8.contentRoot, built8.schemaId, origin.fieldKey, memberPath.setRoot);
        expect(led.claims.member(hexToBytes(memKey))).toBe(true);
        expect(led.content_anchors.member(bytesRk())).toBe(false);
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
    let v: Vault;
    let builtA9: any;
    let builtB9: any;
    let builtC9: any;
    const payloadA9 = bytes32(0xd1);
    const payloadB9 = bytes32(0xd2);
    const payloadC9 = bytes32(0xd3);
    let rkA9: Uint8Array;
    let rkB9: Uint8Array;
    let rkC9: Uint8Array;

    const docPairContract = (openingB: any, secret: Uint8Array | undefined = ownerSecret) =>
        new ContractClass(buildAttestationVaultWitnesses({
            attestationSecret: secret,
            merkleProof: { docPair: { schema: builtA9.schema, openingA: builtA9.opening, openingB } }
        } as any));

    beforeAll(() => {
        v = deployVault();
        ({ builtA: builtA9, builtB: builtB9, builtC: builtC9 } = buildCrossRootDocuments());
        rkA9 = ownerRk(payloadA9);
        rkB9 = ownerRk(payloadB9);
        rkC9 = ownerRk(payloadC9);
        v.attest(v.owner, payloadA9, bytes32(0xd4));
        v.attest(v.owner, payloadB9, bytes32(0xd5));
        v.attest(v.owner, payloadC9, bytes32(0xd6));
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
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 0n, maskOf(0, 2), 1n, VALID_UNTIL))).toBe('');
    });

    test.each([
        ['the all-ones mask', Array.from({ length: 16 }, () => true)],
        ['a mask freeing every real slot of a 4-field schema', maskOf(0, 1, 2, 3)]
    ])('VACUOUS integrity mask rejected in-circuit: %s', (_label, vacuousMask) => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 0n, vacuousMask, 1n, VALID_UNTIL)))
            .toContain('mask must constrain at least one schema slot');
    });

    test('integrity mode rejects a non-neutral k (canonical inactive parameters)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 0n, maskOf(0, 2), 2n, VALID_UNTIL)))
            .toContain('k must be the neutral dummy');
    });

    test('diff mode rejects a non-neutral mask (canonical inactive parameters)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(0), 1n, VALID_UNTIL)))
            .toContain('mask must be the neutral dummy');
    });

    test('a presence change outside the mask is rejected', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 0n, maskOf(0), 1n, VALID_UNTIL)))
            .toContain('slot changed outside allowed mask');
    });

    test('a tampered opening fails the anchored-root binding even inside the allowed mask', () => {
        const tamperedOpening = {
            saltSeed: builtB9.opening.saltSeed,
            slots: builtB9.opening.slots.map((s: any, i: number) => i === 0 ? { present: true, value: '123456' } : s)
        };
        expect(failing(() => v.run(docPairContract(tamperedOpening), 'proveDocumentComparison', rkA9, rkB9, 0n, maskOf(0, 2), 1n, VALID_UNTIL)))
            .toContain('doc B opening does not match anchored root');
    });

    test('a record cannot be compared with itself', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkA9, 0n, maskOf(), 1n, VALID_UNTIL)))
            .toContain('records must differ');
    });

    test('k-differ accepts k = the actual difference count (value + absence)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(), 2n, VALID_UNTIL))).toBe('');
    });

    test('k above the actual difference count is rejected', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(), 3n, VALID_UNTIL)))
            .toContain('too few differing fields');
    });

    test('k = 0 is rejected before any folding', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(), 0n, VALID_UNTIL)))
            .toContain('k out of range');
    });

    test('an anchored schema mismatch aborts the comparison before any value is compared', () => {
        expect(failing(() => v.run(docPairContract(builtC9.opening), 'proveDocumentComparison', rkA9, rkC9, 1n, maskOf(), 1n, VALID_UNTIL)))
            .toContain('doc B schema mismatch');
    });

    test('ADVERSARIAL: a forged schema label cannot produce a diff claim', () => {
        const payloadF9 = bytes32(0xd7);
        v.attest(v.owner, payloadF9, bytes32(0xd8));
        v.run(v.owner, 'anchorContentRoot', payloadF9, hexToBytes(builtC9.contentRoot), hexToBytes(builtA9.schemaId));
        expect(failing(() => v.run(docPairContract(builtC9.opening), 'proveDocumentComparison', rkA9, ownerRk(payloadF9), 1n, maskOf(), 1n, VALID_UNTIL)))
            .toContain('doc B opening does not match anchored root');
    });

    /** A raw-witness comparison over sixteen descriptors of one kind, both documents all-absent. */
    function rawComparison(kind: bigint, keys: Uint8Array[], payloadA: number, payloadB: number, seedA: number, seedB: number) {
        const fold16 = (leaves: Uint8Array[]) => {
            let level = leaves;
            while (level.length > 1) {
                const next: Uint8Array[] = [];
                for (let i = 0; i < level.length; i += 2) next.push(mod.pureCircuits.nodeHash(level[i], level[i + 1]));
                level = next;
            }
            return level[0];
        };
        const rootFor = (seedByte: number) => fold16(keys.map((k, i) =>
            mod.pureCircuits.absentLeafHash(k, mod.pureCircuits.slotSalt(bytes32(seedByte), BigInt(i)))));
        const schemaId = fold16(keys.map(k => mod.pureCircuits.descriptorLeafHash(k, kind, 0n)));
        const pA = bytes32(payloadA);
        const pB = bytes32(payloadB);
        v.attest(v.owner, pA, bytes32(payloadA + 1));
        v.attest(v.owner, pB, bytes32(payloadB + 1));
        v.run(v.owner, 'anchorContentRoot', pA, rootFor(seedA), schemaId);
        v.run(v.owner, 'anchorContentRoot', pB, rootFor(seedB), schemaId);
        const slots = (fill: number) => Array.from({ length: 16 }, () =>
            ({ present: false, uint_value: 0n, value_digest: new Uint8Array(32).fill(fill) }));
        const contract = new ContractClass({
            ...buildAttestationVaultWitnesses({ attestationSecret: ownerSecret }),
            doc_schema:  (ctx: any) => [ctx.privateState, keys.map(k => ({ field_key: k, kind, scale: 0n }))],
            doc_salt_a:  (ctx: any) => [ctx.privateState, bytes32(seedA)],
            doc_salt_b:  (ctx: any) => [ctx.privateState, bytes32(seedB)],
            doc_slots_a: (ctx: any) => [ctx.privateState, slots(0x11)],
            doc_slots_b: (ctx: any) => [ctx.privateState, slots(0x22)]
        });
        return failing(() => v.run(contract, 'proveDocumentComparison', ownerRk(pA), ownerRk(pB), 1n, maskOf(), 1n, VALID_UNTIL));
    }

    test.each([
        { kind: 3n,   payloadA: 0xd9, payloadB: 0xda, seedA: 0xe1, seedB: 0xe2 },
        { kind: 255n, payloadA: 0xe5, payloadB: 0xe6, seedA: 0xe3, seedB: 0xe4 }
    ])('ADVERSARIAL: out-of-range descriptor kind $kind is rejected in-circuit', (c) => {
        const keys = Array.from({ length: 16 }, (_, i) => {
            const b = new Uint8Array(32); b[0] = 0xee; b[1] = Number(c.kind & 0xffn); b[2] = i; return b;
        });
        expect(rawComparison(c.kind, keys, c.payloadA, c.payloadB, c.seedA, c.seedB)).toContain('schema kind out of range');
    });

    test('ADVERSARIAL: the padding key in a real slot is rejected in-circuit', () => {
        const keys = Array.from({ length: 16 }, () => mod.pureCircuits.emptyLeafKey());
        expect(rawComparison(1n, keys, 0xe9, 0xea, 0xeb, 0xec)).toContain('padding key in a real slot');
    });

    test('a holder proves WITHOUT the attester secret (privilege separation)', () => {
        expect(failing(() => v.run(docPairContract(builtB9.opening, undefined), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(), 1n, VALID_UNTIL))).toBe('');
    });

    test('the claim-key recomputes hit the recorded claims and the reversed order does not', async () => {
        const led = v.ledger();
        const rootA = toHex(led.content_anchors.lookup(rkA9).root);
        const rootB = toHex(led.content_anchors.lookup(rkB9).root);
        const schema = toHex(led.content_anchors.lookup(rkA9).schema);
        expect(schema).toBe(builtA9.schemaId);
        const integKey = await computeDocumentIntegrityClaimKey(toHex(rkA9), rootA, toHex(rkB9), rootB, schema, 0b101);
        expect(led.claims.member(hexToBytes(integKey))).toBe(true);
        expect(led.claims.lookup(hexToBytes(integKey))).toBe(VALID_UNTIL);
        const diffKey = await computeDocumentDiffClaimKey(toHex(rkA9), rootA, toHex(rkB9), rootB, schema, 2);
        expect(led.claims.member(hexToBytes(diffKey))).toBe(true);
        // (A, B) order is part of the claim.
        const reversedKey = await computeDocumentIntegrityClaimKey(toHex(rkB9), rootB, toHex(rkA9), rootA, schema, 0b101);
        expect(led.claims.member(hexToBytes(reversedKey))).toBe(false);
    });

    test('a comparison claim does not survive a re-anchor of the same root under another schema', async () => {
        // Retract B, attest it again, anchor the SAME root under a different
        // schema id: the anchor's schema is part of the claim key, so the key a
        // verifier recomputes from the CURRENT anchors misses the old claim; a
        // fresh proof with the original openings is refused by the circuit.
        const led0 = v.ledger();
        const rootA = toHex(led0.content_anchors.lookup(rkA9).root);
        const rootB = toHex(led0.content_anchors.lookup(rkB9).root);
        v.run(v.owner, 'retract', 0n, payloadB9);
        v.attest(v.owner, payloadB9, bytes32(0xd5));
        v.run(v.owner, 'anchorContentRoot', payloadB9, hexToBytes(builtB9.contentRoot), hexToBytes(builtC9.schemaId));
        const led = v.ledger();
        expect(toHex(led.content_anchors.lookup(rkB9).root)).toBe(rootB);
        const oldKey = await computeDocumentDiffClaimKey(toHex(rkA9), rootA, toHex(rkB9), rootB, builtA9.schemaId, 2);
        expect(led.claims.member(hexToBytes(oldKey))).toBe(true);
        const currentKey = await computeDocumentDiffClaimKey(toHex(rkA9), rootA, toHex(rkB9), rootB, builtC9.schemaId, 2);
        expect(led.claims.member(hexToBytes(currentKey))).toBe(false);
        expect(failing(() => v.run(docPairContract(builtB9.opening), 'proveDocumentComparison', rkA9, rkB9, 1n, maskOf(), 2n, VALID_UNTIL)))
            .toContain('doc B schema mismatch');
    });
});

describe('record model: one record per attester and payload', () => {
    let v: Vault;
    const payload = bytes32(0xa7);

    beforeAll(() => {
        v = deployVault();
    });

    test('the record key is the off-chain recompute of attester id and payload', async () => {
        expect(toHex(ownerRk(payload))).toBe(await computeRecordKey(toHex(attesterIdOf(ownerSecret)), toHex(payload)));
        expect(toHex(ownerRk(payload))).not.toBe(toHex(attackerRk(payload)));
        expect(toHex(ownerRk(payload))).not.toBe(toHex(ownerRk(bytes32(0xa8))));
    });

    test('two attesters record the same payload without touching each other', () => {
        v.attest(v.owner, payload, bytes32(0x01));
        expect(failing(() => v.attest(v.attacker, payload, bytes32(0x02)))).toBe('');
        const led = v.ledger();
        const mine = led.attestations.lookup(ownerRk(payload));
        const theirs = led.attestations.lookup(attackerRk(payload));
        expect(sameBytes(mine.owner, attesterIdOf(ownerSecret))).toBe(true);
        expect(sameBytes(mine.payload_hash, payload)).toBe(true);
        expect(sameBytes(mine.metadata_hash, bytes32(0x01))).toBe(true);
        expect(sameBytes(theirs.owner, attesterIdOf(attackerSecret))).toBe(true);
        expect(sameBytes(theirs.metadata_hash, bytes32(0x02))).toBe(true);
    });

    test('a record is only ever written by its own attester', () => {
        v.run(v.owner, 'grantDisclosure', payload, bytes32(0xcc), 2n);
        // The attacker's calls address the attacker's own record of the payload.
        expect(failing(() => v.run(v.attacker, 'revokeDisclosure', payload, bytes32(0xcc)))).toContain('no disclosures');
        expect(v.ledger().disclosures.lookup(ownerRk(payload)).member(bytes32(0xcc))).toBe(true);
        expect(failing(() => v.run(v.attacker, 'retract', 0n, payload))).toBe('');
        const led = v.ledger();
        expect(led.attestations.member(attackerRk(payload))).toBe(false);
        expect(led.attestations.member(ownerRk(payload))).toBe(true);
        expect(led.disclosures.lookup(ownerRk(payload)).member(bytes32(0xcc))).toBe(true);
    });

    test('a document id resolves to exactly one record', () => {
        v.run(v.owner, 'bindDocument', bytes32(0x7c), payload);
        expect(sameBytes(v.ledger().document_bindings.lookup(bytes32(0x7c)), ownerRk(payload))).toBe(true);
        expect(sameBytes(v.ledger().attestations.lookup(ownerRk(payload)).document_id, bytes32(0x7c))).toBe(true);
    });

    test('proofs address one record: another attester\'s record of the same payload has no anchor', () => {
        const { builtA } = buildCrossRootDocuments();
        const energy = builtA.fields.find((f: any) => f.field === 'energy')!;
        v.run(v.owner, 'anchorContentRoot', payload, hexToBytes(builtA.contentRoot), hexToBytes(builtA.schemaId));
        v.attest(v.attacker, payload, bytes32(0x03));
        const holder = new ContractClass(buildAttestationVaultWitnesses({
            merkleProof: { fieldValue: energy.value, fieldSalt: energy.salt, siblings: energy.siblings, dirs: energy.dirs }
        } as any));
        expect(failing(() => v.run(holder, 'proveFieldPredicate', ownerRk(payload), hexToBytes(energy.fieldKey), 100n, 1n, VALID_UNTIL))).toBe('');
        expect(failing(() => v.run(holder, 'proveFieldPredicate', attackerRk(payload), hexToBytes(energy.fieldKey), 100n, 1n, VALID_UNTIL)))
            .toContain('no content root');
    });

    test('retract modes past 1 are out of range', () => {
        expect(failing(() => v.run(v.owner, 'retract', 2n, ZERO))).toContain('mode out of range');
        expect(failing(() => v.run(v.owner, 'retract', 3n, ZERO))).toContain('mode out of range');
    });
});
