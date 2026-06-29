// `@odatano/nightgate/browser` — browser entry for the wallet-connector path.
//
// Browser-safe surface ONLY: no @sap/cds, no worker, no Node-only providers.
// Heavy contract artifacts are exposed via per-contract subpaths so consumers
// import just what they need and the barrel stays light:
//   import { Contract, ledger } from '@odatano/nightgate/browser/attestation-vault';
//
// This barrel re-exports the witness/attester-secret helpers and a small
// metadata map. Provider wiring (connector -> midnight-js providers) and typed
// call helpers land in Phase 4.

export {
    deriveAttestationSecret,
    deriveAttestationSecretFromSignature,
    buildAttestationVaultWitnesses,
    ATTESTER_SECRET_MESSAGE
} from './witnesses.mjs';

// Phase 4 — providers + typed call helpers.
export { FetchZkConfigProvider } from './zk-config.mjs';
export { InMemoryPrivateStateProvider } from './private-state.mjs';
export { createNightgateConnectorProviders } from './providers.mjs';
export {
    prepareRevokeDisclosure,
    prepareGrantDisclosure,
    prepareAttest
} from './attestation-vault-calls.mjs';

/**
 * Static metadata for the contracts NIGHTGATE ships browser artifacts for.
 * The deployed address + zk-config URL come at runtime from the NIGHTGATE
 * `/contract-manifest` endpoint (Phase 3) — NOT hard-coded here.
 */
export const CONTRACTS = {
    'attestation-vault': {
        name: 'attestation-vault',
        artifactSubpath: '@odatano/nightgate/browser/attestation-vault',
        circuits: ['attest', 'grantDisclosure', 'revokeDisclosure', 'commitValue', 'provePredicate'],
        // Circuits that need the attester-identity witness (local_secret_key).
        attesterGated: ['attest', 'grantDisclosure', 'revokeDisclosure', 'commitValue'],
        // Circuits that need per-call value/salt witnesses.
        valueWitnessed: ['commitValue', 'provePredicate'],
        hasPrivateState: false
    }
};
