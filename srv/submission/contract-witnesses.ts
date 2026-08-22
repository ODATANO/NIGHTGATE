/**
 * Per-contract witness factories.
 *
 * The Compact compiler emits a `Witnesses<PS>` type per contract: off-chain
 * functions the SDK invokes during circuit execution. Each registered contract
 * gets either a real witness object built from the caller's wallet session, or
 * vacant witnesses (only valid for contracts that declare none).
 *
 * The factory receives a primitive snapshot (just the bits the witness needs) so
 * we don't smuggle SDK-shaped objects across the worker boundary or test seams.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

export interface WitnessFactoryInput {
    /**
     * 32-byte AES-GCM-encryptable secret derived once per wallet session
     * from the seed key. Stable across reconnects for the same viewing key.
     */
    attestationSecret: Uint8Array;
    /**
     * Per-CALL proof bundle for the field-bound proof circuits. Absent for
     * every other circuit. Serialized as primitives so it survives the
     * worker-thread boundary:
     *   - `fieldValue`: decimal string of the Uint<64> field value
     *     (`proveFieldPredicate` only).
     *   - `fieldSalt`: 64-char hex per-slot salt (v4; every single-field
     *     proof circuit recomputes a SALTED leaf).
     *   - `fieldDigest`: 64-char hex digest of the field's value bytes
     *     (`proveFieldMembership` only; `proveFieldEquality` needs neither,
     *     its expected digest is a public circuit arg).
     *   - `siblings`: 4 × 64-char hex (the DEPTH=4 content-root path).
     *   - `dirs`: 4 booleans (true = current node is the LEFT child at that level).
     *   - `setProof`: DEPTH=6 membership-set path (`proveFieldMembership` only),
     *     6 × 64-char hex siblings + 6 booleans.
     *   - `docPair`: cross-root material (`proveDocumentComparison`, both
     *     modes): the SHARED 16-entry schema descriptor list plus both
     *     documents' full openings (salt seed + 16 slot openings). When
     *     present, `siblings`/`dirs` may be omitted.
     */
    merkleProof?: MerkleProofBundle;
    /**
     * Batch mode: a mutable holder whose `current` proof the batch loop swaps
     * immediately before each call (wallet-worker builds `before` hooks for
     * batch-call-scope.ts). Resolved at witness INVOCATION time, so ONE
     * compiled contract instance serves N proof calls with N different
     * bundles inside one transaction scope. Mutually exclusive with
     * `merkleProof`. Same primitive serialization rules.
     */
    merkleProofHolder?: {
        current?: MerkleProofBundle;
    };
    /**
     * Content-tree width of the target artifact (provable fields per
     * document): 16 for the classic vault (default), 32 for
     * `attestation-vault-32`. Sizes every width-dependent decode check
     * (schema/opening slot counts, inclusion-path depth = log2(width)).
     * Comes from the contract registration's `slotWidth`.
     */
    slotWidth?: number;
}

export interface MerkleProofBundle {
    fieldValue?:  string;
    /** Per-slot salt, 64 hex (v4; required by every single-field proof). */
    fieldSalt?:   string;
    fieldDigest?: string;
    /** Optional when `docPair` is present (the cross-root circuits use no inclusion path). */
    siblings?:    string[];
    dirs?:        boolean[];
    setProof?:    { siblings: string[]; dirs: boolean[] };
    docPair?:     DocPairBundle;
}

/** One slot of the shared schema (wire form; see document-proof.ts). */
export interface SchemaDescriptorWire {
    fieldKey: string;
    kind: number;
    scale: string;
}

/** One document's opening of one slot (wire form). */
export interface SlotOpeningWire {
    present: boolean;
    value?: string;
    valueDigest?: string;
}

/**
 * Cross-root proof material (proveDocumentComparison, both modes, v4): the
 * SHARED 16-entry descriptor list plus both documents' full openings (salt
 * seed + 16 slot openings). Primitives only, so the bundle survives the
 * worker-thread boundary. The circuit recomputes schema root and both
 * content roots from this, so nothing here is trusted, only proven.
 */
