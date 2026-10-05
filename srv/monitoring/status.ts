/** Builds the answers of the health, readiness, metrics and status functions of the indexer service. */

import cds from '@sap/cds';
const { SELECT } = cds.ql;

import { SyncState, BackgroundJobs } from '#cds-models/midnight';
import { getRuntimeTopology } from '../utils/runtime-topology';
import {
    getNightgatePluginConfig,
    resolveNightgateRuntimeConfig,
    getConfiguredNightgateNetwork,
    resolveEffectiveProvingMode
} from '../utils/nightgate-config';
import {
    listRegisteredContracts,
    getContractRegistration,
    getArtifactGenerationDigest,
    getCurrentArtifactDigest,
    slotWidthOf
} from '../submission/contract-registry';
import { getWalletWorkerStatus } from '../midnight/wallet-worker-client';
import { listWalletFacades } from '../submission/wallet-facade-builder';
import { readRuntimeState } from '../utils/runtime-state';
import { absorbedCrawlerFaults } from '../crawler/crawler-fault-guard';
import type { DbRunner } from '../utils/db-types';
import type { getReadiness, getRuntimeInfo } from '#cds-models/NightgateIndexerService';

export const metricPrefix = 'odatano_nightgate';

export const processStartTime = Date.now();

const OPEN_JOB_STATUSES = ['pending', 'running', 'external_execution', 'submitted', 'reconciliation_required'];


export function buildLiveness(): Record<string, unknown> {
    const topology = getRuntimeTopology(getNightgatePluginConfig());
    return {
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - processStartTime) / 1000),
        instanceId: topology.instanceId
    };
}

export async function buildHealth(db: DbRunner): Promise<Record<string, unknown>> {
    const topology = getRuntimeTopology(getNightgatePluginConfig());
    const syncState = await db.run(SELECT.one.from(SyncState).where({ ID: 'SINGLETON' }));

    if (!syncState) {
        return {
            status: 'unknown',
            chainHeight: 0,
            indexedHeight: 0,
            finalizedHeight: 0,
            lag: 0,
            finalizedLag: 0,
            blocksPerSecond: 0,
            syncStatus: 'stopped',
            instanceId: topology.instanceId,
            runtimeMode: topology.runtimeMode,
            replicaCount: topology.replicaCount,
            databaseKind: topology.databaseKind,
            topologyValid: topology.valid,
            runtimeWarnings: [...topology.errors, ...topology.warnings]
        };
    }

    // Large integers and decimals come back from the database as strings.
    const chainHeight = Number(syncState.chainHeight || 0);
    const indexedHeight = Number(syncState.lastIndexedHeight || 0);
    const finalizedHeight = Number(syncState.lastFinalizedHeight || 0);
    const lag = Math.max(chainHeight - indexedHeight, 0);
    const finalizedLag = Math.max(chainHeight - finalizedHeight, 0);
    let status = 'healthy';
    if (lag > 100) status = 'unhealthy';
    else if (lag > 10) status = 'degraded';

    return {
        status,
        chainHeight,
        indexedHeight,
        finalizedHeight,
        lag,
        finalizedLag,
        blocksPerSecond: Number(syncState.blocksPerSecond || 0),
        syncStatus: syncState.syncStatus || 'stopped',
        instanceId: topology.instanceId,
        runtimeMode: topology.runtimeMode,
        replicaCount: topology.replicaCount,
        databaseKind: topology.databaseKind,
        topologyValid: topology.valid,
        runtimeWarnings: [...topology.errors, ...topology.warnings]
    };
}

export async function buildReadiness(db: DbRunner): Promise<NonNullable<Awaited<ReturnType<typeof getReadiness>>>> {
    const pluginConfig = getNightgatePluginConfig();
    const topology = getRuntimeTopology(pluginConfig);
    // A disabled crawler does not make the server unready. Its checks simply pass.
    const crawlerEnabled = (resolveNightgateRuntimeConfig(pluginConfig).crawlerConfig as any)?.enabled !== false;

    // Both conditions are needed. `initialized` is also set when startup ended offline.
    const runtime = readRuntimeStatus();
    const initialisationOk = runtime?.initialized === true && runtime.mode !== 'offline';

    const checks = {
        database: false,
        crawler: !crawlerEnabled,
        node: !crawlerEnabled,
        runtime: topology.valid,
        initialization: initialisationOk
    };

    try {
        const syncState = await db.run(SELECT.one.from(SyncState).where({ ID: 'SINGLETON' }));
        checks.database = true;

        if (syncState && crawlerEnabled) {
            checks.crawler = syncState.syncStatus === 'syncing' || syncState.syncStatus === 'synced';

            if (syncState.lastIndexedAt) {
                const lastActivity = new Date(syncState.lastIndexedAt).getTime();
                checks.node = (Date.now() - lastActivity) < 5 * 60 * 1000;
            }
        }
    } catch {
        // Database unavailable: checks.database stays false.
    }

    return {
        ready: checks.database && checks.crawler && checks.node && checks.runtime && checks.initialization,
        crawlerEnabled,
        checks,
        initializationMode: runtime?.mode ?? 'unknown',
        instanceId: topology.instanceId,
        runtimeMode: topology.runtimeMode,
        replicaCount: topology.replicaCount,
        databaseKind: topology.databaseKind,
        runtimeWarnings: [
            ...topology.errors,
            ...topology.warnings,
            ...(initialisationOk ? [] : [summariseInitFailure(runtime)])
        ]
    };
}

