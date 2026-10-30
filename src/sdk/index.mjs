// `@odatano/nightgate-tx`: connect() calls a NIGHTGATE server, createTxBuilder() proves and signs on your machine.
// Call inputs come from `@odatano/nightgate-tx/calls`, the vault contract from `/attestation-vault`, the allow-list hashing from `/set-root`.
// SPDX-License-Identifier: Apache-2.0

export { connect, int64, isRetryable, RETRYABLE_ERROR_CODES, NightgateApiError, NightgateJobError } from './client.mjs';
export { verifyReceipt } from './receipt.mjs';
export { createTxBuilder, deriveIdentity, ensureZkAssets, ATTESTATION_VAULT_CIRCUITS, createSwapWallet, readSwapTerms, readTransferShape, encodeOffer, decodeOffer, holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from '../txbuilder/index.mjs';
