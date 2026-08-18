// Types for `@odatano/nightgate/txbuilder`: build a sponsorable transaction
// locally, with your own key, without running a NIGHTGATE server.

/** A call prepared by the browser export's `prepare*` helpers. */
export interface PreparedCall {
    circuitId: string;
    args: Array<Uint8Array | bigint | boolean[]>;
    witnesses: object;
}

export interface ZkAssetResult {
    cacheDir: string;
    /** Files downloaded on this run. */
    fetched: number;
    /** Files already present in the cache. */
    cached: number;
}

export interface EnsureZkAssetsInput {
    /** A public `/zk-config/<contract>` base URL. */
    zkConfigBaseUrl: string;
    cacheDir: string;
    /** Restricts only the HEAVY prover keys + zkir; verifier keys are always fetched for verifierCircuits. */
    circuits?: string[];
    /** Full circuit list of the contract (verifier keys are needed for ALL of them). */
    verifierCircuits?: string[];
    fetchFn?: typeof fetch;
    onProgress?: (e: Record<string, unknown>) => void;
}

export interface CreateTxBuilderInput {
    /** 128 hex chars (64-byte BIP39 seed). Never leaves the process. */
    seedHex: string;
    networkId?: string;
    accountIndex?: number;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    /** Substrate RPC the wallet SDK talks to (its `relayURL`). */
    nodeUrl: string;
    /** Unused under wasm proving; only the SDK's config type asks for it. */
    proofServerUrl?: string;
    /** A public `/zk-config/<contract>`; assets are fetched once and cached. */
    zkConfigBaseUrl: string;
    /** The compiled contract class, e.g. from `@odatano/nightgate/browser/attestation-vault`. */
    contractClass: Function;
    contractName?: string;
    privateStateId?: string;
    cacheDir?: string;
    circuits?: string[];
    /** Transaction TTL in minutes (default 30): the sponsor must submit within it. */
    ttlMinutes?: number;
    attestationSecret?: Uint8Array;
    onProgress?: (e: Record<string, unknown>) => void;
}

export interface BuildSponsorableInput {
    contractAddress: string;
    call: PreparedCall;
    initialPrivateState?: unknown;
}

export interface BuiltTransaction {
    /** Base64 of the fee-unpaid, signed, proven transaction; hand this to a sponsor. */
    finalizedTxB64: string;
    serializedBytes: number;
}

export interface TxBuilder {
    /** Feed this to the browser export's `prepare*` helpers. */
    attestationSecret: Uint8Array;
    /** The identity every attestation built here will carry (hex). */
    attesterId: string;
    zkAssets: ZkAssetResult;
    addresses: { night: string };
    buildSponsorable(input: BuildSponsorableInput): Promise<BuiltTransaction>;
    close(): Promise<void>;
}

export declare const ATTESTATION_VAULT_CIRCUITS: string[];
export declare function ensureZkAssets(input: EnsureZkAssetsInput): Promise<ZkAssetResult>;
export declare function createTxBuilder(opts: CreateTxBuilderInput): Promise<TxBuilder>;
