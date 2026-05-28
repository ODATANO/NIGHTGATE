namespace midnight;

using {
    cuid,
    managed
} from '@sap/cds/common';
using {
    HexEncoded,
    UnshieldedAddr,
    DustAddr,
    BigInt,
    TransactionResultStatus,
    TransactionType,
    ContractActionType,
    DustLedgerEventType,
    TxType,
    SyncStatus,
    PendingSubmissionStatus,
    BackgroundJobStatus,
    BackgroundJobKind,
    DisclosureRole
} from './types.cds';

/**
 * Represents a block in the Midnight blockchain
 */
entity Blocks : cuid, managed {
    hash             : HexEncoded not null;
    height           : Integer64 not null;
    protocolVersion  : Integer not null;
    timestamp        : Integer not null; // UNIX timestamp
    author           : HexEncoded;
    ledgerParameters : HexEncoded not null;

    // Associations
    parent           : Association to Blocks;
    transactions     : Composition of many Transactions
                           on transactions.block = $self;
}

/**
 * Represents a transaction in the Midnight blockchain
 */
entity Transactions : cuid, managed {
    transactionId            : Integer not null; // index within block
    hash                     : HexEncoded not null;
    protocolVersion          : Integer not null;
    raw                      : LargeBinary; // hex-encoded serialized content
    transactionType          : TransactionType not null;

    // Regular Transaction specific fields
    merkleTreeRoot           : HexEncoded;
    startIndex               : Integer64; // zswap state start index
    endIndex                 : Integer64; // zswap state end index
    identifiers              : LargeString; // JSON array of HexEncoded identifiers

    // Classification fields (populated by Crawler / BlockProcessor)
    txType                   : TxType;
    isShielded               : Boolean default false;
    senderAddress            : String(256); // For unshielded TXs
    receiverAddress          : String(256); // For unshielded TXs
    nightAmount              : BigInt; // NIGHT amount transferred
    dustConsumed             : BigInt; // DUST consumed in fees
    hasProof                 : Boolean default false;
    proofHash                : HexEncoded;
    contractAddress          : HexEncoded; // Contract address if contract TX
    circuitName              : String(100); // Entry point / circuit name for contract calls
    size                     : Integer; // TX size in bytes

    // Associations
    block                    : Association to Blocks not null;
    transactionResult        : Composition of one TransactionResults
                                   on transactionResult.transaction = $self;
    transactionFees          : Composition of one TransactionFees
                                   on transactionFees.transaction = $self;
    contractActions          : Composition of many ContractActions
                                   on contractActions.transaction = $self;
    unshieldedCreatedOutputs : Composition of many UnshieldedUtxos
                                   on unshieldedCreatedOutputs.createdAtTransaction = $self;
    unshieldedSpentOutputs   : Association to many UnshieldedUtxos
                                   on unshieldedSpentOutputs.spentAtTransaction = $self;
    zswapLedgerEvents        : Composition of many ZswapLedgerEvents
                                   on zswapLedgerEvents.transaction = $self;
    dustLedgerEvents         : Composition of many DustLedgerEvents
                                   on dustLedgerEvents.transaction = $self;
}

/**
 * Transaction execution result
 */
entity TransactionResults : cuid {
    status      : TransactionResultStatus not null;
    transaction : Association to Transactions;
    segments    : Composition of many TransactionSegments
                      on segments.transactionResult = $self;
}

/**
 * Segment of a transaction result (for partial success)
 */
entity TransactionSegments : cuid {
    segmentId         : Integer not null;
    success           : Boolean not null;
    transactionResult : Association to TransactionResults;
}

/**
 * Transaction fee information
 */
entity TransactionFees : cuid {
    paidFees      : BigInt not null; // actual fees in DUST
    estimatedFees : BigInt not null; // estimated fees in DUST
    transaction   : Association to Transactions;
}

// ============================================================================
// Contract Entities
// ============================================================================

/**
 * Contract actions (Deploy, Call, Update)
 */
entity ContractActions : cuid, managed {
    address            : HexEncoded not null;
    state              : LargeBinary; // hex-encoded serialized state
    zswapState         : LargeBinary; // contract-specific zswap state
    actionType         : ContractActionType not null;
    entryPoint         : String(256); // only for CALL actions

    // Associations
    transaction        : Association to Transactions not null;
    deploy             : Association to ContractActions; // for CALL actions, reference to deployment
    unshieldedBalances : Composition of many ContractBalances
                             on unshieldedBalances.contractAction = $self;
}

/**
 * Token balances for contracts
 */