export interface DocPairBundle {
    schema?: SchemaDescriptorWire[];
    openingA?: { saltSeed: string; slots: SlotOpeningWire[] };
    openingB?: { saltSeed: string; slots: SlotOpeningWire[] };
}

// Classic 16-slot defaults; the decode helpers take the per-artifact width
// (WitnessFactoryInput.slotWidth) and derive depth = log2(width) from it.
const MERKLE_DEPTH = 4;
const SET_DEPTH = 6;
const SLOT_COUNT = 16;

/** compact-runtime value shapes of the contract's cross-root witnesses. */
interface DecodedDescriptor { field_key: Uint8Array; kind: bigint; scale: bigint }
interface DecodedOpening { present: boolean; uint_value: bigint; value_digest: Uint8Array }

interface DecodedMerkleProof {
    fieldValue?:  bigint;
    fieldSalt?:   Uint8Array;
    fieldDigest?: Uint8Array;
    siblings?:    Uint8Array[];
    dirs?:        boolean[];
    setSiblings?: Uint8Array[];
    setDirs?:     boolean[];
    docSchema?:   DecodedDescriptor[];
    docSaltA?:    Uint8Array;
    docSaltB?:    Uint8Array;
    docSlotsA?:   DecodedOpening[];
    docSlotsB?:   DecodedOpening[];
}

const ZERO32 = new Uint8Array(32);

function decodeSchema(schema: SchemaDescriptorWire[] | undefined, label: string, slotCount: number = SLOT_COUNT): DecodedDescriptor[] | undefined {
    if (schema === undefined) return undefined;
    if (!Array.isArray(schema) || schema.length !== slotCount) {
        throw new Error(`${label} must have exactly ${slotCount} entries`);
    }
    return schema.map((d, i) => {
        const kind = BigInt(d.kind);
        if (kind < 0n || kind > 2n) throw new Error(`${label}[${i}].kind must be 0, 1 or 2`);
        return { field_key: hexToBytes32(d.fieldKey), kind, scale: BigInt(d.scale ?? '0') };
    });
}

function decodeOpening(
    opening: { saltSeed: string; slots: SlotOpeningWire[] } | undefined,
    label: string,
    slotCount: number = SLOT_COUNT
): { seed: Uint8Array; slots: DecodedOpening[] } | undefined {
    if (opening === undefined) return undefined;
    if (!Array.isArray(opening.slots) || opening.slots.length !== slotCount) {
        throw new Error(`${label}.slots must have exactly ${slotCount} entries`);
    }
    const seed = hexToBytes32(opening.saltSeed);
    const slots = opening.slots.map((s) => ({
        present: Boolean(s.present),
        uint_value: s.value !== undefined ? BigInt(s.value) : 0n,
        value_digest: s.valueDigest !== undefined ? hexToBytes32(s.valueDigest) : ZERO32
    }));
    return { seed, slots };
}

