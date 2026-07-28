/**
 * Memoized dynamic-import loader for the Midnight JS SDK.
 *
 * The SDK is pure ESM (terminates at `@midnight-ntwrk/compact-runtime`, no CJS
 * export); NIGHTGATE is CommonJS, so a top-level `import` compiles to `require()`
 * and fails at runtime. Load once via dynamic `import()`, cache the namespaces,
 * reuse. Call sites await `loadMidnightSdk()`; only the first call is async.
 *
 * Scope: the MAIN-thread provider surface only (providers.ts). The wallet
 * worker loads its own SDK set inside the worker thread (wallet-worker.ts),
 * so heavyweight packages the main thread never touches (contracts, facade,
 * wallet sub-wallets) are deliberately NOT part of this bundle.
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