entity ContractBalances : cuid {
    tokenType      : HexEncoded not null;
    amount         : BigInt not null; // balance as string (u128)
    contractAction : Association to ContractActions;
}

// ============================================================================
// UTXO Entities
// ============================================================================

/**
 * Unshielded Unspent Transaction Outputs
 */
entity UnshieldedUtxos : cuid, managed {
    owner                       : UnshieldedAddr not null; // Bech32m-encoded
    tokenType                   : HexEncoded not null;
    value                       : BigInt not null; // UTXO quantity (u128)
    intentHash                  : HexEncoded not null;
    outputIndex                 : Integer not null;
    ctime                       : Integer; // creation timestamp (seconds)
    initialNonce                : HexEncoded not null; // for DUST tracking
    registeredForDustGeneration : Boolean default false;

    // Associations
    createdAtTransaction        : Association to Transactions not null;
    spentAtTransaction          : Association to Transactions;
}

// ============================================================================
// Ledger Events
// ============================================================================

/**
 * Zswap Ledger Events
 */
entity ZswapLedgerEvents : cuid {
    eventId     : Integer not null;
    raw         : LargeBinary; // hex-encoded serialized event
    maxId       : Integer not null;
    transaction : Association to Transactions not null;
}

/**
 * DUST Ledger Events
 */
entity DustLedgerEvents : cuid {
    eventId         : Integer not null;
    raw             : LargeBinary; // hex-encoded serialized event
    maxId           : Integer not null;
    eventType       : DustLedgerEventType not null;

    // For INITIAL_UTXO events
    dustOutputNonce : HexEncoded; // 32-byte nonce

    transaction     : Association to Transactions not null;
}

// ============================================================================
// Session Management (for wallet connections)
// ============================================================================

/**
 * Wallet sessions for authenticated access.
 *
 * `encryptedViewingKey` alone supports read-only ledger queries and the
 * deterministic derivation of accountId + private-state storage password
 * (T7). It does NOT support signing or transaction balancing, those need
 * `encryptedSeedKey`, which is nullable today because the existing read-only
 * sessions don't carry it. Submission flows that require signing will fail
 * with a clear error when this field is absent (T7-extended will plumb a
 * `connectWalletForSigning` action that populates it).
 */
entity WalletSessions : cuid, managed {
    viewingKeyHash      : String(64); // SHA-256 of viewing key (for lookup/dedup)
    encryptedViewingKey : LargeString; // AES-256-GCM encrypted viewing key
    encryptedSeedKey    : LargeString; // optional: AES-256-GCM encrypted seed/signing key (T7-extended)
    sessionId           : UUID not null;
    connectedAt         : Timestamp not null;
    disconnectedAt      : Timestamp;
    expiresAt           : Timestamp; // Session TTL
    isActive            : Boolean default true;
}

// ============================================================================
// Indexer State & Sync
// ============================================================================

/**
 * Indexer sync status, singleton table tracking crawler progress
 */
entity SyncState {
    key ID                  : String(10) default 'SINGLETON';
        networkId           : String(30);

        // Sync position
        lastIndexedHeight   : Integer64 default 0;
        lastIndexedHash     : HexEncoded;
        lastIndexedAt       : Timestamp;

        // Finality tracking
        lastFinalizedHeight : Integer64 default 0;
        lastFinalizedHash   : HexEncoded;

        // Node info
        nodeUrl             : String(200);
        chainHeight         : Integer64 default 0;

        // Status
        syncStatus          : SyncStatus default 'stopped';
        syncProgress        : Decimal(5, 2) default 0;
        blocksPerSecond     : Decimal(10, 2) default 0;

        // Errors
        lastError           : String(500);
        lastErrorAt         : Timestamp;
        consecutiveErrors   : Integer default 0;
}

/**
 * Reorg history, tracks blockchain reorganizations detected by the crawler
 */
entity ReorgLog : cuid, managed {
    detectedAt       : Timestamp not null;
    forkHeight       : Integer64 not null;
    oldTipHash       : HexEncoded not null;
    newTipHash       : HexEncoded not null;
    blocksRolledBack : Integer default 0;
    blocksReIndexed  : Integer default 0;
    status           : String(20); // 'completed', 'failed'
}

// ============================================================================
// Balance & Token Tracking
// ============================================================================

// ============================================================================
// Pending Submissions (T4/T5, submission lifecycle tracking)
// ============================================================================

/**
 * Tracks transactions submitted through NIGHTGATE's submission path
 * (`TransactionSubmitter.deploy`/`call`). Lifecycle:
 *
 *   pending  →  included  →  finalized
 *                            (or failed at any step)
 *
 * Rows are written BEFORE invoking the SDK so we can recover if the process
 * crashes mid-submission. After the SDK resolves we attach `txHash` and move
 * to `included`. The crawler's BlockProcessor reconciles to `finalized` once
 * it indexes the matching tx hash.
 */
