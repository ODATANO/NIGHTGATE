import cds from '@sap/cds';

import { startCrawler, stopCrawler } from '../srv/crawler/index';
import { ensureNightgateModelLoaded } from '../srv/utils/cds-model';
import {
    isNightgatePluginConfigured,
    resolveNightgateRuntimeConfig,
    VALID_NIGHTGATE_NETWORKS,
    getNightgatePluginConfig,
    DEFAULT_NETWORK
} from '../srv/utils/nightgate-config';
import { loadRegistryFromConfig, listRegisteredContracts } from '../srv/submission/contract-registry';
import { applySqliteTuning } from '../srv/utils/sqlite-tuning';
import { startWalletWorker, stopWalletWorker } from '../srv/midnight/wallet-worker-client';
import { wireWorkerStateSaveSink } from '../srv/submission/wallet-facade-builder';
import { recoverInterruptedJobs } from '../srv/submission/background-jobs';

export type { NightgateConfig } from '../srv/types';
export { DEFAULT_NETWORK, DEFAULT_NODE_URL } from '../srv/utils/nightgate-config';

export interface NightgateIndexerStatus {
    initialized: boolean;
    crawlerEnabled: boolean;
    network?: string;
    nodeUrl?: string;
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
}

let initialized = false;
let lastStatus: NightgateIndexerStatus = {
    initialized: false,
    crawlerEnabled: false,
    mode: 'idle'
};

function isLikelyNodeConnectionError(message: string): boolean {
    return /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|WebSocket|Not connected to Midnight Node/i.test(message);
}

function logStartupState(state: 'stopped' | 'syncing' | 'offline', detail?: string): void {
    const suffix = detail ? ` (${detail})` : '';
    console.log(`[odatano-nightgate] Startup state: ${state}${suffix}`);
}

/**
 * Thrown by `ensureSchemaDeployed` when a required CAP entity has no backing
 * table in the connected database. Carries the missing table name and the
 * resolved DB URL so the surfaced message is actionable without guessing.
 *
 * Production behaviour (in `src/plugin.ts::registerLifecycle`): this error is
 * caught, logged with a "RUN THIS" block, and the process exits non-zero so
 * the operator notices instead of half-booting against a stale schema.
 */
export class SchemaNotDeployedError extends Error {
    constructor(
        public readonly missingTable: string,
        public readonly dbPath: string,
        cause: unknown
    ) {
        const causeMsg = cause instanceof Error ? cause.message : String(cause);
        super(
            `Nightgate schema is not deployed (or out of date): ` +
            `missing table for '${missingTable}' in ${dbPath}. ` +
            `Underlying error: ${causeMsg}. ` +
            `Fix: run \`npm run deploy\` from the project root.`
        );
        this.name = 'SchemaNotDeployedError';
    }
}

/**
 * Resolve the database file path the runtime is connected to. Used in the
 * SchemaNotDeployedError message so users see exactly which file is missing
 * the tables bare `cds deploy` defaults to `db.sqlite` which would silently
 * deploy to the wrong file otherwise.
 */
function resolveDbPath(): string {
    const dbCfg = (cds.env as any).requires?.db?.credentials || (cds.env as any).requires?.db || {};
    return dbCfg.database || dbCfg.url || 'db.sqlite';
}

/**
 * Probe-only schema check. Returns silently when every required table exists;
 * throws `SchemaNotDeployedError` on the first miss so the operator can fix
 * it explicitly via `npm run deploy`.
 **/
async function ensureSchemaDeployed(): Promise<void> {
    const requiredTables = [
        'midnight.Blocks',
        'midnight.SyncState',
        'midnight.PendingSubmissions',
        'midnight.PrivateStates',
        'midnight.ContractSigningKeys',
        'midnight.WalletSyncStates',
        'midnight.Attestations',
        'midnight.Documents',
        'midnight.DisclosureRoles',
        'midnight.BackgroundJobs'
    ];

    const db = cds.db || await cds.connect.to('db');
    const { SELECT } = cds.ql;

    for (const table of requiredTables) {
        try {
            await db.run(SELECT.one.from(table));
        } catch (probeErr) {
            throw new SchemaNotDeployedError(table, resolveDbPath(), probeErr);
        }
    }
}

