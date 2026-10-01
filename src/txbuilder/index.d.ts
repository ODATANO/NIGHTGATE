// Types for `@odatano/nightgate/txbuilder`: build a sponsorable transaction
// locally, with your own key, without running a NIGHTGATE server.

/** A call prepared by the browser export's `prepare*` helpers. */
export interface PreparedCall {
    circuitId: string;
    args: Array<Uint8Array | bigint | boolean[]>;
    /** The contract's witness functions. Optional on a batch entry when the batch carries shared `witnesses`. */
    witnesses?: object;
    /** Runs immediately before this call is proven (single call and batch entry alike), to swap per-call state in the shared witnesses. */
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
    /**
     * Server proving only: HTTP timeout of one proof request, ms (default the
     * SDK's 300000). The SDK re-requests a timed-out proof up to three times,
     * so set it above your slowest circuit. Positive integer.
     */
    proofTimeoutMs?: number;
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
    /**
     * `true` (default): the wallet syncs from genesis against the indexer on
     * the calling thread for the life of the builder (a full core while it
     * catches up). `false`: no sync. A call that moves no value (every vault
     * circuit) needs no wallet state to build, prove and sign; a call that
     * does move value then fails at balancing instead of building wrong.
     * `'shielded'`: only the shielded coins sync, enough for a call that moves
     * shielded value while a sponsor pays the fee.
     */
    walletSync?: boolean | 'shielded';
    /** From `serializeWalletState()`: the sub-wallets named in it resume instead of syncing from genesis. */
    walletState?: WalletState;
    onProgress?: (e: Record<string, unknown>) => void;
}

/** Serialized sub-wallet states, as the wallet SDK writes them. They hold the wallet's coins: store them like a key. */
export interface WalletState {
    shielded?: string;
    unshielded?: string;
    dust?: string;
}

/** The public shielded keys of a wallet: what a sender needs to create a coin for it. */
export interface ShieldedPublicKeys {
    /** 64 hex */
    coinPublicKey: string;
    /** 64 hex */
    encryptionPublicKey: string;
}

export interface DeriveIdentityInput {
    /** 128 hex chars (64-byte BIP39 seed). */
    seedHex: string;
    /** Default `preprod`; only the NIGHT address format depends on it. */
    networkId?: string;
    accountIndex?: number;
    /** Bring your own, else derived from the seed. */
    attestationSecret?: Uint8Array;
}

export interface Identity {
    /** hex, `persistentHash` of the attestation secret */
    attesterId: string;
    attestationSecret: Uint8Array;
    addresses: { night: string; shielded: string };
    shieldedKeys: ShieldedPublicKeys;
}

/** Tracks the sockets a `ws` class opens; `closeAll()` terminates them. */
export interface TrackingWebSocket {
    WebSocket: Function;
    readonly size: number;
    closeAll(): void;
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
    /**
     * Batch only: the calls past `orderedPrefix` share no state (a proof cart of
     * distinct claims). They are grouped by execution stage before proving,
     * guaranteed-only calls first, call order within a group: on a grown contract
     * the same circuit lands in different stages for different keys, and call
     * order alone then fails the causality pre-check although a valid order
     * exists. Leave unset for dependent batches (apply order = array order).
     */
    independentCalls?: boolean;
    /** Batch only, with `independentCalls`: leading calls that keep their position (an in-batch anchor the proofs read). */
    orderedPrefix?: number;
    /**
     * Wallets besides the builder's own that a call creates a shielded coin for
     * (a mint to another wallet). Without the recipient's keys here the build
     * fails: the coin's ciphertext cannot be encrypted.
     */
    recipients?: ShieldedPublicKeys[];
    initialPrivateState?: unknown;
    /** true (default): FINALIZED handover (sponsorFinalizedTransaction).
     *  false: UNBOUND handover (sponsorUnboundTransaction, parallel). */
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
    addresses: { night: string; shielded: string };
    /** What another builder lists under `recipients` to create a coin for this wallet. */
    shieldedKeys: ShieldedPublicKeys;
    /** Which sub-wallets sync. */
    walletSync: 'all' | 'shielded' | 'none';
    /** Resolves once the syncing sub-wallets have caught up with the indexer. */
    waitForSync(): Promise<void>;
    /** The state of the syncing sub-wallets, for `createTxBuilder({ walletState })`. */
    serializeWalletState(): Promise<WalletState>;
    buildSponsorable(input: BuildSponsorableUnboundInput): Promise<BuiltUnboundTransaction>;
    buildSponsorable(input: BuildSponsorableBoundInput): Promise<BuiltBoundTransaction>;
    buildSponsorable(input: BuildSponsorableInput): Promise<BuiltTransaction>;
    /**
     * Build + prove + sign a contract deploy without submitting; the caller's
     * key signs it, a sponsor pays the dust. Sponsoring needs
     * `NIGHTGATE_SPONSOR_ALLOW_DEPLOY` on the server and, for a token caller,
     * `allowDeploy` with budget left on the grant. The landed address is recorded
     * in the grant's `deployedContracts` and sponsorable on top of the allow-list.
     * `contractAddress` is read off the deploy action before anything is submitted.
     */
    buildDeploySponsorable(input: BuildDeploySponsorableUnboundInput): Promise<BuiltUnboundDeploy>;
    buildDeploySponsorable(input?: BuildDeploySponsorableBoundInput): Promise<BuiltBoundDeploy>;
    buildDeploySponsorable(input: BuildDeploySponsorableInput): Promise<BuiltDeploy>;
    /** Stops the wallet sync and ends the indexer sockets. Call it; the sync otherwise runs until the process exits. */
    close(): Promise<void>;
}

