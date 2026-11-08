// Shared state of the worker thread. A facade is the SDK wallet that combines the shielded, unshielded and dust parts.
// This module can be imported outside a worker. `log` then does nothing.

// Must stay the first import. The worker modules import each other in a cycle,
// and config is read at load time.
import { configEnum, setConfigWarnSink } from '../../utils/config';
import type { NightgateNetwork } from '../../utils/nightgate-config';
import { RpcErrorPayload } from '../wallet-worker-protocol';
import { parseMidnightAddress, receiverKind, RECEIVER_PREFIXES } from '../../utils/midnight-address';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import type * as LedgerV9 from '@midnightntwrk/ledger-v9';
import type * as ShieldedSdk from '@midnightntwrk/wallet-sdk-shielded';
import type * as UnshieldedSdk from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import type * as DustSdk from '@midnightntwrk/wallet-sdk-dust-wallet';
import type * as DustV2 from '@midnightntwrk/wallet-sdk-dust-wallet/v2';
import type { NodeClientSdk } from './phased-submit';
import type * as AbstractionsSdk from '@midnightntwrk/wallet-sdk-abstractions';
import type * as FacadeSdk from '@midnightntwrk/wallet-sdk-facade';
import type * as ProvingSdk from '@midnightntwrk/wallet-sdk-capabilities/proving';
import type * as ContractsSdk from '@midnight-ntwrk/midnight-js-contracts';
import type * as IndexerSdk from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type * as ProofSdk from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import type * as ZkConfigSdk from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type * as CompactJsSdk from '@midnight-ntwrk/compact-js';
import type * as MidnightJsTypes from '@midnight-ntwrk/midnight-js-types';
import { parentPort, type MessagePort } from 'node:worker_threads';
import type { ReplayKind, ReplayTrack } from './sync-replay';
import type { RevocableKeystore } from './revocable-keystore';

export interface RpcRequest {
    kind: 'rpc';
    method: string;
    args: unknown;
    port: MessagePort;
}

export interface RpcOk { ok: true; result: unknown }
export interface RpcErr { ok: false; error: RpcErrorPayload }

export interface InitArgs {
    sessionId: string;
    seedHex: string;
    /** BIP32 account index the seed signs with. Default 0. */
    accountIndex?: number;
    networkId: NightgateNetwork;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    relayUrl: string;
    restoreBlobs?: { shielded?: string; unshielded?: string; dust?: string };
}

export interface SerializedBlobs {
    shielded?: string;
    unshielded?: string;
    dust?: string;
}

/** A save the main thread has not confirmed yet. The epochs tell a save of a replaced wallet from a current one. */
export interface PendingSave {
    blobs: SerializedBlobs;
    dustEpoch: number;
    shieldedEpoch: number;
    dustKey?: string;
}

export interface FacadeEntry {
    /** The key of this entry in `facades`. */
    sessionId: string;
    facade: FacadeSdk.WalletFacade;
    sdkVersion: string;
    zswapKeys: LedgerV9.ZswapSecretKeys;
    dustKey: LedgerV9.DustSecretKey;
    /** A fresh sub-wallet starts from its seed, so it can follow a ledger fork. */
    walletSeeds: { shielded: Uint8Array; unshielded: Uint8Array; dust: Uint8Array };
    unshieldedKeystore: RevocableKeystore;
    saveTimer?: NodeJS.Timeout;
    /** A save tick is queued or running. A timer that fires meanwhile is skipped. */
    saveTickInFlight?: boolean;
    progressTimer?: NodeJS.Timeout;
    lastIndexerLiveness?: string;
    lastSavedBlobs?: SerializedBlobs; // last save the main thread confirmed
    pendingSaves?: Map<number, PendingSave>; // by save number, until confirmed
    /** Key of the confirmed dust save (`dustSaveKey`) and the epoch of the wallet that produced it. */
    lastSavedDustKey?: { epoch: number; key: string };
    networkId: string;
    /** Used to read the indexer's latest block, which is the real sync target. */
    indexerHttpUrl: string;
    /** Kept to rebuild the dust wallet when its state is restored. */
    walletConfiguration: FacadeSdk.ResolvedConfiguration;
    /** Dust state saved before a build, because the build marks dust as spent. Restored when the node rejects the tx before the mempool. */
    preSubmitDustSnapshot?: string;
    /** Raised whenever the dust wallet is replaced. Saves of the old wallet are then ignored. */
    dustEpoch?: number;
    /** The same as `dustEpoch`, for the shielded wallet. */
    shieldedEpoch?: number;
    /** Wallet parts restored from a save that have not yet moved past the saved position. */
    restoredSubWallets?: { dust?: boolean; shielded?: boolean };
    replayTracks?: Partial<Record<ReplayKind, ReplayTrack>>;
    restoredStateLogged?: boolean;
    lastSyncStateLogAt?: number;
    /** Dust restores whose new save was confirmed. Reported as dustRestoreCount. */
    dustRestoresPersisted?: number;
    /** Fixed per session. Provides the contract's `local_secret_key()` value. */
    attestationSecret: Uint8Array;
    /** Fixed per session. Provides the token factory contract's `issuerSecret()` value. */
    tokenFactoryIssuerSecret: Uint8Array;
}

