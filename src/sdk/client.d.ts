export declare class NightgateApiError extends Error {
    status: number;
    code: string | undefined;
}

/** Server error codes a client may retry unchanged. */
export declare const RETRYABLE_ERROR_CODES: ReadonlySet<string>;

/** Whether a failed call may be retried unchanged. Checks the error code, then the HTTP status, then network errors. */
export declare function isRetryable(err: unknown): boolean;

export declare class NightgateJobError extends Error {
    job: JobStatus & { jobId: string };
}

/** A 64-bit integer for a function URL. Keeps full precision for values above Number.MAX_SAFE_INTEGER. */
export interface Int64Literal { $int64: string; }
export declare function int64(value: string | number | bigint): Int64Literal;

export interface ConnectOptions {
    /** For example https://nightgate.example */
    baseUrl: string;
    /** Defaults to '/api/v1/nightgate'. */
    servicePath?: string;
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
    fetchFn?: typeof fetch;
}

export interface JobStatus {
    status: string;
    result?: string;
    errorCode?: string;
    errorMessage?: string;
    txHash?: string;
}

export type Params = Record<string, string | number | bigint | boolean | Int64Literal | undefined>;
export type ActionParams = Record<string, unknown>;
/** The parsed job result, plus the job id and the transaction hash. */
export type JobResult = Record<string, unknown> & { jobId: string; txHash?: string };

/** A contract's state as the server serves it. Binary fields are base64. */
export interface ContractStateSnapshot {
    address: string;
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

/** Where a transaction landed. */
export interface TransactionInclusion {
    identifier: string;
    hash: string;
    ledgerTxHash: string | null;
    blockHeight: number;
    blockHash: string;
    /** SUCCESS, PARTIAL_SUCCESS or FAILURE. Null until the server has the result. */
    status: string | null;
    failedSegments: number[];
}

/** The transaction that deployed a contract. */
export interface ContractDeployInfo {
    txHash: string;
    ledgerTxHash: string | null;
    blockHeight: number;
    blockHash: string;
    status: string | null;
    failedSegments: number[];
    /** The transaction's ledger identifiers, in order. */
    identifiers: string[];
    /** The identifier of the deploy action, when the server has the list. */
    txId?: string;
}

export interface NightgateClient {
    /** GET <service>/<name>(p1=...,p2=...) */
    callFunction(name: string, params?: Params): Promise<any>;
    /** POST <service>/<name> */
    callAction(name: string, params?: ActionParams): Promise<any>;
    /** Polls getJobStatus until the job ends. Temporary poll errors are retried until they last longer than pollGraceMs, default 5 minutes. */
    waitForJob(input: { jobId: string; sessionId?: string; pollMs?: number; timeoutMs?: number; pollGraceMs?: number }): Promise<JobResult>;

    // chain reads a transaction builder needs
    /** The contract's state at `height`, or its newest one. Null when the server knows no state. */
    contractStateAt(input: { address: string; height?: number | null }): Promise<ContractStateSnapshot | null>;
    /** Null while the server has not indexed the transaction. */
    transactionByIdentifier(identifier: string): Promise<TransactionInclusion | null>;
    /** Null while the server has not indexed the deploy. */
    contractDeploy(address: string): Promise<ContractDeployInfo | null>;

    // checks that read the chain directly
    verifyAttestation(p: Params): Promise<any>;
    verifyPredicate(p: Params): Promise<any>;
    verifyPredicateAttestation(p: Params): Promise<any>;
    verifyDocument(p: Params): Promise<any>;
    deriveTokenType(p: Params): Promise<any>;
    getHealth(): Promise<any>;

    // input preparation, no transaction
    prepareDocumentProof(p: ActionParams): Promise<any>;
    prepareMembershipSet(p: ActionParams): Promise<any>;

    // wallet sessions
    connectWallet(p: ActionParams): Promise<any>;
    connectWalletForSigning(p: ActionParams): Promise<any>;
    disconnectWallet(p: ActionParams): Promise<any>;
    deriveWalletInfo(p: ActionParams): Promise<any>;
    getWalletBalance(p: Params): Promise<any>;
    getWalletSyncProgress(p: Params): Promise<any>;

    // documents and zero-knowledge proofs. Each submits a job, waits, and returns its result.
    anchorDocument(p: ActionParams): Promise<JobResult>;
    attestAgentOutput(p: ActionParams): Promise<JobResult>;
    proveFieldPredicate(p: ActionParams): Promise<JobResult>;
    proveFieldEquality(p: ActionParams): Promise<JobResult>;
    proveFieldMembership(p: ActionParams): Promise<JobResult>;
    proveFieldPredicatesBatch(p: ActionParams): Promise<JobResult>;
    proveDocumentIntegrity(p: ActionParams): Promise<JobResult>;
    proveDocumentDiff(p: ActionParams): Promise<JobResult>;

    // disclosure
    grantDisclosure(p: ActionParams): Promise<JobResult>;
    revokeDisclosure(p: ActionParams): Promise<JobResult>;
    registerPassport(p: ActionParams): Promise<JobResult>;
    /**
     * Same action as registerPassport. Takes `documentId` and `mode`.
     * Modes: 0 register, 1 unregister, 2 transfer the registrar, 3 recovery sets the registrar, 4 recovery sets the recovery key.
     */
    registerDocument(p: ActionParams): Promise<JobResult>;
    retractAttestation(p: ActionParams): Promise<JobResult>;
    purgeExpired(p: ActionParams): Promise<JobResult>;

    // contracts + tokens
    deployContract(p: ActionParams): Promise<JobResult>;
    submitContractCall(p: ActionParams): Promise<JobResult>;
    submitContractCallBatch(p: ActionParams): Promise<JobResult>;
    mintShieldedTestToken(p: ActionParams): Promise<JobResult>;
    sendNight(p: ActionParams): Promise<JobResult>;

    // the server pays the fee for a transaction built elsewhere
    sponsorFinalized(p: ActionParams): Promise<JobResult>;
    sponsorUnbound(p: ActionParams): Promise<JobResult>;
    /**
     * Takes `makerHalfB64`, `takerHalfB64` and optionally `idempotencyKey`.
     * Each half is either offer file text (`swapoffer1...`) or base64.
     */
    sponsorSwap(p: ActionParams): Promise<JobResult>;
    buildSponsorable(p: ActionParams): Promise<JobResult>;
}

export declare function connect(opts: ConnectOptions): NightgateClient;
