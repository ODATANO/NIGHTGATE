export declare class NightgateApiError extends Error {
    status: number;
    code: string | undefined;
    /** Seconds the server asked to wait, from `Retry-After`; set on 429 and on retryable 503s. */
    retryAfterSeconds: number | undefined;
    /** On a 409 `IDEMPOTENCY_KEY_CONFLICT`: the job that holds the key, sent only to the caller that started it. */
    job?: ConflictingJob;
    /** The key this client made for a write that failed to start, also after its one repeat. Repeat the call with it, so a job the server did start is not started twice. */
    idempotencyKey?: string;
}

/** Server error codes a client may retry unchanged. */
export declare const RETRYABLE_ERROR_CODES: ReadonlySet<string>;

/** Whether a failed call may be retried unchanged. Checks the error code, then the HTTP status, then network errors.
 *  False for a write that got no answer of the server itself and carries `idempotencyKey`: repeat that one with the key. */
export declare function isRetryable(err: unknown): boolean;

export declare class NightgateJobError extends Error {
    job: JobStatus;
}

/** A 64-bit integer for a function URL. Keeps full precision for values above Number.MAX_SAFE_INTEGER. */
export interface Int64Literal { $int64: string; }
export declare function int64(value: string | number | bigint): Int64Literal;

export interface ConnectOptions {
    /** For example https://nightgate.example */
    baseUrl: string;
    /** Defaults to '/odata/v4/midnight'. */
    servicePath?: string;
    /** Defaults to '/odata/v4/midnight-indexer'. getHealth() reads it. */
    indexerServicePath?: string;
    /** Agent token (ngat_...). Sent in the x-agent-token header. */
    agentToken?: string;
    /** Bearer token */
    token?: string;
    username?: string;
    password?: string;
    /** Timeout per request in ms. Defaults to 120000. */
    timeoutMs?: number;
    /** How often waitForJob polls, in ms. Defaults to 2000. */
    pollMs?: number;
    /** How long one getJobStatus call of waitForJob waits on the server, in ms. Defaults to 20000; 0 polls instead. At most 25000 and 5000 below timeoutMs. */
    longPollMs?: number;
    fetchFn?: typeof fetch;
}

/** A job as the server sees it. `succeeded` means the action returned; the chain's verdict is `chainStatus`. */
export type JobState = 'pending' | 'running' | 'external_execution' | 'submitted' | 'reconciliation_required' | 'succeeded' | 'failed';
/** The chain's verdict on a job's transaction. `pending` until the server has seen it in a block or given it up. */
export type JobChainStatus = 'pending' | 'success' | 'failure' | 'dropped';

/** The job that holds an idempotency key. */
export interface ConflictingJob { jobId: string; status: JobState; chainStatus: JobChainStatus | null }

/** The answer of `getJobStatus`. */
export interface JobStatus {
    jobId: string;
    /** The action that started the job. */
    kind: string;
    status: JobState;
    /** What the action returned, as an object; null while the job has no result. */
    result: Record<string, unknown> | null;
    errorCode: string | null;
    errorMessage: string | null;
    attempt: number | null;
    maxAttempts: number | null;
    submissionId: string | null;
    /** A ledger identifier of the job's transaction; null before the build. */
    txId: string | null;
    /** The ledger hash, as explorers show it; null before the send. */
    txHash: string | null;
    /** Null for a job that sends nothing to the chain. */
    chainStatus: JobChainStatus | null;
    chainFinalizedAt: string | null;
    /** The block of the transaction; null until the server has seen it there. */
    blockHeight: number | string | null;
    blockHash: string | null;
    /** Per segment of a batch, whether the chain applied it. Empty for a job that is no batch or not on chain yet. */
    chainSegments: Array<{ segment: number; calls: string[]; applied: boolean }>;
    queuedAt: string | null;
    externalExecutionAt: string | null;
    submittedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** Null until a sponsored swap or transfer succeeded on chain. */
    receipt: Receipt | null;
}

export type Params = Record<string, string | number | bigint | boolean | Int64Literal | undefined>;
export type ActionParams = Record<string, unknown>;
/** The job result, plus the job id. `txId` is a ledger identifier of the transaction, `txHash` the ledger hash explorers show.
 *  The job succeeded, which can be before the chain's verdict: `chainStatus` says how far the chain is. */
