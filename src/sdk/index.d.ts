// Aggregate entry of the NIGHTGATE client SDK. See index.mjs.
export { connect, int64, NightgateApiError, NightgateJobError } from './client';
export type { ConnectOptions, NightgateClient, JobResult, Int64Literal } from './client';
export { createTxBuilder, deriveIdentity, ensureZkAssets, ATTESTATION_VAULT_CIRCUITS } from '../txbuilder/index';
export type { TxBuilder, CreateTxBuilderInput, BuiltTransaction, PreparedCall, DeriveIdentityInput, Identity } from '../txbuilder/index';
