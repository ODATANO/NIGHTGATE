// Types for `@odatano/nightgate/txbuilder`. It builds a transaction on your machine,
// with your own key, for a NIGHTGATE server to pay the fee and submit.

/** A call prepared by one of the `prepare*` helpers. */
export interface PreparedCall {
    circuitId: string;
    args: Array<Uint8Array | bigint | boolean[]>;
    /** The functions that supply the call's private inputs. Optional in a batch that passes shared `witnesses`. */
    witnesses?: object;
    /** Runs right before this call is proven. Use it to set per-call data in shared witnesses. */
    before?: () => void;
    /** The document's Merkle proof data. Only set by the proof helpers. */
    merkleProof?: object;
    /** Number of document fields the call was prepared for. 16 by default, 32 for attestation-vault-32. */
    slotWidth?: number;
}

export interface ZkAssetResult {
    cacheDir: string;
    /** Files downloaded on this run. */
    fetched: number;
    /** Files that were already there. */
    cached: number;
    /** Where the files came from: a server, a local directory or a contract package. */
    source?: 'remote' | 'local' | 'package';
}

export interface EnsureZkAssetsInput {
    /** A server's `/zk-config/<contract>` URL. Required unless `package` is given. */
    zkConfigBaseUrl?: string;
    cacheDir?: string;
    /**
     * An installed contract package (`@odatano/contract-<name>`).
     * Its missing prover keys are downloaded into the package and checked against its `keys/manifest.json`.
     */
    package?: string;
    /** Directory to resolve the package from. Defaults to `process.cwd()`. */
    from?: string;
    /** Circuits to fetch the large prover keys for. */
    circuits?: string[];
    /** All circuits of the contract. Verifier keys are needed for every one of them. */
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
    /** Node RPC URL. */
    nodeUrl: string;
    /** Only used with `provingMode: 'server'`. */
    proofServerUrl?: string;
    /**
     * 'wasm' (default) proves in this process.
     * 'server' proves on `proofServerUrl`, which is faster for large circuits.
     * The proof server sees your private inputs, so only use one you run yourself.
     */
    provingMode?: 'wasm' | 'server';
    /**
     * Server proving only. Timeout of one proof request in ms, default 300000.
     * The SDK retries a timed-out proof, so set it above your slowest circuit.
     */
    proofTimeoutMs?: number;
    /** A server's `/zk-config/<contract>` URL. Files are downloaded once and cached. */
    zkConfigBaseUrl?: string;
    /**
     * A local directory with `keys/` and `zkir/`. Nothing is downloaded.
     * It needs verifier keys for every circuit of the contract.
     */
    zkConfigDir?: string;
    /**
     * An installed contract package (`@odatano/contract-<name>`).
     * It supplies the contract class, names and proving files. Explicit options win over it.
     */
    package?: string;
    /** Directory to resolve the package from. Defaults to `process.cwd()`. */
    from?: string;
    /** Defaults to the global `fetch`. */
    fetchFn?: typeof fetch;
    /** The compiled contract class. Not needed with `package`. */
    contractClass?: Function;
    contractName?: string;
    privateStateId?: string;
    cacheDir?: string;
    /** Circuits you will call. Defaults to all circuits of the contract. */
    circuits?: string[];
    /** How long the transaction stays valid, default 30. The sponsor must submit it in that time. */
    ttlMinutes?: number;
    attestationSecret?: Uint8Array;
    /**
     * `true` (default) syncs the wallet. This reads the whole chain and keeps a CPU core busy until it catches up.
     * `false` skips the sync. Calls that move no tokens, like all vault calls, work without it.
     * `'shielded'` syncs only the private coins, which is enough when a sponsor pays the fee.
     */
    walletSync?: boolean | 'shielded';
    /** Saved state from `serializeWalletState()`, to skip a full sync. */
    walletState?: WalletState;
    onProgress?: (e: Record<string, unknown>) => void;
}

