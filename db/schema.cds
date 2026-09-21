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
    DisclosureRole
} from './types.cds';

@assert.unique.hash: [hash]
entity Blocks : cuid, managed {
    hash             : HexEncoded not null;
    height           : Integer64 not null;
    protocolVersion  : Integer not null;
    timestamp        : Integer not null; // UNIX timestamp
    author           : HexEncoded;
    stateRoot        : HexEncoded; // substrate header state root
    // The ledger's parameters, which decide fee pricing. Not in the block the
    // node serves, so the indexer supplement fills it, and only when they
    // CHANGED: null means "as at the last lower block that carries them".
    // They are 724 bytes and hold for thousands of blocks at a time.
    ledgerParameters : LargeBinary;

    parent           : Association to Blocks;
    transactions     : Composition of many Transactions
                           on transactions.block = $self;
}

// The extrinsic hash is not unique across blocks; the in-block position is.
@assert.unique.blockPosition: [
    block,
    transactionId
]
entity Transactions : cuid, managed {
    transactionId            : Integer not null; // index within block
    hash                     : HexEncoded not null; // blake2b of the extrinsic bytes
    // Hash of the ledger transaction the extrinsic carries, from the pallet's
    // own report. What an explorer and the Midnight indexer key a tx by.
    ledgerTxHash             : HexEncoded;
    protocolVersion          : Integer not null;
    raw                      : LargeBinary; // serialized transaction
    transactionType          : TransactionType not null;

    // regular transactions only
    merkleTreeRoot           : HexEncoded;
    startIndex               : Integer64; // zswap state start index
    endIndex                 : Integer64; // zswap state end index
    identifiers              : LargeString; // JSON array of HexEncoded identifiers

    // crawler classification
    txType                   : TxType;
    isShielded               : Boolean default false;
    senderAddress            : String(256); // unshielded txs only
    receiverAddress          : String(256); // unshielded txs only
    nightAmount              : BigInt;
    dustConsumed             : BigInt; // DUST the transaction's spends declare
    hasProof                 : Boolean default false;
    proofHash                : HexEncoded;
    contractAddress          : HexEncoded;
    circuitName              : String(100); // contract calls only
    size                     : Integer; // bytes

    // From the serialized ledger transaction, filled by the decoder pass.
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
    outcomeSource : String(40); // 'substrate-system-events'; null = unverified
    transaction   : Association to Transactions;
    segments      : Composition of many TransactionSegments
                        on segments.transactionResult = $self;
}

/** Per-segment outcome (partial success). */
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
    // Position within the transaction, in the order the pallet reported the
    // actions. Two calls on ONE contract are otherwise indistinguishable, and
    // their circuit names and states would be assigned by chance.
    actionIndex        : Integer;
    address            : HexEncoded; // from the pallet's contract event
    state              : LargeBinary; // not on the block; the indexer supplement fills it
    zswapState         : LargeBinary;
    actionType         : ContractActionType not null;
    entryPoint         : String(256); // CALL only

    transaction        : Association to Transactions not null;
    deploy             : Association to ContractActions; // CALL only: the deployment
    unshieldedBalances : Composition of many ContractBalances
                             on unshieldedBalances.contractAction = $self;
}

entity ContractBalances : cuid {
    tokenType      : HexEncoded not null;
    amount         : BigInt not null; // u128
    contractAction : Association to ContractActions;
}

// The ledger identifies a UTXO by its intent and output number, and one
// transaction can carry several intents whose outputs both start at 0.
@assert.unique.createdOutput: [
    intentHash,
    outputIndex
]
entity UnshieldedUtxos : cuid, managed {
    owner                       : UnshieldedAddr not null;
    tokenType                   : HexEncoded not null;
    value                       : BigInt not null; // u128
    intentHash                  : HexEncoded not null;
    outputIndex                 : Integer not null;
    ctime                       : Integer; // creation time, UNIX seconds
    initialNonce                : HexEncoded not null; // for DUST tracking
    registeredForDustGeneration : Boolean default false;

    createdAtTransaction        : Association to Transactions not null;
    spentAtTransaction          : Association to Transactions;
}

entity ZswapLedgerEvents : cuid {
    eventId     : Integer not null;
    raw         : LargeBinary; // serialized event
    maxId       : Integer not null;
    transaction : Association to Transactions not null;
}

