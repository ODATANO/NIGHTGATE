/**
 * Status builders shared by two callers.
 *
 * The OData functions on NightgateIndexerService (`getHealth()`,
 * `getReadiness()`, `getMetrics()`, `getLiveness()`) and the plain HTTP routes
 * mounted in src/status-routes.ts (`/health`, `/ready`, `/metrics`) must
 * answer with the SAME numbers. They used to live inside the service's
 * `this.on(...)` closures, where only OData could reach them; lifting them out
 * changes no behaviour and no payload, it just gives both callers one
 * implementation.
 *
 * `getRuntimeInfo()` and `getWorkerStatus()` are new and live here for the
 * same reason: whatever answers them, it is the same code.
 */

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

export const metricPrefix = 'odatano_nightgate';

/** Process start, module load time. Imported by the service so uptime agrees. */
export const processStartTime = Date.now();

/** Statuses that mean a job is still on its way somewhere. */
const OPEN_JOB_STATUSES = ['pending', 'running', 'external_execution', 'submitted', 'reconciliation_required'];

// Structural, not cds.DatabaseService: the plain HTTP routes hand in
// `cds.db` and the unit tests hand in a two-line stub, and both must fit.
type Db = { run: (...args: any[]) => Promise<any> };

export function buildLiveness(): Record<string, unknown> {
    const topology = getRuntimeTopology(getNightgatePluginConfig());
    return {
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - processStartTime) / 1000),
        instanceId: topology.instanceId
    };
}