/** Saved wallet state. It contains the wallet's coins, so keep it as safe as a key. */
export interface WalletState {
    shielded?: string;
    unshielded?: string;
    dust?: string;
}

/** The public keys a sender needs to send a private coin to a wallet. */
export interface ShieldedPublicKeys {
    /** 64 hex */
    coinPublicKey: string;
    /** 64 hex */
    encryptionPublicKey: string;
}

export interface DeriveIdentityInput {
    /** 128 hex chars (64-byte BIP39 seed). */
    seedHex: string;
    /** Defaults to `preprod`. Only the address format depends on it. */
    networkId?: string;
    accountIndex?: number;
    /** Defaults to a secret derived from the seed. */
    attestationSecret?: Uint8Array;
}

export interface Identity {
    /** Hex. A hash of the attestation secret. */
    attesterId: string;
    attestationSecret: Uint8Array;
    addresses: { night: string; shielded: string };
    shieldedKeys: ShieldedPublicKeys;
}

/** Remembers the sockets a `ws` class opens. `closeAll()` ends them. */
export interface TrackingWebSocket {
    WebSocket: Function;
    readonly size: number;
    closeAll(): void;
}

export interface BuildSponsorableInput {
    contractAddress: string;
    /** A single call. Use either `call` or `calls`. */
    call?: PreparedCall;
    /**
     * Up to 8 calls in one transaction, run in array order.
     * If the ledger would reject the order, it fails before proving with `code: 'BatchCausalityViolation'`.
     * Putting the most expensive call last usually helps.
     * Every circuit must be allowed by the sponsor.
     */
    calls?: PreparedCall[];
    /**
     * Batch only. One witnesses object for all calls, because a contract instance takes its witnesses once.
     * Use each call's `before` hook for what differs per call.
     */
    witnesses?: object;
    /** Batch only, attestation vault only. Replaces the builder's own attestation secret. */
    attestationSecret?: Uint8Array;
    /**
     * Batch only. Set it when the calls after `orderedPrefix` do not depend on each other.
     * They may then be reordered to an order the ledger accepts.
     */
    independentCalls?: boolean;
    /** Batch only, with `independentCalls`. The number of leading calls that keep their position. */
    orderedPrefix?: number;
    /**
     * Other wallets that a call sends a private coin to, for example when minting for someone else.
     * Without their keys the build fails, because the coin cannot be encrypted for them.
     */
    recipients?: ShieldedPublicKeys[];
    initialPrivateState?: unknown;
    /**
     * `true` (default) returns a sealed transaction for sponsorFinalizedTransaction.
     * `false` returns an unsealed one for sponsorUnboundTransaction, which lets a sponsor pay for several at once.
     */
    bind?: boolean;
}
export interface BuildSponsorableBoundInput extends BuildSponsorableInput { bind?: true; }
export interface BuildSponsorableUnboundInput extends BuildSponsorableInput { bind: false; }

/** A sealed transaction without a fee, as base64. Send it to sponsorFinalizedTransaction. */
export interface BuiltBoundTransaction {
    finalizedTxB64: string;
    unboundTxB64?: undefined;
    serializedBytes: number;
    bound: true;
}
/** A signed but unsealed transaction without a fee, as base64. Send it to sponsorUnboundTransaction. */
export interface BuiltUnboundTransaction {
    unboundTxB64: string;
    finalizedTxB64?: undefined;
    serializedBytes: number;
    bound: false;
}
export type BuiltTransaction = BuiltBoundTransaction | BuiltUnboundTransaction;