entity PendingSubmissions : cuid, managed {
    txHash          : HexEncoded;              // null until SDK returns
    contractAddress : HexEncoded;              // null for deploys until SDK returns
    circuitName     : String(100);             // null for deploys
    actionType      : ContractActionType not null;  // DEPLOY | CALL | UPDATE
    submittedAt     : Timestamp not null;
    status          : PendingSubmissionStatus default 'pending';
    finalizedAt     : Timestamp;
    finalizedTxData : LargeString;             // JSON snapshot of crawler-indexed tx
    errorCode       : String(50);              // e.g. '1016', 'TIMEOUT', 'TxFailed'
    errorMessage    : String(500);
    sessionId       : UUID;                    // links to WalletSessions for audit
}

// ============================================================================
// Background Jobs (async submission lifecycle, 0.2.0)
// ============================================================================

/**
 * Async job rows for long-running submission actions.
 *
 * Migrated actions (registerForDustGeneration, sendNight, shieldFunds,
 * unshieldFunds, deregisterFromDustGeneration, deployContract,
 * submitContractCall, anchorDocument, connectWalletForSigning) no longer await
 * the multi-minute-to-hours work inline. Instead, the handler:
 *
 *   1. Inserts a row here with `status='pending'` on `req.tx` (commits with the
 *      OData response).
 *   2. Returns `{ jobId, status }` to the caller in milliseconds.
 *   3. Detaches the long-running work via `cds.spawn`. The spawn transitions
 *      the row through `running` → `succeeded` (with serialized `result`) or
 *      `failed` (with classified `errorCode` + `errorMessage`).
 *
 * Crash recovery: `src/plugin.ts` flips any `pending`/`running` rows to
 * `failed:PROCESS_RESTART` on boot. Idempotent.
 *
 * Idempotency: optional `idempotencyKey` deduplicates retries; a fresh attempt
 * with the same (sessionId, kind, idempotencyKey) returns the existing row's
 * jobId rather than starting a new job.
 *
 * `request` and `result` are JSON-encoded blobs of the original action's
 * input arguments (minus secrets — viewing keys, seeds, ENCRYPTION_KEY-derived
 * material are NEVER written) and return shape.
 */
entity BackgroundJobs : cuid, managed {
    kind           : BackgroundJobKind not null;
    sessionId      : String(64);            // owner scope; matches WalletSessions.sessionId
    status         : BackgroundJobStatus default 'pending';
    idempotencyKey : String(128);           // optional, unique per (sessionId, kind)
    request        : LargeString;           // JSON of inbound args (secrets redacted)
    result         : LargeString;           // JSON of return value on success
    errorCode      : String(64);            // classified code on failure
    errorMessage   : LargeString;           // user-facing failure message
    startedAt      : Timestamp;             // when the spawn picked it up
    finishedAt     : Timestamp;             // when it transitioned to succeeded/failed
}

// ============================================================================
// Midnight SDK Private State Storage (T29, production replacement for LevelDB)
// ============================================================================

/**
 * Encrypted private states held on behalf of authenticated wallet sessions.
 *
 * Wire format of `ciphertext` is the same one the Midnight SDK's LevelDB
 * provider uses for its export blobs: a base64-encoded buffer composed of
 *   [1B version=2][32B salt][12B IV][16B authTag][ciphertext]
 *
 * Key is (accountId, contractAddress, privateStateId). Account isolation is
 * enforced by including accountId in the key.
 */