export async function initialize(): Promise<NightgateIndexerStatus> {
    await ensureNightgateModelLoaded();

    const nightgateConfig = getNightgatePluginConfig();
    if (!isNightgatePluginConfigured(nightgateConfig)) {
        lastStatus = {
            initialized: false,
            crawlerEnabled: false,
            mode: 'idle'
        };
        logStartupState('stopped', 'plugin not configured');
        return getStatus();
    }

    if (initialized) {
        return getStatus();
    }

    const { network, nodeUrl, crawlerConfig, crawlerNodeUrl, invalidNetwork } = resolveNightgateRuntimeConfig(nightgateConfig);
    const crawlerEnabled = (crawlerConfig as any).enabled !== false;

    if (invalidNetwork) {
        console.error(`[odatano-nightgate] Invalid network "${invalidNetwork}". Must be one of: ${VALID_NIGHTGATE_NETWORKS.join(', ')}`);
        console.error(`[odatano-nightgate] Falling back to "${DEFAULT_NETWORK}"`);
    }

    await ensureSchemaDeployed();

    // Tune SQLite for catch-up write throughput. No-op on HANA.
    try {
        const db = cds.db || await cds.connect.to('db');
        await applySqliteTuning(db);
    } catch (err) {
        console.warn(`[odatano-nightgate] SQLite tuning skipped: ${(err as Error).message}`);
    }

    // Crash recovery: any BackgroundJobs row that was pending/running when the
    // previous process exited becomes a ghost forever otherwise. Flip them to
    // failed:PROCESS_RESTART so callers polling getJobStatus see a definitive
    // terminal state. Idempotent; safe to run on every boot.
    try {
        const recovered = await recoverInterruptedJobs();
        if (recovered > 0) {
            console.log(`[odatano-nightgate] Recovered ${recovered} interrupted background job(s) as failed:PROCESS_RESTART`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[odatano-nightgate] Background-job recovery skipped: ${msg}`);
    }


    // Load any contracts declared under cds.requires.nightgate.contracts into
    // the in-memory registry. Safe to call repeatedly, idempotent.
    try {
        loadRegistryFromConfig(nightgateConfig);
        const refs = listRegisteredContracts();
        if (refs.length) {
            console.log(`[odatano-nightgate] Registered contracts: ${refs.join(', ')}`);
        }
    } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        console.warn(`[odatano-nightgate] Contract registry load warning: ${msg}`);
    }

    // Spin up the wallet worker thread now so it's ready when the first
    // connectWalletForSigning request lands. The Midnight wallet SDK
    // monopolises the microtask queue while syncing — running it in a worker
    // keeps CAP's `db.run`, OData handlers, and the crawler responsive.
    try {
        await startWalletWorker();
        wireWorkerStateSaveSink();
        console.log('[odatano-nightgate] Wallet worker thread ready');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[odatano-nightgate] Wallet worker startup failed: ${msg}`);
        console.warn('[odatano-nightgate] Signing-related operations will fail until restart');
    }

    console.log(`[odatano-nightgate] Network: ${network}`);
    console.log(`[odatano-nightgate] Node: ${nodeUrl}`);

    let mode: NightgateIndexerStatus['mode'] = crawlerEnabled ? 'active' : 'idle';
    let lastError: string | undefined;

    if (crawlerEnabled) {
        try {
            console.log('[odatano-nightgate] Initializing crawler and starting catch-up...');
            await startCrawler({
                ...(crawlerConfig as Record<string, unknown>),
                enabled: true,
                nodeUrl: crawlerNodeUrl,
                requestTimeout: (crawlerConfig as any).requestTimeout || 30000
            });
            logStartupState('syncing', 'crawler started');
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            mode = 'offline';
            if (isLikelyNodeConnectionError(lastError)) {
                console.warn(`[odatano-nightgate] Node not reachable at ${crawlerNodeUrl}: ${lastError}`);
                logStartupState('offline', 'node unreachable');
                console.log('[odatano-nightgate] Running in offline mode. Start a Midnight node: docker compose -f docker/docker-compose.yml up -d');
            } else {
                console.warn(`[odatano-nightgate] Crawler startup failed: ${lastError}`);
                logStartupState('offline', 'startup error');
                console.log('[odatano-nightgate] Running in offline mode until the startup error is resolved');
            }
        }
    } else {
        logStartupState('stopped', 'crawler disabled');
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
        console.warn(`[odatano-nightgate] Crawler stop error: ${message}`);
        lastStatus = {
            ...lastStatus,
            lastError: message
        };
    }
    try {
        await stopWalletWorker();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[odatano-nightgate] Wallet worker stop error: ${message}`);
    }
    initialized = false;
    lastStatus = {
        ...lastStatus,
        initialized: false,
        mode: 'idle'
    };
}

export function getStatus(): NightgateIndexerStatus {
    return { ...lastStatus };
}
