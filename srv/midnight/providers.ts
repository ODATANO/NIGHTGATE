/** Builds the set of Midnight SDK providers a contract needs. Wallet providers are added when a wallet is available. */

import WebSocket from 'ws';
import { loadMidnightSdk } from './sdk-loader';
import { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';
import { isWasmProvingMode, buildWasmProofProvider } from './wasm-proof-provider';
import { proofRequestTimeoutMs } from '../utils/proof-timeout';

/** Sets the SDK's network id for the whole process. Call it before any other SDK call. */
let lastSetNetworkId: string | undefined;
export async function ensureNetworkId(network: string): Promise<void> {
    if (lastSetNetworkId === network) return;
    const mod: any = await import('@midnight-ntwrk/midnight-js-network-id');
    mod.setNetworkId(network);
    lastSetNetworkId = network;
}

export type PrivateStateBackend = 'cap-db' | 'level';

export interface ContractProvidersConfig {
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    zkConfigPath: string; // absolute path to the contract's `src/managed/<name>/`
}

export interface WalletMaterial {
    accountId: string; // keeps each account's private contract state apart
    privateStoragePasswordProvider: () => Promise<string> | string;
    /** Older forms of the password, used only for reading. Data found with one is saved again under the current password. */
    privateStoragePasswordFallbacks?: () => Promise<string[]> | string[];
    walletAndMidnightProvider: any;
    privateStateBackend?: PrivateStateBackend; // default 'cap-db'
    // Safe to call more than once.
    ensureFacade?: () => Promise<void>;
}

export interface ContractProviderBundle {
    publicDataProvider: any;
    zkConfigProvider: any;
    proofProvider: any;
}

/** All providers that `deployContract` and `findDeployedContract` expect. */
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
    const proofProvider = isWasmProvingMode()
        ? await buildWasmProofProvider(zkConfigProvider)
        : sdk.proof.httpClientProofProvider(cfg.proofServerUrl, zkConfigProvider as any, { timeout: proofRequestTimeoutMs() });

    return { publicDataProvider, zkConfigProvider, proofProvider };
}

/**
 * The SDK's password rules for LevelDB storage reject a plain hex string.
 * This turns the hex into an accepted password. The same input always gives the same result.
 */
export function levelStoragePassword(password: string): string {
    const pairs = password.match(/.{1,2}/g) ?? [password];
    return `${pairs.join('-')}-Ng`;
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
            privateStoragePasswordProvider: checkedPasswordProvider,
            privateStoragePasswordFallbacks: wallet.privateStoragePasswordFallbacks
        });
    } else {
        const sdk = await loadMidnightSdk();
        privateStateProvider = sdk.level.levelPrivateStateProvider({
            accountId: wallet.accountId,
            privateStoragePasswordProvider: async () => levelStoragePassword(await checkedPasswordProvider())
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