export const facades = new Map<string, FacadeEntry>();

/** Puts a fresh sub-wallet into a facade and returns the old one. The facade reads its sub-wallets per call; the SDK types them read-only. */
export function replaceSubWallet<K extends 'dust' | 'shielded'>(facade: FacadeSdk.WalletFacade, kind: K, fresh: FacadeSdk.WalletFacade[K]): FacadeSdk.WalletFacade[K] {
    const slots = facade as { -readonly [P in K]: FacadeSdk.WalletFacade[P] };
    const old = slots[kind];
    slots[kind] = fresh;
    return old;
}

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

setConfigWarnSink((message) => log('warn', message));

/** The ledger, wallet and facade packages the worker builds wallets with. */
export interface WalletSdk {
    ledger: typeof LedgerV9;
    shielded: typeof ShieldedSdk;
    unshielded: typeof UnshieldedSdk;
    dust: typeof DustSdk;
    abstractions: typeof AbstractionsSdk;
    facade: typeof FacadeSdk;
}

/** The midnight-js packages a contract call needs. */
export interface ContractsSdkBundle {
    contracts: typeof ContractsSdk;
    indexer: typeof IndexerSdk;
    proof: typeof ProofSdk;
    zk: typeof ZkConfigSdk;
    compactJs: typeof CompactJsSdk;
    types: typeof MidnightJsTypes;
}

export let cachedLedger: typeof LedgerV9 | undefined;
/** Returns the same ledger module instance that `loadSdk` uses. */
export async function loadLedger(): Promise<typeof LedgerV9> {
    cachedLedger ??= await import('@midnightntwrk/ledger-v9');
    return cachedLedger;
}
let cachedWallet: Omit<WalletSdk, 'ledger' | 'facade'> | undefined;
let cachedFacadeSdk: typeof FacadeSdk | undefined;
let cachedContractsSdk: ContractsSdkBundle | undefined;
let cachedProving: Promise<typeof ProvingSdk> | undefined;
export let cachedAddressFormat: typeof AddressFormat | undefined;

export async function loadAddressFormat(): Promise<typeof AddressFormat> {
    if (cachedAddressFormat) return cachedAddressFormat;
    cachedAddressFormat = await import('@midnightntwrk/wallet-sdk-address-format');
    return cachedAddressFormat;
}

/** The ledger 9 variant of the dust wallet, which reads and spends the core dust state. */
export type DustV2Sdk = typeof DustV2;

// Cached as a promise so concurrent first calls share one import.
export let cachedDustV2: Promise<DustV2Sdk> | undefined;
export function loadDustV2Sdk(): Promise<DustV2Sdk> {
    cachedDustV2 ??= import('@midnightntwrk/wallet-sdk-dust-wallet/v2');
    return cachedDustV2;
}

// The SDK calls system.chain before every node read and retries each second on a closed socket.
// polkadot would print each retry at error level. The caller still gets the error.
export async function muteNodeProbeLog(): Promise<void> {
    const { rpcDefinitions } = await import('@polkadot/types');
    rpcDefinitions.system.chain.noErrorLog = true;
}

