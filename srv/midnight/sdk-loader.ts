/**
 * Loads the Midnight JS SDK once and caches it.
 * The SDK is ESM only and this project is CommonJS, so a normal import would fail.
 * A dynamic `import()` works.
 * This covers only what the main thread needs. The wallet worker loads its own SDK packages.
 */

type MidnightSdkIndexerProvider = any;
type MidnightSdkProofProvider = any;
type MidnightSdkZkConfig = any;
type MidnightSdkLevelState = any;
type LedgerV8 = any;

export interface MidnightSdkBundle {
    indexer: MidnightSdkIndexerProvider;
    proof: MidnightSdkProofProvider;
    zk: MidnightSdkZkConfig;
    level: MidnightSdkLevelState;
}

let cachedBundle: MidnightSdkBundle | undefined;
let inflight: Promise<MidnightSdkBundle> | undefined;

export async function loadMidnightSdk(): Promise<MidnightSdkBundle> {
    if (cachedBundle) return cachedBundle;
    if (inflight) return inflight;

    inflight = (async () => {
        const [indexer, proof, zk, level] = await Promise.all([
            import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
            import('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
            import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
            import('@midnight-ntwrk/midnight-js-level-private-state-provider')
        ]);
        const bundle: MidnightSdkBundle = { indexer, proof, zk, level };
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
}

// The ledger package is loaded on its own because many callers need only the ledger.

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
