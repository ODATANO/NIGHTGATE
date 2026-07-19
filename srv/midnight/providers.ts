/**
 * Midnight provider bundle assembly.
 *
 * Builds the six-provider bundle the Midnight JS SDK expects (per the Counter
 * CLI tutorial): privateState, publicData, zkConfig, proof, wallet, midnight.
 *
 * Split into two stages:
 *
 *  - `buildContractProviders(cfg)`, providers that need no wallet material:
 *    `publicDataProvider`, `zkConfigProvider`, `proofProvider`. Safe to build
 *    on plugin startup or per request.
 *
 *  - `buildFullProviderBundle(cfg, walletMaterial)`, augments the above with
 *    `privateStateProvider`, `walletProvider`, `midnightProvider`. Requires a
 *    decrypted session-scoped passwordProvider + accountId from the wallet
 *    material factory.
 *
 * The two-stage split lets submission construct contract providers cheaply and
 * only assemble wallet-bound providers when an active session is present.
 */

import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';
import { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';

/**
 * The Midnight SDK keeps the active network as process-global state (see
 * `@midnight-ntwrk/midnight-js-network-id`). Every wallet/contract call reads
 * it via `getNetworkId()` and throws "Network ID has not been configured" if
 * it was never set. Call this before any SDK invocation. Idempotent.
 */
let lastSetNetworkId: string | undefined;
export async function ensureNetworkId(network: string): Promise<void> {
    if (lastSetNetworkId === network) return;
    const mod: any = await import('@midnight-ntwrk/midnight-js-network-id');
    mod.setNetworkId(network);
    lastSetNetworkId = network;
}

export type PrivateStateBackend = 'cap-db' | 'level';

export interface ContractProvidersConfig {
    /** Indexer GraphQL HTTP endpoint, e.g. `https://indexer.preprod.midnight.network/api/v4/graphql` */
    indexerHttpUrl: string;
    /** Indexer GraphQL WS endpoint, e.g. `wss://indexer.preprod.midnight.network/api/v4/graphql/ws` */
    indexerWsUrl: string;
    /** Proof server URL, e.g. `http://localhost:6300` */
    proofServerUrl: string;
    /**
     * Absolute path to the contract's `src/managed/<name>/` directory.
     * Contains the `keys/` and `zkir/` subdirectories the SDK reads.
     */
    zkConfigPath: string;
}

export interface WalletMaterial {
    /**
     * Stable identifier scoping private-state storage; typically the wallet
     * address. The SDK's LevelDB provider hashes it; our CAP-DB provider
     * stores it as-is and uses it as part of the row key.
     */
    accountId: string;
    /**
     * Returns the passphrase used to encrypt private state on disk. Must be
     * ≥16 chars. NIGHTGATE derives this from the wallet session, never from
     * public key material.
     */
    privateStoragePasswordProvider: () => Promise<string> | string;
    /**
     * Wallet+midnight provider built from the wallet-sdk-facade. The same
     * instance is reused for both `walletProvider` and `midnightProvider`
     * slots per the Counter CLI pattern.
     *
     * Typed `any` (not `unknown`) because the underlying SDK interfaces
     * (`WalletProvider & MidnightProvider` from `@midnight-ntwrk/midnight-js-types`)
     * are ESM-only and we don't want to pull them into CommonJS code just to
     * satisfy `.getCoinPublicKey()` etc. callsites. Duck-typed at runtime.
     */
    walletAndMidnightProvider: any;
    /**
     * Which backend to use for the SDK's private-state provider.
     * - 'cap-db' (default): NIGHTGATE's encrypted CAP-DB-backed provider.
     *   Persistent, multi-user safe, production-grade.
     * - 'level': SDK's bundled LevelDB provider. Dev-only, SDK docs explicitly
     *   warn against use with real assets ("clearing local files permanently
     *   destroys the private state").
     */
    privateStateBackend?: PrivateStateBackend;
    /**
     * Idempotently initialises this wallet's facade in the worker (same call
     * the connectWalletForSigning prewarm makes). Present when the session
     * carries signing material and a facade config. Submission jobs call it
     * before dispatching so a session that was never prewarmed (or whose
     * facade was evicted) does not fail with "No facade for sessionId".
     */
    ensureFacade?: () => Promise<void>;
}

/**
 * Provider bundle without wallet-bound components. Safe to assemble eagerly.
 *
 * Fields are typed `any` (not `unknown`), the SDK consumes these via duck
 * typing, and the real types live in the ESM-only `@midnight-ntwrk/*` packages.
 */
export interface ContractProviderBundle {
    publicDataProvider: any;
    zkConfigProvider:   any;
    proofProvider:      any;
}

/**
 * Full bundle in the shape the SDK's `deployContract` / `findDeployedContract`
 * expects. Includes wallet-bound providers.
 */
export interface MidnightProviderBundle extends ContractProviderBundle {
    privateStateProvider: any;
    walletProvider:       any;
    midnightProvider:     any;
}

export async function buildContractProviders(cfg: ContractProvidersConfig): Promise<ContractProviderBundle> {
    validateContractProvidersConfig(cfg);
    const sdk = await loadMidnightSdk();

    const zkConfigProvider = new sdk.zk.NodeZkConfigProvider(cfg.zkConfigPath);
    const publicDataProvider = sdk.indexer.indexerPublicDataProvider(
        cfg.indexerHttpUrl,
        cfg.indexerWsUrl,
        // Node has no built-in WebSocket; pass `ws` explicitly.
        WebSocket as unknown as typeof import('isomorphic-ws').WebSocket
    );
    const proofProvider = sdk.proof.httpClientProofProvider(cfg.proofServerUrl, zkConfigProvider as any);

    return { publicDataProvider, zkConfigProvider, proofProvider };
}

export async function buildFullProviderBundle(
    cfg: ContractProvidersConfig,
    wallet: WalletMaterial
): Promise<MidnightProviderBundle> {
    validateWalletMaterial(wallet);
    const contractProviders = await buildContractProviders(cfg);
    const backend: PrivateStateBackend = wallet.privateStateBackend ?? 'cap-db';

    const checkedPasswordProvider = async () => {
        const pw = await wallet.privateStoragePasswordProvider();
        if (typeof pw !== 'string' || pw.length < 16) {
            throw new Error('Private storage password must be a string of at least 16 characters');
        }
        return pw;
    };

    let privateStateProvider: unknown;
    if (backend === 'cap-db') {
        privateStateProvider = new CapDbPrivateStateProvider({
            accountId: wallet.accountId,
            privateStoragePasswordProvider: checkedPasswordProvider
        });
    } else {
        const sdk = await loadMidnightSdk();
        privateStateProvider = sdk.level.levelPrivateStateProvider({
            accountId: wallet.accountId,
            privateStoragePasswordProvider: checkedPasswordProvider
        });
    }

    return {
        ...contractProviders,
        privateStateProvider,
        walletProvider:   wallet.walletAndMidnightProvider,
        midnightProvider: wallet.walletAndMidnightProvider
    };
}

function validateContractProvidersConfig(cfg: ContractProvidersConfig): void {
    if (!cfg.indexerHttpUrl)  throw new Error('indexerHttpUrl is required');
    if (!cfg.indexerWsUrl)    throw new Error('indexerWsUrl is required');
    if (!cfg.proofServerUrl)  throw new Error('proofServerUrl is required');
    if (!cfg.zkConfigPath)    throw new Error('zkConfigPath is required');
}

function validateWalletMaterial(wallet: WalletMaterial): void {
    if (!wallet.accountId)                     throw new Error('walletMaterial.accountId is required');
    if (!wallet.privateStoragePasswordProvider) throw new Error('walletMaterial.privateStoragePasswordProvider is required');
    if (!wallet.walletAndMidnightProvider)     throw new Error('walletMaterial.walletAndMidnightProvider is required');
}
