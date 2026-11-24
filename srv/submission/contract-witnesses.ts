// Builds the witnesses (private inputs) for each contract. Inputs are plain values only, so they can be passed to the worker thread.
// Contracts without a builder get empty witnesses.
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret,
    deriveTokenFactoryIssuerSecret as deriveFactorySecret,
    tokenFactoryWitnesses,
    type BuildWitnessesInput,
    type MerkleProof,
    type SchemaDescriptor,
    type SlotOpening,
    type DocPair,
    type AttestationVaultWitnesses,
    type TokenFactoryWitnesses
} from '@odatano/contract-kit';
import type { Witnesses } from '@midnight-ntwrk/compact-js';
import type { Types } from 'effect';

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

// Simplify turns the kit's interfaces into plain object types, which fit the string-keyed witness record.
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): Types.Simplify<AttestationVaultWitnesses> {
    return buildVaultWitnesses(input);
}

/** `burn` needs no secret. `mint` throws if the secret is missing. */
export function buildTokenFactoryWitnesses(input: WitnessFactoryInput): Types.Simplify<TokenFactoryWitnesses> {
    const issuerSecret = input.issuerSecret;
    return tokenFactoryWitnesses(() => ({ issuerSecret }));
}

export type WitnessFactory = (input: WitnessFactoryInput) => Witnesses<unknown>;

const FACTORIES: Record<string, WitnessFactory> = {
    'attestation-vault': buildAttestationVaultWitnesses,
    'attestation-vault-32': buildAttestationVaultWitnesses,
    'token-factory': buildTokenFactoryWitnesses
};

/** The witnesses of a contract package, by the package's contract name. `lineage` comes from the build's digest, never from the name it is registered under. */
export function getContractWitnessFactory(lineage: string | undefined): WitnessFactory | undefined {
    return lineage !== undefined && Object.hasOwn(FACTORIES, lineage) ? FACTORIES[lineage] : undefined;
}

/** Whether a contract package is an attestation vault, whose constructor takes the deployer's attester id. */
export function isVaultLineage(lineage: string | undefined): boolean {
    return lineage === 'attestation-vault' || lineage === 'attestation-vault-32';
}
