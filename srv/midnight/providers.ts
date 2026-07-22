/**
 * Midnight provider bundle assembly.
 *
 * Builds the six-provider bundle the SDK expects. Two stages:
 *  - `buildContractProviders(cfg)`: wallet-free providers (publicData, zkConfig,
 *    proof). Safe to build on startup or per request.
 *  - `buildFullProviderBundle(cfg, wallet)`: adds privateState/wallet/midnight
 *    providers; needs a decrypted session-scoped password + accountId.
 * The split builds contract providers cheaply and only assembles wallet-bound
 * ones when a session is present.
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
    indexerHttpUrl: string; // Indexer GraphQL HTTP endpoint, e.g. `https://indexer.preprod.midnight.network/api/v4/graphql`
    indexerWsUrl: string; // Indexer GraphQL WS endpoint, e.g. `wss://indexer.preprod.midnight.network/api/v4/graphql/ws`
    proofServerUrl: string; // Proof server URL, e.g. `http://localhost:6300`
    zkConfigPath: string; //  Absolute path to the contract's `src/managed/<name>/` directory.
}

export interface WalletMaterial {
    accountId: string; // Stable identifier scoping private-state storage (wallet address)
    privateStoragePasswordProvider: () => Promise<string> | string; // passphrase used to encrypt private state on disk
    walletAndMidnightProvider: any; // Wallet+midnight provider built from the wallet-sdk-facade
    privateStateBackend?: PrivateStateBackend; // backend to use for the SDK's private-state provider (default: 'cap-db')
    // Idempotently initialises this wallet's facade in the worker
    ensureFacade?: () => Promise<void>;
}

/** Provider bundle without wallet-bound components. Safe to assemble eagerly. */
export interface ContractProviderBundle {
    publicDataProvider: any;
    zkConfigProvider: any;
    proofProvider: any;
}

/**
 * Full bundle in the shape the SDK's `deployContract` / `findDeployedContract`
 * expects. Includes wallet-bound providers.
 */
export interface MidnightProviderBundle extends ContractProviderBundle {
    privateStateProvider: any;
    walletProvider: any;
    midnightProvider: any;
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
        walletProvider: wallet.walletAndMidnightProvider,
        midnightProvider: wallet.walletAndMidnightProvider
    };
}

function validateContractProvidersConfig(cfg: ContractProvidersConfig): void {
    if (!cfg.indexerHttpUrl) throw new Error('indexerHttpUrl is required');
    if (!cfg.indexerWsUrl) throw new Error('indexerWsUrl is required');
    if (!cfg.proofServerUrl) throw new Error('proofServerUrl is required');
    if (!cfg.zkConfigPath) throw new Error('zkConfigPath is required');
}

function validateWalletMaterial(wallet: WalletMaterial): void {
    if (!wallet.accountId) throw new Error('walletMaterial.accountId is required');
    if (!wallet.privateStoragePasswordProvider) throw new Error('walletMaterial.privateStoragePasswordProvider is required');
    if (!wallet.walletAndMidnightProvider) throw new Error('walletMaterial.walletAndMidnightProvider is required');
}