entity DustLedgerEvents : cuid {
    eventId         : Integer not null;
    raw             : LargeBinary; // serialized event
    maxId           : Integer not null;
    eventType       : DustLedgerEventType not null;
    dustOutputNonce : HexEncoded; // 32 bytes; INITIAL_UTXO only

    transaction     : Association to Transactions not null;
}

@assert.unique.sessionId: [sessionId]
entity WalletSessions : cuid, managed {
    userId              : String(200); // owning principal (req.user.id); gates all session actions
    label               : String(100);
    viewingKeyHash      : String(64); // SHA-256, for lookup/dedup
    encryptedViewingKey : LargeString; // AES-256-GCM
    encryptedSeedKey    : LargeString; // AES-256-GCM; null for viewing-only sessions
    accountIndex        : Integer; // BIP32 account the seed signs with; null = 0
    sessionId           : UUID not null;
    connectedAt         : Timestamp not null;
    disconnectedAt      : Timestamp;
    expiresAt           : Timestamp;
    isActive            : Boolean default true;
}

/**
 * Scoped, revocable, budgeted bearer token over one wallet session. Only the
 * token's SHA-256 is stored. A grant only restricts the session's authority.
 */
@assert.unique.tokenHash: [tokenHash]
entity AgentGrants : cuid, managed {
    userId            : String(200) not null; // operator; the effective req.user for token requests
    agentLabel        : String(100);
    sessionId         : UUID not null; // session every token request is bound to
    tokenHash         : String(64) not null; // SHA-256 of the bearer token
    allowedActions    : LargeString not null; // JSON array of write-action names
    maxJobsPerDay     : Integer; // null = unlimited; per UTC day
    jobsUsedToday     : Integer default 0; // within budgetWindow
    budgetWindow      : String(10); // UTC day 'YYYY-MM-DD'
    sponsorSessionId  : UUID; // fixed fee sponsor; requests cannot override it
    allowedContracts  : LargeString; // JSON array; effective = floor ∩ grant; null = platform floor
    allowedCircuits   : LargeString; // JSON array, same rule
    allowDeploy       : Boolean default false; // sponsor may pay for a caller-built deploy
    maxDeploys        : Integer; // lifetime deploy budget; default 1 when allowDeploy
    deploysUsed       : Integer default 0; // reserved before broadcast; refunded only on rejection
    deployedContracts : LargeString; // JSON array of addresses deployed under this grant; sponsorable beyond floor ∩ grant
    allowedTokenTypes : LargeString; // JSON array of raw shielded token types the sponsor pays offers for; null = platform floor
    validUntil        : Timestamp; // null = no expiry
    isActive          : Boolean default true;
    revokedAt         : Timestamp;
}

/**
 * Runtime contract registrations on top of the config floor; never shadow a
 * config name. Absolute paths inside NIGHTGATE_CONTRACTS_DIR.
 */
entity ContractRegistrations : managed {
    key name           : String(100);
        artifactPath   : String(1000) not null; // Compact-emitted JS module
        zkConfigPath   : String(1000) not null; // holds keys/ and zkir/
        privateStateId : String(200) not null;
        slotWidth      : Integer; // content-tree width; null = 16
        networkId      : String(30); // informational
        registeredBy   : String(200); // admin principal
}

/** Crawler progress, single row. */
entity SyncState {
    key ID                  : String(10) default 'SINGLETON';
        networkId           : String(30);

        lastIndexedHeight   : Integer64 default 0;
        lastIndexedHash     : HexEncoded;
        lastIndexedAt       : Timestamp;

        // Cursors of the two passes that trail the indexed tip. Null = never run.
        lastDecodedHeight   : Integer64;
        lastSupplementedHeight : Integer64;

        lastFinalizedHeight : Integer64 default 0;
        lastFinalizedHash   : HexEncoded;

        nodeUrl             : String(200);
        chainHeight         : Integer64 default 0;

        syncStatus          : SyncStatus default 'stopped';
        reorgGeneration     : Integer64 default 0;
        syncProgress        : Decimal(5, 2) default 0;
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
    status           : String(20); // 'completed', 'failed'
}