export interface TxBuilder {
    provingMode: 'wasm' | 'server';
    /** Pass this to the `prepare*` helpers. */
    attestationSecret: Uint8Array;
    /** The attester id (hex) that every attestation built here carries. */
    attesterId: string;
    zkAssets: ZkAssetResult;
    addresses: { night: string; shielded: string };
    /** Another builder lists these under `recipients` to send this wallet a private coin. */
    shieldedKeys: ShieldedPublicKeys;
    walletSync: 'all' | 'shielded' | 'none';
    /** Resolves once the wallet has caught up with the chain. */
    waitForSync(): Promise<void>;
    /** Saves the wallet state for `createTxBuilder({ walletState })`. */
    serializeWalletState(): Promise<WalletState>;
    buildSponsorable(input: BuildSponsorableUnboundInput): Promise<BuiltUnboundTransaction>;
    buildSponsorable(input: BuildSponsorableBoundInput): Promise<BuiltBoundTransaction>;
    buildSponsorable(input: BuildSponsorableInput): Promise<BuiltTransaction>;
    /**
     * Builds, proves and signs a contract deploy without submitting it. A sponsor pays the fee.
     * The server must allow sponsored deploys, and an agent token needs `allowDeploy` with budget left.
     */
    buildDeploySponsorable(input: BuildDeploySponsorableUnboundInput): Promise<BuiltUnboundDeploy>;
    buildDeploySponsorable(input?: BuildDeploySponsorableBoundInput): Promise<BuiltBoundDeploy>;
    buildDeploySponsorable(input: BuildDeploySponsorableInput): Promise<BuiltDeploy>;
    /** Stops the wallet sync and closes connections. Without it the sync runs until the process exits. */
    close(): Promise<void>;
}

export interface BuildDeploySponsorableInput {
    /** Stays in this process only. */
    initialPrivateState?: unknown;
    /** The contract's constructor arguments, in order. */
    constructorArgs?: unknown[];
    /** Witnesses the constructor needs, if any. */
    witnesses?: object;
    /** Other wallets the constructor sends a private coin to. */
    recipients?: ShieldedPublicKeys[];
    bind?: boolean;
}
export interface BuildDeploySponsorableBoundInput extends BuildDeploySponsorableInput { bind?: true; }
export interface BuildDeploySponsorableUnboundInput extends BuildDeploySponsorableInput { bind: false; }
export interface BuiltBoundDeploy extends BuiltBoundTransaction { contractAddress: string; }
export interface BuiltUnboundDeploy extends BuiltUnboundTransaction { contractAddress: string; }
export type BuiltDeploy = BuiltBoundDeploy | BuiltUnboundDeploy;
/** Options for the SDK's proof provider. Undefined without `proofTimeoutMs`. */
export declare function proofProviderConfig(opts: { proofTimeoutMs?: number } | undefined): { timeout: number } | undefined;
/** Returns the address of the contract a deploy transaction creates. Throws unless it deploys exactly one contract. */
export declare function readDeployAddress(tx: unknown): string;

// ---- paying your own fee and submitting to the node directly

/** A decoded ledger transaction. */
export interface LedgerTransaction {
    serialize(): Uint8Array;
    identifiers(): Iterable<unknown>;
}

/** Decodes a transaction from bytes or base64. Accepts sealed and unsealed transactions. */
export declare function deserializeTransaction(bytesOrB64: Uint8Array | string): Promise<LedgerTransaction>;
/** The transaction's identifiers. Use the last one to look it up in the indexer. */
export declare function txIdentifiers(tx: LedgerTransaction): string[];

export interface SubmitOptions {
    /** Node WebSocket URL, for example `wss://rpc.preprod.midnight.network/`. */
    nodeUrl: string;
    /** Node HTTP URL. Derived from `nodeUrl` when omitted. */
    nodeHttpUrl?: string;
    /** Default 30000 ms. After a timeout the transaction may still have arrived, so check before resending. */
    timeoutMs?: number;
    /** Defaults to `ws`. */
    WebSocketImpl?: Function;
}

/**
 * Submits a sealed transaction with its fee paid and returns the extrinsic hash.
 * Needs the optional dependency `@polkadot/api`.
 */
