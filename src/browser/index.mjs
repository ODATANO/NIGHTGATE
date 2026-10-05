// `@odatano/nightgate/browser`, the entry point for browser apps that use a Midnight wallet.
// Everything here runs in a browser. Nothing depends on CAP or Node.
//
// The compiled contracts are large, so each has its own import path:
//   import { Contract, ledger } from '@odatano/nightgate/browser/attestation-vault';

export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses
} from './witnesses.mjs';

export { FetchZkConfigProvider } from './zk-config.mjs';
export { InMemoryPrivateStateProvider } from './private-state.mjs';
export { createNightgateConnectorProviders, buildProofProvider, resolveManifestUrl } from './providers.mjs';
export {
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest,
    recordKeyOf,
    prepareRegisterDocument,
    prepareRegisterPassport,
    prepareBindDocument,
    prepareBindPassport,
    prepareRetract,
    prepareRetractAttestation,
    preparePurgeExpired,
    DEFAULT_CLAIM_LIFETIME_S,
    prepareAnchorContentRoot,
    prepareProveFieldPredicate,
    prepareProveFieldEquality,
    prepareProveFieldMembership,
    prepareProveFieldsUnchangedExcept,
    prepareProveFieldsDiffer
} from './attestation-vault-calls.mjs';

/**
 * Fixed facts about the contracts this package ships for the browser.
 * The deployed address and the key URL come from the server's `/contract-manifest` route.
 */
export const CONTRACTS = {
    'attestation-vault': {
        name: 'attestation-vault',
        artifactSubpath: '@odatano/nightgate/browser/attestation-vault',
        circuits: ['attest', 'retract', 'grantDisclosure', 'revokeDisclosure', 'registerDocument', 'bindDocument', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        // Circuits that need the attester's secret key.
        // The proof circuits are not listed, because a document holder can prove without it.
        attesterGated: ['attest', 'retract', 'grantDisclosure', 'revokeDisclosure', 'registerDocument', 'bindDocument', 'anchorContentRoot'],
        // Circuits that need the document's Merkle proof data as private input.
        merkleWitnessed: ['proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        hasPrivateState: false,
        // A document has up to `slotWidth` provable fields, stored as a Merkle tree of depth `merkleDepth`.
        // For a vault with another width, pass `slotWidth` to the prepare helpers and to buildAttestationVaultWitnesses.
        slotWidth: 16,
        merkleDepth: 4
    },
    // The same contract for documents with up to 32 provable fields.
    // A proof that compares two documents only works when both use the same width.
    'attestation-vault-32': {
        name: 'attestation-vault-32',
        artifactSubpath: '@odatano/nightgate/browser/attestation-vault-32',
        circuits: ['attest', 'retract', 'grantDisclosure', 'revokeDisclosure', 'registerDocument', 'bindDocument', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        attesterGated: ['attest', 'retract', 'grantDisclosure', 'revokeDisclosure', 'registerDocument', 'bindDocument', 'anchorContentRoot'],
        merkleWitnessed: ['proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        hasPrivateState: false,
        slotWidth: 32,
        merkleDepth: 5
    }
};
