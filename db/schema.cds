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
    PayloadDecodeState,
    TxType,
    SyncStatus,
    PendingSubmissionStatus,
    BackgroundJobStatus,
    BackgroundJobKind,
    BackgroundJobChainStatus,
    CommandEncoding,
    DisclosureRole,
    SwapOfferStatus
} from './types.cds';

@assert.unique.hash: [hash]
entity Blocks : cuid, managed {
    hash             : HexEncoded not null;
    height           : Integer64 not null;
    protocolVersion  : Integer not null;
    timestamp        : Integer not null; // UNIX seconds
    author           : HexEncoded;
    stateRoot        : HexEncoded;
    // The ledger parameters that set fee prices. They come from the Midnight
    // indexer and are stored only on blocks where they change.
    ledgerParameters : LargeBinary; // null = same as the last lower block that has them

    parent           : Association to Blocks;
    transactions     : Composition of many Transactions
                           on transactions.block = $self;
}

// The extrinsic hash can repeat across blocks. The position in the block is unique.
@assert.unique.blockPosition: [
    block,
    transactionId
]
entity Transactions : cuid, managed {
    transactionId            : Integer not null;
    hash                     : HexEncoded not null;
    // The hash explorers and the Midnight indexer use for this transaction.
    ledgerTxHash             : HexEncoded;
    protocolVersion          : Integer not null;
    raw                      : LargeBinary;
    transactionType          : TransactionType not null;

    // Set for regular transactions only.
    merkleTreeRoot           : HexEncoded;
    startIndex               : Integer64;
    endIndex                 : Integer64;
    identifiers              : LargeString; // JSON array of strings

    txType                   : TxType;
    isShielded               : Boolean; // null = not decoded yet
    senderAddress            : String(256);
    receiverAddress          : String(256);
    nightAmount              : BigInt;
    dustConsumed             : BigInt;
    // The proof that pays the DUST fee does not count here.
    hasProof                 : Boolean; // null = not decoded yet
    contractAddress          : HexEncoded;
    circuitName              : String(100);
    size                     : Integer;

    // Filled when the transaction bytes are decoded.
    payloadDecode            : PayloadDecodeState;
    zswapInputCount          : Integer;
    zswapOutputCount         : Integer;
    zswapTransientCount      : Integer;
    dustSpendCount           : Integer;
    dustRegistrationCount    : Integer;

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

entity TransactionResults : cuid {
    status        : TransactionResultStatus not null;
    outcomeSource : String(40); // 'substrate-system-events'; null = not verified
    transaction   : Association to Transactions;
    segments      : Composition of many TransactionSegments
                        on segments.transactionResult = $self;
}

/** A transaction runs in segments that succeed or fail separately. One row per segment. */
entity TransactionSegments : cuid {
    segmentId         : Integer not null;
    success           : Boolean not null;
    transactionResult : Association to TransactionResults;
}

entity TransactionFees : cuid {
    paidFees      : BigInt not null; // DUST
    estimatedFees : BigInt not null; // DUST
    transaction   : Association to Transactions;
}

entity ContractActions : cuid, managed {
    // Order of the actions within the transaction. It tells apart two calls on the same contract.
    actionIndex        : Integer;
    address            : HexEncoded;
    // Contract state after the action, filled from the Midnight indexer.
    // Full states are kept only when `crawler.contractStateHistory` asks for them.
    // Hash and size are always kept.
    state              : LargeBinary;
    zswapState         : LargeBinary;
    stateHash          : HexEncoded;
    stateSize          : Integer;
    zswapStateHash     : HexEncoded;
    zswapStateSize     : Integer;
    actionType         : ContractActionType not null;
    entryPoint         : String(256);

    transaction        : Association to Transactions not null;
    deploy             : Association to ContractActions; // null = not a CALL; the action that deployed the contract
    unshieldedBalances : Composition of many ContractBalances
                             on unshieldedBalances.contractAction = $self;
}

entity ContractBalances : cuid {
    tokenType      : HexEncoded not null;
    amount         : BigInt not null;
    contractAction : Association to ContractActions;
}

/** The newest known state of each contract. */
entity ContractStates : managed {
    key address        : HexEncoded;
        height         : Integer64 not null;
        state          : LargeBinary;
        zswapState     : LargeBinary;
        stateHash      : HexEncoded;
        zswapStateHash : HexEncoded;
        contractAction : Association to ContractActions;
}

// The ledger names a UTXO by intent hash and output index.
// One transaction can hold several intents whose outputs all start at 0.
@assert.unique.createdOutput: [
    intentHash,
    outputIndex
]
entity UnshieldedUtxos : cuid, managed {
    owner                       : UnshieldedAddr not null;
    tokenType                   : HexEncoded not null;
    value                       : BigInt not null;
    intentHash                  : HexEncoded not null;
    outputIndex                 : Integer not null;
    ctime                       : Integer; // UNIX seconds; creation time
    initialNonce                : HexEncoded not null;
    registeredForDustGeneration : Boolean default false;

    createdAtTransaction        : Association to Transactions not null;
    spentAtTransaction          : Association to Transactions;
}

entity ZswapLedgerEvents : cuid {
    eventId     : Integer not null;
    raw         : LargeBinary;
    maxId       : Integer not null;
    transaction : Association to Transactions not null;
}

entity DustLedgerEvents : cuid {
    eventId         : Integer not null;
    raw             : LargeBinary;
    maxId           : Integer not null;
    eventType       : DustLedgerEventType not null;
    dustOutputNonce : HexEncoded; // null = not INITIAL_UTXO

    transaction     : Association to Transactions not null;
}

/** A user's connected wallet. Every session action checks `userId`. */
@assert.unique.sessionId: [sessionId]
entity WalletSessions : cuid, managed {
    userId              : String(200);
    label               : String(100);
    viewingKeyHash      : String(64);
    encryptedViewingKey : LargeString;
    encryptedSeedKey    : LargeString; // null = viewing only, cannot sign
    accountIndex        : Integer; // null = 0
    sessionId           : UUID not null;
    connectedAt         : Timestamp not null;
    disconnectedAt      : Timestamp;
    expiresAt           : Timestamp;
    isActive            : Boolean default true;
}

/**
 * A bearer token that lets an agent act on one wallet session within limits.
 * Requests with the token run as `userId` and only on `sessionId`.
 * A grant can only narrow what the session may do. Only the token's hash is stored.
 * The allowed contracts, circuits and token types are the platform lists narrowed by the grant.
 */
@assert.unique.tokenHash: [tokenHash]
entity AgentGrants : cuid, managed {
    userId            : String(200) not null;
    agentLabel        : String(100);
    sessionId         : UUID not null;
    tokenHash         : String(64) not null;
    allowedActions    : LargeString not null; // JSON array of strings; action names
    maxJobsPerDay     : Integer; // null = no limit; per UTC day
    jobsUsedToday     : Integer default 0;
    budgetWindow      : String(10); // YYYY-MM-DD; the UTC day jobsUsedToday counts for
    sponsorSessionId  : UUID;
    allowedContracts  : LargeString; // JSON array of strings; null = platform list
    allowedCircuits   : LargeString; // JSON array of strings; null = platform list
    allowDeploy       : Boolean default false;
    maxDeploys        : Integer; // default 1 when allowDeploy
    deploysUsed       : Integer default 0;
    deployedContracts : LargeString; // JSON array of strings; always allowed
    allowedTokenTypes : LargeString; // JSON array of strings; null = platform list
    mintedTokenTypes  : LargeString; // JSON array of strings; always allowed
    validUntil        : Timestamp; // null = no expiry
    isActive          : Boolean default true;
    revokedAt         : Timestamp;
}

/**
 * Swap offers posted for others to take. A row only advertises the offer.
 * The tokens move when someone completes the swap on chain.
 */
entity SwapOffers : cuid, managed {
    offer         : LargeString not null; // offer file or base64
    givesType     : HexEncoded not null;
    givesAmount   : String(40) not null; // decimal; smallest token unit
    wantsType     : HexEncoded not null;
    wantsAmount   : String(40) not null; // decimal; smallest token unit
    bound         : Boolean not null;
    inputs        : Integer;
    nullifiers    : LargeString not null; // JSON array of strings
    tags          : LargeString; // JSON array of strings
    status        : SwapOfferStatus not null default 'open';
    expiresAt     : Timestamp;
    posterUserId  : String(200) not null;
    posterGrantId : UUID; // null = no agent grant
    sessionId     : UUID;
    filledTxHash  : HexEncoded;
    closedAt      : Timestamp;
}

/**
 * A document text that holders of a shielded token type may read.
 * A reader proves on the holder registry contract `registryAddress` that it holds the token.
 */
entity HolderDisclosureGrants : cuid, managed {
    payloadHash     : HexEncoded not null;
    tokenType       : HexEncoded not null;
    registryAddress : HexEncoded not null;
    grantorUserId   : String(200) not null;
    grantorGrantId  : UUID; // null = no agent grant
    contentType     : String(100);
    contentHashKind : String(20); // 'blake2b-256' or 'sha256'; hash of the text that equals payloadHash
    content         : LargeString; // encrypted with the server key
    expiresAt       : Timestamp;
    active          : Boolean default true;
    revokedAt       : Timestamp;
}

/**
 * Shielded token types minted by sponsored calls on this server.
 * When the platform setting `shareMintedTokenTypes` is on, every grant may use them.
 */
entity LearnedTokenTypes : managed {
    key tokenType        : HexEncoded;
        grantId          : UUID; // null = no agent grant
        sponsorSessionId : String(64);
        txHash           : HexEncoded;
}

/**
 * Contracts registered at runtime, in addition to those in the config.
 * A name from the config cannot be registered here.
 */
entity ContractRegistrations : managed {
    key name           : String(100);
        artifactPath   : String(1000) not null; // absolute path inside NIGHTGATE_CONTRACTS_DIR; compiled contract JS module
        zkConfigPath   : String(1000) not null; // absolute path inside NIGHTGATE_CONTRACTS_DIR; folder with keys/ and zkir/
        privateStateId : String(200) not null;
        slotWidth      : Integer; // null = 16
        networkId      : String(30);
        registeredBy   : String(200);
}

/** Progress of the block indexer. Exactly one row. */
entity SyncState {
    key ID                  : String(10) default 'SINGLETON';
        networkId           : String(30);

        lastIndexedHeight   : Integer64 default 0;
        lastIndexedHash     : HexEncoded;
        lastIndexedAt       : Timestamp;

        // Two later passes add data to indexed blocks. Each keeps its own position.
        lastDecodedHeight   : Integer64; // null = never run
        lastSupplementedHeight : Integer64; // null = never run

        lastFinalizedHeight : Integer64 default 0;
        lastFinalizedHash   : HexEncoded;

        nodeUrl             : String(200);
        chainHeight         : Integer64 default 0;

        syncStatus          : SyncStatus default 'stopped';
        reorgGeneration     : Integer64 default 0;
        syncProgress        : Decimal(5, 2) default 0; // percent; lastIndexedHeight of chainHeight
        blocksPerSecond     : Decimal(10, 2) default 0;

        lastError           : String(500);
        lastErrorAt         : Timestamp;
        consecutiveErrors   : Integer default 0;
}

entity ReorgLog : cuid, managed {
    detectedAt       : Timestamp not null;
    forkHeight       : Integer64 not null;
    oldTipHash       : HexEncoded not null;
    newTipHash       : HexEncoded not null;
    blocksRolledBack : Integer default 0;
    blocksReIndexed  : Integer default 0;
    status           : String(20); // 'completed' or 'failed'
}

/**
 * Transactions submitted through this server.
 * `txHash` and, for deploys, `contractAddress` stay null until the SDK returns them.
 */
entity PendingSubmissions : cuid, managed {
    txHash           : HexEncoded;
    contractAddress  : HexEncoded;
    circuitName      : String(100);
    actionType       : ContractActionType not null;
    submittedAt      : Timestamp not null;
    status           : PendingSubmissionStatus not null default 'pending';
    finalizedAt      : Timestamp;
    finalizedTxData  : LargeString; // JSON
    chainBlockHeight : Integer;
    chainBlockHash   : HexEncoded;
    indexerTxHash    : HexEncoded; // the Midnight indexer's hash, differs from txHash
    submitIntentData : LargeString;
    errorCode        : String(50);
    errorMessage     : String(500);
    sessionId        : UUID;
}

/** Work that runs in the background, such as building and submitting a transaction. */
@assert.unique.idempotency: [
    sessionId,
    kind,
    idempotencyKey
]
entity BackgroundJobs : cuid, managed {
    kind                : BackgroundJobKind not null;
    sessionId           : String(64);
    status              : BackgroundJobStatus not null default 'pending';
    idempotencyKey      : String(128); // optional; unique per sessionId and kind
    request             : LargeString; // JSON; secrets removed
    payloadFingerprint  : String(64);
    commandVersion      : Integer; // null = the job cannot be replayed after a restart
    command             : LargeString;
    commandEncoding     : CommandEncoding;
    requestedBy         : String(200);
    grantId             : UUID; // null = no agent grant
    parentJobId         : UUID;
    workflowStep        : String(64);
    result              : LargeString; // JSON
    errorCode           : String(64);
    errorMessage        : LargeString;
    startedAt           : Timestamp;
    queuedAt            : Timestamp;
    externalExecutionAt : Timestamp; // when the job began work that may reach the chain
    submittedAt         : Timestamp;
    finishedAt          : Timestamp;
    attempt             : Integer not null default 0;
    maxAttempts         : Integer not null default 1;
    leaseOwner          : String(200);
    leaseExpiresAt      : Timestamp;
    heartbeatAt         : Timestamp;
    submissionId        : UUID;
    txHash              : HexEncoded;
    chainStatus         : BackgroundJobChainStatus; // null = nothing submitted
    chainFinalizedAt    : Timestamp;
    // Where the transaction landed. A reorg rolls the job back by this height.
    chainBlockHeight    : Integer;
    chainBlockHash      : HexEncoded;
    indexerTxHash       : HexEncoded; // the Midnight indexer's hash, differs from txHash
    chainSegments       : LargeString; // JSON; batches only; which calls of each segment applied
}

entity PrivateStates {
    key accountId       : String(200);
    key contractAddress : String(200);
    key privateStateId  : String(200);
        ciphertext      : LargeString not null;
        keyScheme       : String(16); // 'dek1'; null = key derived from the viewing key
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

entity ContractSigningKeys {
    key accountId       : String(200);
    key contractAddress : String(200);
        ciphertext      : LargeString not null;
        keyScheme       : String(16); // 'dek1'; null = key derived from the viewing key
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

/**
 * The key that encrypts an account's private states, signing keys and wallet state ('dek1').
 * It is stored twice. One copy opens with the server key ring, so the operator can rotate the ring.
 * The other opens with the account's viewing key, so data stays readable after a ring change.
 */
entity AccountKeys {
    key accountId              : String(200);
        wrappedDek             : LargeString not null;
        wrappedDekByViewingKey : LargeString not null;
        createdAt              : Timestamp;
        rotatedAt              : Timestamp;
}

/** Saved wallet state, one row per account. */
entity WalletSyncStates {
    key accountId           : String(200);
        shieldedStateBlob   : LargeString;
        unshieldedStateBlob : LargeString;
        dustStateBlob       : LargeString;
        keyScheme           : String(16); // 'dek1'; null = key derived from the viewing key
        sdkVersion          : String(64) not null;
        networkId           : String(32);
        seedFingerprint     : String(64);
        createdAt           : Timestamp;
        updatedAt           : Timestamp;
}

entity Attestations : cuid, managed {
    attestationId   : HexEncoded not null; // blake2b-256; the payload hash
    contractAddress : HexEncoded not null;
    attester        : HexEncoded not null;
    publicMetadata  : LargeString; // JSON
    payloadCipher   : LargeBinary;
    anchoredTxHash  : HexEncoded;
    anchoredAt      : Timestamp;
}

/**
 * Documents whose hash was written to an attestation contract.
 * Agent tokens see only rows of their own session. Rows with a null `sessionId` are visible to the owner only.
 */
entity Documents : cuid, managed {
    sha256              : HexEncoded not null;
    contentType         : String(100);
    size                : Integer64;
    storageRef          : String(500); // file://, s3:// or ipfs:// URL
    anchoredTxHash      : HexEncoded;
    anchoredAt          : Timestamp;
    // Where the hash was written. verifyDocument checks against these values.
    userId              : String(200);
    contractAddress     : HexEncoded;
    network             : String(30);
    compiledArtifactRef : String(200); // contract name; may later point to a newer build
    artifactDigest      : HexEncoded;
    sessionId           : UUID;
    attesterId          : HexEncoded;
}

/** Zero-knowledge proofs about a document's fields, recorded on chain. */
entity PredicateAttestations : cuid, managed {
    payloadHash         : HexEncoded not null;
    attesterId          : HexEncoded;
    contractAddress     : HexEncoded not null;
    predicate           : String(20) not null; // 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'
    op                  : Integer; // 0 or 1; null = not a numeric predicate
    threshold           : Integer64; // scaled integer for numeric predicates; for documentDiff the minimum number of differing fields
    unit                : String(50);
    fieldKey            : HexEncoded; // null = proof not tied to one field
    expectedDigest      : HexEncoded;
    setRoot             : HexEncoded;
    // Proofs that compare two documents: payloadHash is document A, these name document B.
    payloadHashB        : HexEncoded;
    attesterIdB         : HexEncoded;
    allowedMask         : Integer64; // documentIntegrity only; bit i set = field i may differ
    provenTxHash        : HexEncoded;
    provenAt            : Timestamp;
    network             : String(30);
    compiledArtifactRef : String(200); // contract name; may later point to a newer build
    artifactDigest      : HexEncoded;
}

entity DisclosureRoles : cuid, managed {
    userId     : String(200) not null;
    role       : DisclosureRole not null;
    scope      : String(500); // null = global; contract address or attestation id
    grantedBy  : String(200);
    validFrom  : Timestamp;
    validUntil : Timestamp;
}

/**
 * Who may read an attested document, mirrored from the attestation contract.
 * The contract decides access. `grantDisclosure` inserts a row as inactive.
 * It turns active once the grant shows up in the contract state.
 */
@assert.unique.logicalGrant: [
    contractAddress,
    attesterId,
    payloadHash,
    grantee
]
entity DisclosureGrants : cuid, managed {
    payloadHash     : HexEncoded not null;
    attesterId      : HexEncoded;
    grantee         : HexEncoded not null;
    level           : Integer not null; // 0 public, 1 legitimate interest, 2 authority; confirmed on chain
    pendingLevel    : Integer; // requested level not yet on chain; never grants access
    contractAddress : HexEncoded not null;
    grantedTxHash   : HexEncoded;
    revokedTxHash   : HexEncoded;
    active          : Boolean default false; // granted on chain and not revoked
    changedAtHeight : Integer64; // block of the last applied change; older states never overwrite it
}

/**
 * Links a user to the grantee id the attestation contract checks.
 * A row with a scope wins over a global one.
 */
entity GranteeIdentities : cuid, managed {
    userId      : String(200) not null;
    granteeId   : HexEncoded not null;
    bindingKind : String(20) not null; // 'wallet', 'did' or 'custom'
    scope       : String(500); // null = global; contract address or attestation id
}

/** Unshielded NIGHT balance per address. */
entity NightBalances {
    key address            : String(256);
        balance            : Decimal(20, 0) default 0;
        utxoCount          : Integer default 0;

        firstSeenHeight    : Integer64;
        firstSeenAt        : Timestamp;
        lastActivityHeight : Integer64;
        lastActivityAt     : Timestamp;

        txSentCount        : Integer default 0;
        txReceivedCount    : Integer default 0;
        totalSent          : Decimal(20, 0) default 0;
        totalReceived      : Decimal(20, 0) default 0;

        dustAddress        : DustAddr;
        isDustRegistered   : Boolean default false;

        lastUpdatedHeight  : Integer64;
        lastUpdatedAt      : Timestamp;
}

/**
 * The server instance that runs the background work on this database.
 * It renews the lease while running and releases it on stop.
 */
entity InstanceLeases {
    key role        : String(20);
        instanceId  : String(200);
        acquiredAt  : Timestamp;
        heartbeatAt : Timestamp;
}