// Used to open a separate node connection for each submit.
export let cachedNodeClient: Promise<NodeClientSdk> | undefined;
export function loadNodeClientSdk(): Promise<NodeClientSdk> {
    cachedNodeClient ??= Promise.all([
        import('@midnightntwrk/wallet-sdk-node-client/effect'),
        import('@midnightntwrk/wallet-sdk-abstractions'),
        import('effect'),
        muteNodeProbeLog()
    ]).then(([nodeClient, abstractions, effect]) => ({
        PolkadotNodeClient: nodeClient.PolkadotNodeClient,
        SerializedTransaction: abstractions.SerializedTransaction,
        Effect: effect.Effect, Scope: effect.Scope, Exit: effect.Exit, Stream: effect.Stream, Duration: effect.Duration
    }));
    return cachedNodeClient;
}

export async function loadProvingSdk(): Promise<typeof ProvingSdk> {
    // Cached as a promise so concurrent first calls share one import.
    cachedProving ??= import('@midnightntwrk/wallet-sdk-capabilities/proving');
    return cachedProving;
}

export type ProvingMode = 'server' | 'wasm';

export function resolveProvingMode(): ProvingMode {
    return configEnum<ProvingMode>('NIGHTGATE_PROVING_MODE') ?? 'server';
}

export async function loadSdk(): Promise<WalletSdk> {
    const ledger = await loadLedger();
    if (!cachedWallet) {
        const [shielded, unshielded, dust, abstractions] = await Promise.all([
            import('@midnightntwrk/wallet-sdk-shielded'),
            import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
            import('@midnightntwrk/wallet-sdk-dust-wallet'),
            import('@midnightntwrk/wallet-sdk-abstractions'),
            muteNodeProbeLog()
        ]);
        cachedWallet = { shielded, unshielded, dust, abstractions };
    }
    cachedFacadeSdk ??= await import('@midnightntwrk/wallet-sdk-facade');
    return { ledger, ...cachedWallet, facade: cachedFacadeSdk };
}

export async function loadContractsSdk(): Promise<ContractsSdkBundle> {
    if (cachedContractsSdk) return cachedContractsSdk;
    const [contracts, indexer, proof, zk, compactJs, types] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
        import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
        import('@midnight-ntwrk/compact-js'),
        import('@midnight-ntwrk/midnight-js-types')
    ]);
    cachedContractsSdk = { contracts, indexer, proof, zk, compactJs, types };
    return cachedContractsSdk;
}

export let resolvedSdkVersion: string | undefined;
export function getSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        let pkgPath: string | undefined;
        // The package's `exports` map blocks require.resolve() of its package.json, so search the paths by hand.
        const searchDirs = require.resolve.paths('@midnightntwrk/wallet-sdk-facade') ?? [];
        for (const dir of searchDirs) {
            const candidate = path.join(dir, '@midnightntwrk', 'wallet-sdk-facade', 'package.json');
            if (fs.existsSync(candidate)) { pkgPath = candidate; break; }
        }
        if (!pkgPath) throw new Error('package.json not located');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        resolvedSdkVersion = `wallet-sdk-facade@${pkg.version}`;
    } catch {
        resolvedSdkVersion = 'wallet-sdk-facade@unknown';
    }
    return resolvedSdkVersion;
}

/** Encodes a Midnight address object as Bech32m. Strings are returned unchanged. */
export async function encodeAddressString<T extends AddressFormat.HasCodec<T>>(
    addr: T | string | null | undefined,
    networkId: string
): Promise<string> {
    if (addr == null) return '';
    if (typeof addr === 'string') return addr;
    const af = await loadAddressFormat();
    return af.MidnightBech32m.encode(networkId, addr).toString();
}

export type ReceiverParsed =
    | { kind: 'shielded'; addr: AddressFormat.ShieldedAddress }
    | { kind: 'unshielded'; addr: AddressFormat.UnshieldedAddress };

export async function parseReceiverAddress(addr: string, networkId: string): Promise<ReceiverParsed> {
    const af = await loadAddressFormat();
    const kind = receiverKind(addr);
    if (kind === 'shielded') return { kind, addr: (await parseMidnightAddress(af, addr)).decode(af.ShieldedAddress, networkId) };
    if (kind === 'unshielded') return { kind, addr: (await parseMidnightAddress(af, addr)).decode(af.UnshieldedAddress, networkId) };
    throw new Error(`Unsupported receiver address prefix in '${addr.slice(0, 16)}...' (expected ${RECEIVER_PREFIXES})`);
}

