// `@odatano/nightgate/browser`: browser entry for the wallet-connector path.
//
// Browser-safe surface ONLY: no @sap/cds, no worker, no Node-only providers.
// Heavy contract artifacts are exposed via per-contract subpaths so consumers
// import just what they need and the barrel stays light:
//   import { Contract, ledger } from '@odatano/nightgate/browser/attestation-vault';
//
// This barrel re-exports the witness/attester-secret helpers, a small
// metadata map, provider wiring (connector -> midnight-js providers), and
// typed call helpers.

export {
    deriveAttestationSecret,
    generateAttestationSecret,
    sealAttestationSecret,
    openAttestationSecret,
    buildAttestationVaultWitnesses
} from './witnesses.mjs';

// Providers + typed call helpers.
export { FetchZkConfigProvider } from './zk-config.mjs';
export { InMemoryPrivateStateProvider } from './private-state.mjs';
export { createNightgateConnectorProviders, buildProofProvider } from './providers.mjs';
export {
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest,
    prepareAttestCommit,
    prepareAttestReveal,
    prepareRegisterPassport,
    prepareBindPassport,
    prepareAnchorContentRoot,
    prepareProveFieldPredicate,
    prepareProveFieldEquality,
    prepareProveFieldMembership,
    prepareProveFieldsUnchangedExcept,
    prepareProveFieldsDiffer
} from './attestation-vault-calls.mjs';

/**
 * Static metadata for the contracts NIGHTGATE ships browser artifacts for.
 * The deployed address + zk-config URL come at runtime from the NIGHTGATE
 * `/contract-manifest` endpoint, NOT hard-coded here.
 */
export const CONTRACTS = {
    'attestation-vault': {
        name: 'attestation-vault',
        artifactSubpath: '@odatano/nightgate/browser/attestation-vault',
        circuits: ['attest', 'attestGuarded', 'grantDisclosure', 'revokeDisclosure', 'registerPassport', 'bindPassport', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        // Circuits that need the attester-identity witness (local_secret_key).
        // The proof circuits are NOT in here: holders prove without the secret.
        attesterGated: ['attest', 'attestGuarded', 'grantDisclosure', 'revokeDisclosure', 'registerPassport', 'bindPassport', 'anchorContentRoot'],
        // Circuits that need the per-call proof bundle witnesses
        // (proveFieldEquality: path only; proveFieldMembership: digest + set
        // path; proveDocumentComparison: docPair leaf layers).
        merkleWitnessed: ['proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        hasPrivateState: false,
        // Content-tree dimensions: provable fields per document and the
        // inclusion-path depth. Pass `slotWidth` to the prepare* helpers /
        // buildAttestationVaultWitnesses when targeting a non-16 variant.
        slotWidth: 16,
        merkleDepth: 4
    },
    // 32-slot width variant: same circuit set and semantics, tree width 32
    // (panels of 17-32 provable fields under ONE root). Cross-root proofs
    // only work between documents of the SAME width.
    'attestation-vault-32': {
        name: 'attestation-vault-32',
        artifactSubpath: '@odatano/nightgate/browser/attestation-vault-32',
        circuits: ['attest', 'attestGuarded', 'grantDisclosure', 'revokeDisclosure', 'registerPassport', 'bindPassport', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        attesterGated: ['attest', 'attestGuarded', 'grantDisclosure', 'revokeDisclosure', 'registerPassport', 'bindPassport', 'anchorContentRoot'],
        merkleWitnessed: ['proveFieldPredicate', 'proveFieldEquality', 'proveFieldMembership', 'proveDocumentComparison'],
        hasPrivateState: false,
        slotWidth: 32,
        merkleDepth: 5
    }
};
