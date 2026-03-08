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

    const modelPaths = [
        path.join(pluginRoot, 'db'),
        path.join(pluginRoot, 'srv')
    ];

    requires.nightgate ??= {};
    requires.nightgate.model = modelPaths;
}

function registerSecurityHeaders(): void {
    cds.on('bootstrap', (app: any) => {
        const nightgateConfig = (cds.env as any).requires?.nightgate || {};
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
            'cds.requires.nightgate': {
                description: 'Nightgate configuration for @odatano/nightgate',
                properties: {
                    network: {
                        description: 'Target Midnight network: testnet | mainnet',
                        type: 'string',
                        enum: ['testnet', 'mainnet']
                    },
                    nodeUrl: {
                        description: 'Midnight Node Substrate RPC endpoint (default: ws://localhost:9944). The indexer crawls blocks directly from the node.',
                        type: 'string'
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
                            nodeUrl: { type: 'string', description: 'Override node URL for crawler (default: uses top-level nodeUrl)' },
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