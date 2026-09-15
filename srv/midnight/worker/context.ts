/**
 * Worker-thread context: facade registry, log channel, memoised SDK loaders,
 * address helpers. Importable without a parentPort (`log` is then a no-op).
 */

// First import on purpose: the worker modules import each other in cycles and
// a module-level read must resolve before the cycle re-enters.
import { configEnum, setConfigWarnSink } from '../../utils/config';
import { RpcErrorPayload } from '../wallet-worker-protocol';
import path from 'node:path';
import fs from 'node:fs';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { deriveAttestationSecret } from '../../submission/contract-witnesses';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import { parentPort, type MessagePort } from 'node:worker_threads';
import { startProgressWatch } from './facades';
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
    /** BIP32 account level the seed signs with (default 0). */
    accountIndex?: number;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    relayUrl: string;
    restoreBlobs?: { shielded?: string; unshielded?: string; dust?: string };
}

export interface FacadeEntry {
    /** The `facades` map key this entry is stored under (the caller's accountId). */
    sessionId: string;
    facade: any;
    sdkVersion: string;
    zswapKeys: any;
    dustKey: any;
    unshieldedKeystore: any;
    saveTimer?: NodeJS.Timeout;
    /** Idle progress watch (startProgressWatch); cleared with the facade. */
    progressTimer?: NodeJS.Timeout;
    lastSavedBlobs?: { shielded?: string; unshielded?: string; dust?: string }; // last save the main thread confirmed
    pendingSaves?: Map<number, { shielded?: string; unshielded?: string; dust?: string }>; // by seq, resolved by state-save-ack
    networkId: string;
    /** Indexer GraphQL HTTP URL, used to read the genuine sync target (tip). */
    indexerHttpUrl: string;
    /** The wallet configuration the facade's sub-wallets were built with; kept for dust snapshot restores. */
    walletConfiguration: any;
    /**
     * Dust state serialized BEFORE the build (the build books the spend);
     * restored after a pre-mempool reject.
     */
    preSubmitDustSnapshot?: string;
    /** Bumped on every dust restore/replacement; the save tick drops blobs of the previous wallet. */
    dustEpoch?: number;
    /** Dust epoch per in-flight save (by seq); a stale-epoch ack must not advance the dust baseline. */
    dustSaveEpochs?: Map<number, number>;
    /** Shielded counterpart of `dustEpoch`. */
    shieldedEpoch?: number;
    shieldedSaveEpochs?: Map<number, number>;
    /** Restored sub-wallets not yet past the restored offset (checkSnapshotReplay). */
    restoredSubWallets?: { dust?: boolean; shielded?: boolean };
    replayTracks?: Partial<Record<ReplayKind, ReplayTrack>>;
    restoredStateLogged?: boolean;
    lastSyncStateLogAt?: number;
    /** Snapshot restores whose re-persist was acked; reported as dustRestoreCount. */
    dustRestoresPersisted?: number;
    /** Session-stable secret for the `local_secret_key()` witness. */
    attestationSecret: Uint8Array;
}

export const facades = new Map<string, FacadeEntry>();

// ---- Logging back to main thread ------------------------------------------

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

// Config parse warnings reach the main process as worker log lines.
setConfigWarnSink((message) => log('warn', message));

// ---- SDK loaders (dynamic ESM imports, same pattern as sdk-loader.ts) ----

export let cachedLedger: any;
/** The ledger wasm module, loaded once (the same instance `loadSdk` uses). */
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

// Memoised as a promise so concurrent first callers share one module evaluation.
export let cachedDustCore: Promise<any> | undefined;
export function loadDustCoreWallet(): Promise<any> {
    cachedDustCore ??= import('@midnightntwrk/wallet-sdk-dust-wallet/v1' as string).then((m: any) => m.CoreWallet);
    return cachedDustCore;
}

// Node client effect API for dedicated per-submit clients; memoised as a promise.
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

// Loaded only in wasm proving mode.
export async function loadProvingSdk(): Promise<any> {
    if (!cachedProving) {
        cachedProving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    }
    return cachedProving;
}

export type ProvingMode = 'server' | 'wasm';

/** 'server' proves via the proof server, 'wasm' in-process (standard-circuit keys cached once per worker). */
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

/** Contract deploy/call SDK packages, loaded lazily on first use. */
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

// ---- SDK version pin ------------------------------------------------------

export let resolvedSdkVersion: string | undefined;
export function getSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        let pkgPath: string | undefined;
        // The package's `exports` map blocks require.resolve() of package.json
        // and the bare specifier; walk the resolution paths instead.
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

/** Bech32m-encodes a Midnight address object; strings pass through. */
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

/** A Bech32m receiver parsed into the SDK's typed address, by HRP prefix. */
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

