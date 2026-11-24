// Hex is lowercase without `0x`. A caller may send either spelling in any letter case.
@nightgate.hex
@assert.format        : '^(0[xX])?[0-9a-fA-F]*$'
@assert.format.message: 'must be hex'
type HexEncoded               : String(512);

@nightgate.hex
@assert.format        : '^(0[xX])?[0-9a-fA-F]{64}$'
@assert.format.message: 'must be 64 hex characters'
type Hex64                    : String; // 32 bytes as 64 hex characters

// Declare a list of hex values with one of these types. The items of a plain `array of Hex64` lose the annotation at runtime.
@nightgate.hex
type Hex64List                : array of Hex64;
@nightgate.hex
type HexList                  : array of HexEncoded;

@nightgate.hex
@assert.format        : '^(0[xX])?[0-9a-fA-F]{128}$'
@assert.format.message: 'must be 128 hex characters'
type SeedHex                  : String; // 64-byte BIP39 seed as 128 hex characters

// Bech32m as `mn_<kind>[_<network>]1...`. Mainnet has no network part.
@assert.format        : '^mn_addr[_1][0-9a-zA-Z_-]+$'
@assert.format.message: 'must be an unshielded address (mn_addr...)'
type UnshieldedAddr           : String(256);

@assert.format        : '^mn_shield-addr[_1][0-9a-zA-Z_-]+$'
@assert.format.message: 'must be a shielded address (mn_shield-addr...)'
type ShieldedAddr             : String(256);

@assert.format        : '^mn_dust[_1][0-9a-zA-Z_-]+$'
@assert.format.message: 'must be a DUST address (mn_dust...)'
type DustAddr                 : String(256);

@assert.format        : '^mn_(shield-addr|addr)[_1][0-9a-zA-Z_-]+$'
@assert.format.message: 'must be a shielded (mn_shield-addr...) or an unshielded (mn_addr...) address'
type ReceiverAddr             : String(256); // the kind picks the ledger a payment comes from

@assert.format        : '^[0-9]+$'
@assert.format.message: 'must be a decimal integer'
type BigInt                   : String(78); // decimal; unsigned 128-bit integer

// Spelling of values: our own states are lowercase with underscores, values of the Midnight indexer keep
// its upper case, and names of checks are written like action names.
type TransactionResultStatus  : String enum {
    SUCCESS;
    PARTIAL_SUCCESS;
    FAILURE;
}

type TransactionType          : String enum {
    REGULAR;
    SYSTEM;
}

type ContractActionType       : String enum {
    DEPLOY;
    CALL;
    UPDATE;
}

/** Result of decoding the ledger transaction inside an extrinsic. */
type PayloadDecodeState       : String(20) enum {
    decoded;
    absent; // the extrinsic carries no ledger transaction
    failed; // the bytes could not be decoded
}

/** The event kinds of the Midnight indexer's DUST event stream. */
type DustLedgerEventType      : String enum {
    DTIME_UPDATE;
    INITIAL_UTXO;
    SPEND_PROCESSED;
    PARAM_CHANGE;
}

type TxType                   : String(30) enum {
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

type SyncStatus               : String(20) enum {
    syncing;
    synced;
    error;
    stopped;
}

type PendingSubmissionStatus  : String(20) enum {
    pending;
    included;
    finalized;
    failed;
}

type BackgroundJobStatus      : String(32) enum {
    pending; // queued
    running; // working, nothing sent to the chain yet
    external_execution; // in a call that may reach the chain
    submitted; // transaction hash known, waiting for finality
    reconciliation_required; // stopped after it may have reached the chain
    succeeded; // `result` holds the return value
    failed; // see errorCode and errorMessage
}

type BackgroundJobKind        : String(64);

type BackgroundJobChainStatus : String(20) enum {
    pending;
    success;
    failure;
    dropped;
}

type CommandEncoding          : String(20) enum {
    json_v1 = 'json-v1';
    aes_gcm_v1 = 'aes-gcm-v1';
}

type SwapOfferStatus          : String(10) enum {
    open;
    filled;
    retired;
    expired;
}

@assert.range
type NumericPredicate         : String(20) enum {
    lessOrEqual;
    greaterOrEqual;
}

@assert.range
type ClaimPredicate           : String(20) enum {
    lessOrEqual;
    greaterOrEqual;
    bytesEquality;
    setMembership;
    documentIntegrity;
    documentDiff;
}

@assert.range
type Network                  : String(32) enum {
    preview;
    preprod;
    mainnet;
    stagenet;
    undeployed;
}

type GranteeBinding           : String(20) enum {
    wallet;
    did;
    custom;
}

type ContentHashKind          : String(20) enum {
    blake2b_256 = 'blake2b-256';
    sha256;
}

type ReorgStatus              : String(20) enum {
    in_progress;
    completed;
    failed;
}

type ReadinessPhase           : String enum {
    starting;
    warming;
    catching_up;
    ready;
    degraded;
    failed;
}

type ProvingMode              : String enum {
    wasm;
    server;
}

type SponsorWorkers           : String enum {
    shared;
    dedicated;
}

type StateSource              : String(10) enum {
    history;
    current;
    indexer;
}

@assert.range
type SwapOfferFilter          : String(10) enum {
    open;
    filled;
    retired;
    expired;
    ![all];
}

type HolderGrantStatus        : String enum {
    granted;
    updated;
    revoked;
}

type ContractSource           : String enum {
    config;
    runtime;
}

type PolicySource             : String enum {
    file;
    env;
}

@assert.range
type WorkerThread             : String enum {
    main;
    worker;
}
