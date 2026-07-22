/**
 * Nightgate Indexer Service Implementation
 *
 * Exposes sync state, health metrics, and reorg history.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, UPDATE } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from './utils/nightgate-config';
import { ensureSyncStateSingleton } from './utils/sync-state';
import { isCrawlerRunning, startCrawler, stopCrawler } from './crawler';
import { rollbackIndexedDataFromHeight, RollbackResult } from './crawler/rollback';
import { SyncState, ReorgLog, BackgroundJobs } from '#cds-models/midnight';
import { getRuntimeTopology } from './utils/runtime-topology';

const log = cds.log('nightgate:indexer');
const processStartTime = Date.now();
const metricPrefix = 'odatano_nightgate';

export default class NightgateIndexerService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    private resolveCrawlerStartConfig(): { enabled: boolean; nodeUrl: string; requestTimeout?: number } {
        const { crawlerConfig, crawlerNodeUrl } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
        return {
            ...(crawlerConfig as Record<string, unknown>),
            enabled: true,
            nodeUrl: crawlerNodeUrl,
            requestTimeout: (crawlerConfig as any).requestTimeout || 30000
        };
    }

    private async rollbackFromHeight(fromHeight: number): Promise<{
        blocksRolledBack: number;
        transactionsRolledBack: number;
        effectiveStartHeight: number;
    }> {
        // Explicit transaction: the shared cascade (srv/crawler/rollback.ts,
        // same utility as the reorg path incl. NightBalances repair) commits
        // atomically BEFORE the caller restarts the crawler, so a resumed
        // crawler can never read pre-rollback state.
        const result: RollbackResult = await this.db.tx(async (tx: any) =>
            rollbackIndexedDataFromHeight(tx, fromHeight, {
                syncStatus: 'stopped',
                extraSyncState: { syncProgress: 0 }
            })
        ) as RollbackResult;

        const effectiveStartHeight = result.forkBlock?.height != null
            ? Number(result.forkBlock.height) + 1
            : 0;

        return {
            blocksRolledBack: result.blocksRolledBack,
            transactionsRolledBack: result.transactionsRolledBack,
            effectiveStartHeight
        };
    }

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        // Ensure SyncState row exists (even before crawler starts)
        try {
            await ensureSyncStateSingleton(this.db);
        } catch (err) {
            log.warn('SyncState init skipped:', (err as Error).message);
        }

        this.on('getSyncStatus', async () => {
            const syncState = await this.db.run(
                SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
            );
            return syncState || {
                ID: 'SINGLETON',
                syncStatus: 'stopped',
                lastIndexedHeight: 0,
                chainHeight: 0,
                consecutiveErrors: 0
            };
        });

        this.on('getHealth', async () => {
            const topology = getRuntimeTopology(getNightgatePluginConfig());
            const syncState = await this.db.run(
                SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
            );

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

            // Integer64/Decimal columns come back as STRINGS from CAP 10
            // databases (ieee754compatible); coerce so the health payload
            // keeps its numeric contract on both CAP 9 and 10.
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
        });

        this.on('getReorgHistory', async (req: Request) => {
            const { limit } = req.data as { limit?: number };
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 100);
            return this.db.run(
                SELECT.from(ReorgLog)
                    .orderBy('detectedAt desc')
                    .limit(effectiveLimit)
            );
        });

        this.on('getLiveness', async () => {
            const topology = getRuntimeTopology(getNightgatePluginConfig());
            return {
                status: 'alive',
                timestamp: new Date().toISOString(),
                uptime: Math.floor((Date.now() - processStartTime) / 1000),
                instanceId: topology.instanceId
            };
        });

        this.on('getReadiness', async () => {
            const topology = getRuntimeTopology(getNightgatePluginConfig());
            const checks = {
                database: false,
                crawler: false,
                node: false,
                runtime: topology.valid
            };

            try {
                const syncState = await this.db.run(
                    SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
                );
                checks.database = true;

                if (syncState) {
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
                ready: checks.database && checks.crawler && checks.node && checks.runtime,
                checks,
                instanceId: topology.instanceId,
                runtimeMode: topology.runtimeMode,
                replicaCount: topology.replicaCount,
                databaseKind: topology.databaseKind,
                runtimeWarnings: [...topology.errors, ...topology.warnings]
            };
        });

        this.on('getMetrics', async () => {
            const syncState = await this.db.run(
                SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
            );

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
            let jobRows: Array<{ status?: string; createdAt?: string }> = [];
            try {
                jobRows = await this.db.run(
                    SELECT.from(BackgroundJobs).columns('status', 'createdAt')
                        .where({ status: { in: ['pending', 'running', 'external_execution', 'submitted', 'reconciliation_required'] } })
                ) || [];
            } catch {
                // Metrics must stay available during schema rollout/degraded DB states.
            }
            const queuedJobs = jobRows.filter(job => job.status === 'pending');
            const runningJobs = jobRows.filter(job => ['running', 'external_execution', 'submitted'].includes(job.status || ''));
            const reconciliationJobs = jobRows.filter(job => job.status === 'reconciliation_required');
            const oldestQueuedSeconds = queuedJobs.length
                ? Math.max(0, (Date.now() - Math.min(...queuedJobs.map(job => new Date(job.createdAt || Date.now()).getTime()))) / 1000)
                : 0;

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
            lines.push(`${metricPrefix}_jobs_queued ${queuedJobs.length}`);
            lines.push(`# HELP ${metricPrefix}_jobs_running Background jobs currently executing or submitted`);
            lines.push(`# TYPE ${metricPrefix}_jobs_running gauge`);
            lines.push(`${metricPrefix}_jobs_running ${runningJobs.length}`);
            lines.push(`# HELP ${metricPrefix}_jobs_reconciliation_required Jobs requiring external-state reconciliation`);
            lines.push(`# TYPE ${metricPrefix}_jobs_reconciliation_required gauge`);
            lines.push(`${metricPrefix}_jobs_reconciliation_required ${reconciliationJobs.length}`);
            lines.push(`# HELP ${metricPrefix}_jobs_oldest_queued_seconds Age of the oldest queued job`);
            lines.push(`# TYPE ${metricPrefix}_jobs_oldest_queued_seconds gauge`);
            lines.push(`${metricPrefix}_jobs_oldest_queued_seconds ${oldestQueuedSeconds}`);

            return lines.join('\n') + '\n';
        });

        this.on('pauseCrawler', async () => {
            if (!isCrawlerRunning()) {
                return {
                    status: 'ok',
                    running: false,
                    message: 'Crawler is already paused'
                };
            }

            await stopCrawler();
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    syncStatus: 'stopped'
                }).where({ ID: 'SINGLETON' })
            );

            return {
                status: 'ok',
                running: false,
                message: 'Crawler paused'
            };
        });

        this.on('resumeCrawler', async (req: Request) => {
            if (isCrawlerRunning()) {
                return {
                    status: 'ok',
                    running: true,
                    message: 'Crawler already running'
                };
            }

            try {
                await startCrawler(this.resolveCrawlerStartConfig());
                return {
                    status: 'ok',
                    running: true,
                    message: 'Crawler resumed'
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return req.reject(500, `Failed to resume crawler: ${message}`);
            }
        });

        this.on('reindexFromHeight', async (req: Request) => {
            const { height } = req.data as { height?: number };
            const requestedHeight = Number(height);

            if (!Number.isInteger(requestedHeight) || requestedHeight < 0) {
                return req.reject(400, 'height must be a non-negative integer');
            }

            const wasRunning = isCrawlerRunning();
            if (wasRunning) {
                await stopCrawler();
            }

            const rollback = await this.rollbackFromHeight(requestedHeight);

            let crawlerResumed = false;
            let resumeError: string | null = null;
            if (wasRunning) {
                try {
                    await startCrawler(this.resolveCrawlerStartConfig());
                    crawlerResumed = true;
                } catch (err) {
                    resumeError = err instanceof Error ? err.message : String(err);
                    log.error('Failed to resume crawler after reindex:', resumeError);
                }
            }

            return {
                status: resumeError ? 'partial' : 'ok',
                message: resumeError
                    ? `Reindex prepared but crawler resume failed: ${resumeError}`
                    : 'Reindex prepared',
                requestedHeight,
                effectiveStartHeight: rollback.effectiveStartHeight,
                blocksRolledBack: rollback.blocksRolledBack,
                transactionsRolledBack: rollback.transactionsRolledBack,
                crawlerResumed
            };
        });

        await super.init();
    }
}