export declare function submitFinalized(tx: LedgerTransaction | Uint8Array | string, opts: SubmitOptions): Promise<string>;
/** Submits an already encoded extrinsic and returns its hash. */
export declare function submitExtrinsic(extrinsicHex: string, opts: SubmitOptions): Promise<string>;
/** Turns a ws(s):// node URL into the matching http(s):// URL. */
export declare function nodeHttpUrlFor(nodeUrl: string): string;

export interface NodeRejectClassification {
    /**
     * 'stale-dust-proof' (170, 171, 196): the fee was proven against an outdated state. Sync, rebuild, submit again.
     * 'funds' (138, 173): the wallet cannot pay. Retrying does not help.
     * 'sequencing' (219-224, 188): the batch order is not allowed. Send the calls separately.
     * 'malformed' (117): retrying does not help.
     * 'stale-transcript' (104): another transaction changed the contract first. Build the call again.
     * 'unknown': any other rejection.
     */
    kind: 'stale-dust-proof' | 'funds' | 'sequencing' | 'malformed' | 'stale-transcript' | 'unknown';
    subCode: number | null;
}

/** Explains a node rejection by its ledger error code. */
export declare function classifyNodeReject(err: unknown): NodeRejectClassification;
export interface StaleTranscriptRebuildOptions {
    /** Retries after the first rejection. Defaults to 2. */
    retries?: number;
    /** Pause before each retry in ms, so the indexer shows the new state. Defaults to 15000. */
    backoffMs?: number;
    /** Called before each retry with the retry number, starting at 1, and the error. */
    onRetry?: (retry: number, err: unknown) => void;
    /** Replaces the pause, for tests. */
    sleep?: (ms: number) => Promise<void>;
}
/** Runs `attempt` again after a 'stale-transcript' rejection. `attempt` must build a new transaction each time. */
export declare function rebuildOnStaleTranscript<T>(attempt: (retry: number) => Promise<T>, opts?: StaleTranscriptRebuildOptions): Promise<T>;
/** Whether the node refused the transaction before the mempool (1010, 1014, 1016). No fee was spent. */
export declare function isPreMempoolReject(err: unknown): boolean;
/** Whether the connection failed while sending. Check with `probeLanded`, then resend the same bytes. Never rebuild. */
export declare function isTransportFailure(err: unknown): boolean;
/** Whether the transaction is already in the pool (1013). After a resend this means the first send worked. */
export declare function isAlreadyImported(err: unknown): boolean;

export interface LandedProbeResult {
    height: string;
    status: string;
    failedSegments: number[];
    /** false means the transaction is in a block but its call failed. The fee was still spent. */
    applied: boolean;
}

/** Asks the indexer whether a transaction landed. Returns null while this is not known yet. */
export declare function probeLanded(identifier: string, opts: { indexerHttpUrl: string, fetchFn?: typeof fetch, timeoutMs?: number }): Promise<LandedProbeResult | null>;
/** Calls `probeLanded` until the transaction is found or `timeoutMs` has passed. Use it when a resend is rejected. */
export declare function waitLanded(identifier: string, opts: { indexerHttpUrl: string, timeoutMs?: number, pollMs?: number, fetchFn?: typeof fetch }): Promise<LandedProbeResult | null>;

export interface DustGuardOptions {
    /** The configuration the facade was created with. */
    configuration: object;
    /** The facade's DUST secret key. */
    dustKey: unknown;
    /** Defaults to the SDK's DustWallet. */
    dustWalletFactory?: (configuration: object) => { restore(snapshot: unknown): { start(dustKey: unknown): Promise<unknown> } };
}

/**
 * Runs `fn`, which builds and submits one transaction that pays its own fee.
 * If the node rejects it before the mempool, the DUST wallet is restored, because the SDK would keep the fee reserved.
 */
export declare function withDustGuard<T>(facade: { dust: object }, opts: DustGuardOptions, fn: () => Promise<T>): Promise<T>;