/**
 * Turns the startup error into a short public reason.
 * The raw error can contain the database path and SQL, and anyone can call getReadiness.
 */
function summariseInitFailure(runtime: { mode?: string; lastError?: string } | null): string {
    if (!runtime || runtime.mode === 'idle') {
        return 'not initialized: Nightgate has not completed startup in this process';
    }
    const raw = runtime.lastError ?? '';
    if (/schema is not deployed/i.test(raw)) {
        return 'not initialized: database schema is not deployed or out of date, run nightgate-schema-delta';
    }
    if (/submission pipeline/i.test(raw)) {
        return 'not initialized: the submission pipeline did not start';
    }
    if (/crawler/i.test(raw)) {
        return 'not initialized: the crawler failed to start';
    }
    return 'not initialized: startup failed, see the server log';
}

function readRuntimeStatus(): { mode?: string; lastError?: string; initialized?: boolean } | null {
    return readRuntimeState();
}

export function dbPoolGauges(db: unknown): { size: number; available: number; borrowed: number; pending: number } | null {
    const pools = (db as { pools?: unknown } | null | undefined)?.pools;
    if (!pools || typeof pools !== 'object') return null;
    const list = Object.values(pools as Record<string, unknown>)
        .filter((p): p is Record<string, unknown> => !!p && typeof (p as { size?: unknown }).size === 'number');
    if (list.length === 0) return null;
    const sum = (field: string) => list.reduce((n, p) => n + (Number.isFinite(p[field]) ? Number(p[field]) : 0), 0);
    return { size: sum('size'), available: sum('available'), borrowed: sum('borrowed'), pending: sum('pending') };
}

