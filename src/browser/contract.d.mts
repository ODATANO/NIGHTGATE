// Types for imports of './contract.mjs'. TypeScript looks for them in a `.d.mts` file.
// The actual declarations are in index.d.ts.
export { connectContract } from './index.js';
export type {
    ConnectContractOptions,
    ConnectedContract,
    ContractBatchOptions,
    ContractCall,
    ContractConnector,
    ContractDeployInput,
    ContractManifest,
    ContractTxResult
} from './index.js';
