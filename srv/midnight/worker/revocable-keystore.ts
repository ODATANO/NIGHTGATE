import type { UnshieldedKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';

/** A keystore that can drop its key. The SDK's keystore keeps a hex string of the secret, which no wipe reaches. */
export interface RevocableKeystore extends UnshieldedKeystore {
    revoke(): void;
}

export function revocableKeystore(inner: UnshieldedKeystore): RevocableKeystore {
    let current: UnshieldedKeystore | undefined = inner;
    const use = (): UnshieldedKeystore => {
        if (!current) throw new Error('the wallet was unloaded and its signing key dropped');
        return current;
    };
    return {
        getSecretKey: () => use().getSecretKey(),
        getBech32Address: () => use().getBech32Address(),
        getPublicKey: () => use().getPublicKey(),
        getAddress: () => use().getAddress(),
        signData: (data) => use().signData(data),
        signDataAsync: async (data) => use().signData(data),
        revoke: () => { current = undefined; }
    };
}
