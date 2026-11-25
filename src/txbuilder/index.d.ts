// Types for `@odatano/nightgate-tx/txbuilder`. It builds a transaction on your machine,
// with your own key, for a NIGHTGATE server to pay the fee and submit.
import type { ConnectOptions, NightgateClient } from '../sdk/client';
import type { ContractDeploy, MaintenanceUpdate } from '@midnightntwrk/ledger-v9';

/** A started shielded wallet of the SDK, as a swap wallet hands it out and a builder takes it. */
export interface ShieldedWalletInstance {
    state: { subscribe(observer: { next?(state: unknown): void; error?(e: unknown): void }): { unsubscribe(): void } };
    start(secretKeys: unknown): Promise<void>;
    stop(): Promise<void>;
    balanceTransaction(secretKeys: unknown, tx: unknown): Promise<unknown>;
    revertTransaction(tx: unknown): Promise<void>;
    waitForSyncedState(): Promise<unknown>;
    serializeState(): Promise<string>;
}

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
    /** Cached files that no longer matched the manifest and were downloaded again. Absent for a local directory. */
    refreshed?: number;
    /** The files were checked against a key manifest. Absent for a local directory. */
    verified?: boolean;
    /** Where the files came from: a server, a local directory or a contract package. */
    source?: 'remote' | 'local' | 'package';
}

export interface EnsureZkAssetsInput {
    /** A server's `/zk-config/<contract>` URL. Required unless `package` is given. */
    zkConfigBaseUrl?: string;
    /** Where the downloaded files are kept; default `~/.cache/nightgate-txbuilder/<contractName>`. */
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
    onProgress?: (e: ZkAssetProgress) => void;
}

export interface CreateTxBuilderInput {
    /** 128 hex chars (64-byte BIP39 seed). Never leaves the process. */
    seedHex: string;
    networkId?: string;
    accountIndex?: number;
    /**
     * A NIGHTGATE server to read the chain through: the options for `connect()` or a connected client.
     * Replaces the indexer and the node. A wallet sync needs the indexer URLs as well, unless `api` is the
     * options object with a gateway key (`token: 'oda_…'`): then the wallet syncs through the gateway's
     * indexer lane. A connected client carries no key, so it never takes the lane.
     */
    api?: ConnectOptions | NightgateClient;
    /**
     * With `api`: a contract state from a server whose database is more blocks behind the chain is refused,
     * because a build on a stale state can fail on chain. Default 60.
     */
    maxLagBlocks?: number;
    /**
     * With `api`: how long a contract state read is asked again while the server answers 429, 502, 503 or 504,
     * for example while its indexer has not reached the newest action. Default 120000 ms.
     */
    stateRetryMs?: number;
    /** Required without `api`; with `api` only for a wallet sync. */
    indexerHttpUrl?: string;
    /** Required without `api`; with `api` only for a wallet sync. */
    indexerWsUrl?: string;
    /** Node RPC URL. Required without `api`. */
    nodeUrl?: string;
    /** Only used with `provingMode: 'server'`. */
    proofServerUrl?: string;
    /**
     * 'wasm' (default) proves in this process.
     * 'server' proves the wallet's circuits and the contract's on `proofServerUrl`, several times faster.
     * The proof server sees your private inputs and the coins you spend, so only use one you run yourself.
     */
    provingMode?: 'wasm' | 'server';
    /**
     * Server proving only. Timeout of one proof request in ms, default 300000.
     * The SDK retries a timed-out proof, so set it above your slowest circuit.
     */
    proofTimeoutMs?: number;
    /**
     * Where the standard circuits' keys and the BLS parameters are kept, default
     * `~/.cache/nightgate-txbuilder/prover-material`. Downloaded once, read from disk by every later process.
     */
    proverMaterialDir?: string;
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
     * A contract deployed before ledger 9 needs the package version compiled for ledger 8.
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
    /**
     * Where files from `zkConfigBaseUrl` are kept; default `~/.cache/nightgate-txbuilder/<contractName>`.
     * Give each process its own when they build at the same time against servers with different versions of one contract.
     */
    cacheDir?: string;
    /** Circuits you will call. Defaults to all circuits of the contract. */
    circuits?: string[];
    /** How long the transaction stays valid, default 30. The sponsor must submit it in that time. */
    ttlMinutes?: number;
    attestationSecret?: Uint8Array; // 32 bytes; default derived from the seed; attestation vault only
    /**
     * `true` (default) syncs the wallet. This reads the whole chain and keeps a CPU core busy until it catches up.
     * `false` skips the sync. Calls that move no tokens, like all vault calls, work without it.
     * `'shielded'` syncs only the private coins, `'coins'` the private and the NIGHT coins; both leave
     * the dust wallet out, which a sponsor-paid call never needs.
     */
    walletSync?: boolean | 'shielded' | 'coins';
    /** Saved state from `serializeWalletState()`, to skip a full sync. */
    walletState?: WalletState;
    /**
     * A started shielded wallet of the same seed, such as a swap wallet's `shieldedWallet`. The builder balances
     * from it and neither starts nor stops it, so the swap wallet and every builder of a process share one sync
     * and one view of the coins. Excludes `walletState.shielded`.
     */
    shieldedWallet?: ShieldedWalletInstance;
    /** Asset download, wallet start, build phases and, while a wallet syncs, a `SyncProgressEvent` per wallet. */
    onProgress?: (e: BuilderProgressEvent) => void;
}