export declare const ATTESTATION_VAULT_CIRCUITS: string[];
export declare function ensureZkAssets(input: EnsureZkAssetsInput): Promise<ZkAssetResult>;
/** What the builder loads from an installed contract package. */
export interface BuilderPackage {
    package: { name: string; version: string; root: string };
    contractClass: Function;
    contractName: string;
    privateStateId: string;
    zkConfigDir: string;
    /** All circuits of the contract. */
    circuits: string[];
}
export declare function resolveBuilderPackage(input: { package: string; from?: string }): Promise<BuilderPackage>;
/** Checks that a local directory has all proving files. Downloads nothing. */
export declare function describeLocalZkAssets(zkConfigDir: string, circuits?: string[], proveCircuits?: string[]): Promise<ZkAssetResult>;
export declare function createTxBuilder(opts: CreateTxBuilderInput): Promise<TxBuilder>;
/** Derives the attester id, attestation secret and addresses of a seed. Needs no network. */
export declare function deriveIdentity(opts: DeriveIdentityInput): Promise<Identity>;
/** The key under which the vault stores an attester's attestation of a payload, as hex. */
export declare function computeRecordKey(attesterId: string, payloadHash: string): string;
export declare function trackingWebSocket(WebSocketImpl: Function): TrackingWebSocket;
/** Derives the night, zswap and dust seeds from a BIP39 seed. These are secret keys. */
export declare function deriveRoleSeeds(seedHex: string, accountIndex?: number): Promise<{ night: Uint8Array; zswap: Uint8Array; dust: Uint8Array }>;
/** Converts `recipients` into the SDK's key map. Undefined when empty. */
export declare function recipientKeyMap(recipients: ShieldedPublicKeys[] | undefined | null): Map<string, string> | undefined;

// ---- private token swaps

/** Prefix of an offer file, the text form of a swap half. */
export declare const SWAP_OFFER_PREFIX: 'swapoffer';

/** One side of a swap: a token type (64 hex) and an amount in the smallest unit. */
export interface SwapLeg {
    tokenType: string;
    amount: bigint;
}
/** Like SwapLeg, but the amount may also be a number or a decimal string. */
export interface SwapLegInput {
    tokenType: string;
    amount: bigint | number | string;
}
/** What a half gives and wants. */
export interface SwapTerms {
    gives: SwapLeg;
    wants: SwapLeg;
}
export interface SwapTermsInput {
    gives: SwapLegInput;
    wants: SwapLegInput;
}
/** Terms read from a transaction, plus how many coins the half spends and creates. */
export interface ReadSwapTerms extends SwapTerms {
    inputs: number;
    outputs: number;
}

/** Reads what a swap half gives and wants. Throws unless it is a plain swap half. */
export declare function readSwapTerms(tx: LedgerTransaction): ReadSwapTerms;
export declare function sameSwapTerms(terms: SwapTermsInput, expect: SwapTermsInput): boolean;
/** Encodes a transaction as offer file text (`swapoffer1...`). */
export declare function encodeOffer(txOrBytes: LedgerTransaction | Uint8Array): Promise<string>;
/** Decodes an offer file, base64 or bytes. `bound` tells whether the transaction is sealed. */
export declare function decodeOffer(input: string | Uint8Array): Promise<{ tx: LedgerTransaction; bound: boolean; bytes: Uint8Array }>;

export interface CreateSwapWalletInput {
    /** 128 hex chars (64-byte BIP39 seed). Never leaves the process. */
    seedHex: string;
    networkId?: string;
    accountIndex?: number;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    /** Not needed for swapping. */
    nodeUrl?: string;
    /**
     * 'wasm' (default) proves in this process. 'server' proves on `proofServerUrl`, which is faster.
     * The proof server sees the coins you spend, so only use one you run yourself.
     */
    provingMode?: 'wasm' | 'server';
    proofServerUrl?: string;
    /** Saved state from `serializeState()`, to skip a full sync. */
    walletState?: string;
    /**
     * Most coins one half may spend. Defaults to 4, the sponsor's default.
     * Each coin makes the half larger, so a sponsor that accepts more coins also needs a larger size limit.
     */
    maxInputs?: number;
}

