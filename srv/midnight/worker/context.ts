/**
 * Worker-thread context shared by every worker module: the facade registry,
 * the log channel to the main thread, the SDK loaders (dynamic ESM imports,
 * memoised) and the address helpers. Importable without a parentPort: `log`
 * is a no-op outside a worker thread.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
import { configEnum, setConfigWarnSink } from '../../utils/config';
import { RpcErrorPayload } from '../wallet-worker-protocol';
import path from 'node:path';
import fs from 'node:fs';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { deriveAttestationSecret } from '../../submission/contract-witnesses';
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import { parentPort, type MessagePort } from 'node:worker_threads';
import { startProgressWatch } from './facades';

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
    lastSavedBlobs?: { shielded?: string; unshielded?: string; dust?: string }; // Blobs of the last save the MAIN THREAD CONFIRMED it persisted
    pendingSaves?: Map<number, { shielded?: string; unshielded?: string; dust?: string }>; // In-flight saves by sequence number, resolved by `state-save-ack
    networkId: string;
    /** Indexer GraphQL HTTP URL, used to read the genuine sync target (tip). */
    indexerHttpUrl: string;
    /** The wallet configuration the facade's sub-wallets were built with; kept for dust snapshot restores. */
    walletConfiguration: any;
    /**
     * Dust sub-wallet state serialized BEFORE the current submission's build
     * (the build books the dust spend, so a pre-submit snapshot would already
     * carry the in-flight marker). Used to swap in a clean dust wallet after
     * a pre-mempool reject; see dust-pending-note-leak FR.
     */
    preSubmitDustSnapshot?: string;
    /** Bumped on every dust snapshot restore; lets the save tick drop a dust blob serialized from the pre-restore wallet. */
    dustEpoch?: number;
    /** Dust epoch each in-flight save's dust blob was serialized under (by seq); acks with a stale epoch must not advance the dust baseline. */
    dustSaveEpochs?: Map<number, number>;
    /** Snapshot restores whose re-persist the main thread CONFIRMED (state-save-ack). What getWalletBalance reports as dustRestoreCount. */
    dustRestoresPersisted?: number;
    // 32-byte session-stable secret for contracts that use the
    // `local_secret_key()` witness pattern (e.g. AttestationVault). Derived
    // once per facade build via deriveAttestationSecret(seedBytes).
    attestationSecret: Uint8Array;
}

export const facades = new Map<string, FacadeEntry>();

// ---- Logging back to main thread ------------------------------------------

export function log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    parentPort?.postMessage({ kind: 'log', level, message });
}

// Config parse warnings of THIS thread reach the main process like every
// other worker log line. In a real worker the snapshot is pinned and nothing
// is parsed here; the unit tests exercise the accessors unpinned.
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

// The dust wallet's CoreWallet API (functional spendCoins), used by the
// note-pool paths. Memoized as a PROMISE so concurrent first callers share
// one module evaluation.
export let cachedDustCore: Promise<any> | undefined;
export function loadDustCoreWallet(): Promise<any> {
    cachedDustCore ??= import('@midnightntwrk/wallet-sdk-dust-wallet/v1' as string).then((m: any) => m.CoreWallet);
    return cachedDustCore;
}

// The node client's effect API (dedicated per-submit node clients of the
// parallel sponsor path; `phased-submit.ts` drives its event stream itself).
// Memoized as a PROMISE, like loadDustCoreWallet.
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

// Loaded only when NIGHTGATE_PROVING_MODE=wasm; the default server path
// never touches the WASM prover module.
export async function loadProvingSdk(): Promise<any> {
    if (!cachedProving) {
        cachedProving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    }
    return cachedProving;
}

export type ProvingMode = 'server' | 'wasm';

/**
 * NIGHTGATE_PROVING_MODE selects how transactions are proved: 'server'
 * (default) proxies to the proof-server container at proofServerUrl; 'wasm'
 * proves in-process, with no proof server needed. Wallet proving goes through
 * the SDK's WASM prover; contract circuits go through our own
 * wasm-proof-provider (zkir over the contract's local key material). Proving
 * keys for the standard circuits are fetched from Midnight's S3 bucket into
 * ONE shared in-memory cache per worker (getSharedKeyMaterialProvider), so
 * they download once per process, not once per session.
 */
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

/**
 * SDK packages needed for contract deploy/call (Phase 2b). Loaded lazily on
 * the first deploy/call so the worker startup cost only covers the wallet
 * sync surface.
 */
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
        // The package's `exports` map exposes neither `./package.json` nor a
        // `require` condition, so require.resolve() throws for both the
        // subpath and the bare specifier. Locate the package.json on disk by
        // walking the module resolution paths instead.
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

/**
 * Bech32m-encodes a Midnight address object (Dust/Shielded/Unshielded) to its
 * canonical string via `MidnightBech32m.encode`, which reads the
 * `[Bech32mSymbol]` codec on each address class. Pre-encoded strings pass
 * through untouched.
 */
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

/**
 * Parses a Bech32m receiver string into the SDK's typed address object.
 * Discriminates on the `mn_shield-addr_` vs `mn_addr_` HRP prefix so callers
 * can build the matching `CombinedTokenTransfer` wrapper.
 */
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

