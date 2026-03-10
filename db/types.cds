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

