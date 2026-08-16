/** Browser witness + attester-secret helpers. See witnesses.mjs. */

/** One slot of the shared schema (kind: 0 = uint, 1 = bytes, 2 = padding). */
export interface SchemaDescriptor {
    fieldKey: string;
    kind: number;
    scale: string;
}

/** One document's opening of one slot (witness material). */
export interface SlotOpening {
    present: boolean;
    value?: string;
    valueDigest?: string;
}

/** A document's full cross-root opening (witness material; STORE the seed). */
export interface DocumentOpening {
    saltSeed: string;
    slots: SlotOpening[];
}

/**
 * Cross-root proof material (proveDocumentComparison, both modes, v4): the
 * SHARED descriptor list plus both documents' full openings. The circuit
 * recomputes schema root and both content roots from these, so nothing here
 * is trusted, only proven against the anchors.
 */
export interface DocPair {
    schema?: SchemaDescriptor[];
    openingA?: DocumentOpening;
    openingB?: DocumentOpening;
}

/**
 * Per-call proof bundle for the field-bound proof circuits (DEPTH=4 content
 * path; DEPTH=6 set path for membership). `fieldValue` feeds
 * proveFieldPredicate, `fieldDigest` + `setProof` feed proveFieldMembership;
 * proveFieldEquality needs only siblings/dirs; the cross-root circuits need
 * only `docPair` (and `siblings`/`dirs` may then be omitted).
 */
export interface MerkleProof {
    /** Decimal string of the scaled Uint<64> field value (proveFieldPredicate). */
    fieldValue?: string;
    /** 64-char hex per-slot salt (v4; every single-field proof circuit). */
    fieldSalt?: string;
    /** 64-char hex digest of the field's value bytes (proveFieldMembership). */
    fieldDigest?: string;
    /** 4 × 64-char hex sibling digests along the content-root path. Optional when `docPair` is present. */
    siblings?: string[];
    /** 4 booleans, true = current node is the LEFT child at that level. Optional when `docPair` is present. */
    dirs?: boolean[];
    /** Membership-set path (proveFieldMembership): 6 siblings + 6 booleans. */
    setProof?: { siblings: string[]; dirs: boolean[] };
    /** Cross-root material (proveDocumentComparison (mode 0 integrity / mode 1 diff)). */
    docPair?: DocPair;
}

/**
 * Batch mode (0.12.0): one witness object serving N proof calls in ONE
 * transaction scope. The proof is read at witness INVOCATION time, so the batch loop swaps
 * `current` immediately before each `callTx`. Mirrors the server's `WitnessFactoryInput`.
 */
export interface MerkleProofHolder {
    /** The proof for the call about to run. A witness invoked with this unset throws by name. */
    current?: MerkleProof;
}

export interface BuildWitnessesInput {
    /**
     * 32-byte attester secret. OPTIONAL (holder/attester separation): the
     * proof circuits never invoke local_secret_key, so a holder proving
     * against an anchored root omits it entirely; only the owner-gated
     * circuits (attest/attestGuarded, grant/revokeDisclosure,
     * registerPassport, bindPassport, anchorContentRoot) resolve it, and the
     * witness throws by name when they do without one.
     */
    attestationSecret?: Uint8Array;
    /** Single-call field-bound proof. Mutually exclusive with `merkleProofHolder`. */
    merkleProof?: MerkleProof;
    /** Batch field-bound proofs. Mutually exclusive with `merkleProof` (the builder throws). */
    merkleProofHolder?: MerkleProofHolder;
}

/** Generated `Witnesses<PS>` shape for the AttestationVault contract. */
export interface AttestationVaultWitnesses<PS = unknown> {
    local_secret_key(ctx: { privateState: PS }): [PS, Uint8Array];
    field_value(ctx: { privateState: PS }): [PS, bigint];
    merkle_siblings(ctx: { privateState: PS }): [PS, Uint8Array[]];
    merkle_dirs(ctx: { privateState: PS }): [PS, boolean[]];
    field_digest(ctx: { privateState: PS }): [PS, Uint8Array];
    set_siblings(ctx: { privateState: PS }): [PS, Uint8Array[]];
    set_dirs(ctx: { privateState: PS }): [PS, boolean[]];
    field_salt(ctx: { privateState: PS }): [PS, Uint8Array];
    doc_schema(ctx: { privateState: PS }): [PS, Array<{ field_key: Uint8Array; kind: bigint; scale: bigint }>];
    doc_salt_a(ctx: { privateState: PS }): [PS, Uint8Array];
    doc_salt_b(ctx: { privateState: PS }): [PS, Uint8Array];
    doc_slots_a(ctx: { privateState: PS }): [PS, Array<{ present: boolean; uint_value: bigint; value_digest: Uint8Array }>];
    doc_slots_b(ctx: { privateState: PS }): [PS, Array<{ present: boolean; uint_value: bigint; value_digest: Uint8Array }>];
}

/** HMAC-SHA256(material, 'nightgate/attestation-vault/v1') → 32 bytes. Never feed shareable evidence (signatures over fixed messages). */
export function deriveAttestationSecret(material: Uint8Array): Uint8Array;

/** Fresh RANDOM 32-byte attester secret (CSPRNG). Generate once per wallet, then seal + store. */
export function generateAttestationSecret(): Uint8Array;

/** AES-256-GCM sealed attester-secret blob (hex members; JSON-serializable). */
export interface SealedAttestationSecret {
    v: 1;
    salt: string;
    iv: string;
    cipher: string;
}

/** Seal the secret under unlock material (e.g. a wallet signature; it only decrypts THIS blob, it is not the secret). */
export function sealAttestationSecret(secret: Uint8Array, unlockMaterial: Uint8Array): Promise<SealedAttestationSecret>;

/** Reopen a sealed secret; throws on wrong unlock material or tampering. */
export function openAttestationSecret(sealed: SealedAttestationSecret, unlockMaterial: Uint8Array): Promise<Uint8Array>;

/** Build the AttestationVault witness object bound to a secret (+ optional value/salt). Argument-less builds a fully lazy witness set (every witness throws by name when actually invoked without its material). */
export function buildAttestationVaultWitnesses(input?: BuildWitnessesInput): AttestationVaultWitnesses;
