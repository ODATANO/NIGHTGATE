// ============================================================================
// Custom Types
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
type PendingSubmissionStatus : String(20) enum {
    pending;
    included;
    finalized;
    failed;
}

// Background job lifecycle for long-running submission actions.
//   pending   , row written by the OData handler; work is queued but not yet running
//   running   , the worker owns the job and is still before the external-effect boundary
//   external_execution , an SDK operation that may create a chain effect is in progress
//   submitted , the SDK returned a transaction hash; finality is pending
//   reconciliation_required , execution was interrupted after it may have produced an external effect
//   succeeded , work resolved; result column carries the JSON of the original return shape
//   failed    , work threw; errorCode + errorMessage classify it
//
type BackgroundJobStatus     : String(32) enum {
    pending;
    running;
    external_execution;
    submitted;
    reconciliation_required;
    succeeded;
    failed;
}

// Discriminator across the migrated actions
type BackgroundJobKind       : String(64);

// Tiered disclosure roles for the AttestationService
type DisclosureRole          : String(30) enum {
    public_only;
    legitimate_interest;
    authority;
}
