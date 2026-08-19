// Types for the NIGHTGATE client SDK. See client.mjs.

export declare class NightgateApiError extends Error {
    status: number;
    code: string | undefined;
}

export declare class NightgateJobError extends Error {
    job: JobStatus & { jobId: string };
}

/** OData Int64 URL literal, precision-safe beyond Number.MAX_SAFE_INTEGER. */
export interface Int64Literal { $int64: string; }
export declare function int64(value: string | number | bigint): Int64Literal;

export interface ConnectOptions {
    /** e.g. https://nightgate.example */
    baseUrl: string;
    /** default '/api/v1/nightgate' */
    servicePath?: string;
    /** agent-grant token (ngat_...), sent as x-agent-token */
    agentToken?: string;
    /** Bearer token */
    token?: string;
    username?: string;
    password?: string;
    /** per-request timeout, default 120000 */
    timeoutMs?: number;
    /** waitForJob poll interval, default 2000 */
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
/** Job result parsed from JSON, plus jobId/txHash. */
export type JobResult = Record<string, unknown> & { jobId: string; txHash?: string };

export interface NightgateClient {
    /** GET <service>/<name>(p1=...,p2=...) */
    callFunction(name: string, params?: Params): Promise<any>;
    /** POST <service>/<name> */
    callAction(name: string, params?: ActionParams): Promise<any>;
    /** Polls getJobStatus; transient poll failures (429/502/503/504, network, timeout) are retried for up to pollGraceMs (default 5 min) of consecutive failures. */
    waitForJob(input: { jobId: string; sessionId?: string; pollMs?: number; timeoutMs?: number; pollGraceMs?: number }): Promise<JobResult>;

    // crawler-free verification
    verifyAttestation(p: Params): Promise<any>;
    verifyPredicate(p: Params): Promise<any>;
    verifyPredicateAttestation(p: Params): Promise<any>;
    verifyDocument(p: Params): Promise<any>;
    deriveTokenType(p: Params): Promise<any>;
    getHealth(): Promise<any>;

    // compute-only preparation
    prepareDocumentProof(p: ActionParams): Promise<any>;
    prepareMembershipSet(p: ActionParams): Promise<any>;
    prepareAnchorCommitment(p: ActionParams): Promise<any>;

    // wallet sessions
    connectWallet(p: ActionParams): Promise<any>;
    connectWalletForSigning(p: ActionParams): Promise<any>;
    disconnectWallet(p: ActionParams): Promise<any>;
    deriveWalletInfo(p: ActionParams): Promise<any>;
    getWalletBalance(p: Params): Promise<any>;
    getWalletSyncProgress(p: Params): Promise<any>;

    // anchoring + ZK attestations (submit + wait, returns the job result)
    anchorDocument(p: ActionParams): Promise<JobResult>;
    commitDocumentAnchor(p: ActionParams): Promise<JobResult>;
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

    // contracts + tokens
    deployContract(p: ActionParams): Promise<JobResult>;
    submitContractCall(p: ActionParams): Promise<JobResult>;
    submitContractCallBatch(p: ActionParams): Promise<JobResult>;
    mintShieldedTestToken(p: ActionParams): Promise<JobResult>;
    sendNight(p: ActionParams): Promise<JobResult>;

    // cross-server fee sponsoring
    sponsorFinalized(p: ActionParams): Promise<JobResult>;
    sponsorUnbound(p: ActionParams): Promise<JobResult>;
    buildSponsorable(p: ActionParams): Promise<JobResult>;
}

export declare function connect(opts: ConnectOptions): NightgateClient;
