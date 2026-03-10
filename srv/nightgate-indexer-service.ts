/**
 * Nightgate Indexer Service Implementation
 *
 * Exposes sync state, health metrics, and reorg history.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, UPDATE, DELETE } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';
import { resolveNightgateRuntimeConfig } from './utils/nightgate-config';
import { ensureSyncStateSingleton } from './utils/sync-state';
import { isCrawlerRunning, startCrawler, stopCrawler } from './crawler';

const processStartTime = Date.now();
const metricPrefix = 'odatano_nightgate';

export default class NightgateIndexerService extends cds.ApplicationService {
    private db!: any;

    private resolveCrawlerStartConfig(): { enabled: boolean; nodeUrl: string; requestTimeout?: number } {
        const { crawlerConfig, crawlerNodeUrl } = resolveNightgateRuntimeConfig((cds.env as any).requires?.nightgate || {});
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
        const blocksToRollback = await this.db.run(
            SELECT.from('midnight.Blocks').where({ height: { '>=': fromHeight } })
        ) || [];

        if (blocksToRollback.length === 0) {
            const forkBlock = await this.db.run(
                SELECT.one.from('midnight.Blocks')
                    .where({ height: { '<': fromHeight } })
                    .orderBy('height desc')
            );
            const effectiveStartHeight = forkBlock?.height != null ? Number(forkBlock.height) + 1 : 0;
            return {
                blocksRolledBack: 0,
                transactionsRolledBack: 0,
                effectiveStartHeight
            };
        }

        const blockIds = blocksToRollback.map((b: any) => b.ID).filter(Boolean);
        const txsToDelete = blockIds.length > 0
            ? await this.db.run(SELECT.from('midnight.Transactions').where({ block_ID: { in: blockIds } })) || []
            : [];
        const txIds = txsToDelete.map((t: any) => t.ID).filter(Boolean);

        if (txIds.length > 0) {
            const actionsToDelete = await this.db.run(
                SELECT.from('midnight.ContractActions').where({ transaction_ID: { in: txIds } })
            ) || [];
            const actionIds = actionsToDelete.map((a: any) => a.ID).filter(Boolean);

            if (actionIds.length > 0) {
                await this.db.run(DELETE.from('midnight.ContractBalances').where({ contractAction_ID: { in: actionIds } }));
            }

            await this.db.run(DELETE.from('midnight.ContractActions').where({ transaction_ID: { in: txIds } }));
            await this.db.run(DELETE.from('midnight.UnshieldedUtxos').where({ createdAtTransaction_ID: { in: txIds } }));
            await this.db.run(DELETE.from('midnight.ZswapLedgerEvents').where({ transaction_ID: { in: txIds } }));
            await this.db.run(DELETE.from('midnight.DustLedgerEvents').where({ transaction_ID: { in: txIds } }));
            await this.db.run(DELETE.from('midnight.TransactionFees').where({ transaction_ID: { in: txIds } }));

            const resultsToDelete = await this.db.run(
                SELECT.from('midnight.TransactionResults').where({ transaction_ID: { in: txIds } })
            ) || [];
            const resultIds = resultsToDelete.map((r: any) => r.ID).filter(Boolean);
            if (resultIds.length > 0) {
                await this.db.run(DELETE.from('midnight.TransactionSegments').where({ transactionResult_ID: { in: resultIds } }));
            }
            await this.db.run(DELETE.from('midnight.TransactionResults').where({ transaction_ID: { in: txIds } }));

            await this.db.run(
                UPDATE.entity('midnight.UnshieldedUtxos')
                    .set({ spentAtTransaction_ID: null })
                    .where({ spentAtTransaction_ID: { in: txIds } })
            );

            await this.db.run(DELETE.from('midnight.Transactions').where({ ID: { in: txIds } }));
        }

        await this.db.run(DELETE.from('midnight.Blocks').where({ ID: { in: blockIds } }));

        const forkBlock = await this.db.run(
            SELECT.one.from('midnight.Blocks')
                .where({ height: { '<': fromHeight } })
                .orderBy('height desc')
        );
        const effectiveStartHeight = forkBlock?.height != null ? Number(forkBlock.height) + 1 : 0;

        await this.db.run(
            UPDATE.entity('midnight.SyncState').set({
                lastIndexedHeight: forkBlock?.height ?? 0,
                lastIndexedHash: forkBlock?.hash ?? null,
                lastIndexedAt: new Date().toISOString(),
                syncStatus: 'stopped',
                syncProgress: 0
            }).where({ ID: 'SINGLETON' })
        );

        return {
            blocksRolledBack: blocksToRollback.length,
            transactionsRolledBack: txIds.length,
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
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 100);
            return this.db.run(
                SELECT.from('midnight.ReorgLog')
                    .orderBy('detectedAt desc')
                    .limit(effectiveLimit)
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
                UPDATE.entity('midnight.SyncState').set({
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
                    console.error('[IndexerService] Failed to resume crawler after reindex:', resumeError);
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