export async function buildHealth(db: Db): Promise<Record<string, unknown>> {
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

    // Integer64/Decimal columns come back as STRINGS from CAP 10 databases
    // (ieee754compatible); coerce so the health payload keeps its numeric
    // contract on both CAP 9 and 10.
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

export async function buildReadiness(db: Db): Promise<Record<string, unknown>> {
    const pluginConfig = getNightgatePluginConfig();
    const topology = getRuntimeTopology(pluginConfig);
    // A deliberately disabled crawler (the Docker default) is not a readiness
    // failure: submission/verification runs without it. The crawler/node checks
    // then pass as "not applicable" so ready reflects what this deployment
    // actually operates.
    const crawlerEnabled = (resolveNightgateRuntimeConfig(pluginConfig).crawlerConfig as any)?.enabled !== false;

    // Initialisation is part of readiness, and the load-bearing bit is
    // `initialized`, not the mode. A process whose initialize() bailed (the
    // classic case: an un-migrated database the schema preflight refused)
    // otherwise answered ready:true whenever the crawler was disabled, because
    // a plain SELECT on the old SyncState table succeeded.
    //
    // BOTH conditions, and neither alone is sufficient:
    //
    // - `initialized` alone passes a process whose crawler or submission
    //   bootstrap failed, because initialize() sets the flag and then reports
    //   mode 'offline'. With the crawler disabled every other check is true,
    //   so readiness came back 200 for a process that cannot work.
    // - `mode !== 'offline'` alone passes the startup phase before
    //   initialize() runs, SKIP_AUTO_INIT, a host that never started the
    //   plugin, and the state after shutdown(): all of them report 'idle',
    //   which is also what a SUCCESSFUL crawler-less start reports.
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
        // Database not available
    }

    return {
        ready: checks.database && checks.crawler && checks.node && checks.runtime && checks.initialization,
        crawlerEnabled,
        checks,
        // What initialize() last reported, so a not-ready answer says WHY
        // rather than leaving the operator to read logs.
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
 * A stable, sanitised reason. The raw `lastError` is unsuitable here:
 * SchemaNotDeployedError carries the absolute database path and the driver's
 * SQL fragment, and this payload is reachable anonymously when an operator
 * chooses NIGHTGATE_STATUS_ROUTES=public. The full text stays in the log.
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

/**
 * The plugin's own initialisation state, read LAZILY.
 *
 * src/index.ts pulls in half of srv/, so importing it at module load would
 * close a cycle. Requiring it at call time is resolved long after both sides
 * are loaded, and a host that does not have it at all simply reports unknown.
 */
function readRuntimeStatus(): { mode?: string; lastError?: string; initialized?: boolean } | null {
    return readRuntimeState();
}

export async function buildMetricsText(db: Db): Promise<string> {
    const syncState = await db.run(SELECT.one.from(SyncState).where({ ID: 'SINGLETON' }));

    const lines: string[] = [];
    // Number() coercion: Integer64/Decimal read back as strings on CAP 10.
    const chainHeight = Number(syncState?.chainHeight || 0);
    const indexedHeight = Number(syncState?.lastIndexedHeight || 0);
    const lag = chainHeight - indexedHeight;
    const bps = Number(syncState?.blocksPerSecond || 0);
    const errors = syncState?.consecutiveErrors || 0;
    const uptimeSec = Math.floor((Date.now() - processStartTime) / 1000);
    const syncStatus = syncState?.syncStatus || 'stopped';
    const topology = getRuntimeTopology(getNightgatePluginConfig());
    // Aggregate in SQL. This path is scraped on a schedule, and reading every
    // open job row into the process made each scrape cost memory and transfer
    // proportional to the backlog: exactly when a backlog exists, which is
    // exactly when the gauges matter.
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
        // Metrics must stay available during schema rollout/degraded DB states.
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

    // Worker liveness as a gauge, so the same alert rules that watch the
    // crawler can watch the submission side.
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

    return lines.join('\n') + '\n';
}

/**
 * What this process IS: version, network, proving mode, and the artifact
 * digest per registered contract.
 *
 * The digest is the reason this exists. `assertArtifactGeneration` refuses
 * every persisted command whose recorded digest no longer matches the loaded
 * artifact, so recompiling contracts under a running server blocks all writes
 * until it restarts. Without this function that failure has no visible cause;
 * with it, one read shows the digest and when it last changed.
 */
export function buildRuntimeInfo(): Record<string, unknown> {
    const config = getNightgatePluginConfig();
    const topology = getRuntimeTopology(config);

    let version = 'unknown';
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        version = String((require('../../package.json') as { version?: string }).version ?? 'unknown');
    } catch {
        // Packaged layouts may not expose it; the rest of the payload stands.
    }

    const contracts = listRegisteredContracts().map(name => {
        const registration = getContractRegistration(name);
        let artifactDigest: string | null = null;
        let currentDigest: string | null = null;
        let digestError: string | null = null;
        try {
            // Two digests on purpose. The per-alias one is the generation this
            // process LOADED and stamped onto persisted commands, and it never
            // changes while the alias points where it does. The other tracks
            // what the files say right now, which is what resolveContract
            // compares against; it is memoised behind a stat fingerprint and a
            // max age, so it is current without re-hashing 200 MB per request.
            // Reporting only the loaded generation would hide the exact failure
            // this endpoint exists to explain: artifacts replaced under a
            // running server, every job refused, the alias digest serene.
            artifactDigest = getArtifactGenerationDigest(name);
            currentDigest = getCurrentArtifactDigest(name);
        } catch (err) {
            // A contract whose artifact does not load is exactly what an
            // operator needs to see here, so it is reported, not swallowed.
            digestError = err instanceof Error ? err.message : String(err);
        }
        return {
            name,
            artifactDigest,
            currentDigest,
            // True when the files on disk no longer match what this process
            // loaded: every write job fails the generation guard until restart.
            digestStale: Boolean(artifactDigest && currentDigest && artifactDigest !== currentDigest),
            digestError,
            slotWidth: slotWidthOf(registration),
            privateStateId: registration?.privateStateId ?? null
        };
    });

    return {
        version,
        network: getConfiguredNightgateNetwork(config),
        provingMode: resolveEffectiveProvingMode(config),
        instanceId: topology.instanceId,
        runtimeMode: topology.runtimeMode,
        databaseKind: topology.databaseKind,
        uptime: Math.floor((Date.now() - processStartTime) / 1000),
        contracts
    };
}

/**
 * Wallet worker health at PROCESS level, deliberately its own function rather
 * than a fifth entry in `getReadiness().checks`.
 *
 * `ready` is an AND over those checks, so putting worker state in there would
 * take a pod out of rotation the first time the worker is merely busy. Making
 * a signal visible and making it load-bearing are two decisions; this is only
 * the first one.
 */
export function buildWorkerStatus(isAdmin = false): Record<string, unknown> {
    const worker = getWalletWorkerStatus();
    // The facade REGISTRY is the authority on what this process holds. The
    // worker's list comes from the sync-progress cache, which only fills while
    // a sync wait is running, so a pool restored from persisted state at the
    // tip reported `facadeCount: 0` while sponsoring happily. Progress detail
    // is merged in where a snapshot exists.
    const bySession = new Map(worker.facades.map(f => [f.sessionId, f]));
    const facades = listWalletFacades().map(sessionId => bySession.get(sessionId)
        ?? { sessionId, label: null, caughtUp: null, updatedAt: null });
    // A snapshot for an account no longer resident is stale, but dropping it
    // silently would hide a facade the worker still thinks it has.
    for (const f of worker.facades) if (!facades.some(x => x.sessionId === f.sessionId)) facades.push(f);
    return {
        started: worker.started,
        running: worker.running,
        inFlightRpcs: worker.inFlightRpcs,
        exitCount: worker.exitCount,
        lastExitCode: worker.lastExitCode,
        lastExitAt: worker.lastExitAt,
        rpcTimeoutMs: worker.rpcTimeoutMs,
        facadeCount: facades.length,
        // `sessionId` here is the wallet cacheKey, an accountId derived from
        // wallet material and stable across sessions. Handing every
        // authenticated caller the full list would leak which wallets this
        // process holds, across tenants, so the per-facade detail is admin
        // only. The count carries the operational signal for everyone else.
        facades: isAdmin ? facades : []
    };
}
