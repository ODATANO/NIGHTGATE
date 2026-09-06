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
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret
} from '../../src/browser/witnesses.mjs';

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

/**
 * Derives the per-session AttestationVault secret (32 raw bytes) from the wallet
 * seed, fed directly to the `local_secret_key()` witness. Domain-separated by a
 * v1 label so future contracts can derive their own without colliding.
 */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveVaultSecret(seedBytes);
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
    // ONE implementation for server, worker thread, browser bundle and
    // txbuilder: src/browser/witnesses.mjs (decoders + witness object). The
    // interfaces above are the typed server view of its input.
    return buildVaultWitnesses(input);
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
