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
const log = cds.log('nightgate');
import { startWalletWorker, stopWalletWorker } from '../srv/midnight/wallet-worker-client';
import { wireWorkerStateSaveSink } from '../srv/submission/wallet-facade-builder';
import { recoverInterruptedJobs, startBackgroundJobProcessor, stopBackgroundJobProcessor } from '../srv/submission/background-jobs';
import { TransactionResults } from '#cds-models/midnight';
import {
    assertSupportedRuntimeTopology,
    UnsupportedRuntimeTopologyError
} from '../srv/utils/runtime-topology';

export type { NightgateConfig } from '../srv/types';
export { DEFAULT_NETWORK, DEFAULT_NODE_URL } from '../srv/utils/nightgate-config';

export interface NightgateIndexerStatus {
    initialized: boolean;
    crawlerEnabled: boolean;
    network?: string;
    nodeUrl?: string;
    mode: 'idle' | 'active' | 'offline';
    lastError?: string;
    instanceId?: string;
    runtimeMode?: 'single-instance';
    replicaCount?: number;
    databaseKind?: string;
    runtimeWarnings?: string[];
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
    log.info(`Startup state: ${state}${suffix}`);
}

/**
 * Thrown by `ensureSchemaDeployed` when a required CAP entity has no backing
 * table in the connected database. Carries the missing table name and the
 * resolved DB URL so the surfaced message is actionable without guessing.
 *
 * Production behaviour (in `src/plugin.ts::registerLifecycle`): this error is
 * caught and logged, while Nightgate remains explicitly offline. The plugin
 * never terminates its CAP host process.
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
 * the tables; bare `cds deploy` defaults to `db.sqlite`, which would silently
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
        'midnight.TransactionResults',
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

    // Pre-0.9 rows were unconditional SUCCESS placeholders. Keeping them would
    // continue exposing a known-false execution claim through OData. The new
    // outcomeSource column distinguishes canonical System.Events evidence.
    const removed = await db.run(
        cds.ql.DELETE.from(TransactionResults).where({ outcomeSource: null })
    );
    const removedCount = typeof removed === 'number' ? removed : Number((removed as any)?.changes ?? 0);
    if (removedCount > 0) log.warn(`Removed ${removedCount} legacy unverified TransactionResults row(s); re-crawl historical blocks to backfill canonical outcomes`);
}

/**
 * Initialize the Nightgate indexer. Idempotent; safe to call repeatedly.
 * Returns the current status, which may be "offline" if the crawler failed to
 * start (e.g. node unreachable) or "idle" if the crawler is disabled in config.
 */
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
        log.warn(`Invalid network "${invalidNetwork}". Must be one of: ${VALID_NIGHTGATE_NETWORKS.join(', ')}`);
        log.warn(`Falling back to "${DEFAULT_NETWORK}"`);
    }

    let runtimeTopology;
    try {
        runtimeTopology = assertSupportedRuntimeTopology(nightgateConfig);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const rejected = err instanceof UnsupportedRuntimeTopologyError ? err.topology : undefined;
        initialized = false;
        lastStatus = {
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            instanceId: rejected?.instanceId,
            runtimeMode: rejected?.runtimeMode,
            replicaCount: rejected?.replicaCount,
            databaseKind: rejected?.databaseKind,
            runtimeWarnings: rejected?.warnings
        };
        logStartupState('offline', 'unsupported runtime topology');
        throw err;
    }
    log.info(
        `Runtime topology accepted: instanceId=${runtimeTopology.instanceId}, ` +
        `mode=${runtimeTopology.runtimeMode}, replicas=${runtimeTopology.replicaCount}, database=${runtimeTopology.databaseKind}`
    );
    for (const warning of runtimeTopology.warnings) log.warn(warning);

    try {
        await ensureSchemaDeployed();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        initialized = false;
        lastStatus = {
            initialized: false,
            crawlerEnabled,
            network,
            nodeUrl,
            mode: 'offline',
            lastError: message,
            instanceId: runtimeTopology.instanceId,
            runtimeMode: runtimeTopology.runtimeMode,
            replicaCount: runtimeTopology.replicaCount,
            databaseKind: runtimeTopology.databaseKind,
            runtimeWarnings: runtimeTopology.warnings
        };
        logStartupState('offline', 'schema unavailable');
        throw err;
    }

    // Crash recovery is deliberately asymmetric: versioned commands interrupted
    // before the external boundary return to the queue; legacy closures become
    // terminal because they cannot be reconstructed. External execution is
    // always moved to reconciliation_required and never blindly resubmitted.
    try {
        const recovered = await recoverInterruptedJobs();
        if (recovered > 0) {
            log.info(`Classified ${recovered} interrupted background job(s) for safe restart recovery/reconciliation`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Background-job recovery skipped: ${msg}`);
    }


    // Load any contracts declared under cds.requires.nightgate.contracts into
    // the in-memory registry. Safe to call repeatedly, idempotent.
    try {
        loadRegistryFromConfig(nightgateConfig);
        const refs = listRegisteredContracts();
        if (refs.length) {
            log.info(`Registered contracts: ${refs.join(', ')}`);
        }
    } catch (regErr) {
        const msg = regErr instanceof Error ? regErr.message : String(regErr);
        log.warn(`Contract registry load warning: ${msg}`);
    }

    // Spin up the wallet worker thread now so it's ready when the first
    // connectWalletForSigning request lands. The Midnight wallet SDK
    // monopolises the microtask queue while syncing; running it in a worker
    // keeps CAP's `db.run`, OData handlers, and the crawler responsive.
    try {
        await startWalletWorker();
        wireWorkerStateSaveSink();
        await startBackgroundJobProcessor();
        log.info('Wallet worker thread ready');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Wallet worker startup failed: ${msg}`);
        log.warn('Signing-related operations will fail until restart');
    }

    log.info(`Network: ${network}`);
    log.info(`Node: ${nodeUrl}`);

    let mode: NightgateIndexerStatus['mode'] = crawlerEnabled ? 'active' : 'idle';
    let lastError: string | undefined;

    if (crawlerEnabled) {
        try {
            log.info('Initializing crawler and starting catch-up...');
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
                log.warn(`Node not reachable at ${crawlerNodeUrl}: ${lastError}`);
                logStartupState('offline', 'node unreachable');
                log.info('Running in offline mode. Start a Midnight node: docker compose -f docker/docker-compose.yml up -d');
            } else {
                log.warn(`Crawler startup failed: ${lastError}`);
                logStartupState('offline', 'startup error');
                log.info('Running in offline mode until the startup error is resolved');
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
        lastError,
        instanceId: runtimeTopology.instanceId,
        runtimeMode: runtimeTopology.runtimeMode,
        replicaCount: runtimeTopology.replicaCount,
        databaseKind: runtimeTopology.databaseKind,
        runtimeWarnings: runtimeTopology.warnings
    };

    return getStatus();
}

/**
 * Shut down the Nightgate indexer. Idempotent; safe to call repeatedly.
 * Returns the current status, which will be "idle" after shutdown.
 */
export async function shutdown(): Promise<void> {
    stopBackgroundJobProcessor();
    try {
        await stopCrawler();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Crawler stop error: ${message}`);
        lastStatus = {
            ...lastStatus,
            lastError: message
        };
    }
    try {
        await stopWalletWorker();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Wallet worker stop error: ${message}`);
    }
    initialized = false;
    lastStatus = {
        ...lastStatus,
        initialized: false,
        mode: 'idle'
    };
}

/** Return the last known indexer status. */
export function getStatus(): NightgateIndexerStatus {
    return { ...lastStatus };
}
