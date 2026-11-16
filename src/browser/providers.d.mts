/**
 * Types for providers.mjs, so a direct import of that file is typed.
 * TypeScript only finds types for an `.mjs` file in a `.d.mts` file next to it.
 */
import type { ZKConfigProvider, ZKConfigRegistry } from '@midnight-ntwrk/midnight-js-types';

/** Where the proof provider finds a circuit's files: one contract's provider, or a registry of several. */
export type KeyMaterialSource = ZKConfigProvider<string> | ZKConfigRegistry;

/**
 * Where proofs are made.
 *   'server' - on the proof server the wallet reports. This is the default.
 *   'wallet' - in the wallet. Throws if the wallet cannot prove.
 *   'auto'   - in the wallet if it can prove, else on the server.
 */
export type ProvingModality = 'server' | 'wallet' | 'auto';
/** Where proofs end up being made. 'none' when the wallet cannot prove and reports no proof server, so the app can only read. */
export type AssembledProvingModality = 'server' | 'wallet' | 'none';

export function createNightgateConnectorProviders(opts: {
    connector: any;
    manifest: { contracts: Array<{ name: string; zkConfigBaseUrl: string; circuits: string[] }> };
    /** The URL the manifest was loaded from. Needed when the manifest has relative URLs and the app runs on another origin. */
    manifestUrl?: string;
    contract: string;
    fetchFn?: typeof fetch;
    webSocket?: any;
    proving?: ProvingModality;
    expectedManifestHash?: string; // SHA-256 as 64 hex; optional; the compiler manifest the served files must match
}): Promise<Record<string, any> & { provingModality: AssembledProvingModality }>;

export function buildProofProvider(input: {
    proving?: ProvingModality;
    connector: any;
    zkConfigProvider: KeyMaterialSource;
    proverServerUri?: string;
    proofMod: any;
}): Promise<{ proofProvider: unknown | undefined; provingModality: AssembledProvingModality }>;
