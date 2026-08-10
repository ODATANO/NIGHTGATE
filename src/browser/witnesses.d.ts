/** Browser witness + attester-secret helpers. See witnesses.mjs. */

/** Per-call witnesses for commitValue / provePredicate. */
export interface WitnessValues {
    /** Decimal string of the Uint<64> value being proven. */
    attestedValue: string;
    /** 64-char hex (32 bytes) commitment opening. */
    valueSalt: string;
}

/**
 * Per-call proof bundle for the field-bound proof circuits (DEPTH=4 content
 * path; DEPTH=6 set path for membership). `fieldValue` feeds
 * proveFieldPredicate, `fieldDigest` + `setProof` feed proveFieldMembership;
 * proveFieldEquality needs only siblings/dirs.
 */
export interface MerkleProof {
    /** Decimal string of the scaled Uint<64> field value (proveFieldPredicate). */
    fieldValue?: string;
    /** 64-char hex digest of the field's value bytes (proveFieldMembership). */
    fieldDigest?: string;
    /** 4 × 64-char hex sibling digests along the content-root path. */
    siblings: string[];
    /** 4 booleans, true = current node is the LEFT child at that level. */
    dirs: boolean[];
    /** Membership-set path (proveFieldMembership): 6 siblings + 6 booleans. */
    setProof?: { siblings: string[]; dirs: boolean[] };
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
    /** 32-byte attester secret (output of deriveAttestationSecret*). */
    attestationSecret: Uint8Array;
    /** Required only for commitValue / provePredicate. */
    witnessValues?: WitnessValues;
    /** Single-call field-bound proof. Mutually exclusive with `merkleProofHolder`. */
    merkleProof?: MerkleProof;
    /** Batch field-bound proofs. Mutually exclusive with `merkleProof` (the builder throws). */
    merkleProofHolder?: MerkleProofHolder;
}

/** Generated `Witnesses<PS>` shape for the AttestationVault contract. */
export interface AttestationVaultWitnesses<PS = unknown> {
    local_secret_key(ctx: { privateState: PS }): [PS, Uint8Array];
    attested_value(ctx: { privateState: PS }): [PS, bigint];
    value_salt(ctx: { privateState: PS }): [PS, Uint8Array];
    field_value(ctx: { privateState: PS }): [PS, bigint];
    merkle_siblings(ctx: { privateState: PS }): [PS, Uint8Array[]];
    merkle_dirs(ctx: { privateState: PS }): [PS, boolean[]];
    field_digest(ctx: { privateState: PS }): [PS, Uint8Array];
    set_siblings(ctx: { privateState: PS }): [PS, Uint8Array[]];
    set_dirs(ctx: { privateState: PS }): [PS, boolean[]];
}

/** HMAC-SHA256(material, 'nightgate/attestation-vault/v1') → 32 bytes. */
export function deriveAttestationSecret(material: Uint8Array): Uint8Array;

/** Derive the attester secret from a connector `signData` signature (hex). */
export function deriveAttestationSecretFromSignature(signatureHex: string): Uint8Array;

/** Build the AttestationVault witness object bound to a secret (+ optional value/salt). */
export function buildAttestationVaultWitnesses(input: BuildWitnessesInput): AttestationVaultWitnesses;

/** Fixed message a consumer signs (via connector.signData) to derive a stable secret. */
export const ATTESTER_SECRET_MESSAGE: string;