export interface BuildDeploySponsorableInput {
    /** Initial private state for `privateStateId`; lives in this process only. */
    initialPrivateState?: unknown;
    /** Public constructor arguments of the contract, in declaration order. */
    constructorArgs?: unknown[];
    /** Witnesses the constructor needs; vacant when omitted. */
    witnesses?: object;
    /** Wallets besides the builder's own that the constructor creates a shielded coin for. */
    recipients?: ShieldedPublicKeys[];
    bind?: boolean;
}
export interface BuildDeploySponsorableBoundInput extends BuildDeploySponsorableInput { bind?: true; }
export interface BuildDeploySponsorableUnboundInput extends BuildDeploySponsorableInput { bind: false; }
export interface BuiltBoundDeploy extends BuiltBoundTransaction { contractAddress: string; }
export interface BuiltUnboundDeploy extends BuiltUnboundTransaction { contractAddress: string; }
export type BuiltDeploy = BuiltBoundDeploy | BuiltUnboundDeploy;
/** `{ timeout }` for the SDK's proof provider when `proofTimeoutMs` is set, else undefined. */
export declare function proofProviderConfig(opts: { proofTimeoutMs?: number } | undefined): { timeout: number } | undefined;
/** The contract address a built deploy transaction creates; throws unless exactly one deploy action is present. */
export declare function readDeployAddress(tx: unknown): string;

// ---- self-funded submission (pay your own dust, submit to the node yourself)

/** A deserialized ledger transaction; opaque here (the ledger package owns the type). */
export interface LedgerTransaction {
    serialize(): Uint8Array;
    identifiers(): Iterable<unknown>;
}

/** Deserializes bytes or base64 into a ledger `Transaction` (bound tags first, then pre-binding). */
export declare function deserializeTransaction(bytesOrB64: Uint8Array | string): Promise<LedgerTransaction>;
/** The transaction's identifiers; the LAST one is what the indexer's `transactions(offset:{identifier})` takes. */
export declare function txIdentifiers(tx: LedgerTransaction): string[];

export interface SubmitOptions {
    /** The node WebSocket RPC, e.g. `wss://rpc.preprod.midnight.network/`. */
    nodeUrl: string;
    /** HTTP RPC for the extrinsic encoding; derived from `nodeUrl` by protocol swap when omitted. */
    nodeHttpUrl?: string;
    /** One-shot submit timeout, default 30000 ms. On timeout the transaction MAY be in the mempool: probe before resending. */
    timeoutMs?: number;
    /** Test seam / custom WebSocket class; defaults to `ws`. */
    WebSocketImpl?: Function;
}

/**
 * Submit a finalized (bound, fee-paid) transaction: encodes the
 * `midnight.sendMnTransaction` extrinsic over HTTP, submits over a one-shot
 * WebSocket (the node's HTTP gateway 403s bodies over ~14 KB). Returns the
 * extrinsic hash. Needs `@polkadot/api` (optional peer dependency).
 */
