/**
 * Types for providers.mjs, so a direct import of that file is typed.
 * TypeScript only finds types for an `.mjs` file in a `.d.mts` file next to it.
 */
// This interface is written out here on purpose. zk-config.mjs ships without types,
// so importing its type would fail for users who type-check installed packages.
/** The part of a zk-config provider this module uses. */
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