/** Transactions submitted through this server. */
entity PendingSubmissions : cuid, managed {
    txHash           : HexEncoded; // null until the SDK returns
    contractAddress  : HexEncoded; // deploys: null until the SDK returns
    circuitName      : String(100); // null for deploys
    actionType       : ContractActionType not null;
    submittedAt      : Timestamp not null;
    status           : PendingSubmissionStatus default 'pending';
    finalizedAt      : Timestamp;
    finalizedTxData  : LargeString; // JSON snapshot of the confirmed inclusion
    chainBlockHeight : Integer;
    chainBlockHash   : HexEncoded;
    indexerTxHash    : HexEncoded; // indexer's hash, distinct from txHash (ledger identifier)
    submitIntentData : LargeString;
    errorCode        : String(50); // e.g. '1016', 'TIMEOUT', 'TxFailed'
    errorMessage     : String(500);
    sessionId        : UUID;
}

@assert.unique.idempotency: [
    sessionId,
    kind,
    idempotencyKey
]
entity BackgroundJobs : cuid, managed {
    kind                : BackgroundJobKind not null;
    sessionId           : String(64); // owner scope
    status              : BackgroundJobStatus default 'pending';
    idempotencyKey      : String(128); // optional, unique per (sessionId, kind)
    request             : LargeString; // JSON args, secrets redacted
    payloadFingerprint  : String(64); // SHA-256 of kind/session/request; rejects key reuse with a different payload
    commandVersion      : Integer; // set only for commands replayable after restart
    command             : LargeString; // executable payload; never holds seed material
    commandEncoding     : String(20); // json-v1 | aes-gcm-v1
    requestedBy         : String(200); // principal at admission
    grantId             : UUID; // agent grant, inherited by child jobs; null otherwise
    parentJobId         : UUID; // null for root jobs
    workflowStep        : String(64); // child step name
    result              : LargeString; // JSON return value
    errorCode           : String(64);
    errorMessage        : LargeString; // user-facing
    startedAt           : Timestamp;
    queuedAt            : Timestamp;
    externalExecutionAt : Timestamp; // entered a proof/broadcast SDK call
    submittedAt         : Timestamp; // txHash known
    finishedAt          : Timestamp;
    attempt             : Integer default 0;
    maxAttempts         : Integer default 1; // on-chain work is never retried blindly
    leaseOwner          : String(200);
    leaseExpiresAt      : Timestamp;
    heartbeatAt         : Timestamp;
    submissionId        : UUID; // PendingSubmissions.ID
    txHash              : HexEncoded;
    chainStatus         : String(20); // pending | success | failure; null = none yet or n/a
    chainFinalizedAt    : Timestamp;
    // Inclusion coordinates, null until confirmed; reorg rollback reverts by height.
    chainBlockHeight    : Integer;
    chainBlockHash      : HexEncoded;
    indexerTxHash       : HexEncoded;
}

