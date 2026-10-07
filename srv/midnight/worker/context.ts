/**
 * Shared state of the worker thread.
 * A facade is the SDK wallet object that combines the shielded, unshielded and dust parts.
 * This module can be imported outside a worker. `log` then does nothing.
 */

// Must stay the first import. The worker modules import each other in a cycle,
// and config is read at load time.
import { configEnum, setConfigWarnSink } from '../../utils/config';
import { RpcErrorPayload } from '../wallet-worker-protocol';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import { parentPort, type MessagePort } from 'node:worker_threads';
import type { ReplayKind, ReplayTrack } from './sync-replay';

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
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
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
    facade: any;
    sdkVersion: string;
    zswapKeys: any;
    dustKey: any;
    unshieldedKeystore: any;
    saveTimer?: NodeJS.Timeout;
    progressTimer?: NodeJS.Timeout;
    lastSavedBlobs?: SerializedBlobs; // last save the main thread confirmed
    pendingSaves?: Map<number, PendingSave>; // by save number, until confirmed
    /** Key of the confirmed dust save (`dustSaveKey`) and the epoch of the wallet that produced it. */
    lastSavedDustKey?: { epoch: number; key: string };
    networkId: string;
    /** Used to read the indexer's latest block, which is the real sync target. */
    indexerHttpUrl: string;
    /** Kept to rebuild the dust wallet when its state is restored. */
    walletConfiguration: any;
    /**
     * Dust state saved before building a tx, because the build marks the dust as spent.
     * Restored when the node rejects the tx before the mempool.
     */
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

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

setConfigWarnSink((message) => log('warn', message));

export let cachedLedger: any;
/** Returns the same ledger module instance that `loadSdk` uses. */
export async function loadLedger(): Promise<any> {
    if (!cachedLedger) cachedLedger = await import('@midnight-ntwrk/ledger-v8');
    return cachedLedger;
}
export let cachedWallet: any;
export let cachedFacadeSdk: any;
export let cachedContractsSdk: any;
export let cachedProving: any;
export let cachedAddressFormat: typeof AddressFormat | undefined;

export async function loadAddressFormat(): Promise<typeof AddressFormat> {
    if (cachedAddressFormat) return cachedAddressFormat;
    cachedAddressFormat = await import('@midnightntwrk/wallet-sdk-address-format');
    return cachedAddressFormat;
}

// Cached as a promise so concurrent first calls share one import.
export let cachedDustCore: Promise<any> | undefined;
export function loadDustCoreWallet(): Promise<any> {
    cachedDustCore ??= import('@midnightntwrk/wallet-sdk-dust-wallet/v1' as string).then((m: any) => m.CoreWallet);
    return cachedDustCore;
}

// Used to open a separate node connection for each submit.
export let cachedNodeClient: Promise<any> | undefined;
export function loadNodeClientSdk(): Promise<any> {
    cachedNodeClient ??= Promise.all([
        import('@midnightntwrk/wallet-sdk-node-client/effect' as string),
        import('@midnightntwrk/wallet-sdk-abstractions' as string),
        import('effect' as string)
    ]).then(([nodeClient, abstractions, effect]: any[]) => ({
        PolkadotNodeClient: nodeClient.PolkadotNodeClient,
        SerializedTransaction: abstractions.SerializedTransaction,
        Effect: effect.Effect, Scope: effect.Scope, Exit: effect.Exit, Stream: effect.Stream, Duration: effect.Duration
    }));
    return cachedNodeClient;
}

export async function loadProvingSdk(): Promise<any> {
    if (!cachedProving) {
        cachedProving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    }
    return cachedProving;
}

export type ProvingMode = 'server' | 'wasm';

export function resolveProvingMode(): ProvingMode {
    return configEnum<ProvingMode>('NIGHTGATE_PROVING_MODE') ?? 'server';
}

export async function loadSdk(): Promise<{
    ledger: any;
    shielded: any;
    unshielded: any;
    dust: any;
    abstractions: any;
    facade: any;
    networkId: any;
}> {
    if (!cachedLedger) {
        cachedLedger = await import('@midnight-ntwrk/ledger-v8');
    }
    if (!cachedWallet) {
        const [shielded, unshielded, dust, abstractions] = await Promise.all([
            import('@midnightntwrk/wallet-sdk-shielded'),
            import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
            import('@midnightntwrk/wallet-sdk-dust-wallet'),
            import('@midnightntwrk/wallet-sdk-abstractions')
        ]);
        cachedWallet = { shielded, unshielded, dust, abstractions };
    }
    if (!cachedFacadeSdk) {
        const [facade, networkId] = await Promise.all([
            import('@midnightntwrk/wallet-sdk-facade'),
            import('@midnight-ntwrk/midnight-js-network-id')
        ]);
        cachedFacadeSdk = { facade, networkId };
    }
    return {
        ledger: cachedLedger,
        shielded: cachedWallet.shielded,
        unshielded: cachedWallet.unshielded,
        dust: cachedWallet.dust,
        abstractions: cachedWallet.abstractions,
        facade: cachedFacadeSdk.facade,
        networkId: cachedFacadeSdk.networkId
    };
}

export let lastNetworkId: string | undefined;
export async function ensureNetworkId(networkId: string, sdk: any): Promise<void> {
    if (lastNetworkId === networkId) return;
    sdk.networkId.setNetworkId(networkId);
    lastNetworkId = networkId;
}

export async function loadContractsSdk(): Promise<{
    contracts: any;
    indexer: any;
    proof: any;
    zk: any;
    compactJs: any;
}> {
    if (cachedContractsSdk) return cachedContractsSdk;
    const [contracts, indexer, proof, zk, compactJs] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
        import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
        import('@midnight-ntwrk/compact-js')
    ]);
    cachedContractsSdk = { contracts, indexer, proof, zk, compactJs };
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
export async function encodeAddressString(
    addr: AddressFormat.DustAddress | string | null | undefined,
    networkId: string
): Promise<string>;
export async function encodeAddressString(
    addr: AddressFormat.ShieldedAddress | string | null | undefined,
    networkId: string
): Promise<string>;
export async function encodeAddressString(
    addr: AddressFormat.UnshieldedAddress | string | null | undefined,
    networkId: string
): Promise<string>;
export async function encodeAddressString(addr: any, networkId: string): Promise<string> {
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
    if (addr.startsWith('mn_shield-addr_')) {
        return { kind: 'shielded', addr: af.MidnightBech32m.parse(addr).decode(af.ShieldedAddress, networkId) };
    }
    if (addr.startsWith('mn_addr_')) {
        return { kind: 'unshielded', addr: af.MidnightBech32m.parse(addr).decode(af.UnshieldedAddress, networkId) };
    }
    throw new Error(
        `Unsupported receiver address prefix in '${addr.slice(0, 16)}...' ` +
        `(expected 'mn_shield-addr_' for shielded or 'mn_addr_' for unshielded)`
    );
}