export interface BuiltSwapHalf {
    /** The half as base64, for `sponsorSwap`. */
    halfB64: string;
    /** Offer file text. Only for a sealed half. */
    offer?: string;
    bound: boolean;
    serializedBytes: number;
    terms: ReadSwapTerms;
    /** Releases the half's coins if the half will not be used. */
    revert(): Promise<void>;
}

export interface TakenOffer {
    makerHalfB64: string;
    takerHalfB64: string;
    /** Whether both halves are sealed. The taker's half matches the offer. */
    bound: boolean;
    /** The offer's terms, from the maker's side. */
    terms: ReadSwapTerms;
    /** Releases the taker's coins if the swap will not be submitted. */
    revert(): Promise<void>;
}

export interface SwapWallet {
    provingMode: 'wasm' | 'server';
    /** Shielded address. */
    address: string;
    coinPublicKey: string;
    encryptionPublicKey: string;
    /** Resolves once the wallet has caught up with the chain. */
    sync(): Promise<void>;
    maxInputs: number;
    /** Balance per token type, in the smallest unit. */
    balances(): Promise<Record<string, bigint>>;
    /** The unreserved coins, smallest first. */
    coins(): Promise<SwapLeg[]>;
    /** The most one half can give of a token type. */
    spendable(tokenType: string): Promise<bigint>;
    /**
     * Builds and proves one half of a swap that gives `give` and receives `want`.
     * Its coins stay reserved until the swap lands or `revert()` is called.
     * Hand the half over soon after building it, because it refers to the current chain state.
     */
    buildHalf(input: { give: SwapLegInput; want: SwapLegInput; bind?: boolean }): Promise<BuiltSwapHalf>;
    /** Accepts an offer and returns both halves for `sponsorSwap`. Checks the terms against `expect` if given. */
    takeOffer(input: { offer: string | Uint8Array; expect?: SwapTermsInput }): Promise<TakenOffer>;
    /** Saves the wallet state. It contains the wallet's coins, so keep it as safe as a key. */
    serializeState(): Promise<string>;
    close(): Promise<void>;
}

/** Default limit of coins one half may spend. */
export declare const SWAP_MAX_INPUTS: 4;
/** A coin as the wallet SDK lists it. */
export interface SwapCoin { type: string; value: bigint; }
/** The sum of the `maxInputs` largest coins of a token type. */
export declare function spendableWithin(coins: readonly SwapCoin[], tokenType: string, maxInputs?: number): bigint;
/** Picks the next coin for a half: the smallest that still lets the remaining slots cover the rest. Updates `plan`. */
export declare function chooseSwapCoin<C extends SwapCoin>(coins: readonly C[], tokenType: string, plan: { remaining: bigint; slots: number }): C | undefined;

/** Creates a wallet for swapping. It syncs only the private coins of the seed. */
export declare function createSwapWallet(opts: CreateSwapWalletInput): Promise<SwapWallet>;

/** The circuits of the holder registry contract. */
export declare const HOLDER_REGISTRY_CIRCUITS: readonly ['registerHolder', 'unregisterHolder'];
/** The claim key to pass to `registerHolder`, computed from a secret you keep (64 hex). */
export declare function holderClaimKey(claimSecretHex: string): string;

/** Token factory helpers from `@odatano/contract-kit`. */
export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';
/** Derives the token issuer secret from a wallet seed. A server session on the same seed gets the same issuer. */
export declare function tokenFactoryIssuerSecret(opts: { seedHex: string; accountIndex?: number }): Promise<string>;
