import cds from '@sap/cds';
import crypto from 'crypto';
import path from 'path';

import { initialize, shutdown } from './index';

const pluginRoot = path.resolve(__dirname, '..');

let registered = false;

function registerModels(): void {
    cds.env.roots = [...(cds.env.roots || []), pluginRoot];

    const requires = ((cds.env as unknown as {
        requires?: Record<string, any>;
    }).requires ??= {});

    requires.midnight ??= {};

    requires.midnight.model = [
        path.join(pluginRoot, 'db'),
        path.join(pluginRoot, 'srv')
    ];
}

function registerSecurityHeaders(): void {
    cds.on('bootstrap', (app: any) => {
        const midnightConfig = (cds.env as any).requires?.midnight || {};
        const corsOrigin = midnightConfig.corsOrigin || '*';

        app.use((req: any, res: any, next: () => void) => {
            const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
            req.correlationId = correlationId;
            res.setHeader('X-Correlation-ID', correlationId);

            res.setHeader('Access-Control-Allow-Origin', corsOrigin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
            res.setHeader('Access-Control-Max-Age', '86400');

            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '0');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");

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
        await initialize();
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
            'cds.requires.midnight': {
                description: 'Midnight Network Configuration for @odatano/night-indexer',
                properties: {
                    network: {
                        description: 'Midnight network: testnet | mainnet',
                        type: 'string',
                        enum: ['testnet', 'mainnet']
                    },
                    nodeUrl: {
                        description: 'Midnight Node Substrate RPC endpoint (default: ws://localhost:9944). The indexer crawls blocks directly from the node.',
                        type: 'string'
                    },
                    crawler: {
                        description: 'Crawler settings (default: enabled, crawls from Midnight node)',
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', description: 'Enable active crawler (default: true)' },
                            nodeUrl: { type: 'string', description: 'Override node URL for crawler (default: uses top-level nodeUrl)' },
                            batchSize: { type: 'number', description: 'Blocks per batch during catch-up (default: 10)' },
                            requestTimeout: { type: 'number', description: 'RPC request timeout ms (default: 30000)' }
                        }
                    }
                }
            }
        }
    }
};

export default plugin;