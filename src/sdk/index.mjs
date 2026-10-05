// `@odatano/nightgate-tx`, the NIGHTGATE client SDK. It has two parts.
//   - connect() calls a hosted NIGHTGATE server. Each server action is a function.
//   - createTxBuilder() builds, proves and signs a transaction on your machine with your own key.
//     You then send only the finished bytes to the server, which pays the fee.
//
// Call input helpers are in './calls', the compiled vault contract in './attestation-vault',
// and the allow-list hashing rule in './set-root'.
//
// SPDX-License-Identifier: Apache-2.0

export { connect, int64, isRetryable, RETRYABLE_ERROR_CODES, NightgateApiError, NightgateJobError } from './client.mjs';
export { createTxBuilder, deriveIdentity, ensureZkAssets, ATTESTATION_VAULT_CIRCUITS, createSwapWallet, readSwapTerms, encodeOffer, decodeOffer, holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from '../txbuilder/index.mjs';
