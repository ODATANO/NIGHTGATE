/**
 * Nightgate Indexer Service Implementation
 *
 * Exposes sync state, health metrics, and reorg history.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, INSERT } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';

const processStartTime = Date.now();
const metricPrefix = 'odatano_nightgate';

export default class NightgateIndexerService extends cds.ApplicationService {
    private db!: any;

    async init(): Promise<void> {
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

        // Ensure SyncState row exists (even before crawler starts)
        try {
            const existing = await this.db.run(
                SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
            );
            if (!existing) {
                const nightgateConfig = (cds.env as any).requires?.nightgate || {};
                await this.db.run(INSERT.into('midnight.SyncState').entries({
                    ID: 'SINGLETON',
                    networkId: nightgateConfig.network || 'testnet',
                    lastIndexedHeight: 0,
                    syncStatus: 'stopped',
                    nodeUrl: nightgateConfig.nodeUrl || '',
                    chainHeight: 0,
                    consecutiveErrors: 0
                }));
            }
        } catch (err) {
            console.warn('[IndexerService] SyncState init skipped:', (err as Error).message);
        }

        this.on('getSyncStatus', async () => {
            const syncState = await this.db.run(
                SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
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
            const syncState = await this.db.run(
                SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
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
                    syncStatus: 'stopped'
                };
            }

            const chainHeight = syncState.chainHeight || 0;
            const indexedHeight = syncState.lastIndexedHeight || 0;
            const finalizedHeight = syncState.lastFinalizedHeight || 0;
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
                blocksPerSecond: syncState.blocksPerSecond || 0,
                syncStatus: syncState.syncStatus || 'stopped'
            };
        });

        this.on('getReorgHistory', async (req: Request) => {
            const { limit } = req.data as { limit?: number };
            return this.db.run(
                SELECT.from('midnight.ReorgLog')
                    .orderBy('detectedAt desc')
                    .limit(limit || 10)
            );
        });

        this.on('getLiveness', async () => {
            return {
                status: 'alive',
                timestamp: new Date().toISOString(),
                uptime: Math.floor((Date.now() - processStartTime) / 1000)
            };
        });

        this.on('getReadiness', async () => {
            const checks = {
                database: false,
                crawler: false,
                node: false
            };

            try {
                const syncState = await this.db.run(
                    SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
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
                ready: checks.database && checks.crawler && checks.node,
                checks
            };
        });

        this.on('getMetrics', async () => {
            const syncState = await this.db.run(
                SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
            );

            const lines: string[] = [];
            const chainHeight = syncState?.chainHeight || 0;
            const indexedHeight = syncState?.lastIndexedHeight || 0;
            const lag = chainHeight - indexedHeight;
            const bps = syncState?.blocksPerSecond || 0;
            const errors = syncState?.consecutiveErrors || 0;
            const uptimeSec = Math.floor((Date.now() - processStartTime) / 1000);
            const syncStatus = syncState?.syncStatus || 'stopped';

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

            return lines.join('\n') + '\n';
        });

        await super.init();
    }
}
