/** The provider settings a contract call or a wallet needs. */

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
    walletAndMidnightProvider: WalletPublicKeys;
    // Safe to call more than once.
    ensureFacade?: () => Promise<void>;
}