export type JobResult = Record<string, unknown> & {
    jobId: string; sessionId?: string; txId: string | null; txHash: string | null;
    chainStatus: JobChainStatus | null; blockHeight: number | string | null; receipt?: Receipt;
};

/** A contract's state as the server serves it. Binary fields are base64. */
export interface ContractStateSnapshot {
    contractAddress: string;
    /** Block of the state. Null when the server knows the state only from its indexer. */
    height: number | null;
    state: string | null;
    zswapState: string | null;
    stateHash: string | null;
    zswapStateHash: string | null;
    source: 'history' | 'current' | 'indexer';
    verified: boolean | null;
    blockHash: string | null;
    /** The parameters in effect at that block. Null when neither the server nor its indexer knows them. */
    ledgerParameters: string | null;
    /** The server's database holds every contract state up to this block. Null for an indexer answer, or while the supplement never ran. */
    coveredHeight: number | null;
    /** The chain tip the server last saw. */
    chainHeight: number | null;
}

/** A block as the server indexed it. */
export interface BlockInfo {
    hash: string;
    height: number;
    protocolVersion: number;
    timestamp: number;
}

/** Where a transaction landed. */
export interface TransactionInclusion {
    txId: string;
    extrinsicHash: string;
    txHash: string | null;
    blockHeight: number;
    blockHash: string;
    /** SUCCESS, PARTIAL_SUCCESS or FAILURE. Null until the server has the result. */
    status: string | null;
    failedSegments: number[];
}

/** The transaction that deployed a contract. */
export interface ContractDeployInfo {
    extrinsicHash: string;
    txHash: string | null;
    blockHeight: number;
    blockHash: string;
    blockTimestamp: number;
    protocolVersion: number;
    status: string | null;
    failedSegments: number[];
    /** The transaction's ledger identifiers, in order. */
    identifiers: string[];
    /** The identifier of the deploy action, when the server has the list. */
    txId?: string;
}

// answer-types:start
// Written by `npm run client:types` from the server's model. A field or a list item the model does not mark `not null` can be null.

export interface PreparedField {
    field: string | null;
    fieldKey: string | null;
    kind: "uint" | "bytes" | null;
    value: string | null;
    valueDigest: string | null;
    salt: string | null;
    siblings: Array<string | null>;
    dirs: Array<boolean | null>;
}

export interface SchemaSlot {
    fieldKey: string | null;
    kind: number | null;
    scale: string | null;
}

export interface DocumentOpening {
    saltSeed: string | null;
    slots: Array<SlotOpening | null>;
}

export interface SlotOpening {
    present: boolean | null;
    value: string | null;
    valueDigest: string | null;
}

/** The answer of `verifyAttestation`. */
export interface VerifyAttestationAnswer {
    verified: boolean;
    attested: boolean;
    contentRootOk: boolean;
    schemaOk: boolean;
    bindingRegistered: boolean;
    attesterId: string;
    payloadHash: string;
    recordKey: string;
    documentId: string;
    blockHeight: number | string | null;
}

/** The answer of `verifyPredicate`. */
export interface VerifyPredicateAnswer {
    verified: boolean;
    proven: boolean;
    blockHeight: number | string | null;
}

/** The answer of `verifyDisclosure`. */
export interface VerifyDisclosureAnswer {
    verified: boolean;
    granted: boolean;
    level: number | null;
    blockHeight: number | string | null;
}

/** The answer of `verifyPredicateAttestation`. */
export interface VerifyPredicateAttestationAnswer {
    verified: boolean;
    included: boolean;
    stateChecked: boolean;
    contractAddress: string | null;
    attesterId: string | null;
    payloadHash: string | null;
    fieldKey: string | null;
    predicate: "lessOrEqual" | "greaterOrEqual" | "bytesEquality" | "setMembership" | "documentIntegrity" | "documentDiff" | null;
    threshold: string | null;
    unit: string | null;
    expectedDigest: string | null;
    setRoot: string | null;
    attesterIdB: string | null;
    payloadHashB: string | null;
    allowedMask: number | string | null;
    k: number | null;
    provenTxHash: string | null;
    provenAt: string | null;
}