export async function buildMetricsText(db: DbRunner): Promise<string> {
    const syncState = await db.run(SELECT.one.from(SyncState).where({ ID: 'SINGLETON' }));

    const lines: string[] = [];
    const chainHeight = Number(syncState?.chainHeight || 0);
    const indexedHeight = Number(syncState?.lastIndexedHeight || 0);
    const lag = chainHeight - indexedHeight;
    const bps = Number(syncState?.blocksPerSecond || 0);
    const errors = syncState?.consecutiveErrors || 0;
    const uptimeSec = Math.floor((Date.now() - processStartTime) / 1000);
    const syncStatus = syncState?.syncStatus || 'stopped';
    const topology = getRuntimeTopology(getNightgatePluginConfig());
    // Count in SQL. Loading the job rows would be most expensive exactly when many jobs are queued.
    const jobCounts = new Map<string, number>();
    let oldestQueuedSeconds = 0;
    try {
        const grouped: Array<{ status?: string; count?: number }> = await db.run(
            SELECT.from(BackgroundJobs)
                .columns('status', 'count(*) as count')
                .where({ status: { in: OPEN_JOB_STATUSES } })
                .groupBy('status')
        ) || [];
        for (const row of grouped) jobCounts.set(row.status ?? 'unknown', Number(row.count ?? 0));

        const oldestRows: Array<{ oldest?: string | null }> = await db.run(
            SELECT.from(BackgroundJobs)
                .columns('min(createdAt) as oldest')
                .where({ status: 'pending' })
        ) || [];
        const oldestMs = oldestRows[0]?.oldest ? new Date(oldestRows[0].oldest).getTime() : NaN;
        if (Number.isFinite(oldestMs)) oldestQueuedSeconds = Math.max(0, (Date.now() - oldestMs) / 1000);
    } catch {
        // Metrics must keep working while the schema is being updated or the database has problems.
    }
    const countOf = (...statuses: string[]) =>
        statuses.reduce((sum, status) => sum + (jobCounts.get(status) ?? 0), 0);
    const queuedCount = countOf('pending');
    const runningCount = countOf('running', 'external_execution', 'submitted');
    const reconciliationCount = countOf('reconciliation_required');

    lines.push(`# HELP ${metricPrefix}_chain_height Current chain height`);
    lines.push(`# TYPE ${metricPrefix}_chain_height gauge`);
    lines.push(`${metricPrefix}_chain_height ${chainHeight}`);

    lines.push(`# HELP ${metricPrefix}_indexed_height Last indexed block height`);
    lines.push(`# TYPE ${metricPrefix}_indexed_height gauge`);
    lines.push(`${metricPrefix}_indexed_height ${indexedHeight}`);

    lines.push(`# HELP ${metricPrefix}_sync_lag Blocks behind chain tip`);
    lines.push(`# TYPE ${metricPrefix}_sync_lag gauge`);
    lines.push(`${metricPrefix}_sync_lag ${lag}`);

    lines.push(`# HELP ${metricPrefix}_blocks_per_second Indexing throughput`);
    lines.push(`# TYPE ${metricPrefix}_blocks_per_second gauge`);
    lines.push(`${metricPrefix}_blocks_per_second ${bps}`);

    lines.push(`# HELP ${metricPrefix}_consecutive_errors Consecutive indexing errors`);
    lines.push(`# TYPE ${metricPrefix}_consecutive_errors gauge`);
    lines.push(`${metricPrefix}_consecutive_errors ${errors}`);

    lines.push(`# HELP ${metricPrefix}_absorbed_transport_faults Node transport faults that did not shut the server down`);
    lines.push(`# TYPE ${metricPrefix}_absorbed_transport_faults counter`);
    lines.push(`${metricPrefix}_absorbed_transport_faults ${absorbedCrawlerFaults()}`);

    lines.push(`# HELP ${metricPrefix}_uptime_seconds Process uptime in seconds`);
    lines.push(`# TYPE ${metricPrefix}_uptime_seconds gauge`);
    lines.push(`${metricPrefix}_uptime_seconds ${uptimeSec}`);

    lines.push(`# HELP ${metricPrefix}_sync_status Sync status (0=stopped, 1=syncing, 2=synced, 3=error)`);
    lines.push(`# TYPE ${metricPrefix}_sync_status gauge`);
    const statusMap: Record<string, number> = { stopped: 0, syncing: 1, synced: 2, error: 3 };
    lines.push(`${metricPrefix}_sync_status ${statusMap[syncStatus] ?? 0}`);

    lines.push(`# HELP ${metricPrefix}_runtime_topology_valid Runtime topology support (1=supported, 0=unsupported)`);
    lines.push(`# TYPE ${metricPrefix}_runtime_topology_valid gauge`);
    lines.push(`${metricPrefix}_runtime_topology_valid ${topology.valid ? 1 : 0}`);

    lines.push(`# HELP ${metricPrefix}_runtime_replicas Declared Nightgate process/replica count`);
    lines.push(`# TYPE ${metricPrefix}_runtime_replicas gauge`);
    lines.push(`${metricPrefix}_runtime_replicas ${topology.replicaCount}`);
    lines.push(`${metricPrefix}_runtime_database_info{kind="${topology.databaseKind}"} 1`);
    lines.push(`# HELP ${metricPrefix}_jobs_queued Background jobs waiting to execute`);
    lines.push(`# TYPE ${metricPrefix}_jobs_queued gauge`);
    lines.push(`${metricPrefix}_jobs_queued ${queuedCount}`);
    lines.push(`# HELP ${metricPrefix}_jobs_running Background jobs currently executing or submitted`);
    lines.push(`# TYPE ${metricPrefix}_jobs_running gauge`);
    lines.push(`${metricPrefix}_jobs_running ${runningCount}`);
    lines.push(`# HELP ${metricPrefix}_jobs_reconciliation_required Jobs requiring external-state reconciliation`);
    lines.push(`# TYPE ${metricPrefix}_jobs_reconciliation_required gauge`);
    lines.push(`${metricPrefix}_jobs_reconciliation_required ${reconciliationCount}`);
    lines.push(`# HELP ${metricPrefix}_jobs_oldest_queued_seconds Age of the oldest queued job`);
    lines.push(`# TYPE ${metricPrefix}_jobs_oldest_queued_seconds gauge`);
    lines.push(`${metricPrefix}_jobs_oldest_queued_seconds ${oldestQueuedSeconds}`);

    const worker = getWalletWorkerStatus();
    lines.push(`# HELP ${metricPrefix}_wallet_worker_running Wallet worker thread alive (1=running, 0=not running)`);
    lines.push(`# TYPE ${metricPrefix}_wallet_worker_running gauge`);
    lines.push(`${metricPrefix}_wallet_worker_running ${worker.running ? 1 : 0}`);
    lines.push(`# HELP ${metricPrefix}_wallet_worker_inflight_rpcs Wallet worker calls awaiting an answer`);
    lines.push(`# TYPE ${metricPrefix}_wallet_worker_inflight_rpcs gauge`);
    lines.push(`${metricPrefix}_wallet_worker_inflight_rpcs ${worker.inFlightRpcs}`);
    lines.push(`# HELP ${metricPrefix}_wallet_worker_exits Wallet worker thread exits since process start`);
    lines.push(`# TYPE ${metricPrefix}_wallet_worker_exits counter`);
    lines.push(`${metricPrefix}_wallet_worker_exits ${worker.exitCount}`);
    lines.push(`# HELP ${metricPrefix}_wallet_worker_rotations Controlled wallet worker rotations (artifact generation budget) since process start`);
    lines.push(`# TYPE ${metricPrefix}_wallet_worker_rotations counter`);
    lines.push(`${metricPrefix}_wallet_worker_rotations ${worker.rotationCount ?? 0}`);

    const pool = dbPoolGauges(db);
    if (pool) {
        const gauges = [
            ['size', 'Database connections open or being created'],
            ['available', 'Idle database connections'],
            ['borrowed', 'Database connections in use'],
            ['pending', 'Requests waiting for a database connection']
        ] as const;
        for (const [name, help] of gauges) {
            lines.push(`# HELP ${metricPrefix}_db_pool_${name} ${help}`);
            lines.push(`# TYPE ${metricPrefix}_db_pool_${name} gauge`);
            lines.push(`${metricPrefix}_db_pool_${name} ${pool[name]}`);
        }
    }

    return lines.join('\n') + '\n';
}

