/**
 * Per-contract witness factories. Inputs are primitives only, so they cross the
 * worker boundary; contracts without a factory get vacant witnesses.
 */
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret,
    type BuildWitnessesInput,
    type MerkleProof,
    type SchemaDescriptor,
    type SlotOpening,
    type DocPair
} from '@odatano/contract-kit';

export type WitnessFactoryInput = BuildWitnessesInput;
export type MerkleProofBundle = MerkleProof;
export type SchemaDescriptorWire = SchemaDescriptor;
export type SlotOpeningWire = SlotOpening;
export type DocPairBundle = DocPair;

/** 32-byte vault secret for `local_secret_key()`, domain-separated from the seed by a v1 label. */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveVaultSecret(seedBytes);
}

/** Vault witnesses; the single implementation (shared with browser and txbuilder) lives in the kit. */
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
