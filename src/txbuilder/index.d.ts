// Types for `@odatano/nightgate/txbuilder`: build a sponsorable transaction
// locally, with your own key, without running a NIGHTGATE server.

/** A call prepared by the browser export's `prepare*` helpers. */
export interface PreparedCall {
    circuitId: string;
    args: Array<Uint8Array | bigint | boolean[]>;
    /** The contract's witness functions. Optional on a batch entry when the batch carries shared `witnesses`. */
    witnesses?: object;
    /** Batch only: runs immediately before this call, to swap per-call state in the shared witnesses. */
    before?: () => void;
    /**
     * Raw proof bundle passthrough (proof helpers only): the batch path
     * rebinds it through a shared witness holder. Absent on the
     * attester-gated helpers (attest, anchor, ...), which need no bundle.
     */
    merkleProof?: object;
    /** Content-tree width the call was prepared for (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
}

export interface ZkAssetResult {
    cacheDir: string;
    /** Files downloaded on this run; 0 with `zkConfigDir`. */
    fetched: number;
    /** Files already present in the cache. With `zkConfigDir`: the verified files, i.e. every circuit's verifier key plus prover key and bzkir of the circuits to prove. */
    cached: number;
    /** `'remote'`: a public `/zk-config`; `'local'`: `zkConfigDir`. */
    source?: 'remote' | 'local';
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
    /** Unused unless `provingMode: 'server'` (only the SDK's config type asks for it otherwise). */
    proofServerUrl?: string;
    /**
     * 'wasm' (default): prove the contract circuit in-process; nothing leaves
     * the process. 'server': prove on `proofServerUrl`, which then RECEIVES THE
     * WITNESSES (native, multi-threaded, several times faster on the big
     * circuits): only ever a proof server you run yourself, never the
     * sponsor's. Explicit opt-in on purpose.
     */
    provingMode?: 'wasm' | 'server';
    /** A public `/zk-config/<contract>`; assets are fetched once and cached. Optional when `zkConfigDir` is given. */
    zkConfigBaseUrl?: string;
    /**
     * Local directory holding `keys/` and `zkir/` (a contract the sponsor does not serve).
     * Nothing is fetched; the verifier keys must cover every circuit of `contractClass`.
     */
    zkConfigDir?: string;
    /** The compiled contract class, e.g. from `@odatano/nightgate/browser/attestation-vault`. */
    contractClass: Function;
    contractName?: string;
    privateStateId?: string;
    cacheDir?: string;
    /** Circuits to fetch prover keys + zkir for; verifier keys cover the whole contract. Default: every circuit of `contractClass`, else the vault's set. */
    circuits?: string[];
    /** Transaction TTL in minutes (default 30): the sponsor must submit within it. */
    ttlMinutes?: number;
    attestationSecret?: Uint8Array;
    onProgress?: (e: Record<string, unknown>) => void;
}

export interface BuildSponsorableInput {
    contractAddress: string;
    /** ONE call (mutually exclusive with `calls`). */
    call?: PreparedCall;
    /**
     * Batch: up to 8 calls in one transaction. Apply order = array order, segment
     * ordering fail-closed, causality pre-check aborts before proving with
     * `code: 'BatchCausalityViolation'`: put the most expensive call last.
     * One witnesses object serves the batch: the `witnesses` input, else the
     * object every entry carries when it is the same one, else (attestation-vault
     * family only) the builder's own; anything else is refused up front. Per-call
     * state goes through the entries' `before` hooks; every batched vault call
     * must be prepared with the same secret. Same-named calls are unordered among
     * themselves: group them. On a 1010/104 reject rebuild the batch, do not
     * resubmit identical bytes. `bind: false` refuses a value-moving batch; every
     * circuit must be on the sponsor's allow-list.
     */
    calls?: PreparedCall[];
    /**
     * Batch only: one shared witnesses object for any contract (a Compact instance
     * binds its witnesses once); per-call state goes through the entries' `before` hooks.
     */
    witnesses?: object;
    /** Batch only (vault family): overrides the builder's own secret for the shared witnesses. */
    attestationSecret?: Uint8Array;
    initialPrivateState?: unknown;
    /** true (default): FINALIZED handover (sponsorFinalizedTransaction).
     *  false: UNBOUND handover (sponsorUnboundTransaction, parallel 0.18). */
    bind?: boolean;
}
export interface BuildSponsorableBoundInput extends BuildSponsorableInput { bind?: true; }
export interface BuildSponsorableUnboundInput extends BuildSponsorableInput { bind: false; }

