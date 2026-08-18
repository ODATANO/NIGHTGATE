// `@odatano/nightgate-tx`: the NIGHTGATE client SDK.
//
// Two halves, one import:
//   - connect(): every capability of a HOSTED NIGHTGATE as a function
//     (verification, document ingestion, ZK attestations, disclosure,
//     tokens, fee sponsoring, job polling)
//   - createTxBuilder(): build + prove + sign a transaction LOCALLY with
//     your own key, then hand only the bytes to the hosted sponsor
//
// The `prepare*` call builders live in './calls', the compiled vault class in
// './attestation-vault', the canonical membership-set rule in './set-root'.
//
// SPDX-License-Identifier: Apache-2.0

export { connect, int64, NightgateApiError, NightgateJobError } from './client.mjs';
export { createTxBuilder, ensureZkAssets, ATTESTATION_VAULT_CIRCUITS } from '../txbuilder/index.mjs';
