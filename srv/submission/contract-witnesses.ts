/**
 * Builds the witnesses (private inputs) for each contract.
 * Inputs are plain values only, so they can be passed to the worker thread.
 * Contracts without a builder get empty witnesses.
 */
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret,
    deriveTokenFactoryIssuerSecret as deriveFactorySecret,
    tokenFactoryWitnesses,
    type BuildWitnessesInput,
    type MerkleProof,
    type SchemaDescriptor,
    type SlotOpening,
    type DocPair
} from '@odatano/contract-kit';

export type WitnessFactoryInput = BuildWitnessesInput & {
    /** 32-byte issuer secret for the token factory's `issuerSecret()` witness. */
    issuerSecret?: Uint8Array;
};
export type MerkleProofBundle = MerkleProof;
export type SchemaDescriptorWire = SchemaDescriptor;
export type SlotOpeningWire = SlotOpening;
export type DocPairBundle = DocPair;

/** 32-byte vault secret for `local_secret_key()`, derived from the seed with a fixed label. */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveVaultSecret(seedBytes);
}

/** Issuer secret for the factory. The rule comes from the contract kit, so the txbuilder derives the same bytes. */
export function deriveTokenFactoryIssuerSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveFactorySecret(seedBytes);
}

export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    return buildVaultWitnesses(input);
}

/** `burn` needs no secret. `mint` throws if the secret is missing. */
export function buildTokenFactoryWitnesses(input: WitnessFactoryInput): any {
    const issuerSecret = input.issuerSecret;
    return tokenFactoryWitnesses(() => ({ issuerSecret }));
}

export type WitnessFactory = (input: WitnessFactoryInput) => any;

const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses,
    'attestation-vault-32': buildAttestationVaultWitnesses,
    'token-factory': buildTokenFactoryWitnesses
};

export function getContractWitnessFactory(contractName: string): WitnessFactory | undefined {
    const exact = FACTORIES[contractName];
    if (exact) return exact;
    // Vault contracts registered under another name use the same witnesses.
    // Empty witnesses would break owner-only calls.
    if (contractName.startsWith('attestation-vault')) return buildAttestationVaultWitnesses;
    if (contractName.startsWith('token-factory')) return buildTokenFactoryWitnesses;
    return undefined;
}