entity PrivateStates {
    key accountId       : String(200);
    key contractAddress : String(200);
    key privateStateId  : String(200);
        ciphertext      : LargeString not null;
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

/**
 * Encrypted contract signing keys, scoped per (accountId, contractAddress).
 * Same on-disk format as PrivateStates.ciphertext.
 */
entity ContractSigningKeys {
    key accountId       : String(200);
    key contractAddress : String(200);
        ciphertext      : LargeString not null;
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

/**
 * Persisted wallet sub-state, one row per session (accountId).
 *
 * The Midnight wallet SDK exposes `serializeState()` on each sub-wallet
 * (shielded/unshielded/dust) and a corresponding `restore(serialized)` static.
 * We capture all three blobs every ~30 s and on graceful disconnect so that a
 * server restart can skip the full chain scan from genesis (5–6 h on preprod
 * for a fresh seed) and continue from the last persisted index.
 *
 * Each *Blob field is an AES-256-GCM ciphertext produced by storage-encryption.ts
 * (same wire format as PrivateStates.ciphertext), keyed on the per-session
 * storage password derived in T7. `sdkVersion` is the resolved version of
 * `@midnight-ntwrk/wallet-sdk-facade` at save time; on restore we discard the
 * blob if the version no longer matches, to protect against silent state-shape
 * drift across SDK upgrades.
 */
entity WalletSyncStates {
    key accountId           : String(200);
        shieldedStateBlob   : LargeString;
        unshieldedStateBlob : LargeString;
        dustStateBlob       : LargeString;
        sdkVersion          : String(64) not null;
        createdAt           : Timestamp;
        updatedAt           : Timestamp;
}

// ============================================================================
// Attestation / Document Anchoring / Tiered Disclosure (T10-ext, T11, T12, T14)
// ============================================================================

/**
 * Attestations recorded on-chain via the AttestationVault Compact contract.
 *
 * Rows are created reactively by the crawler when it indexes an `attest`
 * contract action: `attestationId` mirrors the on-chain `payload_hash`
 * (blake2b-256 of the private payload). `publicMetadata` is the JSON written
 * to the contract's public ledger. `payloadCipher` is the optional encrypted
 * off-chain payload that disclosure recipients can decrypt — kept here so
 * Tier 2/3 readers can fetch it without a separate storage round-trip.
 *
 * Read-side surface for T11's AttestationService projections (Public,
 * Disclosed, Authority), gated by the requester's DisclosureRole.
 */
entity Attestations : cuid, managed {
    attestationId    : HexEncoded not null; // payload_hash (blake2b-256)
    contractAddress  : HexEncoded not null; // AttestationVault deployment
    attester         : HexEncoded not null; // attester pubkey
    publicMetadata   : LargeString;         // JSON
    payloadCipher    : LargeBinary;         // optional off-chain encrypted payload
    anchoredTxHash   : HexEncoded;
    anchoredAt       : Timestamp;
}

/**
 * Document anchoring (T12).
 *
 * Inserted by the `anchorDocument` action. `sha256` is the content hash that
 * gets written on-chain as the AttestationVault `payload_hash`. `storageRef`
 * points at the actual bytes in the configured storage backend
 * (`file://`, `s3://`, `ipfs://`). After the on-chain `attest` lands and the
 * crawler indexes it, `anchoredTxHash`/`anchoredAt` are filled in.
 *
 * `verifyDocument` (T13) selects on `ID`, compares the caller-supplied hash
 * to `sha256`, then checks `anchoredTxHash` against `Transactions` for a
 * successful result.
 */
entity Documents : cuid, managed {
    sha256         : HexEncoded not null;
    contentType    : String(100);
    size           : Integer64;
    storageRef     : String(500); // file:// | s3:// | ipfs://
    anchoredTxHash : HexEncoded;
    anchoredAt     : Timestamp;
}

/**
 * Disclosure role grants for tiered access (T14).
 *
 * The `attachDisclosureRole` middleware reads from this table on every
 * request, picks the highest-tier currently-valid row for the authenticated
 * user, and attaches `req.disclosureRole` for downstream service handlers.
 * Without a matching row the default is `public_only`.
 *
 * `scope` is optional: an empty value applies globally; a contract address
 * scopes the grant to a single AttestationVault deployment; an attestation
 * ID (payload_hash) scopes it to a single record. Grant management
 * (`grantRole` admin action) is gated on the caller already holding
 * `authority` role.
 */
entity DisclosureRoles : cuid, managed {
    userId     : String(200)    not null; // matches req.user.id from CAP auth
    role       : DisclosureRole not null;
    scope      : String(500);             // optional: contract addr or attestation id
    grantedBy  : String(200);
    validFrom  : Timestamp;
    validUntil : Timestamp;
}


/**
 * Unshielded NIGHT token balances per address
 */
entity NightBalances {
    key address            : String(256);
        balance            : Decimal(20, 0) default 0;
        utxoCount          : Integer default 0;

        // Activity tracking
        firstSeenHeight    : Integer64;
        firstSeenAt        : Timestamp;
        lastActivityHeight : Integer64;
        lastActivityAt     : Timestamp;

        // TX statistics
        txSentCount        : Integer default 0;
        txReceivedCount    : Integer default 0;
        totalSent          : Decimal(20, 0) default 0;
        totalReceived      : Decimal(20, 0) default 0;

        // DUST linkage
        dustAddress        : DustAddr;
        isDustRegistered   : Boolean default false;

        // Indexer metadata
        lastUpdatedHeight  : Integer64;
        lastUpdatedAt      : Timestamp;
}


