import cds from '@sap/cds';

import { startCrawler, stopCrawler } from '../srv/crawler/index';

export type { MidnightConfig, MidnightProviders, CircuitResult } from '../srv/types';
export { MIDNIGHT_DEFAULTS } from '../srv/types';

export interface MidnightIndexerStatus {
    initialized: boolean;
    crawlerEnabled: boolean;
    network?: string;
    nodeUrl?: string;
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
}

let initialized = false;
let lastStatus: MidnightIndexerStatus = {
    initialized: false,
    crawlerEnabled: false,
    mode: 'idle'
};

function getMidnightConfig(): any {
    return (cds.env as any).requires?.midnight;
}

function isPluginConfigured(config: any): boolean {
    if (!config) {
        return false;
    }

    return !(config.kind === 'midnight' && !config.network);
}

function resolveRuntimeConfig(config: any): {
    network: string;
    nodeUrl: string;
    crawlerConfig: Record<string, unknown>;
    crawlerNodeUrl: string;
} {
    const network = config.network || 'testnet';
    const nodeUrl = config.nodeUrl || 'ws://localhost:9944';
    const crawlerConfig = config.crawler || {};
    const crawlerNodeUrl = (crawlerConfig as any).nodeUrl || nodeUrl;

    const validNetworks = ['testnet', 'mainnet'];
    if (!validNetworks.includes(network)) {
        console.error(`[odatano-night-indexer] Invalid network "${network}". Must be one of: ${validNetworks.join(', ')}`);
        console.error('[odatano-night-indexer] Falling back to "testnet"');
        config.network = 'testnet';
    }

    if (nodeUrl && !nodeUrl.match(/^wss?:\/\/.+/)) {
        console.warn(`[odatano-night-indexer] nodeUrl "${nodeUrl}" does not look like a WebSocket URL (expected ws:// or wss://)`);
    }

    return {
        network: config.network || network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl
    };
}

async function ensureSchemaDeployed(): Promise<void> {
    try {
        const db = await cds.connect.to('db');
        const { SELECT } = cds.ql;
        await db.run(SELECT.one.from('midnight.Blocks'));
    } catch {
        console.warn('[odatano-night-indexer] DB schema not deployed — running auto-deploy...');
        try {
            const db = cds.db || await cds.connect.to('db');
            if (db.deploy) {
                await db.deploy();
            }
            console.log('[odatano-night-indexer] DB schema deployed');
        } catch (deployErr) {
            const message = deployErr instanceof Error ? deployErr.message : String(deployErr);
            console.warn(`[odatano-night-indexer] Auto-deploy failed: ${message}`);
            console.warn('[odatano-night-indexer] Run: cds deploy --to sqlite');
        }
    }
}

export async function initialize(): Promise<MidnightIndexerStatus> {
    const midnightConfig = getMidnightConfig();
    if (!isPluginConfigured(midnightConfig)) {
        lastStatus = {
            initialized: false,
            crawlerEnabled: false,
            mode: 'idle'
        };
        return getStatus();
    }

    if (initialized) {
        return getStatus();
    }

    const { network, nodeUrl, crawlerConfig, crawlerNodeUrl } = resolveRuntimeConfig(midnightConfig);
    const crawlerEnabled = (crawlerConfig as any).enabled !== false;

    await ensureSchemaDeployed();

    console.log(`[odatano-night-indexer] Network: ${network}`);
    console.log(`[odatano-night-indexer] Node: ${nodeUrl}`);

    let mode: MidnightIndexerStatus['mode'] = crawlerEnabled ? 'active' : 'idle';
    let lastError: string | undefined;

    if (crawlerEnabled) {
        try {
            await startCrawler({
                ...(crawlerConfig as Record<string, unknown>),
                enabled: true,
                nodeUrl: crawlerNodeUrl,
                requestTimeout: (crawlerConfig as any).requestTimeout || 30000
            });
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            mode = 'offline';
            console.warn(`[odatano-night-indexer] Node not reachable at ${crawlerNodeUrl}: ${lastError}`);
            console.log('[odatano-night-indexer] Running in offline mode — start a Midnight node: docker compose -f docker/docker-compose.yml up -d');
        }
    }

    initialized = true;
    lastStatus = {
        initialized,
        crawlerEnabled,
        network,
        nodeUrl,
        mode,
        lastError
    };

    return getStatus();
}

export async function shutdown(): Promise<void> {
    try {
        await stopCrawler();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[odatano-night-indexer] Crawler stop error: ${message}`);
        lastStatus = {
            ...lastStatus,
            lastError: message
        };
    } finally {
        initialized = false;
        lastStatus = {
            ...lastStatus,
            initialized: false,
            mode: 'idle'
        };
    }
}

export function getStatus(): MidnightIndexerStatus {
    return { ...lastStatus };
}