function decodeMerkleProof(proof: MerkleProofBundle, slotCount: number = SLOT_COUNT): DecodedMerkleProof {
    const depth = Math.log2(slotCount);
    const fieldValue = proof.fieldValue !== undefined ? BigInt(proof.fieldValue) : undefined;
    const fieldSalt = proof.fieldSalt !== undefined ? hexToBytes32(proof.fieldSalt) : undefined;
    const fieldDigest = proof.fieldDigest !== undefined ? hexToBytes32(proof.fieldDigest) : undefined;
    // The inclusion path is required for the single-field circuits; a bundle
    // carrying ONLY cross-root material may omit it (those circuits never
    // invoke merkle_siblings/merkle_dirs).
    let siblings: Uint8Array[] | undefined;
    let dirs: boolean[] | undefined;
    if (proof.siblings !== undefined || proof.dirs !== undefined || !proof.docPair) {
        siblings = (proof.siblings || []).map(hexToBytes32);
        dirs = (proof.dirs || []).map(Boolean);
        if (siblings.length !== depth || dirs.length !== depth) {
            throw new Error(`merkleProof.siblings and .dirs must each have ${depth} entries`);
        }
    }
    let setSiblings: Uint8Array[] | undefined;
    let setDirs: boolean[] | undefined;
    if (proof.setProof) {
        setSiblings = (proof.setProof.siblings || []).map(hexToBytes32);
        setDirs = (proof.setProof.dirs || []).map(Boolean);
        if (setSiblings.length !== SET_DEPTH || setDirs.length !== SET_DEPTH) {
            throw new Error(`merkleProof.setProof.siblings and .dirs must each have ${SET_DEPTH} entries`);
        }
    }
    const docSchema = decodeSchema(proof.docPair?.schema, 'merkleProof.docPair.schema', slotCount);
    const openingA = decodeOpening(proof.docPair?.openingA, 'merkleProof.docPair.openingA', slotCount);
    const openingB = decodeOpening(proof.docPair?.openingB, 'merkleProof.docPair.openingB', slotCount);
    if (proof.docPair && (docSchema === undefined || openingA === undefined || openingB === undefined)) {
        throw new Error('merkleProof.docPair requires schema, openingA and openingB');
    }
    return {
        fieldValue, fieldSalt, fieldDigest, siblings, dirs, setSiblings, setDirs,
        docSchema, docSaltA: openingA?.seed, docSaltB: openingB?.seed,
        docSlotsA: openingA?.slots, docSlotsB: openingB?.slots
    };
}

function hexToBytes32(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error('expected 64 hex chars (32 bytes)');
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Derives the per-session AttestationVault secret (32 raw bytes) from the wallet
 * seed, fed directly to the `local_secret_key()` witness. Domain-separated by a
 * v1 label so future contracts can derive their own without colliding.
 */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return hmac(sha256, seedBytes, new TextEncoder().encode('nightgate/attestation-vault/v1'));
}