/** The answer of `verifyDocument`. */
export interface VerifyDocumentAnswer {
    verified: boolean;
    included: boolean;
    stateChecked: boolean;
    anchoredTxHash: string;
    anchoredAt: string | null;
    payloadHash: string;
}

/** The answer of `deriveTokenType`. */
export interface DeriveTokenTypeAnswer {
    tokenType: string;
    contractAddress: string;
    domainSeparator: string;
}

/** The answer of `prepareDocumentProof`. */
export interface PrepareDocumentProofAnswer {
    payloadHash: string;
    canonicalDocument: string;
    contentRoot: string;
    fields: Array<PreparedField>;
    emptyFields: Array<string>;
    schemaId: string;
    schema: Array<SchemaSlot>;
    leaves: Array<string | null>;
    opening: DocumentOpening;
}

/** The answer of `prepareMembershipSet`. */
export interface PrepareMembershipSetAnswer {
    setRoot: string;
    memberCount: number;
    setSiblings: Array<string | null>;
    setDirs: Array<boolean>;
}

/** The answer of `connectWallet`. */
export interface ConnectWalletAnswer {
    sessionId: string;
    label: string | null;
    connectedAt: string;
    expiresAt: string;
    isActive: boolean;
}

/** The answer of `connectWalletForSigning`. */
export interface ConnectWalletForSigningAnswer {
    sessionId: string;
    signingEnabled: boolean;
    jobId: string | null;
    status: "pending" | "running" | "external_execution" | "submitted" | "reconciliation_required" | "succeeded" | "failed" | null;
}

/** The answer of `disconnectWallet`. */
export interface DisconnectWalletAnswer {
    sessionId: string;
    isActive: boolean;
}

/** The answer of `deriveWalletInfo`. */
export interface DeriveWalletInfoAnswer {
    viewingKey: string;
    shieldedAddress: string;
    nightAddress: string;
    dustAddress: string;
    attesterId: string;
    accountIndex: number;
    network: "preview" | "preprod" | "mainnet" | "stagenet" | "undeployed";
}

/** The answer of `getWalletBalance`. */
export interface GetWalletBalanceAnswer {
    shieldedNight: string;
    unshieldedNight: string;
    shieldedTokens: Array<{ tokenType: string; amount: string; }>;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
    dustUtxoCount: number;
    dustPendingCount: number;
    dustPendingValue: string;
    dustRestoreCount: number;
}

/** The answer of `getWalletSyncProgress`. */
export interface GetWalletSyncProgressAnswer {
    known: boolean;
    caughtUp: boolean;
    appliedIndex: string | null;
    streamTip: string | null;
    behindEvents: string | null;
    eventsPerSecond: number | string | null;
    etaSeconds: number | null;
    blockHeight: number | string | null;
    isConnected: boolean | null;
    indexerFresh: boolean | null;
    indexerTipAgeSeconds: number | null;
    indexerError: string | null;
    elapsedMs: number | null;
    phase: string | null;
    updatedAt: string | null;
    lastProgressAt: string | null;
    staleSeconds: number | null;
    stale: boolean | null;
    jobId: string | null;
    jobStatus: string | null;
    restoredFromSnapshot: boolean | null;
    snapshotSavedAt: string | null;
    facadeBuildStartedAt: string | null;
    facadeBuiltAt: string | null;
}

/** The answer of `getHealth`. */
export interface GetHealthAnswer {
    status: string | null;
    chainHeight: number | string | null;
    indexedHeight: number | string | null;
    finalizedHeight: number | string | null;
    lag: number | string | null;
    finalizedLag: number | string | null;
    blocksPerSecond: number | string | null;
    syncStatus: string | null;
    instanceId: string | null;
    runtimeMode: string | null;
    replicaCount: number | null;
    databaseKind: string | null;
    topologyValid: boolean | null;
    runtimeWarnings: Array<string | null>;
}
// answer-types:end

