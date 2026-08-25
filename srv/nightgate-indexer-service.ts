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
import { SyncState, ReorgLog } from '#cds-models/midnight';
import {
    buildHealth,
    buildLiveness,
    buildMetricsText,
    buildReadiness,
    buildRuntimeInfo,
    buildWorkerStatus
} from './monitoring/status';

import { RateLimiter } from './utils/rate-limiter';

const log = cds.log('nightgate:indexer');

// getRuntimeInfo can force a full artifact re-hash; keep a caller from
// hammering it. Generous enough for any dashboard cadence.
const runtimeInfoRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });

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

        // The four status handlers below delegate to srv/monitoring/status.ts,
        // which the plain /health, /ready and /metrics routes call as well.
        // Same code, same numbers, whichever way a caller arrives.
        this.on('getHealth', async () => buildHealth(this.db));

        this.on('getReorgHistory', async (req: Request) => {
            const { limit } = req.data as { limit?: number };
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 100);
            return this.db.run(
                SELECT.from(ReorgLog)
                    .orderBy('detectedAt desc')
                    .limit(effectiveLimit)
            );
        });

        this.on('getLiveness', async () => buildLiveness());

        // New in this release, both deliberately their own functions rather
        // than extra fields on getReadiness: nothing gates on them.
        // Rate-limited: the first call after an artifact change hashes every
        // prover, verifier and zkir file (around 200 MB for the default
        // registration set) on the event loop. The stat-fingerprint cache
        // makes the steady state cheap, but a caller that keeps forcing the
        // slow path must not be able to starve the process.
        this.on('getRuntimeInfo', async (req: Request) => {
            const clientKey = (req as any)?._?.req?.ip || 'global';
            const rate = runtimeInfoRateLimiter.check(clientKey);
            if (!rate.allowed) {
                return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
            }
            return buildRuntimeInfo();
        });
        // The per-facade list carries wallet-derived account ids, so it is
        // admin only; everyone else gets the counts.
        this.on('getWorkerStatus', async (req: Request) =>
            buildWorkerStatus(Boolean((req.user as any)?.is?.('admin'))));

        this.on('getReadiness', async () => buildReadiness(this.db));

        this.on('getMetrics', async () => buildMetricsText(this.db));

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
