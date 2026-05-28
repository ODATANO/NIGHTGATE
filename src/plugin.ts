import cds from '@sap/cds';
import crypto from 'crypto';
import path from 'path';

import { initialize, shutdown, SchemaNotDeployedError } from './index';
import { getNightgatePluginConfig } from '../srv/utils/nightgate-config';

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

function registerSecurityHeaders(): void {
    cds.on('bootstrap', (app: any) => {
        const nightgateConfig = getNightgatePluginConfig();
        const corsOrigin = nightgateConfig.corsOrigin || '*';
        const strictCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
        const fioriPreviewCsp = [
            "default-src 'self' https://sapui5.hana.ondemand.com https://ui5.sap.com",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://sapui5.hana.ondemand.com https://ui5.sap.com",
            "style-src 'self' 'unsafe-inline' https://sapui5.hana.ondemand.com https://ui5.sap.com",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data: https://sapui5.hana.ondemand.com https://ui5.sap.com",
            "connect-src 'self' ws: wss: https://sapui5.hana.ondemand.com https://ui5.sap.com http://localhost:*"
        ].join('; ');
        const configuredCsp = typeof nightgateConfig.contentSecurityPolicy === 'string'
            ? nightgateConfig.contentSecurityPolicy
            : undefined;
        const cspDisabled = nightgateConfig.contentSecurityPolicy === false || nightgateConfig.contentSecurityPolicy === 'off';

        app.use((req: any, res: any, next: () => void) => {
            const isFioriPreview = typeof req.path === 'string' && req.path.startsWith('/$fiori-preview');
            const isFioriPreviewJs = isFioriPreview && typeof req.path === 'string' && /\.m?js$/i.test(req.path);
            const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
            req.correlationId = correlationId;
            res.setHeader('X-Correlation-ID', correlationId);

            res.setHeader('Access-Control-Allow-Origin', corsOrigin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, X-Correlation-ID');
            res.setHeader('Access-Control-Max-Age', '86400');

            if (!isFioriPreview) {
                res.setHeader('X-Content-Type-Options', 'nosniff');
            }
            res.setHeader('X-Frame-Options', isFioriPreview ? 'SAMEORIGIN' : 'DENY');
            res.setHeader('X-XSS-Protection', '0');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

            // CAP Fiori preview serves Component.js as plain text; force JS MIME for browser loaders.
            if (isFioriPreviewJs) {
                res.type('application/javascript; charset=utf-8');
            }

            // Some UI5 shell startup paths probe a root appconfig URL first.
            if (req.path === '/appconfig/fioriSandboxConfig.json') {
                res.redirect(307, '/$fiori-preview/appconfig/fioriSandboxConfig.json');
                return;
            }

            // Fiori preview bootstraps UI5 from SAP CDN and uses inline startup scripts.
            if (!cspDisabled) {
                res.setHeader('Content-Security-Policy', configuredCsp || (isFioriPreview ? fioriPreviewCsp : strictCsp));
            }

            if (process.env.NODE_ENV === 'production') {
                res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            }

            if (req.method === 'OPTIONS') {
                res.status(204).end();
                return;
            }

            next();
        });
    });
}

function registerLifecycle(): void {
    cds.on('served', async () => {
        try {
            await initialize();
        } catch (err) {
            // SchemaNotDeployedError is the only fatal error initialize() raises.
            // Print a big, instruction-first block and exit non-zero so the
            // operator notices, instead of silently half-booting against a stale
            // schema (the old auto-deploy path would do that on every restart).
            if (err instanceof SchemaNotDeployedError) {
                console.error('\n');
                console.error('================================================================');
                console.error('  NIGHTGATE: schema not deployed');
                console.error('================================================================');
                console.error(`  ${err.message}`);
                console.error('');
                console.error('  Run this from the project root:');
                console.error('');
                console.error('      npm run deploy');
                console.error('');
                console.error('================================================================\n');
                process.exit(1);
            }
            // Anything else: surface but don't kill the server — initialize()
            // already wraps its own soft failures (sqlite tuning, wallet worker,
            // crawler) in try/catch internally.
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[odatano-nightgate] initialize() failed: ${msg}`);
        }
    });

    cds.on('shutdown', async () => {
        await shutdown();
    });
}

if (!registered) {
    registerModels();
    registerSecurityHeaders();
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
                        description: 'Target Midnight network: testnet | preprod | mainnet. Override via NIGHTGATE_NETWORK env var.',
                        type: 'string',
                        enum: ['testnet', 'preprod', 'mainnet'],
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
                                artifactPath:   { type: 'string', description: 'Path to the Compact-emitted contract module (e.g. contracts/<name>/src/managed/<name>/contract/index.js)' },
                                privateStateId: { type: 'string', description: 'Logical private-state identifier passed to deployContract' },
                                zkConfigPath:   { type: 'string', description: 'Path to the managed/<name>/ directory containing keys + zkir' }
                            },
                            required: ['artifactPath', 'privateStateId', 'zkConfigPath']
                        }
                    },
                    contentSecurityPolicy: {
                        description: "Optional custom CSP header value. Use 'off' to disable CSP. Defaults to strict API policy and relaxed UI5 policy for /$fiori-preview/*.",
                        type: 'string'
                    },
                    crawler: {
                        description: 'Crawler settings (default: enabled, crawls from Midnight node)',
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', description: 'Enable active crawler (default: true)' },
                            nodeUrl: { type: 'string', description: 'Override node URL for crawler (default: uses top-level nodeUrl). Override via NIGHTGATE_CRAWLER_NODE_URL env var.' },
                            batchSize: { type: 'number', description: 'Blocks per batch during catch-up (default: 10)' },
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