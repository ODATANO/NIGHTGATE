/**
 * Per-contract witness factories. Inputs are primitives only, so they cross the
 * worker boundary; contracts without a factory get vacant witnesses.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import {
    buildAttestationVaultWitnesses as buildVaultWitnesses,
    deriveAttestationSecret as deriveVaultSecret,
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

/** 32-byte vault secret for `local_secret_key()`, domain-separated from the seed by a v1 label. */
export function deriveAttestationSecret(seedBytes: Uint8Array): Uint8Array {
    return deriveVaultSecret(seedBytes);
}

const TOKEN_FACTORY_ISSUER_LABEL = 'nightgate/token-factory-issuer/v1';

/** 32-byte issuer secret for the factory's `issuerSecret()` witness; its own label keeps it apart from the vault secret. */
export function deriveTokenFactoryIssuerSecret(seedBytes: Uint8Array): Uint8Array {
    return hmac(sha256, seedBytes, new TextEncoder().encode(TOKEN_FACTORY_ISSUER_LABEL));
}

/** Vault witnesses; the single implementation (shared with browser and txbuilder) lives in the kit. */
export function buildAttestationVaultWitnesses(input: WitnessFactoryInput): any {
    return buildVaultWitnesses(input);
}

/** Factory witnesses over the session's issuer secret; `burn` reads none, `mint` throws by name without one. */
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
    // Vault aliases share the witness shape; vacant witnesses would break owner-gated calls.
    if (contractName.startsWith('attestation-vault')) return buildAttestationVaultWitnesses;
    if (contractName.startsWith('token-factory')) return buildTokenFactoryWitnesses;
    return undefined;
}
