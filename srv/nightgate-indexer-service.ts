import cds from '@sap/cds';
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
import { principalRateKey } from './utils/rate-limiter';
import { normalizeHttpError } from './utils/http-errors';
import { buildBoardStatus } from './submission/board-status';
import { getBoardStatus, getReadiness, getReorgHistory, getRuntimeInfo, reindexFromHeight, resumeCrawler } from '#cds-models/NightgateIndexerService';
import type { Request } from '@sap/cds';

const log = cds.log('nightgate:indexer');

// getRuntimeInfo can trigger a full re-hash of the contract files, which blocks the event loop.
const runtimeInfoRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
// Open to anonymous callers and polled by web pages. Each call runs three count queries.
const boardStatusRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 60 });

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
        // Commits before the caller restarts the crawler, so the crawler never sees the old rows.
        const result: RollbackResult = await this.db.tx(async (tx) =>
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
        this.on('error', normalizeHttpError);
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');

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

        this.on('getHealth', async () => buildHealth(this.db));

        this.on(getReorgHistory, async (req) => {
            const { limit } = req.data;
            const effectiveLimit = Math.min(Math.max(limit || 10, 1), 100);
            return this.db.run(
                SELECT.from(ReorgLog)
                    .orderBy('detectedAt desc')
                    .limit(effectiveLimit)
            );
        });

        this.on('getLiveness', async () => buildLiveness());

        this.on(getRuntimeInfo, async (req) => {
            const clientKey = principalRateKey(req, 'runtime-info');
            const rate = runtimeInfoRateLimiter.check(clientKey);
            if (!rate.allowed) {
                return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
            }
            return buildRuntimeInfo();
        });
        this.on('getWorkerStatus', async (req: Request) =>
            buildWorkerStatus(Boolean(req.user?.is?.('admin'))));

        this.on(getBoardStatus, async (req) => {
            const rate = boardStatusRateLimiter.check(principalRateKey(req, 'board-status'));
            if (!rate.allowed) {
                return req.reject(429, `Rate limited. Retry after ${Math.ceil(rate.retryAfterMs / 1000)}s`);
            }
            return buildBoardStatus(this.db);
        });

        this.on(getReadiness, async (req) => {
            const readiness = await buildReadiness(this.db);
            // Health checks only look at the status code, so "not ready" must be a 503.
            // `req.http` is missing on an internal call.
            if (readiness.ready !== true) req?.http?.res?.status(503);
            return readiness;
        });

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

        this.on(resumeCrawler, async (req) => {
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

        this.on(reindexFromHeight, async (req) => {
            const { height } = req.data;
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
