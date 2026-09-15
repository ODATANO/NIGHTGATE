/**
 * Per-contract witness factories. Inputs are primitives only, so they cross the
 * worker boundary; contracts without a factory get vacant witnesses.
 */
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret
} from '../../src/browser/witnesses.mjs';

export interface WitnessFactoryInput {
    /** 32-byte per-session secret derived from the seed. */
    attestationSecret: Uint8Array;
    /** Per-call proof bundle for the field-bound proof circuits. */
    merkleProof?: MerkleProofBundle;
    /**
     * Batch mode, exclusive with `merkleProof`: read at witness invocation, so
     * one contract instance serves N calls whose `before` hooks swap `current`.
     */
    merkleProofHolder?: {
        current?: MerkleProofBundle;
    };
    /** Registration `slotWidth` (default 16); sizes decode checks, path depth = log2(width). */
    slotWidth?: number;
}

export interface MerkleProofBundle {
    /** Decimal Uint<64> (`proveFieldPredicate`). */
    fieldValue?:  string;
    /** Per-slot salt, 64 hex (required by every single-field proof). */
    fieldSalt?:   string;
    /** Value-bytes digest, 64 hex (`proveFieldMembership`). */
    fieldDigest?: string;
    /** Content-root path, 64 hex each; omitted with `docPair`. */
    siblings?:    string[];
    /** true = current node is the LEFT child at that level. */
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
 * Cross-root material: shared schema plus both documents' openings. The circuit
 * recomputes both roots from it, so nothing here is trusted.
 */
export interface DocPairBundle {
    schema?: SchemaDescriptorWire[];
    openingA?: { saltSeed: string; slots: SlotOpeningWire[] };
    openingB?: { saltSeed: string; slots: SlotOpeningWire[] };
}

/** 32-byte vault secret for `local_secret_key()`, domain-separated from the seed by a v1 label. */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveVaultSecret(seedBytes);
}

/**
 * Vault witnesses; the single implementation (shared with browser and
 * txbuilder) lives in src/browser/witnesses.mjs.
 */
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    return buildVaultWitnesses(input);
}

export type WitnessFactory = (input: WitnessFactoryInput) => any;

const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses,
    'attestation-vault-32': buildAttestationVaultWitnesses
};

export function getContractWitnessFactory(contractName: string): WitnessFactory | undefined {
    const exact = FACTORIES[contractName];
    if (exact) return exact;
    // Vault aliases share the witness shape; vacant witnesses would break owner-gated calls.
    if (contractName.startsWith('attestation-vault')) return buildAttestationVaultWitnesses;
    return undefined;
}