entity PrivateStates {
    key accountId       : String(200);
    key contractAddress : String(200);
    key privateStateId  : String(200);
        ciphertext      : LargeString not null;
        keyScheme       : String(16); // 'dek1' = under the account DEK; null = legacy viewing-key derivation
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

entity ContractSigningKeys {
    key accountId       : String(200);
    key contractAddress : String(200);
        ciphertext      : LargeString not null;
        keyScheme       : String(16); // see PrivateStates.keyScheme
        createdAt       : Timestamp;
        updatedAt       : Timestamp;
}

/**
 * Per-account data-encryption key for private states, signing keys and sync
 * blobs. Sealed twice: under the key ring (operator can rewrap) and under the
 * viewing-key storage password (opens after a ring rotation).
 */
entity AccountKeys {
    key accountId              : String(200);
        wrappedDek             : LargeString not null; // under the ring; key id in the prefix
        wrappedDekByViewingKey : LargeString not null; // AES-GCM under HKDF(storage password)
        createdAt              : Timestamp;
        rotatedAt              : Timestamp;
}

/** Persisted wallet sub-states, one row per account. */
entity WalletSyncStates {
    key accountId           : String(200);
        shieldedStateBlob   : LargeString;
        unshieldedStateBlob : LargeString;
        dustStateBlob       : LargeString;
        keyScheme           : String(16); // see PrivateStates.keyScheme
        sdkVersion          : String(64) not null;
        networkId           : String(32);
        seedFingerprint     : String(64);
        createdAt           : Timestamp;
        updatedAt           : Timestamp;
}

entity Attestations : cuid, managed {
    attestationId   : HexEncoded not null; // payload hash (blake2b-256)
    contractAddress : HexEncoded not null; // vault deployment
    attester        : HexEncoded not null; // attester pubkey
    publicMetadata  : LargeString; // JSON
    payloadCipher   : LargeBinary; // optional encrypted off-chain payload
    anchoredTxHash  : HexEncoded;
    anchoredAt      : Timestamp;
}

entity Documents : cuid, managed {
    sha256              : HexEncoded not null;
    contentType         : String(100);
    size                : Integer64;
    storageRef          : String(500); // file:// | s3:// | ipfs://
    anchoredTxHash      : HexEncoded;
    anchoredAt          : Timestamp;
    // Recorded anchoring context; verifyDocument checks against it, and only
    // rows without it take the caller's contractAddress.
    userId              : String(200); // req.user.id at anchor time; scopes reads
    contractAddress     : HexEncoded; // vault the anchor was submitted to
    network             : String(30);
    compiledArtifactRef : String(200); // artifact alias (mutable)
    artifactDigest      : HexEncoded; // sha256 of the artifact generation
    sessionId           : UUID; // agent tokens read only their session's rows; null = owner-only
    attesterId          : HexEncoded; // with sha256 names the on-chain record
}

entity PredicateAttestations : cuid, managed {
    payloadHash         : HexEncoded not null;
    attesterId          : HexEncoded; // attester whose record of payloadHash the claim is bound to
    contractAddress     : HexEncoded not null; // vault deployment
    predicate           : String(20) not null; // 'lessOrEqual' | 'greaterOrEqual' | 'bytesEquality' | 'setMembership' | 'documentIntegrity' | 'documentDiff'
    op                  : Integer; // 0 | 1 for numeric predicates; null otherwise
    threshold           : Integer64; // numeric: scaled integer; documentDiff: minimum differing slots k
    unit                : String(50); // informational, e.g. 'kgCO2e/kWh'
    fieldKey            : HexEncoded; // field-bound proofs only
    expectedDigest      : HexEncoded; // bytesEquality
    setRoot             : HexEncoded; // setMembership: canonical set root
    payloadHashB        : HexEncoded; // cross-root kinds: document B (payloadHash is A)
    attesterIdB         : HexEncoded; // cross-root kinds: document B's attester
    allowedMask         : Integer64; // documentIntegrity: bit i = slot i may differ; 64-bit so bit 31 fits
    provenTxHash        : HexEncoded;
    provenAt            : Timestamp;
    network             : String(30);
    compiledArtifactRef : String(200); // artifact alias (mutable)
    artifactDigest      : HexEncoded; // sha256 of the artifact generation
}

entity DisclosureRoles : cuid, managed {
    userId     : String(200) not null; // req.user.id
    role       : DisclosureRole not null;
    scope      : String(500); // optional contract address or attestation id
    grantedBy  : String(200);
    validFrom  : Timestamp;
    validUntil : Timestamp;
}

/**
 * Chain-derived disclosure grants from the vault `disclosures` map (the
 * contract is the ACL). Inserted inactive by `grantDisclosure`, activated
 * once the grant appears in ledger state.
 */
@assert.unique.logicalGrant: [
    contractAddress,
    attesterId,
    payloadHash,
    grantee
]
entity DisclosureGrants : cuid, managed {
    payloadHash     : HexEncoded not null;
    attesterId      : HexEncoded; // attester whose record of payloadHash carries the grant
    grantee         : HexEncoded not null; // Bytes<32> grantee id
    level           : Integer not null; // 0 public | 1 legitimate interest | 2 authority; chain-confirmed
    pendingLevel    : Integer; // requested level awaiting confirmation; never used for access
    contractAddress : HexEncoded not null; // vault deployment
    grantedTxHash   : HexEncoded;
    revokedTxHash   : HexEncoded;
    active          : Boolean default false; // chain-confirmed granted and not revoked
    changedAtHeight : Integer64; // height of the last applied change; older snapshots never overwrite
}

/**
 * Maps a principal to the Bytes<32> grantee id the vault checks, to match
 * on-chain DisclosureGrants. A scoped row wins over a global one.
 */
entity GranteeIdentities : cuid, managed {
    userId      : String(200) not null; // req.user.id
    granteeId   : HexEncoded not null; // 64 hex
    bindingKind : String(20) not null; // 'wallet' | 'did' | 'custom'
    scope       : String(500); // optional contract address or attestation id; null = global
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