export declare function submitFinalized(tx: LedgerTransaction | Uint8Array | string, opts: SubmitOptions): Promise<string>;
/** The WebSocket half of `submitFinalized`, for an already-encoded extrinsic. */
export declare function submitExtrinsic(extrinsicHex: string, opts: SubmitOptions): Promise<string>;
/** `wss://` -> `https://` (and ws -> http); http(s) passes through. */
export declare function nodeHttpUrlFor(nodeUrl: string): string;

export interface NodeRejectClassification {
    /**
     * 'stale-dust-proof' (170/171/196): re-sync the dust wallet, rebuild, resubmit; the wallet is NOT out of dust.
     * 'funds' (138/173, "could not balance dust"): the wallet cannot pay; retrying buys nothing.
     * 'sequencing' (219-224, 188): split the batch into single-call transactions.
     * 'malformed' (117): neither waiting nor an identical rebuild fixes it.
     * 'stale-transcript' (104): the call no longer fits the current contract state (another transaction on it landed first); build it again, never resend the bytes.
     * 'unknown': a 1010 this table does not know, or not a coded reject.
     */
    kind: 'stale-dust-proof' | 'funds' | 'sequencing' | 'malformed' | 'stale-transcript' | 'unknown';
    subCode: number | null;
}

/** What a node reject means, from the ledger sub-code in the error's message or cause chain. */
export declare function classifyNodeReject(err: unknown): NodeRejectClassification;
export interface StaleTranscriptRebuildOptions {
    /** Further attempts after the first refusal; default 2. */
    retries?: number;
    /** Pause before each rebuild, so the indexer serves the new state; default 15000. */
    backoffMs?: number;
    /** Called before each rebuild with the retry number (1-based) and the refusal. */
    onRetry?: (retry: number, err: unknown) => void;
    /** Injectable pause, for tests. */
    sleep?: (ms: number) => Promise<void>;
}
/** Runs `attempt(retry)` again on a `stale-transcript` refusal (104); `attempt` must build fresh bytes each time. Other errors and the last refusal rethrow. */
export declare function rebuildOnStaleTranscript<T>(attempt: (retry: number) => Promise<T>, opts?: StaleTranscriptRebuildOptions): Promise<T>;
/** 1010/1014/1016: the transaction provably never entered the mempool (fee unspent). NOT 1013 (already imported). */
export declare function isPreMempoolReject(err: unknown): boolean;
/** The SEND failed (socket closed/reset, no reply): probe the indexer, then resend the SAME bytes; never rebuild on transport alone. */
export declare function isTransportFailure(err: unknown): boolean;
/** 1013 Transaction Already Imported: the transaction IS in the pool. Expected after a resend whose first reply was lost; go to the confirmation loop, never treat it as a failure. */
export declare function isAlreadyImported(err: unknown): boolean;

export interface LandedProbeResult {
    height: string;
    status: string;
    failedSegments: number[];
    /** true only for ledger result SUCCESS; false: in a block but the call did NOT apply (fee spent, rebuild against current state). */
    applied: boolean;
}

/** Ask the indexer whether the transaction with this identifier landed; null while unknown (not indexed yet, an HTTP/GraphQL error, or a partial answer without a transaction result). Confirm by identifier, never by watching the contract address. */
export declare function probeLanded(identifier: string, opts: { indexerHttpUrl: string, fetchFn?: typeof fetch, timeoutMs?: number }): Promise<LandedProbeResult | null>;
/** `probeLanded` in a bounded loop (one probe minimum; `timeoutMs` default 30000, `pollMs` default 5000). Run it before trusting the refusal of a RESEND: any reject of resent bytes can mean the first send landed while the indexer still lags. */
export declare function waitLanded(identifier: string, opts: { indexerHttpUrl: string, timeoutMs?: number, pollMs?: number, fetchFn?: typeof fetch }): Promise<LandedProbeResult | null>;

export interface DustGuardOptions {
    /** The configuration object the facade was created with. */
    configuration: object;
    /** The dust secret key the facade runs on. */
    dustKey: unknown;
    /** Your own `(configuration) => DustWallet`; defaults to the SDK's. */
    dustWalletFactory?: (configuration: object) => { restore(snapshot: unknown): { start(dustKey: unknown): Promise<unknown> } };
}

