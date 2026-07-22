/**
 * Memoized dynamic-import loader for the Midnight JS SDK.
 *
 * The SDK is pure ESM (terminates at `@midnight-ntwrk/compact-runtime`, no CJS
 * export); NIGHTGATE is CommonJS, so a top-level `import` compiles to `require()`
 * and fails at runtime. Load once via dynamic `import()`, cache the namespaces,
 * reuse. Call sites await `loadMidnightSdk()`; only the first call is async.
 */

type MidnightSdkContracts = any;
type MidnightSdkIndexerProvider = any;
type MidnightSdkProofProvider = any;
type MidnightSdkZkConfig = any;
type MidnightSdkLevelState = any;
type MidnightSdkWalletFacade = any;
type LedgerV8 = any;
type WalletSdkShielded = any;
type WalletSdkUnshielded = any;
type WalletSdkDust = any;
type WalletSdkAbstractions = any;

export interface MidnightSdkBundle {
    contracts: MidnightSdkContracts;
    indexer: MidnightSdkIndexerProvider;
    proof: MidnightSdkProofProvider;
    zk: MidnightSdkZkConfig;
    level: MidnightSdkLevelState;
    facade: MidnightSdkWalletFacade;
}

let cachedBundle: MidnightSdkBundle | undefined;
let inflight: Promise<MidnightSdkBundle> | undefined;

export async function loadMidnightSdk(): Promise<MidnightSdkBundle> {
    if (cachedBundle) return cachedBundle;
    if (inflight) return inflight;

    inflight = (async () => {
        const [contracts, indexer, proof, zk, level, facade] = await Promise.all([
            import('@midnight-ntwrk/midnight-js-contracts'),
            import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
            import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
            import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
            import('@midnight-ntwrk/midnight-js-level-private-state-provider'),
            import('@midnightntwrk/wallet-sdk-facade')
        ]);
        const bundle: MidnightSdkBundle = { contracts, indexer, proof, zk, level, facade };
        cachedBundle = bundle;
        return bundle;
    })();

    try {
        return await inflight;
    } finally {
        inflight = undefined;
    }
}

export function resetMidnightSdkCache(): void {
    cachedBundle = undefined;
    inflight = undefined;
    cachedLedgerV8 = undefined;
    inflightLedger = undefined;
    cachedWalletSdk = undefined;
    inflightWalletSdk = undefined;
}

// ---- ledger-v8 ----
// Loaded separately because not every code path needs the rest of the SDK.

let cachedLedgerV8: LedgerV8 | undefined;
let inflightLedger: Promise<LedgerV8> | undefined;

export async function loadLedgerV8(): Promise<LedgerV8> {
    if (cachedLedgerV8) return cachedLedgerV8;
    if (inflightLedger) return inflightLedger;
    inflightLedger = (async () => {
        const mod = await import('@midnight-ntwrk/ledger-v8');
        cachedLedgerV8 = mod;
        return mod;
    })();
    try {
        return await inflightLedger;
    } finally {
        inflightLedger = undefined;
    }
}

// ---- wallet-sdk packages (for WalletFacade construction) ----

export interface WalletSdkBundle {
    shielded: WalletSdkShielded;
    unshielded: WalletSdkUnshielded;
    dust: WalletSdkDust;
    abstractions: WalletSdkAbstractions;
}

let cachedWalletSdk: WalletSdkBundle | undefined;
let inflightWalletSdk: Promise<WalletSdkBundle> | undefined;

export async function loadWalletSdk(): Promise<WalletSdkBundle> {
    if (cachedWalletSdk) return cachedWalletSdk;
    if (inflightWalletSdk) return inflightWalletSdk;
    inflightWalletSdk = (async () => {
        const [shielded, unshielded, dust, abstractions] = await Promise.all([
            import('@midnightntwrk/wallet-sdk-shielded'),
            import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
            import('@midnightntwrk/wallet-sdk-dust-wallet'),
            import('@midnightntwrk/wallet-sdk-abstractions')
        ]);
        const bundle: WalletSdkBundle = { shielded, unshielded, dust, abstractions };
        cachedWalletSdk = bundle;
        return bundle;
    })();
    try {
        return await inflightWalletSdk;
    } finally {
        inflightWalletSdk = undefined;
    }
}
