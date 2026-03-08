namespace midnight;

using {
    cuid,
    managed
} from '@sap/cds/common';
using {
    HexEncoded,
    UnshieldedAddr,
    CardanoRewardAddr,
    DustAddr,
    BigInt,
    TransactionResultStatus,
    TransactionType,
    ContractActionType,
    DustLedgerEventType,
    TxType,
    SyncStatus,
    TokenCategory
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
    systemParameters : Association to SystemParameters;
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
// System Parameters & Governance
// ============================================================================

/**
 * System-wide parameters
 */
entity SystemParameters : cuid, managed {
    validFrom                 : Timestamp not null;
    validTo                   : Timestamp;

    // D-Parameter (validator committee composition)
    numPermissionedCandidates : Integer not null;
    numRegisteredCandidates   : Integer not null;

    // Terms and Conditions
    termsHash                 : HexEncoded;
    termsUrl                  : String(2048);
}

/**
 * D-Parameter history for governance tracking
 */
entity DParameterHistory : cuid, managed {
    effectiveFrom             : Timestamp not null;
    effectiveTo               : Timestamp;
    numPermissionedCandidates : Integer not null;
    numRegisteredCandidates   : Integer not null;
    block                     : Association to Blocks;
}

/**
 * Terms and Conditions history
 */
entity TermsAndConditionsHistory : cuid, managed {
    effectiveFrom : Timestamp not null;
    effectiveTo   : Timestamp;
    hash          : HexEncoded not null;
    url           : String(2048) not null;
    block         : Association to Blocks;
}

// ============================================================================
// DUST Generation
// ============================================================================

/**
 * DUST generation status for Cardano reward addresses
 */
entity DustGenerationStatus : cuid, managed {
    cardanoRewardAddress : CardanoRewardAddr not null;
    dustAddress          : DustAddr; // Bech32m-encoded
    registered           : Boolean default false;
    nightBalance         : BigInt not null; // NIGHT backing (STAR)
    generationRate       : BigInt not null; // SPECK per second
    maxCapacity          : BigInt not null; // maximum SPECK capacity
    currentCapacity      : BigInt not null; // current SPECK capacity
    utxoTxHash           : HexEncoded; // Cardano UTXO tx hash
    utxoOutputIndex      : Integer; // Cardano UTXO output index
}

// ============================================================================
// Session Management (for wallet connections)
// ============================================================================

/**
 * Wallet sessions for authenticated access
 */
entity WalletSessions : cuid, managed {
    viewingKeyHash      : String(64); // SHA-256 of viewing key (for lookup/dedup)
    encryptedViewingKey : LargeString; // AES-256-GCM encrypted viewing key
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
 * Indexer sync status — singleton table tracking crawler progress
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
 * Reorg history — tracks blockchain reorganizations detected by the crawler
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

/**
 * NIGHT to DUST registration linkage (Cardano staking ↔ Midnight DUST)
 */
entity DustRegistrations : cuid, managed {
    // Cardano side
    cardanoStakeKey : String(66) not null;
    cardanoTxHash   : HexEncoded not null;

    // Midnight side
    dustPublicKey   : HexEncoded not null;
    nightAddress    : String(256) not null;

    // Status
    isActive        : Boolean default true;
    registeredAt    : Timestamp not null;
    deregisteredAt  : Timestamp;

    // NIGHT amount backing DUST generation
    nightAmount     : Decimal(20, 0);
}

/**
 * Token type registry — tracks all known token types on the Midnight network
 */
entity TokenTypes {
    key tokenTypeId     : HexEncoded;
        tokenName       : String(100);
        tokenCategory   : TokenCategory;

        // For contract-created tokens
        contractAddress : HexEncoded;

        // Metadata
        decimals        : Integer;
        totalSupply     : Decimal(30, 0);

        firstSeenHeight : Integer64;
        firstSeenAt     : Timestamp;
}