/**
 * Builds the AttestationVault witness object.
 *
 * `local_secret_key()` returns the same 32-byte secret on every call for a given
 * session; that determinism is what the circuit's
 * `persistentHash(local_secret_key())` relies on for a stable `attester_id`.
 * `ctx.privateState` passes through unchanged (this witness reads, never mutates).
 */
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    const secret = input.attestationSecret;
    // Per-call Merkle proof for proveFieldPredicate (only that circuit invokes
    // field_value/merkle_siblings/merkle_dirs; others leave them unused).
    // Static mode decodes up-front (fail fast); holder mode re-resolves at
    // every witness invocation so the batch loop can swap `holder.current`
    // between calls of one transaction scope.
    if (input.merkleProof && input.merkleProofHolder) {
        throw new Error('merkleProof and merkleProofHolder are mutually exclusive');
    }
    const slotCount = input.slotWidth ?? SLOT_COUNT;
    const staticProof = input.merkleProof ? decodeMerkleProof(input.merkleProof, slotCount) : undefined;
    const holder = input.merkleProofHolder;
    const currentProof = (witnessName: string): DecodedMerkleProof => {
        if (holder) {
            if (!holder.current) {
                throw new Error(`${witnessName} witness invoked with an empty batch proof holder; set holder.current before the call`);
            }
            return decodeMerkleProof(holder.current, slotCount);
        }
        if (staticProof === undefined) {
            throw new Error(`${witnessName} witness invoked without a merkleProof; the field-bound proof circuits require a proof bundle`);
        }
        return staticProof;
    };
    return {
        local_secret_key(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            return [ctx.privateState, secret];
        },
        field_value(ctx: { privateState: unknown }): [unknown, bigint] {
            const p = currentProof('field_value');
            if (p.fieldValue === undefined) {
                throw new Error('field_value witness invoked without a fieldValue; proveFieldPredicate requires a numeric proof bundle');
            }
            return [ctx.privateState, p.fieldValue];
        },
        merkle_siblings(ctx: { privateState: unknown }): [unknown, Uint8Array[]] {
            const p = currentProof('merkle_siblings');
            if (p.siblings === undefined) {
                throw new Error('merkle_siblings witness invoked without an inclusion path; the single-field proof circuits require siblings/dirs');
            }
            return [ctx.privateState, p.siblings];
        },
        merkle_dirs(ctx: { privateState: unknown }): [unknown, boolean[]] {
            const p = currentProof('merkle_dirs');
            if (p.dirs === undefined) {
                throw new Error('merkle_dirs witness invoked without an inclusion path; the single-field proof circuits require siblings/dirs');
            }
            return [ctx.privateState, p.dirs];
        },
        field_salt(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            const p = currentProof('field_salt');
            if (p.fieldSalt === undefined) {
                throw new Error('field_salt witness invoked without a fieldSalt; the single-field proof circuits require the slot salt (v4)');
            }
            return [ctx.privateState, p.fieldSalt];
        },
        doc_schema(ctx: { privateState: unknown }): [unknown, DecodedDescriptor[]] {
            const p = currentProof('doc_schema');
            if (p.docSchema === undefined) {
                throw new Error('doc_schema witness invoked without docPair.schema; proveDocumentComparison requires the shared descriptor list');
            }
            return [ctx.privateState, p.docSchema];
        },
        doc_salt_a(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            const p = currentProof('doc_salt_a');
            if (p.docSaltA === undefined) {
                throw new Error('doc_salt_a witness invoked without docPair.openingA; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSaltA];
        },
        doc_salt_b(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            const p = currentProof('doc_salt_b');
            if (p.docSaltB === undefined) {
                throw new Error('doc_salt_b witness invoked without docPair.openingB; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSaltB];
        },
        doc_slots_a(ctx: { privateState: unknown }): [unknown, DecodedOpening[]] {
            const p = currentProof('doc_slots_a');
            if (p.docSlotsA === undefined) {
                throw new Error('doc_slots_a witness invoked without docPair.openingA; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSlotsA];
        },
        doc_slots_b(ctx: { privateState: unknown }): [unknown, DecodedOpening[]] {
            const p = currentProof('doc_slots_b');
            if (p.docSlotsB === undefined) {
                throw new Error('doc_slots_b witness invoked without docPair.openingB; proveDocumentComparison requires both openings');
            }
            return [ctx.privateState, p.docSlotsB];
        },
        field_digest(ctx: { privateState: unknown }): [unknown, Uint8Array] {
            const p = currentProof('field_digest');
            if (p.fieldDigest === undefined) {
                throw new Error('field_digest witness invoked without a fieldDigest; proveFieldMembership requires a bytes proof bundle');
            }
            return [ctx.privateState, p.fieldDigest];
        },
        set_siblings(ctx: { privateState: unknown }): [unknown, Uint8Array[]] {
            const p = currentProof('set_siblings');
            if (p.setSiblings === undefined) {
                throw new Error('set_siblings witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setSiblings];
        },
        set_dirs(ctx: { privateState: unknown }): [unknown, boolean[]] {
            const p = currentProof('set_dirs');
            if (p.setDirs === undefined) {
                throw new Error('set_dirs witness invoked without a setProof; proveFieldMembership requires the membership-set path');
            }
            return [ctx.privateState, p.setDirs];
        }
    };
}

export type WitnessFactory = (input: WitnessFactoryInput) => any;

/**
 * Registry of contract-name → witness-builder. Contracts not in this map
 * fall back to `withVacantWitnesses` (i.e. the Compact source declared no
 * witnesses; only valid for those). Counter is one such case.
 */
const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses,
    'attestation-vault-32': buildAttestationVaultWitnesses
};

export function getContractWitnessFactory(contractName: string): WitnessFactory | undefined {
    const exact = FACTORIES[contractName];
    if (exact) return exact;
    // Width variants and consumer aliases of the vault family (e.g. a
    // versioned re-registration) share one witness shape; falling through to
    // vacant witnesses for them would silently break every owner-gated call.
    if (contractName.startsWith('attestation-vault')) return buildAttestationVaultWitnesses;
    return undefined;
}
