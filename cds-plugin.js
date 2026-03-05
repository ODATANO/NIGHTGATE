/**
 * @odatano/night-indexer — CAP Plugin Entry Point
 *
 * CAP loads this file automatically when @odatano/night-indexer is in node_modules.
 * Registers Midnight indexer services: blockchain data, crawler, analytics, admin.
 *
 * This package does NOT include attestation/ZK-proof functionality.
 * For attestations, install @odatano/night-attestation.
 */

const cds = require('@sap/cds');
const path = require('path');
const crypto = require('crypto');

// Register plugin model paths so CAP discovers our CDS files
const pluginRoot = __dirname;
cds.env.roots = [...(cds.env.roots || []), pluginRoot];

// Register midnight service kind
cds.env.requires ??= {};
cds.env.requires.kinds ??= {};
cds.env.requires.kinds.midnight = {
  impl: path.join(pluginRoot, 'lib', 'types', 'midnight.js')
};

// Ensure midnight requires entry exists (may already exist from package.json)
cds.env.requires['midnight'] ??= { kind: 'midnight' };

// Plugin always contributes models regardless of configuration state
cds.env.requires['midnight'].model = [
  path.join(pluginRoot, 'db'),
  path.join(pluginRoot, 'srv')
];

// Security headers middleware — applied to all requests via CAP's Express bootstrap
cds.on('bootstrap', (app) => {
  const midnightConfig = cds.env.requires?.midnight || {};
  const corsOrigin = midnightConfig.corsOrigin || '*';

  app.use((req, res, next) => {
    // Correlation ID — propagate from header or generate new
    const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");

    // HSTS in production
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  });
});

// Lifecycle: Initialize Indexer on server start
cds.on('served', async () => {
  const midnightConfig = cds.env.requires?.midnight;
  if (!midnightConfig || midnightConfig.kind === 'midnight' && !midnightConfig.network) {
    // Plugin installed but not configured — skip silently
    return;
  }

  const network = midnightConfig.network || 'testnet';
  const nodeUrl = midnightConfig.nodeUrl || 'ws://localhost:9944';

  // Validate configuration
  const validNetworks = ['testnet', 'mainnet'];
  if (!validNetworks.includes(network)) {
    console.error(`[odatano-night-indexer] Invalid network "${network}". Must be one of: ${validNetworks.join(', ')}`);
    console.error(`[odatano-night-indexer] Falling back to "testnet"`);
    midnightConfig.network = 'testnet';
  }
  if (nodeUrl && !nodeUrl.match(/^wss?:\/\/.+/)) {
    console.warn(`[odatano-night-indexer] nodeUrl "${nodeUrl}" does not look like a WebSocket URL (expected ws:// or wss://)`);
  }

  // Verify DB schema exists (auto-deploy for SQLite)
  try {
    const db = await cds.connect.to('db');
    const { SELECT } = cds.ql;
    await db.run(SELECT.one.from('midnight.Blocks'));
  } catch (schemaErr) {
    console.warn('[odatano-night-indexer] DB schema not deployed — running auto-deploy...');
    try {
      const db = cds.db || await cds.connect.to('db');
      if (db.deploy) await db.deploy();
      console.log('[odatano-night-indexer] DB schema deployed');
    } catch (deployErr) {
      console.warn(`[odatano-night-indexer] Auto-deploy failed: ${deployErr.message}`);
      console.warn('[odatano-night-indexer] Run: cds deploy --to sqlite');
    }
  }

  console.log(`[odatano-night-indexer] Network: ${midnightConfig.network || network}`);
  console.log(`[odatano-night-indexer] Node: ${nodeUrl}`);
});

// Lifecycle: Cleanup on shutdown
cds.on('shutdown', async () => {
  // Stop crawler (it holds WebSocket subscription to the node)
  try {
    const services = cds.services || {};
    for (const name of Object.keys(services)) {
      const srv = services[name];
      if (srv && typeof srv.stopCrawler === 'function') {
        await srv.stopCrawler();
        console.log('[odatano-night-indexer] Crawler stopped');
        break;
      }
    }
  } catch (err) {
    console.warn(`[odatano-night-indexer] Crawler stop error: ${err.message}`);
  }
});

// Schema definitions for IDE code-completion in consumer's package.json
module.exports = {
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
