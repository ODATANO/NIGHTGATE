import cds from '@sap/cds';
import { errorMessage } from './utils/errors';
const { SELECT, UPDATE } = cds.ql;

import { ensureNightgateModelLoaded } from './utils/cds-model';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig, crawlerStartConfig } from './utils/nightgate-config';
import { ensureSyncStateSingleton } from './utils/sync-state';
import { isCrawlerRunning, startCrawler, stopCrawler } from './crawler';
import { pendingReindexHeight, reindexInProgress, startReindex, type ReindexCrawlerControl, type ReindexOutcome } from './crawler/reindex';
import { configMs } from './utils/config';
import { SyncState, ReorgLog } from '#cds-models/midnight';
import {
    buildHealth,
    buildLiveness,
    buildMetricsText,
    buildReadiness,
    buildRuntimeInfo,
    buildWorkerStatus
} from './monitoring/status';

import { checkRateClass } from './utils/rate-classes';
import { normalizeHttpError } from './utils/http-errors';
import { buildBoardStatus } from './submission/board-status';
import { receiptPublicKey } from './submission/receipts';
import { getBoardStatus, getReadiness, getReceiptKey, getReorgHistory, getRuntimeInfo, reindexFromHeight, resumeCrawler } from '#cds-models/NightgateIndexerService';
import type { Request } from '@sap/cds';

const log = cds.log('nightgate:indexer');

const REINDEX_RUNNING = 'a reindex is running; the log reports each slice it removed, call again once it finished';
const CRAWLER_STARTING = 'the crawler is starting, call again once it runs';

let crawlerStarting = false;

export default class NightgateIndexerService extends cds.ApplicationService {
    private db!: cds.DatabaseService;

    private resolveCrawlerStartConfig(): ReturnType<typeof crawlerStartConfig> {
        return crawlerStartConfig(resolveNightgateRuntimeConfig(getNightgatePluginConfig()));
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
            if (!checkRateClass('read', 'read', req)) return;
            return buildRuntimeInfo();
        });
        this.on('getWorkerStatus', async (req: Request) =>
            buildWorkerStatus(Boolean(req.user?.is?.('admin'))));

        this.on(getBoardStatus, async (req) => {
            if (!checkRateClass('read', 'read', req)) return;
            return buildBoardStatus(this.db);
        });

        this.on(getReceiptKey, async (req) => {
            if (!checkRateClass('read', 'read', req)) return;
            return receiptPublicKey();
        });

        this.on(getReadiness, async (req) => {
            const readiness = await buildReadiness(this.db);
            // Health checks only look at the status code, so "not ready" must be a 503.
            // `req.http` is missing on an internal call.
            if (readiness.ready !== true) req?.http?.res?.status(503);
            return readiness;
        });

        this.on('getMetrics', async () => buildMetricsText(this.db));

        this.on('pauseCrawler', async (req: Request) => {
            if (reindexInProgress()) return req.reject(409, REINDEX_RUNNING);
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
            // The crawler must not index again while blocks below it are still being removed.
            if (reindexInProgress()) return req.reject(409, REINDEX_RUNNING);
            if (crawlerStarting) return req.reject(409, CRAWLER_STARTING);
            if (isCrawlerRunning()) {
                return {
                    status: 'ok',
                    running: true,
                    message: 'Crawler already running'
                };
            }

            crawlerStarting = true;
            try {
                const openReindex = await pendingReindexHeight(this.db);
                if (openReindex !== null) {
                    startReindex(this.db, openReindex, { stop: async () => true, start: () => startCrawler(this.resolveCrawlerStartConfig()) })
                        .catch(err => log.error(`reindex from ${openReindex} failed: ${errorMessage(err)}`));
                    return {
                        status: 'ok',
                        running: false,
                        message: `A reindex from ${openReindex} is not finished. It finishes first, then the crawler starts.`
                    };
                }
                await startCrawler(this.resolveCrawlerStartConfig());
                return {
                    status: 'ok',
                    running: true,
                    message: 'Crawler resumed'
                };
            } catch (err) {
                const message = errorMessage(err);
                return req.reject(500, `Failed to resume crawler: ${message}`);
            } finally {
                crawlerStarting = false;
            }
        });

        this.on(reindexFromHeight, async (req) => {
            const { height } = req.data;
            const requestedHeight = Number(height);

            if (!Number.isInteger(requestedHeight) || requestedHeight < 0) {
                return req.reject(400, 'height must be a non-negative integer');
            }
            if (reindexInProgress()) return req.reject(409, REINDEX_RUNNING);
            if (crawlerStarting) return req.reject(409, CRAWLER_STARTING);

            // No await before the claim: a second call in between would pass the check above.
            const crawler: ReindexCrawlerControl = {
                stop: async () => {
                    const wasRunning = isCrawlerRunning();
                    if (wasRunning) await stopCrawler();
                    return wasRunning;
                },
                start: () => startCrawler(this.resolveCrawlerStartConfig())
            };
            const run = startReindex(this.db, requestedHeight, crawler);
            run.catch(() => { /* recorded in SyncState and the log by the reindex */ });

            // A long rollback continues in the background, so an HTTP timeout leaves nothing half done.
            const waitMs = configMs('NIGHTGATE_REINDEX_REPLY_WAIT_MS');
            let timer: NodeJS.Timeout | undefined;
            let finished: ReindexOutcome | null;
            try {
                finished = await Promise.race([
                    run,
                    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); })
                ]);
            } catch (err) {
                return req.reject(500, `Reindex failed: ${errorMessage(err)}. The crawler stays stopped until a reindex or resumeCrawler finishes the rollback.`);
            } finally {
                clearTimeout(timer);
            }
            if (finished === null) {
                const progress = reindexInProgress();
                return {
                    status: 'running',
                    message: 'Reindex continues in the background. A running crawler resumes when it finishes. A failure shows in getSyncStatus.',
                    requestedHeight,
                    effectiveStartHeight: null,
                    blocksRolledBack: progress?.blocksRolledBack ?? 0,
                    transactionsRolledBack: progress?.transactionsRolledBack ?? 0,
                    crawlerResumed: false
                };
            }

            return {
                status: finished.resumeError ? 'partial' : 'ok',
                message: finished.resumeError
                    ? `Reindex prepared but crawler resume failed: ${finished.resumeError}`
                    : 'Reindex prepared',
                requestedHeight,
                effectiveStartHeight: finished.progress.effectiveStartHeight,
                blocksRolledBack: finished.progress.blocksRolledBack,
                transactionsRolledBack: finished.progress.transactionsRolledBack,
                crawlerResumed: finished.crawlerResumed
            };
        });

        await super.init();
    }
}