/**
 * Version, network, proving mode and a hash of each contract's compiled files.
 * The hashes show why writes are refused after contract files changed on disk.
 */
export function buildRuntimeInfo(): NonNullable<Awaited<ReturnType<typeof getRuntimeInfo>>> {
    const config = getNightgatePluginConfig();
    const topology = getRuntimeTopology(config);

    let version = 'unknown';
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        version = String((require('../../package.json') as { version?: string }).version ?? 'unknown');
    } catch {
        // Some package layouts do not ship package.json. The rest of the answer still works.
    }

    const contracts = listRegisteredContracts().map(name => {
        const registration = getContractRegistration(name);
        let artifactDigest: string | null = null;
        let currentDigest: string | null = null;
        let digestError: string | null = null;
        try {
            artifactDigest = getArtifactGenerationDigest(name);
            currentDigest = getCurrentArtifactDigest(name);
        } catch (err) {
            digestError = err instanceof Error ? err.message : String(err);
        }
        return {
            name,
            artifactDigest,
            currentDigest,
            // The files on disk changed after loading. Writes fail until a restart.
            digestStale: Boolean(artifactDigest && currentDigest && artifactDigest !== currentDigest),
            digestError,
            package: registration?.package?.name ?? null,
            version: registration?.package?.version ?? null,
            slotWidth: slotWidthOf(registration),
            privateStateId: registration?.privateStateId ?? null
        };
    });

    return {
        version,
        apiVersion: version.split('.').slice(0, 2).join('.'),
        network: getConfiguredNightgateNetwork(config) ?? null,
        provingMode: resolveEffectiveProvingMode(config),
        instanceId: topology.instanceId,
        runtimeMode: topology.runtimeMode,
        databaseKind: topology.databaseKind,
        uptime: Math.floor((Date.now() - processStartTime) / 1000),
        contracts
    };
}

/**
 * Wallet worker health. On purpose not part of readiness, which would take the server
 * out of service whenever the worker is only busy.
 */
export function buildWorkerStatus(isAdmin = false): Record<string, unknown> {
    const worker = getWalletWorkerStatus();
    // The main thread's list is the truth. The worker's progress data fills in later.
    const bySession = new Map(worker.facades.map(f => [f.sessionId, f]));
    const facades = listWalletFacades().map(sessionId => bySession.get(sessionId)
        ?? { sessionId, label: null, caughtUp: null, updatedAt: null });
    // Keep wallets that only the worker still reports. They show a mismatch worth seeing.
    for (const f of worker.facades) if (!facades.some(x => x.sessionId === f.sessionId)) facades.push(f);
    return {
        started: worker.started,
        running: worker.running,
        inFlightRpcs: worker.inFlightRpcs,
        exitCount: worker.exitCount,
        rotationCount: worker.rotationCount ?? 0,
        lastExitCode: worker.lastExitCode,
        lastExitAt: worker.lastExitAt,
        rpcTimeoutMs: worker.rpcTimeoutMs,
        facadeCount: facades.length,
        // Admin only. The sessionId here is derived from the wallet and stays the same across sessions,
        // so the list would reveal which wallets this server holds.
        facades: isAdmin ? facades : []
    };
}