/**
 * Dust wedge protection around ONE dust-spending build + submit: snapshots the
 * facade's dust sub-wallet before `fn` and, on a pre-mempool reject, swaps in
 * a wallet restored from the snapshot (the rethrown error carries
 * `dustRestored: true`). The caller owns persistence: never persist a
 * post-reject dust state. One guarded build per facade at a time.
 */
export declare function withDustGuard<T>(facade: { dust: object }, opts: DustGuardOptions, fn: () => Promise<T>): Promise<T>;

export declare const ATTESTATION_VAULT_CIRCUITS: string[];
export declare function ensureZkAssets(input: EnsureZkAssetsInput): Promise<ZkAssetResult>;
/** Checks a local keys/ + zkir/ directory and describes it as a `ZkAssetResult` (`source: 'local'`, nothing fetched). */
export declare function describeLocalZkAssets(zkConfigDir: string, circuits?: string[], proveCircuits?: string[]): Promise<ZkAssetResult>;
export declare function createTxBuilder(opts: CreateTxBuilderInput): Promise<TxBuilder>;
/** The identity a seed yields (attester id, attestation secret, NIGHT address) without a builder, a wallet or the network. */
export declare function deriveIdentity(opts: DeriveIdentityInput): Promise<Identity>;
/** The attester's record key for a payload (hex): persistentHash(AttestRecordKey{tag 21, owner, payload_hash}). */
export declare function computeRecordKey(attesterId: string, payloadHash: string): string;
export declare function trackingWebSocket(WebSocketImpl: Function): TrackingWebSocket;
/** The per-role seeds of a BIP39 seed (128 hex), by the derivation the builder and Lace use. Key material. */
export declare function deriveRoleSeeds(seedHex: string, accountIndex?: number): Promise<{ night: Uint8Array; zswap: Uint8Array; dust: Uint8Array }>;
/** `recipients` as the SDK's map from coin public key to encryption public key; undefined when empty. */
export declare function recipientKeyMap(recipients: ShieldedPublicKeys[] | undefined | null): Map<string, string> | undefined;

// ---- shielded swaps

/** Prefix of an offer file: bech32m text of a serialized transaction. */
export declare const SWAP_OFFER_PREFIX: 'swapoffer';

/** One side of a swap: a raw token type (64 hex) and an amount in atoms. */
export interface SwapLeg {
    tokenType: string;
    amount: bigint;
}
/** A leg as input: the amount may be a bigint, an integer or a decimal string. */
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
/** Terms read from a transaction, with the coins the half carries. */
export interface ReadSwapTerms extends SwapTerms {
    inputs: number;
    outputs: number;
}

/**
 * What one half of a swap gives and wants, read from the transaction itself.
 * Throws for anything but a plain shielded swap half: an offer and nothing
 * else, one token type given, one other wanted.
 */
export declare function readSwapTerms(tx: LedgerTransaction): ReadSwapTerms;
/** True when `terms` say exactly what `expect` says. */
export declare function sameSwapTerms(terms: SwapTermsInput, expect: SwapTermsInput): boolean;
/** Offer file text (`swapoffer1...`) of a transaction or of its serialized bytes. */
export declare function encodeOffer(txOrBytes: LedgerTransaction | Uint8Array): Promise<string>;
/** An offer file, base64 or bytes as a ledger transaction; `bound` is the form it arrived in. */
export declare function decodeOffer(input: string | Uint8Array): Promise<{ tx: LedgerTransaction; bound: boolean; bytes: Uint8Array }>;

export interface CreateSwapWalletInput {
    /** 128 hex chars (64-byte BIP39 seed). Never leaves the process. */
    seedHex: string;
    networkId?: string;
    accountIndex?: number;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    /** Not used for swapping; passed to the wallet when given. */
    nodeUrl?: string;
    /**
     * 'wasm' (default): halves are proven in-process. 'server': on `proofServerUrl`,
     * which then SEES THE COINS YOU SPEND; several times faster, only ever a proof
     * server you run yourself.
     */
    provingMode?: 'wasm' | 'server';
    proofServerUrl?: string;
    /** From `serializeState()`: resume instead of syncing from genesis. */
    walletState?: string;
    /**
     * Most coins one half spends; default 4, the sponsor's default
     * (`NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS`). Every coin adds about 5 kB to the
     * half, so a sponsor that accepts more also needs a larger byte budget.
     */
    maxInputs?: number;
}