/** Bound handover (bind omitted or true): base64 of the fee-unpaid finalized tx -> sponsorFinalizedTransaction. */
export interface BuiltBoundTransaction {
    finalizedTxB64: string;
    unboundTxB64?: undefined;
    serializedBytes: number;
    bound: true;
}
/** Unbound handover (bind:false): base64 of the pre-binding signed tx -> sponsorUnboundTransaction. */
export interface BuiltUnboundTransaction {
    unboundTxB64: string;
    finalizedTxB64?: undefined;
    serializedBytes: number;
    bound: false;
}
export type BuiltTransaction = BuiltBoundTransaction | BuiltUnboundTransaction;

export interface TxBuilder {
    /** 'wasm' (in-process, default) or 'server' (proofServerUrl given). */
    provingMode: 'wasm' | 'server';
    /** Feed this to the browser export's `prepare*` helpers. */
    attestationSecret: Uint8Array;
    /** The identity every attestation built here will carry (hex). */
    attesterId: string;
    zkAssets: ZkAssetResult;
    addresses: { night: string };
    buildSponsorable(input: BuildSponsorableUnboundInput): Promise<BuiltUnboundTransaction>;
    buildSponsorable(input: BuildSponsorableBoundInput): Promise<BuiltBoundTransaction>;
    buildSponsorable(input: BuildSponsorableInput): Promise<BuiltTransaction>;
    /**
     * 0.21.0: build + prove + sign a contract deploy without submitting; the caller's
     * key signs it, a sponsor pays the dust. Sponsoring needs
     * `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` on the server and, for a token caller,
     * `allowDeploy` with budget left on the grant. The landed address is recorded
     * in the grant's `deployedContracts` and sponsorable on top of the allow-list.
     * `contractAddress` is read off the deploy action before anything is submitted.
     */
    buildDeploySponsorable(input: BuildDeploySponsorableUnboundInput): Promise<BuiltUnboundDeploy>;
    buildDeploySponsorable(input?: BuildDeploySponsorableBoundInput): Promise<BuiltBoundDeploy>;
    buildDeploySponsorable(input: BuildDeploySponsorableInput): Promise<BuiltDeploy>;
    close(): Promise<void>;
}

export interface BuildDeploySponsorableInput {
    /** Initial private state for `privateStateId`; lives in this process only. */
    initialPrivateState?: unknown;
    /** Public constructor arguments of the contract, in declaration order. */
    constructorArgs?: unknown[];
    /** Witnesses the constructor needs; vacant when omitted. */
    witnesses?: object;
    bind?: boolean;
}
export interface BuildDeploySponsorableBoundInput extends BuildDeploySponsorableInput { bind?: true; }
export interface BuildDeploySponsorableUnboundInput extends BuildDeploySponsorableInput { bind: false; }
export interface BuiltBoundDeploy extends BuiltBoundTransaction { contractAddress: string; }
export interface BuiltUnboundDeploy extends BuiltUnboundTransaction { contractAddress: string; }
export type BuiltDeploy = BuiltBoundDeploy | BuiltUnboundDeploy;
/** The contract address a built deploy transaction creates; throws unless exactly one deploy action is present. */
export declare function readDeployAddress(tx: unknown): string;

export declare const ATTESTATION_VAULT_CIRCUITS: string[];
export declare function ensureZkAssets(input: EnsureZkAssetsInput): Promise<ZkAssetResult>;
/** Checks a local keys/ + zkir/ directory and describes it as a `ZkAssetResult` (`source: 'local'`, nothing fetched). */
export declare function describeLocalZkAssets(zkConfigDir: string, circuits?: string[], proveCircuits?: string[]): Promise<ZkAssetResult>;
export declare function createTxBuilder(opts: CreateTxBuilderInput): Promise<TxBuilder>;
