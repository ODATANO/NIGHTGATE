/** The provider settings a contract call or a wallet needs. */

export type PrivateStateBackend = 'cap-db' | 'level';

export interface ContractProvidersConfig {
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    zkConfigPath: string; // absolute path to the contract's `src/managed/<name>/`
}

/** What the main thread reads from a session's wallet. Balancing and submitting run in the wallet worker. */
export interface WalletPublicKeys {
    getCoinPublicKey(): string;
    getEncryptionPublicKey(): string;
}

export interface WalletMaterial {
    accountId: string; // keeps each account's private contract state apart
    privateStoragePasswordProvider: () => Promise<string> | string;
    /** Older forms of the password, used only for reading. Data found with one is saved again under the current password. */
    privateStoragePasswordFallbacks?: () => Promise<string[]> | string[];
    walletAndMidnightProvider: WalletPublicKeys;
    privateStateBackend?: PrivateStateBackend; // default 'cap-db'
    // Safe to call more than once.
    ensureFacade?: () => Promise<void>;
}

