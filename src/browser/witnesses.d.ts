/** Browser witness + attester-secret helpers; see @odatano/contract-kit. */
export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses,
    type SealedAttestationSecret,
    type MerkleProof,
    type SchemaDescriptor,
    type SlotOpening,
    type DocumentOpening,
    type DocPair,
    type MerkleProofHolder,
    type BuildWitnessesInput,
    type AttestationVaultWitnesses
} from '@odatano/contract-kit';
