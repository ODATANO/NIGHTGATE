// Loads the Midnight JS SDK once with a dynamic `import()`, because the SDK is ESM only.
// Covers only the main thread. The wallet worker loads its own SDK packages.

import type * as IndexerSdk from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type * as LedgerV9 from '@midnightntwrk/ledger-v9';
import type * as LedgerV8 from '@midnightntwrk/ledger-v8';

type LedgerModule = typeof LedgerV9;

export interface MidnightSdkBundle {
    indexer: typeof IndexerSdk;
}

let cachedBundle: MidnightSdkBundle | undefined;
let inflight: Promise<MidnightSdkBundle> | undefined;

export async function loadMidnightSdk(): Promise<MidnightSdkBundle> {
    if (cachedBundle) return cachedBundle;
    if (inflight) return inflight;

    inflight = (async () => {
        const bundle: MidnightSdkBundle = { indexer: await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider') };
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
    cachedLedgerModule = undefined;
    inflightLedger = undefined;
    ledger8Module = undefined;
}

// The ledger package is loaded on its own because many callers need only the ledger.

/** First runtime `spec_version` whose blocks carry ledger 9 transactions. Older blocks carry ledger 8 ones. */
export const LEDGER_9_FIRST_SPEC_VERSION = 2_000_000;

let ledger8Module: Promise<typeof LedgerV8> | undefined;

/** The ledger of the generation before the fork, for transactions of blocks below `LEDGER_9_FIRST_SPEC_VERSION`. */
export function loadLedger8(): Promise<typeof LedgerV8> {
    ledger8Module ??= import('@midnightntwrk/ledger-v8');
    return ledger8Module;
}

let cachedLedgerModule: LedgerModule | undefined;
let inflightLedger: Promise<LedgerModule> | undefined;

export async function loadLedger(): Promise<LedgerModule> {
    if (cachedLedgerModule) return cachedLedgerModule;
    if (inflightLedger) return inflightLedger;
    inflightLedger = (async () => {
        const mod = await import('@midnightntwrk/ledger-v9');
        cachedLedgerModule = mod;
        return mod;
    })();
    try {
        return await inflightLedger;
    } finally {
        inflightLedger = undefined;
    }
}
