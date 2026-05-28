// ============================================================================
// Custom Types for Midnight Blockchain
// ============================================================================

type HexEncoded              : String(512);
type UnshieldedAddr          : String(256); // Bech32m-encoded
type DustAddr                : String(256); // Bech32m-encoded
type BigInt                  : String(78); // For u128 values as strings

// Enum for Transaction Result Status
type TransactionResultStatus : String enum {
    SUCCESS;
    PARTIAL_SUCCESS;
    FAILURE;
}

// Enum for Transaction Type
type TransactionType         : String enum {
    REGULAR;
    SYSTEM;
}

// Enum for Contract Action Type
type ContractActionType      : String enum {
    DEPLOY;
    CALL;
    UPDATE;
}

// Enum for Dust Ledger Event Type
type DustLedgerEventType     : String enum {
    DTIME_UPDATE;
    INITIAL_UTXO;
}

// Enum for detailed Transaction Type Classification (from Crawler)
type TxType                  : String(30) enum {
    night_transfer;
    shielded_transfer;
    contract_deploy;
    contract_call;
    contract_update;
    dust_registration;
    dust_generation;
    governance;
    system;
    unknown;
}

// Enum for Indexer Sync Status
type SyncStatus              : String(20) enum {
    syncing;
    synced;
    error;
    stopped;
}

// Enum for PendingSubmissions lifecycle
//   pending , row written before SDK call, no txHash yet (or call in flight)
//   included, SDK returned a finalized result; crawler hasn't seen the block yet
//   finalized, crawler has indexed the transaction matching the txHash
//   failed  , SDK threw, or the on-chain status was a non-success (rolled back, dropped)
type PendingSubmissionStatus : String(20) enum {
    pending;
    included;
    finalized;
    failed;
}

// Background job lifecycle for long-running submission actions.
//   pending   , row written by the OData handler; work is queued but not yet running
//   running   , spawn picked up the work and is executing it
//   succeeded , work resolved; result column carries the JSON of the original return shape
//   failed    , work threw; errorCode + errorMessage classify it
//
// Per the 0.2.0 async-job migration: long-running submission actions
// (registerForDustGeneration, sendNight, deployContract, etc.) return
// `{ jobId, status }` synchronously and the caller polls `getJobStatus(jobId)`.
type BackgroundJobStatus     : String(20) enum {
    pending;
    running;
    succeeded;
    failed;
}

// Discriminator across the migrated actions. Kept as String(64) rather than an
// `enum` so adding new kinds in later releases doesn't require a CDS rebuild
// for consumers checking historical rows.
type BackgroundJobKind       : String(64);

// Tiered disclosure roles for the AttestationService (T14).
// Maps 1:1 to the EU Battery Regulation Annex XIII / Art. 77 access tiers:
//   public_only         , general public, basic info, NO supplier identities
//   legitimate_interest , recyclers/repairers/second-life operators
//   authority           , Commission, notified bodies, market surveillance
// `public` is avoided as the literal name because it is a reserved word
// in CDS/TypeScript downstream code.
type DisclosureRole          : String(30) enum {
    public_only;
    legitimate_interest;
    authority;
}