/** Where a syncing sub-wallet stands, at most once a second per wallet and once more when it reaches the tip. */
/** The check of the contract's proving files starts. */
export interface ZkAssetsProgress { phase: 'zk-assets'; }
/** A proving file of the contract was downloaded. The counts are the totals of the run so far; `circuit` is absent for the compiler manifest. */
export interface ZkAssetProgress { phase: 'zk-asset'; circuit?: string; file: string; fetched: number; cached: number; refreshed: number; }
/** The wallet starts. */
export interface WalletProgress { phase: 'wallet'; }
/** A file of the wallet's own proving material was read from disk or downloaded. */
export interface ProverMaterialProgress { phase: 'prover-material'; file: string; source: 'local' | 'remote'; bytes: number; }
/** A build starts. `circuit` names the calls joined by `+`, or `<deploy>`. */
export interface BuildProgress { phase: 'build'; circuit: string; }
/** The calls of a batch were put in order. `before` and `after` list each call with its segment and stage. */
export interface BatchOrderProgress { phase: 'batch-order'; before: string; after: string; stageGrouped: boolean; }
/** The gas check of a batch could not decide, and the build goes on. */
export interface BatchGasCheckProgress { phase: 'batch-gas-check'; outcome: 'skipped' | 'other-failure'; detail: string; }
/** The gas a transcript declares, as decimal strings. */
export interface GasFigures { readTime: string; computeTime: string; bytesWritten: string; bytesDeleted: string; }
/** The declared gas of a single call was raised by `factor`, which can be below `requested`. A call without a stage has no figures for it. */
export interface GasHeadroomProgress { phase: 'gas-headroom'; factor: number; requested: number; guaranteed?: GasFigures; fallible?: GasFigures; }
/** A build is done. `contractAddress` is set for a deploy. */
export interface BuiltProgress { phase: 'built'; bytes: number; bound: boolean; contractAddress?: string; }
/** What a builder reports through `onProgress`. Check `phase` to read an event's fields. */
export type BuilderProgressEvent =
    | ZkAssetsProgress | ZkAssetProgress | WalletProgress | SyncProgressEvent | ProverMaterialProgress
    | BuildProgress | BatchOrderProgress | BatchGasCheckProgress | GasHeadroomProgress | BuiltProgress;

