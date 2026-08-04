/**
 * Types for providers.mjs. The package's public surface is declared in index.d.ts; this sibling
 * exists so the deep path (`@odatano/nightgate/browser/providers.mjs`) and the unit suite are typed
 * too — NodeNext resolves declarations for an `.mjs` file only from a `.d.mts` next to it.
 */
// Structural, NOT `import type { FetchZkConfigProvider } from './zk-config.mjs'`: that module ships
// as plain .mjs with no declaration sibling, so importing from it makes this file error under a
// consumer's `skipLibCheck: false` ("implicitly has an 'any' type"). The repo's own typecheck hides
// that (skipLibCheck is on); only an installed-package typecheck catches it — see
// scripts/check-package-exports.mjs for why packaging is verified against the real tarball.
/** What this module needs from a zk-config provider: the wallet's key-material view. */
export interface KeyMaterialSource {
    asKeyMaterialProvider(): unknown;
}

export type ProvingModality = 'server' | 'wallet' | 'auto';
export type AssembledProvingModality = 'server' | 'wallet' | 'none';

export function createNightgateConnectorProviders(opts: {
    connector: any;
    manifest: { contracts: Array<{ name: string; zkConfigBaseUrl: string; circuits: string[] }> };
    contract: string;
    fetchFn?: typeof fetch;
    webSocket?: any;
    proving?: ProvingModality;
}): Promise<Record<string, any> & { provingModality: AssembledProvingModality }>;

export function buildProofProvider(input: {
    proving?: ProvingModality;
    connector: any;
    zkConfigProvider: KeyMaterialSource;
    proverServerUri?: string;
    proofMod: any;
}): Promise<{ proofProvider: unknown | undefined; provingModality: AssembledProvingModality }>;