/** What a table read asks for. `filter` and `orderby` are OData expressions over the table's fields, such as `blockHeight eq 5`. */
export interface ReadQuery {
    filter?: string;
    orderby?: string;
    /** Rows to return. The server hands out at most its page size, 1000 rows by default. */
    top?: number;
    skip?: number;
    /** The fields to return; default all. */
    select?: string | string[];
    /** The service that has the table; default `main`. */
    service?: 'main' | 'indexer';
}

export interface NightgateClient {
    /** GET <service>/<name>(p1=...,p2=...). `T` is the answer you expect; without it the answer is `unknown`. */
    callFunction<T = unknown>(name: string, params?: Params): Promise<T>;
    /** POST <service>/<name>. `T` is the answer you expect; without it the answer is `unknown`. */
    callAction<T = unknown>(name: string, params?: ActionParams): Promise<T>;
    /** Polls getJobStatus until the job ends. Temporary poll errors are retried until they last longer than pollGraceMs, default 5 minutes. */
    waitForJob(input: { jobId: string; sessionId?: string; pollMs?: number; timeoutMs?: number; pollGraceMs?: number }): Promise<JobResult>;
    /**
     * Waits until the chain confirmed a sponsored swap or transfer and returns its receipt. Throws when the job fails or can have none.
     * Holds one call on the server where it can. Otherwise it polls from `pollMs`, default 10000, doubling up to 60000. `timeoutMs` defaults to 10 minutes.
     */
    waitForReceipt(input: { jobId: string; sessionId?: string; pollMs?: number; timeoutMs?: number; pollGraceMs?: number }): Promise<Receipt>;

    /**
     * One page of a table's rows, such as `read('Transactions', { filter: 'blockHeight eq 5', orderby: 'indexInBlock' })`.
     * A read returns at most the server's page size: page with `skip` until a read is empty. `T` is the row you expect.
     */
    read<T = Record<string, unknown>>(entity: string, query?: ReadQuery): Promise<T[]>;

    // chain reads a transaction builder needs
    /** The contract's state at `height`, or its newest one. Null when the server knows no state. */
    contractStateAt(input: { contractAddress: string; height?: number | null }): Promise<ContractStateSnapshot | null>;
    /** The block at `height`, or the newest one. Null while the server has not indexed it. */
    blockAt(height?: number | null): Promise<BlockInfo | null>;
    /** Null while the server has not indexed the transaction. */
    transactionByTxId(txId: string): Promise<TransactionInclusion | null>;
    /** Null while the server has not indexed the deploy. */
    contractDeploy(contractAddress: string): Promise<ContractDeployInfo | null>;
    /** The serialized ledger transaction as base64, or null while the server has not indexed it. */
    ledgerTransaction(hash: string): Promise<string | null>;

    // checks that read the chain directly
    verifyAttestation(p: Params): Promise<VerifyAttestationAnswer>;
    verifyPredicate(p: Params): Promise<VerifyPredicateAnswer>;
    /** The disclosure level an attester granted a grantee on a payload hash. `level` is null without a grant. */
    verifyDisclosure(p: Params): Promise<VerifyDisclosureAnswer>;
    verifyPredicateAttestation(p: Params): Promise<VerifyPredicateAttestationAnswer>;
    verifyDocument(p: Params): Promise<VerifyDocumentAnswer>;
    deriveTokenType(p: Params): Promise<DeriveTokenTypeAnswer>;
    getHealth(): Promise<GetHealthAnswer>;

    // input preparation, no transaction
    prepareDocumentProof(p: ActionParams): Promise<PrepareDocumentProofAnswer>;
    prepareMembershipSet(p: ActionParams): Promise<PrepareMembershipSetAnswer>;

    // wallet sessions
    connectWallet(p: ActionParams): Promise<ConnectWalletAnswer>;
    connectWalletForSigning(p: ActionParams): Promise<ConnectWalletForSigningAnswer>;
    disconnectWallet(p: ActionParams): Promise<DisconnectWalletAnswer>;
    deriveWalletInfo(p: ActionParams): Promise<DeriveWalletInfoAnswer>;
    getWalletBalance(p: Params): Promise<GetWalletBalanceAnswer>;
    getWalletSyncProgress(p: Params): Promise<GetWalletSyncProgressAnswer>;