export interface BuiltSwapHalf {
    /** base64 of the serialized half: `makerHalfB64` / `takerHalfB64` of `sponsorSwap`. */
    halfB64: string;
    /** Offer file text; present on a bound half only. */
    offer?: string;
    bound: boolean;
    serializedBytes: number;
    terms: ReadSwapTerms;
    /** Releases the coins of a half that is not going to be handed over. */
    revert(): Promise<void>;
}

export interface TakenOffer {
    makerHalfB64: string;
    takerHalfB64: string;
    /** The form of both halves: the taker's half is built in the offer's form. */
    bound: boolean;
    /** The offer's terms, from the maker's side. */
    terms: ReadSwapTerms;
    /** Releases the taker's coins when the swap is not going to be handed over. */
    revert(): Promise<void>;
}

export interface SwapWallet {
    provingMode: 'wasm' | 'server';
    /** Shielded address (bech32m). */
    address: string;
    coinPublicKey: string;
    encryptionPublicKey: string;
    /** Resolves once the wallet has caught up with the indexer. */
    sync(): Promise<void>;
    /** Most coins one half spends. */
    maxInputs: number;
    /** Shielded balance per raw token type, in atoms. */
    balances(): Promise<Record<string, bigint>>;
    /** The free coins, smallest first. */
    coins(): Promise<SwapLeg[]>;
    /** The most one half can give of a token type: what the `maxInputs` largest free coins hold. */
    spendable(tokenType: string): Promise<bigint>;
    /**
     * One half of a swap: spends `give`, creates `want` and the change for this
     * wallet, proves it. It spends the smallest coins that still fit `maxInputs`,
     * so trading merges small coins; more than `spendable(tokenType)` is refused
     * before anything is proven. `bind: true` (default) returns it bound with its
     * offer file; `bind: false` unbound, base64 only. Its coins stay pending until the
     * swap lands or `revert()` is called. A half refers to a recent state of the
     * coin tree: build and hand over close together.
     */
    buildHalf(input: { give: SwapLegInput; want: SwapLegInput; bind?: boolean }): Promise<BuiltSwapHalf>;
    /**
     * Takes an offer: reads its terms from the transaction, compares them with
     * `expect` when given, builds the mirror half in the offer's form and
     * returns both halves for `sponsorSwap`.
     */
    takeOffer(input: { offer: string | Uint8Array; expect?: SwapTermsInput }): Promise<TakenOffer>;
    /** The wallet's state as text, for `createSwapWallet({ walletState })`. It holds the wallet's coins: store it like a key. */
    serializeState(): Promise<string>;
    /** Stops the sync. */
    close(): Promise<void>;
}

/** Most inputs one half carries by default. */
export declare const SWAP_MAX_INPUTS: 4;
/** A coin as the wallet SDK lists it. */
export interface SwapCoin { type: string; value: bigint; }
/** What the `maxInputs` largest coins of a token type hold. */
export declare function spendableWithin(coins: readonly SwapCoin[], tokenType: string, maxInputs?: number): bigint;
/** The next coin of a half: the smallest one that still lets the remaining slots cover the rest. Updates `plan`. */
export declare function chooseSwapCoin<C extends SwapCoin>(coins: readonly C[], tokenType: string, plan: { remaining: bigint; slots: number }): C | undefined;

/** A shielded wallet for swapping: it syncs the shielded coins of the seed and nothing else. */
export declare function createSwapWallet(opts: CreateSwapWalletInput): Promise<SwapWallet>;

/** The holder-registry circuits, for `ensureZkAssets({ circuits })`. */
export declare const HOLDER_REGISTRY_CIRCUITS: readonly ['registerHolder', 'unregisterHolder'];
/** blake2b-256 over `nightgate/holder-claim/v1` and the 32-byte secret (64 hex): the `claim_key` of `registerHolder`. */
export declare function holderClaimKey(claimSecretHex: string): string;
