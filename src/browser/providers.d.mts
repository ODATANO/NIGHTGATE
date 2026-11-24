// Types for imports of './providers.mjs'. TypeScript looks for them in a `.d.mts` file.
// The actual declarations are in index.d.ts.
export { createNightgateConnectorProviders, buildProofProvider } from './index.js';
export type {
    AssembledProvingModality,
    ConnectorProvidersResult,
    ContractConnector,
    ContractManifest,
    HttpProofModule,
    KeyMaterialSource,
    ProvingModality
} from './index.js';
