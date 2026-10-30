/** The SDK network id and the provider settings a contract call or a wallet needs. */

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

