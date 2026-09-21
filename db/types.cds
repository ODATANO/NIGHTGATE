// ============================================================================
// Custom Types
// ============================================================================

type HexEncoded              : String(512);
type UnshieldedAddr          : String(256); // Bech32m-encoded
type DustAddr                : String(256); // Bech32m-encoded
type BigInt                  : String(78); // For u128 values as strings

type TransactionResultStatus : String enum {
    SUCCESS;
    PARTIAL_SUCCESS;
    FAILURE;
}

type TransactionType         : String enum {
    REGULAR;
    SYSTEM;
}

type ContractActionType      : String enum {
    DEPLOY;
    CALL;
    UPDATE;
}

/** Outcome of the crawler's ledger-payload decode for one transaction. */
type PayloadDecodeState      : String(20) enum {
    decoded;
    absent;  // no ledger payload in this extrinsic
    failed;  // the payload did not deserialize
}

/** The four kinds the Midnight indexer's DUST event stream carries. */
type DustLedgerEventType     : String enum {
    DTIME_UPDATE;
    INITIAL_UTXO;
    SPEND_PROCESSED;
    PARAM_CHANGE;
}

// Crawler classification
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

type SyncStatus              : String(20) enum {
    syncing;
    synced;
    error;
    stopped;
}

type PendingSubmissionStatus : String(20) enum {
    pending;
    included;
    finalized;
    failed;
}

// Background job lifecycle:
//   pending: queued; running: before the external-effect boundary;
//   external_execution: an SDK call that may touch the chain is in progress;
//   submitted: tx hash returned, finality pending;
//   reconciliation_required: interrupted after a possible chain effect;
//   succeeded: `result` holds the return JSON; failed: see errorCode/errorMessage
type BackgroundJobStatus     : String(32) enum {
    pending;
    running;
    external_execution;
    submitted;
    reconciliation_required;
    succeeded;
    failed;
}

type BackgroundJobKind       : String(64);

type DisclosureRole          : String(30) enum {
    public_only;
    legitimate_interest;
    authority;
}