    // documents and zero-knowledge proofs. Each submits a job, waits, and returns its result.
    anchorDocument(p: ActionParams): Promise<JobResult>;
    attestAgentOutput(p: ActionParams): Promise<JobResult>;
    proveFieldPredicate(p: ActionParams): Promise<JobResult>;
    proveFieldEquality(p: ActionParams): Promise<JobResult>;
    proveFieldMembership(p: ActionParams): Promise<JobResult>;
    proveClaims(p: ActionParams): Promise<JobResult>;
    proveDocumentIntegrity(p: ActionParams): Promise<JobResult>;
    proveDocumentDiff(p: ActionParams): Promise<JobResult>;

    // disclosure
    grantDisclosure(p: ActionParams): Promise<JobResult>;
    revokeDisclosure(p: ActionParams): Promise<JobResult>;
    /**
     * Takes `documentId`, `ownerId` and `mode`.
     * Modes: 0 register, 1 unregister, 2 transfer the registrar, 3 recovery sets the registrar, 4 recovery sets the recovery key.
     */
    registerDocument(p: ActionParams): Promise<JobResult>;
    retractAttestation(p: ActionParams): Promise<JobResult>;
    purgeExpired(p: ActionParams): Promise<JobResult>;

    // contracts + tokens
    deployContract(p: ActionParams): Promise<JobResult>;
    submitContractCall(p: ActionParams): Promise<JobResult>;
    submitContractCallBatch(p: ActionParams): Promise<JobResult>;
    /** Mints a named token on a token factory. Takes `name`, `amount`, `receiverCoinPublicKey`, optionally `contractAddress` and `sessionId`. */
    mintFactoryToken(p: ActionParams): Promise<JobResult>;
    /** Burns `amount` of a factory token the session holds. Takes `name`, `amount`, `sessionId`, optionally `contractAddress` and `issuerKey`. */
    burnFactoryToken(p: ActionParams): Promise<JobResult>;
    sendToken(p: ActionParams): Promise<JobResult>;

    // the server pays the fee for a transaction built elsewhere
    sponsorFinalized(p: ActionParams): Promise<JobResult>;
    sponsorUnbound(p: ActionParams): Promise<JobResult>;
    /**
     * Takes `makerHalfB64`, `takerHalfB64` and optionally `idempotencyKey`; with `offerId` the maker half comes from the board.
     * Each half is either offer file text (`swapoffer1...`) or base64.
     */
    sponsorSwap(p: ActionParams): Promise<JobResult>;
    /** Takes `transferTxB64`, `tokenType`, `amount` and optionally `idempotencyKey`. The transfer comes from `buildTransfer` of the swap wallet or the unshielded wallet. */
    sponsorTransfer(p: ActionParams): Promise<JobResult>;
    buildSponsorable(p: ActionParams): Promise<JobResult>;

    // public reads of the indexer service
    getBoardStatus(): Promise<BoardStatus>;
    getReceiptKey(): Promise<ReceiptKey>;
}

/** Counts of the offer board and the sponsor pool. */
export interface BoardStatus {
    openOffers: number;
    offersFilledToday: number;
    swapsToday: number;
    sponsorsConfigured: number;
    sponsorsReady: number;
    /** The token factory a mint without `contractAddress` uses; null when the instance sets none. */
    factoryContract: string | null;
    /** The running NIGHTGATE version. */
    version: string;
    asOf: string;
}

/** The key an instance signs job receipts with. */
export interface ReceiptKey { publicKey: string; algorithm: string }

/** A signed statement of the instance about a landed sponsored swap or transfer, as `getJobStatus` returns it. */
export interface Receipt {
    /** Canonical JSON, the signed bytes. */
    payload: string;
    /** Hex, Ed25519 over the UTF-8 payload. */
    signature: string;
    /** Hex, the instance's receipt key. */
    publicKey: string;
    algorithm: string;
}

/** Checks a receipt. Pass the key from `getReceiptKey()` so the receipt cannot vouch for itself. */
export declare function verifyReceipt(receipt: Receipt, publicKeyHex?: string): boolean;

export declare function connect(opts: ConnectOptions): NightgateClient;
