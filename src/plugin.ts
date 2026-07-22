import cds from '@sap/cds';
import path from 'path';

import { initialize, shutdown, SchemaNotDeployedError } from './index';
const log = cds.log('nightgate');
import { mountZkConfigRoute, mountContractManifestRoute } from './connector-routes';

const pluginRoot = path.resolve(__dirname, '..');

let registered = false;

function registerModels(): void {
    cds.env.roots = [...(cds.env.roots || []), pluginRoot];

    const requires = ((cds.env as unknown as {
        requires?: Record<string, any>;
    }).requires ??= {});

    const modelPaths = [
        path.join(pluginRoot, 'db'),
        path.join(pluginRoot, 'srv')
    ];

    requires.nightgate ??= {};
    requires.nightgate.model = modelPaths;
}

function registerConnectorRoutes(): void {
    cds.on('bootstrap', (app: any) => {
        // HTTP policy belongs to the consuming CAP host. NIGHTGATE only owns
        // these connector endpoints and does not install global middleware.
        mountZkConfigRoute(app);
        mountContractManifestRoute(app);
    });
}

function registerLifecycle(): void {
    cds.on('served', async () => {
        if (process.env.SKIP_AUTO_INIT === 'true') return;
        try {
            await initialize();
        } catch (err) {
            // A plugin must not terminate the CAP host process. Keep Nightgate
            // offline (initialize() records the error state) and let the host's
            // readiness/deployment policy decide whether the process is viable.
            if (err instanceof SchemaNotDeployedError) {
                log.error(
                    `Nightgate remains offline because its schema is not deployed. ` +
                    `${err.message}`
                );
                return;
            }
            // Anything else: surface Error but don't kill the server.
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`initialize() failed: ${msg}`);
        }
    });

    cds.on('shutdown', async () => {
        await shutdown();
    });
}

if (!registered) {
    registerModels();
    registerConnectorRoutes();
    registerLifecycle();
    registered = true;
}

const plugin = {
    cds: {
        schema: {
            'cds.requires.nightgate': {
                description: 'Nightgate configuration for @odatano/nightgate',
                properties: {
                    network: {
                        description: 'Target Midnight network: testnet | preview | preprod | mainnet | undeployed. "undeployed" is a local standalone stack (midnight-local-dev). Override via NIGHTGATE_NETWORK env var.',
                        type: 'string',
                        enum: ['testnet', 'preview', 'preprod', 'mainnet', 'undeployed'],
                        default: 'preprod'
                    },
                    nodeUrl: {
                        description: 'Midnight Node Substrate RPC endpoint. Override via NIGHTGATE_NODE_URL env var.',
                        type: 'string',
                        default: 'wss://rpc.preprod.midnight.network/'
                    },
                    indexerHttpUrl: {
                        description: 'Midnight Indexer GraphQL HTTP endpoint (used by the submission path for publicDataProvider). Override via NIGHTGATE_INDEXER_HTTP_URL env var.',
                        type: 'string',
                        default: 'https://indexer.preprod.midnight.network/api/v4/graphql'
                    },
                    indexerWsUrl: {
                        description: 'Midnight Indexer GraphQL WebSocket endpoint (used by the submission path for subscriptions). Override via NIGHTGATE_INDEXER_WS_URL env var.',
                        type: 'string',
                        default: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws'
                    },
                    proofServerUrl: {
                        description: 'Proof server URL. Required only for contract deploy/call submission. Override via NIGHTGATE_PROOF_SERVER_URL env var.',
                        type: 'string',
                        default: 'http://localhost:6300'
                    },
                    zkConfigBasePath: {
                        description: 'Base directory containing contract managed/ artifacts (keys + zkIR). Resolved per contract by appending the contract name. Override via NIGHTGATE_ZK_CONFIG_BASE env var.',
                        type: 'string',
                        default: './contracts'
                    },
                    privateStateBackend: {
                        description: "Backend for the SDK private-state provider. 'cap-db' (default): encrypted CAP-DB-backed provider, persistent, production-grade. 'level': SDK's bundled LevelDB provider (dev-only; the SDK docs explicitly warn against production use). Override via NIGHTGATE_PRIVATE_STATE_BACKEND env var.",
                        type: 'string',
                        enum: ['cap-db', 'level'],
                        default: 'cap-db'
                    },
                    contracts: {
                        description: "Registered Compact contracts. Keys are logical refs used in deployContract/submitContractCall actions. Each entry: { artifactPath, privateStateId, zkConfigPath } (paths absolute or relative to cwd).",
                        type: 'object',
                        additionalProperties: {
                            type: 'object',
                            properties: {
                                artifactPath: { type: 'string', description: 'Path to the Compact-emitted contract module (e.g. contracts/<name>/src/managed/<name>/contract/index.js)' },
                                privateStateId: { type: 'string', description: 'Logical private-state identifier passed to deployContract' },
                                zkConfigPath: { type: 'string', description: 'Path to the managed/<name>/ directory containing keys + zkir' }
                            },
                            required: ['artifactPath', 'privateStateId', 'zkConfigPath']
                        }
                    },
                    allowMainnetSubmission: {
                        description: 'Safety gate for mainnet. Default false: on-chain submission actions reject when network is "mainnet" unless this is explicitly true. Mainnet has known submission instability (1016 Immediately Dropped, forum thread 1190). Read-only indexing is unaffected.',
                        type: 'boolean',
                        default: false
                    },
                    sessionTtlMs: {
                        description: 'Wallet-session time-to-live in milliseconds before a connected session is treated as expired by the cleanup sweep.',
                        type: 'number'
                    },
                    runtimeMode: {
                        description: "Runtime safety contract. Only 'single-instance' is currently supported.",
                        type: 'string',
                        enum: ['single-instance'],
                        default: 'single-instance'
                    },
                    replicaCount: {
                        description: 'Declared Nightgate process/replica count. Must be exactly 1 until distributed leases are implemented.',
                        type: 'number',
                        minimum: 1,
                        default: 1
                    },
                    allowProductionSqlite: {
                        description: 'Emergency-only compatibility override for production SQLite. Defaults to false; prefer PostgreSQL or SAP HANA.',
                        type: 'boolean',
                        default: false
                    },
                    crawler: {
                        description: 'Crawler settings (default: enabled, crawls from Midnight node)',
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', description: 'Enable active crawler (default: true)' },
                            nodeUrl: { type: 'string', description: 'Override node URL for crawler (default: uses top-level nodeUrl). Override via NIGHTGATE_CRAWLER_NODE_URL env var.' },
                            batchSize: { type: 'number', description: 'Blocks per batch during catch-up (default: 10)' },
                            fetchConcurrency: { type: 'number', description: 'Parallel block-fetch requests during catch-up. Override via NIGHTGATE_CRAWLER_FETCH_CONCURRENCY env var.' },
                            rpcBatchSize: { type: 'number', description: 'Batched JSON-RPC calls per round during catch-up. Override via NIGHTGATE_CRAWLER_RPC_BATCH_SIZE env var.' },
                            maxRetries: { type: 'number', description: 'Max retries per block before error (default: 3)' },
                            retryDelay: { type: 'number', description: 'Base retry delay in ms (default: 2000)' },
                            requestTimeout: { type: 'number', description: 'RPC request timeout ms (default: 30000)' }
                        }
                    }
                }
            }
        }
    }
};

export default plugin;
