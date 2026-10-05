type HexEncoded              : String(512);
@assert.format: '^[0-9a-fA-F]{64}$'
@assert.format.message: 'must be 64 hex characters'
type Hex64                   : String; // 32 bytes as 64 hex characters
type UnshieldedAddr          : String(256); // Bech32m
type DustAddr                : String(256); // Bech32m
type BigInt                  : String(78); // decimal; unsigned 128-bit integer

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

/** Result of decoding the ledger transaction inside an extrinsic. */
type PayloadDecodeState      : String(20) enum {
    decoded;
    absent;  // the extrinsic carries no ledger transaction
    failed;  // the bytes could not be decoded
}

/** The event kinds of the Midnight indexer's DUST event stream. */
type DustLedgerEventType     : String enum {
    DTIME_UPDATE;
    INITIAL_UTXO;
    SPEND_PROCESSED;
    PARAM_CHANGE;
}

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

type BackgroundJobStatus     : String(32) enum {
    pending;                 // queued
    running;                 // working, nothing sent to the chain yet
    external_execution;      // in a call that may reach the chain
    submitted;               // transaction hash known, waiting for finality
    reconciliation_required; // stopped after it may have reached the chain
    succeeded;               // `result` holds the return value
    failed;                  // see errorCode and errorMessage
}

type BackgroundJobKind       : String(64);

type BackgroundJobChainStatus : String(20) enum {
    pending;
    success;
    failure;
    dropped;
}

type CommandEncoding         : String(20) enum {
    json_v1    = 'json-v1';
    aes_gcm_v1 = 'aes-gcm-v1';
}

type DisclosureRole          : String(30) enum {
    public_only;
    legitimate_interest;
    authority;
}

type SwapOfferStatus         : String(10) enum {
    open;
    filled;
    retired;
    expired;
}