/** A sub-wallet's position while it syncs: at most once a second per wallet, and once at the tip. */
export interface SyncProgressEvent {
    phase: 'sync';
    wallet: 'shielded' | 'unshielded' | 'dust';
    /** Decimal; the unshielded wallet counts transactions, the others ledger events. */
    appliedIndex: string;
    highestIndex: string;
    isConnected: boolean;
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
    /** Defaults to `mainnet`. Only the address format depends on it. */
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

export interface BuildSponsorableInput {
    contractAddress: string;
    /** A single call. Use either `call` or `calls`. */
    call?: PreparedCall;
    /**
     * Up to 8 calls in one transaction, run in array order.
     * If the ledger would reject the order, it fails before proving with `code: 'BATCH_CAUSALITY_VIOLATION'`.
     * Putting the most expensive call last usually helps.
     * A call that would run out of gas fails before proving with `code: 'BATCH_GAS_BUDGET_EXCEEDED'`.
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
     * Single call only. Multiplies the gas the call declares (the ledger adds 20 % on its own), so the call
     * still fits after another transaction grew a map by a trie level. The fee grows with it. 1 to 10.
     * An upper bound: the builder lowers it to what the ledger's time to dismiss allows, and `onProgress` reports the factor applied.
     */
    gasHeadroom?: number;
    /**
     * Other wallets that a call sends a private coin to, for example when minting for someone else.
     * Without their keys the build fails, because the coin cannot be encrypted for them.
     */
    recipients?: ShieldedPublicKeys[];
    /**
     * The contract's private state before the call; default `{}`. The builder keeps none between builds:
     * pass the `nextPrivateState` of the last build whose transaction landed.
     */
    initialPrivateState?: unknown;
    /**
     * `true` (default) returns a sealed transaction for sponsorFinalized.
     * `false` returns an unsealed one for sponsorUnbound, which lets a sponsor pay for several at once.
     */
    bind?: boolean;
}
export interface BuildSponsorableBoundInput extends BuildSponsorableInput { bind?: true; }
export interface BuildSponsorableUnboundInput extends BuildSponsorableInput { bind: false; }

/** A sealed transaction without a fee, as base64. Send it to sponsorFinalized. */
export interface BuiltBoundTransaction {
    finalizedTxB64: string;
    unboundTxB64?: undefined;
    serializedBytes: number;
    bound: true;
    /** The contract's private state after the call, the last call of a batch or the constructor. It counts once the transaction landed. */
    nextPrivateState: unknown;
}
/** A signed but unsealed transaction without a fee, as base64. Send it to sponsorUnbound. */
export interface BuiltUnboundTransaction {
    unboundTxB64: string;
    finalizedTxB64?: undefined;
    serializedBytes: number;
    bound: false;
    /** The contract's private state after the call, the last call of a batch or the constructor. It counts once the transaction landed. */
    nextPrivateState: unknown;
}
export type BuiltTransaction = BuiltBoundTransaction | BuiltUnboundTransaction;

export interface TxBuilder {
    provingMode: 'wasm' | 'server';
    /** Attestation vault only. Pass this to the `prepare*` helpers. */
    attestationSecret: Uint8Array;
    /** Attestation vault only. The attester id (hex) that every attestation built here carries. */
    attesterId: string;
    zkAssets: ZkAssetResult;
    addresses: { night: string; shielded: string };
    /** Another builder lists these under `recipients` to send this wallet a private coin. */
    shieldedKeys: ShieldedPublicKeys;
    walletSync: 'all' | 'coins' | 'shielded' | 'none';
    /** Resolves once every syncing sub-wallet has caught up with the chain and reads it at ledger 9, a shared shielded wallet included. */
    waitForSync(): Promise<void>;
    /** Saves the wallet state for `createTxBuilder({ walletState })`. */
    serializeWalletState(): Promise<WalletState>;
    buildSponsorable(input: BuildSponsorableUnboundInput): Promise<BuiltUnboundTransaction>;
    buildSponsorable(input: BuildSponsorableBoundInput): Promise<BuiltBoundTransaction>;
    buildSponsorable(input: BuildSponsorableInput): Promise<BuiltTransaction>;
    /**
     * Builds, proves and signs a contract deploy without submitting it. A sponsor pays the fee.
     * An agent token needs `allowDeploy` on its grant with budget left.
     */
    buildDeploySponsorable(input: BuildDeployFromLedgerInput & { bind: false }): Promise<BuiltUnboundMaintenance>;
    buildDeploySponsorable(input: BuildDeployFromLedgerInput): Promise<BuiltMaintenance>;
    buildDeploySponsorable(input: BuildDeploySponsorableUnboundInput): Promise<BuiltUnboundDeploy>;
    buildDeploySponsorable(input?: BuildDeploySponsorableBoundInput): Promise<BuiltBoundDeploy>;
    buildDeploySponsorable(input: BuildDeploySponsorableInput): Promise<BuiltDeploy>;
    /**
     * Proves a signed maintenance update and returns it without a fee. A sponsor pays and submits it.
     * An agent token needs `allowMaintenance` on its grant, and the contract must be one it deployed sponsored.
     */
    buildMaintenanceSponsorable(input: BuildMaintenanceSponsorableUnboundInput): Promise<BuiltUnboundMaintenance>;
    buildMaintenanceSponsorable(input: BuildMaintenanceSponsorableBoundInput): Promise<BuiltBoundMaintenance>;
    buildMaintenanceSponsorable(input: BuildMaintenanceSponsorableInput): Promise<BuiltMaintenance>;
    /**
     * Releases the coins a built transaction reserved in this builder's wallets, a shared shielded wallet included,
     * when it will not land: offer file, base64 or bytes, bound or not.
     */
    revert(tx: string | Uint8Array): Promise<void>;
    /** Stops the wallet sync and closes connections. Without it the sync runs until the process exits. */
    close(): Promise<void>;
}

/** A signing key of the ledger: its kind and the key as hex. */
export interface ContractSigningKey { tag: string; value: string }

export interface BuildDeploySponsorableInput {
    /** The contract's private state before the constructor; default `{}`. Stays in this process. */
    initialPrivateState?: unknown;
    /** The key that may maintain the contract later; default a new random one. The result carries it either way. */
    signingKey?: ContractSigningKey;
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
/** What a deploy build adds. `signingKey` is a secret: only its holder can maintain the contract, and the sponsor never sees it. */
export interface BuiltDeployKeys { contractAddress: string; signingKey: ContractSigningKey; }
export interface BuiltBoundDeploy extends BuiltBoundTransaction, BuiltDeployKeys {}
export interface BuiltUnboundDeploy extends BuiltUnboundTransaction, BuiltDeployKeys {}
export type BuiltDeploy = BuiltBoundDeploy | BuiltUnboundDeploy;
/** A deploy the caller made itself, for example the first step of a contract too large for one block. Its maintenance key stays with the caller. */
export interface BuildDeployFromLedgerInput {
    deploy: ContractDeploy;
    bind?: boolean;
}

export interface BuildMaintenanceSponsorableInput {
    /** The update, signed by enough members of the contract's maintenance authority. One update per transaction. */
    update: MaintenanceUpdate;
    bind?: boolean;
}
export interface BuildMaintenanceSponsorableBoundInput extends BuildMaintenanceSponsorableInput { bind?: true; }
export interface BuildMaintenanceSponsorableUnboundInput extends BuildMaintenanceSponsorableInput { bind: false; }
export interface BuiltBoundMaintenance extends BuiltBoundTransaction { contractAddress: string; }
export interface BuiltUnboundMaintenance extends BuiltUnboundTransaction { contractAddress: string; }
export type BuiltMaintenance = BuiltBoundMaintenance | BuiltUnboundMaintenance;
/** Seals a ledger transaction for a wallet SDK call. `forks` is the `forks` of the wallet's resolved configuration. */
export declare function sealTx(stage: 'Unproven' | 'Unbound' | 'Finalized', tx: { serialize(): Uint8Array }, forks?: { v9: bigint }): Promise<unknown>;
/** A sub-wallet of a wallet SDK facade, as far as the sync wait reads it. */
export interface SyncingWallet { state: { subscribe(observer: { next?(state: unknown): void; error?(e: unknown): void }): { unsubscribe(): void } } }
/**
 * Resolves once the sub-wallets of your own wallet SDK facade caught up and read the chain at ledger 9; default all three.
 * Use it in place of the facade's `waitForSyncedState()`, which is done a moment before a fresh wallet knows the chain's ledger.
 */
export declare function waitForWalletSync(
    facade: Partial<Record<'shielded' | 'unshielded' | 'dust', SyncingWallet>>, forks?: { v9: bigint }, wallets?: Array<'shielded' | 'unshielded' | 'dust'>
): Promise<void>;
/** Reads the proven ledger transaction out of a handle the wallet SDK returned. */
export declare function openTx(handle: unknown): Promise<LedgerTransaction>;
/** What the wallet SDK's wasm prover asks for: the standard circuits' keys by location, the BLS parameters by size. */
export interface ProverMaterialProvider {
    /** The directory the files are kept in. */
    dir: string;
    lookupKey(keyLocation: string): Promise<{ proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array } | undefined>;
    getParams(k: number): Promise<Uint8Array>;
}
export interface ProverMaterialOptions {
    /** Default `~/.cache/nightgate-txbuilder/prover-material`. */
    dir?: string;
    /** The host the files are downloaded from, laid out as the wallet SDK's default host. Defaults to that host. */
    baseUrl?: string;
    /** `{ phase: 'prover-material', file, source: 'local' | 'remote', bytes }`. */
    onProgress?: (e: ProverMaterialProgress) => void;
}
/**
 * Keeps the files the wasm prover needs on disk. The wallet SDK downloads a missing or damaged one and checks it against its ledger release.
 * `createTxBuilder` and `createSwapWallet` use it; call it yourself to warm the directory or to hand it to the SDK.
 */
export declare function createProverMaterialProvider(opts?: ProverMaterialOptions): ProverMaterialProvider;
export declare function defaultProverMaterialDir(): string;
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
export declare function txIds(tx: LedgerTransaction): string[];

export interface SubmitOptions {
    /** Node WebSocket RPC URL (`ws://` or `wss://`), your own node or a hosted one with its token in the URL. */
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
    /** The ledger transaction hash explorers show, when the answer came from a NIGHTGATE server. */
    txHash?: string;
}

/** Where to ask whether a transaction landed: an indexer, or a NIGHTGATE server (`connect()` options or client). */
export interface LandedProbeSource {
    indexerHttpUrl?: string;
    api?: ConnectOptions | NightgateClient;
    fetchFn?: typeof fetch;
}

/** Why a lineage package cannot run on this compact-runtime (major.minor differ); null when it can or its contract.json says nothing. */
export declare function runtimeVersionProblem(manifest: { compactRuntime?: string } | undefined, installed?: string): string | null;

/** The gateway's indexer lane for `connect()` options with a gateway key (`oda_…`), the key in the query string; null otherwise. */
export declare function gatewayIndexerUrls(api: unknown): { indexerHttpUrl: string; indexerWsUrl: string } | null;

/** Asks the indexer or the NIGHTGATE server whether a transaction landed. Returns null while this is not known yet. */
export declare function probeLanded(txId: string, opts: LandedProbeSource & { timeoutMs?: number }): Promise<LandedProbeResult | null>;
/** Calls `probeLanded` until the transaction is found or `timeoutMs` has passed. Use it when a resend is rejected. */
export declare function waitLanded(txId: string, opts: LandedProbeSource & { timeoutMs?: number, pollMs?: number }): Promise<LandedProbeResult | null>;

/** The client behind an `api` option: a connected client, or `connect()` on the options. */
export declare function apiClientFor(api: ConnectOptions | NightgateClient): NightgateClient;

export declare const ATTESTATION_VAULT_CIRCUITS: string[];
export declare function ensureZkAssets(input: EnsureZkAssetsInput & {
    /** The pause before each further try of a download. Empty means one try. */
    retryDelaysMs?: readonly number[];
}): Promise<ZkAssetResult>;
/** What the builder loads from an installed contract package. */
export interface BuilderPackage {
    package: { name: string; version: string; root: string };
    contractClass: Function;
    contractName: string;
    privateStateId: string;
    zkConfigDir: string;
    /** All circuits of the contract. */
    circuits: string[];
    /** Whether the package was compiled for the ledger before the fork. */
    ledger8: boolean;
    /** Content slots of a vault package; absent for any other contract. */
    slotWidth?: number;
}
export declare function resolveBuilderPackage(input: { package: string; from?: string }): Promise<BuilderPackage>;
/** Checks that a local directory has all proving files. Downloads nothing. */
export declare function describeLocalZkAssets(zkConfigDir: string, circuits?: string[], proveCircuits?: string[], options?: { ledger8?: boolean }): Promise<ZkAssetResult>;
/** Whether the compiler that wrote a local directory built for ledger 8. A directory without `compiler/contract-info.json` counts as no. */
export declare function isLedger8ZkDir(zkConfigDir: string): Promise<boolean>;
export declare function createTxBuilder(opts: CreateTxBuilderInput): Promise<TxBuilder>;
/** Derives the attester id, attestation secret and addresses of a seed. Needs no network. */
export declare function deriveIdentity(opts: DeriveIdentityInput): Promise<Identity>;
/** The key under which the vault stores an attester's attestation of a payload, as hex. Both arguments are 64 hex characters. */
export declare function computeRecordKey(attesterId: string, payloadHash: string): Promise<string>;
/** Derives the night, zswap and dust seeds from a BIP39 seed. These are secret keys. */
export declare function deriveRoleSeeds(seedHex: string, accountIndex?: number): Promise<{ night: Uint8Array; zswap: Uint8Array; dust: Uint8Array }>;

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
    /** The indexer the wallet syncs from. Required unless `api` holds a gateway key. */
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    /** The `connect()` options of an ODATANO gateway (`{ baseUrl, token: 'oda_…' }`): the wallet syncs through its indexer lane. */
    api?: ConnectOptions;
    /** Not needed for swapping. */
    nodeUrl?: string;
    /**
     * 'wasm' (default) proves in this process. 'server' proves on `proofServerUrl`, which is faster.
     * The proof server sees the coins you spend, so only use one you run yourself.
     */
    provingMode?: 'wasm' | 'server';
    proofServerUrl?: string;
    /** Wasm proving. Where the standard circuits' keys and the BLS parameters are kept, see `CreateTxBuilderInput`. */
    proverMaterialDir?: string;
    /** Downloads of proving material. */
    onProgress?: (e: ProverMaterialProgress) => void;
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
    /** The deserialized half, for `SwapWallet.revert` or `txIds`. */
    tx: LedgerTransaction;
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

/** A plain transfer built for `sponsorTransfer`. */
export interface BuiltTransfer {
    /** The transfer as base64, for `sponsorTransfer({ transferTxB64 })`. */
    txB64: string;
    /** The deserialized transfer, for the wallet's `revert` or `txIds`. */
    tx: LedgerTransaction;
    bound: boolean;
    serializedBytes: number;
    /** What was asked: the type, the amount in atoms and the recipient's address. */
    terms: { tokenType: string; amount: bigint; to: string };
    /** Coins the transfer spends. */
    inputs: number;
    /** Releases the transfer's coins if it will not be handed over. */
    revert(): Promise<void>;
}

/** Checks that a transaction is a plain shielded transfer: an offer and nothing else that nets to zero. Throws otherwise. */
export declare function readTransferShape(tx: LedgerTransaction): { inputs: number; outputs: number };

export interface SwapWallet {
    provingMode: 'wasm' | 'server';
    /** Shielded address. */
    address: string;
    coinPublicKey: string;
    encryptionPublicKey: string;
    /** Resolves once the wallet has caught up with the chain and reads it at ledger 9. */
    sync(): Promise<void>;
    maxInputs: number;
    /** Balance of the free coins per token type, in the smallest unit. */
    balances(): Promise<Record<string, bigint>>;
    /** Per token type, what the halves built here bring back once their swaps land: change and wanted coins. Listed until the swap lands or `revert()`. */
    pendingBalances(): Promise<Record<string, bigint>>;
    /** The unreserved coins, smallest first. */
    coins(): Promise<SwapLeg[]>;
    /** The coins the halves and transfers built from this seed keep reserved, each with the instant the SDK stops waiting for it (null when unknown). */
    pending(): Promise<Array<{ tokenType: string; amount: bigint; ttl: string | null }>>;
    /**
     * Releases the coins of a half or transfer whose build-time `revert()` is gone with its process: the offer
     * file, base64 or bytes of the transaction (the board keeps an offer's file, also past its expiry).
     * Only for a transaction that did not land; a landed one spent the coins and the sync removes them.
     */
    revert(input: string | Uint8Array): Promise<void>;
    /** The most one half can give of a token type. */
    spendable(tokenType: string): Promise<bigint>;
    /**
     * Builds and proves one half of a swap that gives `give` and receives `want`.
     * Its coins stay reserved until the swap lands or `revert()` is called.
     * Hand the half over soon after building it, because it refers to the current chain state.
     */
    buildHalf(input: { give: SwapLegInput; want: SwapLegInput; bind?: boolean }): Promise<BuiltSwapHalf>;
    /**
     * Builds and proves a plain transfer of `amount` of `tokenType` to the shielded address `to`, for `sponsorTransfer`.
     * Its coins stay reserved until the transfer lands or `revert()` is called.
     */
    buildTransfer(input: { tokenType: string; amount: bigint | number | string; to: string; bind?: boolean }): Promise<BuiltTransfer>;
    /** Accepts an offer and returns both halves for `sponsorSwap`. Checks the terms against `expect` if given. */
    takeOffer(input: { offer: string | Uint8Array; expect?: SwapTermsInput }): Promise<TakenOffer>;
    /** Saves the wallet state. It contains the wallet's coins, so keep it as safe as a key. */
    serializeState(): Promise<string>;
    /** The wallet behind this one, for `createTxBuilder({ shieldedWallet })`: builders of the same seed share its sync and its coins. */
    readonly shieldedWallet: ShieldedWalletInstance;
    close(): Promise<void>;
}

/** Default limit of coins one half may spend. */
export declare const SWAP_MAX_INPUTS: 4;
/** A coin as the wallet SDK lists it. */

/** Creates a wallet for swapping. It syncs only the private coins of the seed. */
export declare function createSwapWallet(opts: CreateSwapWalletInput): Promise<SwapWallet>;

export interface CreateUnshieldedWalletInput {
    /** 128 hex chars (64-byte BIP39 seed). Never leaves the process. */
    seedHex: string;
    networkId?: string;
    accountIndex?: number;
    /** The indexer the wallet syncs from. Required unless `api` holds a gateway key. */
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    /** The `connect()` options of an ODATANO gateway (`{ baseUrl, token: 'oda_…' }`): the wallet syncs through its indexer lane. */
    api?: ConnectOptions;
    /** Saved state from `serializeState()`, to skip a full sync. */
    walletState?: string;
    /** How long a built transfer stays valid. Defaults to 30. */
    ttlMinutes?: number;
}

/** What a plain unshielded transfer moves. `to` is the recipient's raw address (64 hex). */
export interface UnshieldedTransferTerms {
    tokenType: string;
    amount: bigint;
    /** The recipient as wallets show it (`mn_addr_...`), the same form as `buildTransfer().terms.to` and the receipt's `transfer.to`. */
    to: string;
    /** The recipient as raw hex. */
    toHex: string;
    inputs: number;
    outputs: number;
}

/** Reads type, amount and recipient of a plain unshielded transfer, by the sponsor's rule. Throws for anything else. `networkId` defaults to `mainnet`. */
export declare function readUnshieldedTransfer(tx: LedgerTransaction, opts?: { networkId?: string }): Promise<UnshieldedTransferTerms>;

export interface UnshieldedWallet {
    /** Unshielded address (`mn_addr_...`). */
    address: string;
    /** The raw token type of NIGHT. */
    nightTokenType: string;
    /** Resolves once the wallet has caught up with the chain and reads it at ledger 9. */
    sync(): Promise<void>;
    /** Balance of the unreserved coins per token type, in the smallest unit. */
    balances(): Promise<Record<string, bigint>>;
    /** The unreserved coins. */
    coins(): Promise<SwapLeg[]>;
    /** The coins the transfers built here keep reserved. */
    pending(): Promise<SwapLeg[]>;
    /**
     * Builds and signs a plain transfer of `amount` of `tokenType` (default NIGHT) to the unshielded address `to`, for `sponsorTransfer`.
     * Its coins stay reserved until the transfer lands or `revert()` is called. `terms.to` is the address as given.
     */
    buildTransfer(input: { amount: bigint | number | string; to: string; tokenType?: string; bind?: boolean }): Promise<BuiltTransfer>;
    /** Releases the coins of a transfer whose build-time `revert()` is gone with its process: its base64 or bytes. Only for one that did not land. */
    revert(input: string | Uint8Array): Promise<void>;
    /** Saves the wallet state. It lists the wallet's coins. */
    serializeState(): Promise<string>;
    close(): Promise<void>;
}

/** Creates a wallet for plain transfers of unshielded tokens, NIGHT included. It syncs only the unshielded coins of the seed. */
export declare function createUnshieldedWallet(opts: CreateUnshieldedWalletInput): Promise<UnshieldedWallet>;

/** The circuits of the holder registry contract. */
export declare const HOLDER_REGISTRY_CIRCUITS: readonly ['registerHolder', 'unregisterHolder'];
/** The claim key to pass to `registerHolder`, computed from a secret you keep (64 hex). */
export declare function holderClaimKey(claimSecretHex: string): string;

/** Token factory helpers from `@odatano/contract-kit`. */
export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';
/** Derives the token issuer secret from a wallet seed. A server session on the same seed gets the same issuer. */
export declare function tokenFactoryIssuerSecret(opts: { seedHex: string; accountIndex?: number }): Promise<string>;
