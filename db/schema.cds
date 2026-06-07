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

/**
 * Wallet sessions for authenticated access.
 */
entity WalletSessions : cuid, managed {
    viewingKeyHash      : String(64); // SHA-256 of viewing key (for lookup/dedup)
    encryptedViewingKey : LargeString; // AES-256-GCM encrypted viewing key
    encryptedSeedKey    : LargeString; // optional: AES-256-GCM encrypted seed/signing key
    sessionId           : UUID not null;
    connectedAt         : Timestamp not null;
    disconnectedAt      : Timestamp;
    expiresAt           : Timestamp; // Session TTL
    isActive            : Boolean default true;
}

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

/**
 * Tracks transactions submitted through NIGHTGATE's submission path
 */
entity PendingSubmissions : cuid, managed {
    txHash          : HexEncoded; // null until SDK returns
    contractAddress : HexEncoded; // null for deploys until SDK returns
    circuitName     : String(100); // null for deploys
    actionType      : ContractActionType not null; // DEPLOY | CALL | UPDATE
    submittedAt     : Timestamp not null;
    status          : PendingSubmissionStatus default 'pending';
    finalizedAt     : Timestamp;
    finalizedTxData : LargeString; // JSON snapshot of crawler-indexed tx
    errorCode       : String(50); // e.g. '1016', 'TIMEOUT', 'TxFailed'
    errorMessage    : String(500);
    sessionId       : UUID; // links to WalletSessions for audit
}

/**
 * Backgroundjobs for diffrent purposes
 */
entity BackgroundJobs : cuid, managed {
    kind           : BackgroundJobKind not null;
    sessionId      : String(64); // owner scope; matches WalletSessions.sessionId
    status         : BackgroundJobStatus default 'pending';
    idempotencyKey : String(128); // optional, unique per (sessionId, kind)
    request        : LargeString; // JSON of inbound args (secrets redacted)
    result         : LargeString; // JSON of return value on success
    errorCode      : String(64); // classified code on failure
    errorMessage   : LargeString; // user-facing failure message
    startedAt      : Timestamp; // when the spawn picked it up
    finishedAt     : Timestamp; // when it transitioned to succeeded/failed
}

/**
 * Encrypted private states held on behalf of authenticated wallet sessions.
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
 * Encrypted contract signing keys, scoped per (accountId, contractAddress)
 */
entity ContractSigningKeys {
    key accountId       : String(200);
    key contractAddress : String(200);
        ciphertext      : LargeString not null;
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

/**
 * Persisted wallet sub-state, one row per session (accountId)
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

/**
 * Attestations recorded on-chain via the AttestationVault Compact contract
 */
entity Attestations : cuid, managed {
    attestationId   : HexEncoded not null; // payload_hash (blake2b-256)
    contractAddress : HexEncoded not null; // AttestationVault deployment
    attester        : HexEncoded not null; // attester pubkey
    publicMetadata  : LargeString; // JSON
    payloadCipher   : LargeBinary; // optional off-chain encrypted payload
    anchoredTxHash  : HexEncoded;
    anchoredAt      : Timestamp;
}

/**
 * Document anchoring
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
 * ZK predicate attestations
 */
entity PredicateAttestations : cuid, managed {
    payloadHash     : HexEncoded not null; // attestation this predicate is about
    contractAddress : HexEncoded not null; // AttestationVault deployment
    predicate       : String(20) not null; // 'lessOrEqual' | 'greaterOrEqual'
    op              : Integer not null; // 0 | 1
    threshold       : Integer64 not null; // scaled integer
    unit            : String(50); // e.g. 'kgCO2e/kWh' (informational)
    valueCommitment : HexEncoded; // persistentCommit(value, salt), on-chain
    provenTxHash    : HexEncoded; // tx that recorded the on-chain result
    provenAt        : Timestamp;
}

/**
 * Disclosure role grants for tiered access
 */
entity DisclosureRoles : cuid, managed {
    userId     : String(200) not null; // matches req.user.id from CAP auth
    role       : DisclosureRole not null;
    scope      : String(500); // optional: contract addr or attestation id
    grantedBy  : String(200);
    validFrom  : Timestamp;
    validUntil : Timestamp;
}

/**
 * On-chain disclosure grants read off the AttestationVault `disclosures`
 * ledger Map. Distinct from DisclosureRoles (off-chain, operator-configured):
 * these are CHAIN-DERIVED entitlement records — the contract is the ACL.
 *
 * Rows are inserted optimistically (active=false) by `grantDisclosure` and
 * confirmed/flipped by the chain indexer (Phase 2) once the grant appears in
 * ledger state. Logical key for cross-contract reuse:
 * (contractAddress, payloadHash, grantee). `level`: 0=public,
 * 1=legitimate-interest, 2=authority.
 */
entity DisclosureGrants : cuid, managed {
    payloadHash     : HexEncoded not null; // attestation the grant is scoped to
    grantee         : HexEncoded not null; // Bytes<32> grantee identifier
    level           : Integer not null; // 0 | 1 | 2
    contractAddress : HexEncoded not null; // AttestationVault deployment
    grantedTxHash   : HexEncoded; // tx that set this grant on-chain
    revokedTxHash   : HexEncoded; // set when revoked on-chain
    active          : Boolean default false; // granted and not revoked (chain-confirmed)
}

/**
 * Binds an authenticated principal (req.user.id) to the `Bytes<32>` grantee id
 * the AttestationVault circuit checks, so the read gate can resolve
 * principal → granteeId and match an on-chain DisclosureGrant (Phase 0 of
 * expose-disclosure-grants). `bindingKind` records how the id was derived
 * ('wallet' | 'did' | 'custom'); see srv/submission/grantee-identity.ts.
 * Resolution mirrors DisclosureRoles scope precedence: a scoped row wins,
 * else a global (null/empty scope) row applies.
 */
entity GranteeIdentities : cuid, managed {
    userId      : String(200) not null; // matches req.user.id from CAP auth
    granteeId   : HexEncoded not null;  // Bytes<32> grantee id (64 hex)
    bindingKind : String(20) not null;  // 'wallet' | 'did' | 'custom'
    scope       : String(500);          // optional: contract addr / attestation id
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
