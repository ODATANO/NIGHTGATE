/**
 * MidnightCrawler, Blockchain Crawler Orchestrator
 *
 * Two-phase operation:
 * 1. Catch-Up: Sync historical blocks from lastIndexedHeight to chain tip
 * 2. Live: Subscribe to new block headers and process in real-time
 *
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { MidnightNodeProvider, BlockHeader } from '../providers/MidnightNodeProvider';
import { BlockProcessor, ProcessResult } from './BlockProcessor';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { isTransientError, calcBackoff } from '../utils/retry';
import { ensureSyncStateSingleton } from '../utils/sync-state';
const log = cds.log('nightgate:crawler');
import { rollbackIndexedDataFromHeight } from './rollback';
import { SyncState, ReorgLog, Blocks } from '#cds-models/midnight';

// ============================================================================
// Types
// ============================================================================

export interface CrawlerConfig {
    enabled: boolean;
    nodeUrl?: string;           // ws://localhost:9944
    batchSize?: number;         // blocks per batch during catch-up (default: 10)
    maxRetries?: number;        // max retries per block (default: 3)
    retryDelay?: number;        // ms between retries (default: 2000)
    requestTimeout?: number;    // RPC timeout ms (default: 30000)
    fetchConcurrency?: number;  // Number of block-fetch BATCHES kept in flight  (default: 8)
    rpcBatchSize?: number; // Number of consecutive heights bundled into one JSON-RPC batch frame (default: 32)
}

interface ReorgInfo {
    forkHeight: number;
    oldTipHash: string;
    newTipHash: string;
}

// ============================================================================
// Crawler Orchestrator
// ============================================================================

export class MidnightCrawler {
    private isRunning: boolean = false;
    private isCatchingUp: boolean = false;
    private ingestActive: boolean = false;
    private pendingRedrive: boolean = false;  // A drive request that arrived while a pipeline was still unwinding
    private processing: boolean = false;  // Mutex: prevent concurrent block processing
    private pendingHeights: number[] = [];  // Queued live block heights received during processing
    private subscriptionId: string | null = null;
    private db!: cds.DatabaseService;
    private processor!: BlockProcessor;
    private startTime: number = 0;
    private blocksProcessed: number = 0;

    private config: Required<CrawlerConfig>;

    constructor(
        private nodeProvider: MidnightNodeProvider,
        config: CrawlerConfig
    ) {
        this.config = {
            enabled: config.enabled,
            nodeUrl: config.nodeUrl || 'ws://localhost:9944',
            batchSize: config.batchSize || 10,
            maxRetries: config.maxRetries || 3,
            retryDelay: config.retryDelay || 2000,
            requestTimeout: config.requestTimeout || 30000,
            fetchConcurrency: config.fetchConcurrency ?? 8,
            rpcBatchSize: config.rpcBatchSize ?? 32
        };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    async start(): Promise<void> {
        if (this.isRunning) {
            log.warn('Already running');
            return;
        }

        this.isRunning = true;
        this.startTime = Date.now();

        try {
            await ensureNightgateModelLoaded();
            this.db = await cds.connect.to('db');

            // Ensure SyncState singleton exists (shared utility)
            await ensureSyncStateSingleton(this.db, this.config.nodeUrl);

            // Connect to node FIRST
            if (!this.nodeProvider.isConnected()) {
                await this.nodeProvider.connect();
            }

            // Initialize block processor (after node is connected)
            this.processor = new BlockProcessor(this.nodeProvider);
            await this.processor.init();

            log.info('Starting...');

            if (typeof this.nodeProvider.setOnReconnect === 'function') {
                this.nodeProvider.setOnReconnect(async () => {
                    if (!this.isRunning) return;
                    log.info('Reconnected; re-driving ingest pipeline...');
                    this.driveIngest();
                });
            }
            if (typeof this.nodeProvider.setOnReconnectFailed === 'function') {
                this.nodeProvider.setOnReconnectFailed(() => {
                    log.error('Node reconnection abandoned; marking sync errored');
                    void this.db.run(
                        UPDATE.entity(SyncState).set({
                            syncStatus: 'error',
                            lastError: 'Node reconnection abandoned (max attempts reached)',
                            lastErrorAt: new Date().toISOString()
                        }).where({ ID: 'SINGLETON' })
                    ).catch(() => { /* DB may be unavailable too */ });
                });
            }

            // Run the catch-up + live-subscription pipeline in the background
            this.driveIngest();
        } catch (err) {
            this.isRunning = false;
            throw err;
        }
    }

    private async runIngestPipeline(): Promise<void> {
        // Phase 1: Catch-up
        await this.catchUp();

        // Phase 2: Live subscription
        if (this.isRunning) {
            await this.subscribeLive();
        }

        // Phase 3: Second catch-up to cover blocks finalized between
        // end of Phase 1 and subscription establishment in Phase 2
        if (this.isRunning) {
            const gapBlocks = await this.catchUp();
            if (gapBlocks > 0) {
                log.info(`Gap catch-up: ${gapBlocks} blocks indexed`);
            }
        }
    }

    /**
     * Fire-and-forget driver for the ingest pipeline. A connection-loss error is
     * transient (the provider is reconnecting; the reconnect handler re-drives),
     * so isRunning stays true; any other error is fatal. The ingestActive guard
     * prevents overlapping pipelines when a reconnect fires while the previous
     * run is still unwinding.
     */
    private driveIngest(): void {
        // A drive request arriving while a pipeline still runs (e.g. a reconnect
        // during catch-up) is coalesced into `pendingRedrive` and honoured in the
        // `.finally`; otherwise the reconnect no-ops and the crawler can sit
        // connected-but-idle until the next disconnect.
        if (this.ingestActive) { this.pendingRedrive = true; return; }
        this.ingestActive = true;
        this.pendingRedrive = false;
        this.runIngestPipeline()
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (this.isRunning && this.isConnectionLossError(err)) {
                    log.warn(`Ingest interrupted by connection loss; awaiting reconnect: ${msg}`);
                } else {
                    log.error('Ingest pipeline failed:', err);
                    this.isRunning = false;
                }
            })
            .finally(() => {
                this.ingestActive = false;
                if (this.pendingRedrive && this.isRunning) {
                    this.pendingRedrive = false;
                    this.driveIngest();
                }
            });
    }

    private isConnectionLossError(err: unknown): boolean {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        return /not connected|connection closed|websocket closed|closed before|disconnect|econnreset|socket hang up/.test(msg);
    }

    async stop(): Promise<void> {
        log.info('Stopping...');
        this.isRunning = false;

        // Unsubscribe from live updates
        if (this.subscriptionId) {
            try {
                await this.nodeProvider.unsubscribeFinalizedHeads(this.subscriptionId);
            } catch {
                // Ignore unsubscribe errors during shutdown
            }
            this.subscriptionId = null;
        }

        // Update sync state
        try {
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    syncStatus: 'stopped'
                }).where({ ID: 'SINGLETON' })
            );
        } catch {
            // DB might be closed
        }

        log.info('Stopped');
    }

    // ========================================================================
    // Phase 1: Catch-Up (Historical Blocks)
    // ========================================================================

    private async catchUp(): Promise<number> {
        this.isCatchingUp = true;
        try {
            const syncState = await this.getSyncState();
            const startHeight = this.getCatchUpStartHeight(syncState);

            // Target finalized head (not chain tip), avoids ingesting soon-reverted blocks
            const finalizedHash = await this.nodeProvider.getFinalizedHead();
            const finalizedHeader = await this.nodeProvider.getHeader(finalizedHash);
            const tipHeight = MidnightNodeProvider.parseBlockNumber(finalizedHeader.number);

            if (startHeight > tipHeight) {
                log.info(`Already synced to finalized head (height ${tipHeight})`);
                return 0;
            }

            const totalBlocks = tipHeight - startHeight + 1;
            log.info(`Catch-up: ${startHeight} → ${tipHeight} (${totalBlocks} blocks, finalized)`);

            await this.db.run(
                UPDATE.entity(SyncState).set({
                    syncStatus: 'syncing',
                    chainHeight: tipHeight,
                    lastFinalizedHeight: tipHeight,
                    lastFinalizedHash: finalizedHash
                }).where({ ID: 'SINGLETON' })
            );

            const processed = await this.runCatchUpPipeline(startHeight, tipHeight, totalBlocks);
            return processed;
        } finally {
            this.isCatchingUp = false;
        }
    }

    /**
     * Pipelined catch-up with JSON-RPC batching. Each in-flight unit is a BATCH
     * of K consecutive heights doing 2 WSS round-trips (hashes, then
     * blocks+timestamps); `fetchConcurrency` batches stay in flight at once.
     * Throughput ≈ K × concurrency / (2 × RTT).
     *
     * Persist is serial in height order (reorg detection needs monotonic
     * progression) and is the floor when fetch outpaces it (`wait=0` in the
     * diagnostic line).
     */
    private async runCatchUpPipeline(
        startHeight: number,
        tipHeight: number,
        totalBlocks: number
    ): Promise<number> {
        const concurrency = Math.max(1, this.config.fetchConcurrency);
        const rpcBatchSize = Math.max(1, this.config.rpcBatchSize ?? 32);
        const batchStart = Date.now();
        let processed = 0;
        let nextHeightToFetch = startHeight;
        let nextHeightToPersist = startHeight;

        // Diagnostic accumulators (reset per progress log).
        let acc = { fetchMsTotal: 0, persistMsTotal: 0, waitedForFetchMs: 0, samples: 0 };

        // Queue of in-flight batches; each is a Promise<PreparedBlock[]> covering
        // a contiguous height range. Drained in submission order. `retried`
        // marks a batch that was re-queued once after a failure.
        const queue: Array<{ from: number; to: number; data: Promise<any[]>; retried?: boolean }> = [];

        const pumpFetches = () => {
            while (
                queue.length < concurrency &&
                nextHeightToFetch <= tipHeight &&
                this.isRunning
            ) {
                const from = nextHeightToFetch;
                const to = Math.min(from + rpcBatchSize - 1, tipHeight);
                const heights: number[] = [];
                for (let h = from; h <= to; h++) heights.push(h);
                queue.push({ from, to, data: this.fetchBlockBatchWithRetry(heights) });
                nextHeightToFetch = to + 1;
            }
        };

        pumpFetches();

        outer:
        while (nextHeightToPersist <= tipHeight && this.isRunning) {
            const head = queue.shift();
            if (!head) break;

            let preps: any[];
            try {
                const waitStart = Date.now();
                preps = await head.data;
                const waitedForFetchMs = preps[0]?.fetchCompletedAt
                    ? Math.max(0, Date.now() - preps[0].fetchCompletedAt)
                    : Math.max(0, Date.now() - waitStart);

                for (const prep of preps) {
                    if (!this.isRunning) break;
                    const h = prep.height;
                    const fetchMs = (prep.fetchCompletedAt ?? Date.now()) - (prep.fetchStartedAt ?? Date.now());
                    const fetchMsPerBlock = preps.length > 0 ? fetchMs / preps.length : fetchMs;

                    const persistStart = Date.now();
                    await this.processor.persistPreparedBlock(prep);
                    const persistMs = Date.now() - persistStart;

                    acc.fetchMsTotal += fetchMsPerBlock;
                    acc.persistMsTotal += persistMs;
                    acc.waitedForFetchMs += waitedForFetchMs / preps.length;
                    acc.samples++;

                    processed++;
                    this.blocksProcessed++;
                    nextHeightToPersist = h + 1;

                    if (processed % this.config.batchSize === 0 || h === tipHeight) {
                        const elapsed = (Date.now() - batchStart) / 1000;
                        const bps = elapsed > 0 ? processed / elapsed : 0;
                        const remaining = tipHeight - h;
                        const eta = bps > 0 ? remaining / bps : 0;
                        const avgFetch = acc.samples ? (acc.fetchMsTotal / acc.samples).toFixed(0) : '0';
                        const avgPersist = acc.samples ? (acc.persistMsTotal / acc.samples).toFixed(0) : '0';
                        const avgWait = acc.samples ? (acc.waitedForFetchMs / acc.samples).toFixed(0) : '0';

                        log.info(
                            `Catch-up: ${h}/${tipHeight} ` +
                            `(${((h - startHeight + 1) / totalBlocks * 100).toFixed(1)}%) ` +
                            `${bps.toFixed(1)} bps, ETA: ${Math.ceil(eta)}s ` +
                            `[fetch=${avgFetch}ms persist=${avgPersist}ms wait=${avgWait}ms batch=${rpcBatchSize}]`
                        );
                        acc = { fetchMsTotal: 0, persistMsTotal: 0, waitedForFetchMs: 0, samples: 0 };

                        await this.db.run(
                            UPDATE.entity(SyncState).set({
                                syncProgress: ((h - startHeight + 1) / totalBlocks * 100),
                                blocksPerSecond: bps,
                                consecutiveErrors: 0
                            }).where({ ID: 'SINGLETON' })
                        );
                    }
                }
            } catch (err) {
                log.error(
                    `Failed to process batch ${head.from}-${head.to}:`,
                    (err as Error).message
                );
                await this.recordError((err as Error).message);

                const state = await this.getSyncState();
                if ((state?.consecutiveErrors || 0) > 10) {
                    log.error('Too many consecutive errors, stopping catch-up');
                    break outer;
                }

                // A failed range must never be skipped: skipping would leave a
                // hole in the index while lastIndexedHeight keeps advancing.
                if (!head.retried) {
                    log.warn(`Re-queueing batch ${head.from}-${head.to} for a final retry`);
                    const heights: number[] = [];
                    for (let h = head.from; h <= head.to; h++) heights.push(h);
                    queue.unshift({
                        from: head.from,
                        to: head.to,
                        retried: true,
                        data: this.fetchBlockBatchWithRetry(heights)
                    });
                } else {
                    log.error(
                        `Batch ${head.from}-${head.to} failed after retry; ` +
                        'stopping catch-up to avoid index gaps'
                    );
                    await this.db.run(
                        UPDATE.entity(SyncState).set({ syncStatus: 'error' }).where({ ID: 'SINGLETON' })
                    );
                    break outer;
                }
            }

            pumpFetches();
        }

        // Drain in-flight prefetches we don't intend to persist (best effort).
        for (const item of queue) {
            item.data.catch(() => { /* discard */ });
        }

        log.info(`Catch-up complete: ${processed} blocks in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
        return processed;
    }

    /**
     * Batch fetch with a transient-error retry policy. On retry, the entire
     * batch is re-fetched.
     */
    private async fetchBlockBatchWithRetry(heights: number[]): Promise<any[]> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.processor.fetchBlockBatch(heights);
            } catch (err) {
                lastError = err as Error;
                const transient = isTransientError(lastError);
                if (!transient) {
                    log.error(`Batch ${heights[0]}-${heights[heights.length - 1]} permanent error: ${lastError.message}`);
                    break;
                }
                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    log.warn(
                        `Batch ${heights[0]}-${heights[heights.length - 1]} attempt ${attempt} failed (transient): ` +
                        `${lastError.message}, retrying in ${Math.round(delay)}ms`
                    );
                    await this.sleep(delay);
                }
            }
        }
        throw lastError || new Error(`Failed to fetch batch starting at ${heights[0]}`);
    }

    // ========================================================================
    // Phase 2: Live Subscription
    // ========================================================================

    private async subscribeLive(): Promise<void> {
        log.info('Starting live subscription...');

        // Reconnect handling is registered once in start() (setOnReconnect →
        // driveIngest), so a drop during catch-up OR live is covered there.
        this.subscriptionId = await this.nodeProvider.subscribeFinalizedHeads(async (header: BlockHeader) => {
            if (!this.isRunning || this.isCatchingUp) return;

            const height = MidnightNodeProvider.parseBlockNumber(header.number);

            // Queue block height if already processing, don't drop it
            if (this.processing) {
                this.pendingHeights.push(height);
                return;
            }

            this.processing = true;

            try {
                await this.processLiveBlock(header, height);

                // Drain queued heights: clear the queue and let catchUp() close
                // any gap between the current tip and the chain head.
                while (this.pendingHeights.length > 0 && this.isRunning) {
                    this.pendingHeights = [];
                    const gapBlocks = await this.catchUp();
                    if (gapBlocks > 0) {
                        log.debug(`Drained ${gapBlocks} queued blocks`);
                    }
                }
            } finally {
                this.processing = false;
            }
        });

        // Update sync state
        await this.db.run(
            UPDATE.entity(SyncState).set({
                syncStatus: 'synced'
            }).where({ ID: 'SINGLETON' })
        );

        log.info('Live subscription active');
    }

    private async processLiveBlock(header: BlockHeader, height: number): Promise<void> {
        try {
            const tipState = await this.getSyncState();

            // Only advance chainHeight
            const currentChainHeight = Number(tipState?.chainHeight ?? 0);
            if (height > currentChainHeight) {
                await this.db.run(
                    UPDATE.entity(SyncState).set({
                        chainHeight: height
                    }).where({ ID: 'SINGLETON' })
                );
            }

            // Gap: the head is more than one block ahead of the index (e.g.
            // heads buffered during a reconnect). Not a fork; run a normal
            // catch-up to the finalized tip instead of single-block processing.
            const lastIndexedHeight = Number(tipState?.lastIndexedHeight ?? 0);
            if (tipState?.lastIndexedHash && height > lastIndexedHeight + 1) {
                log.info(`Live: gap detected (head ${height}, indexed ${lastIndexedHeight}); catching up`);
                await this.catchUp();
                return;
            }

            // Check for reorg
            const reorg = await this.checkForReorg(header);
            if (reorg) {
                const reorgLogId = await this.handleReorg(reorg);
                const reIndexedCount = await this.catchUp();
                await this.db.run(
                    UPDATE.entity(ReorgLog).set({
                        blocksReIndexed: reIndexedCount,
                        status: 'completed'
                    }).where({ ID: reorgLogId })
                );
                return;
            }

            // Process new block (processBlockByHeight already fetches the hash)
            const result = await this.processBlockWithRetry(height);
            this.blocksProcessed++;

            // Update sync state to synced
            const elapsed = (Date.now() - this.startTime) / 1000;
            const syncState = await this.getSyncState();
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    syncStatus: 'synced',
                    syncProgress: 100,
                    blocksPerSecond: this.blocksProcessed / elapsed,
                    consecutiveErrors: 0,
                    lastFinalizedHeight: height,
                    lastFinalizedHash: syncState?.lastIndexedHash || result.blockHash
                }).where({ ID: 'SINGLETON' })
            );

            log.debug(
                `Live: block ${height} ` +
                `(${result.transactionCount} txs, ${result.processingTimeMs}ms)`
            );
        } catch (err) {
            const error = err as Error;
            const transient = isTransientError(error);
            log.error(
                `Live: failed to process block ${height} ` +
                `(${transient ? 'transient' : 'permanent'}): ${error.message}`
            );
            await this.recordError(error.message);

            const state = await this.getSyncState();
            if ((state?.consecutiveErrors || 0) > 10) {
                log.error('Too many consecutive errors in live mode, pausing...');
            }
        }
    }

    // ========================================================================
    // Reorg Detection & Recovery
    // ========================================================================

    private async checkForReorg(header: BlockHeader): Promise<ReorgInfo | null> {
        const syncState = await this.getSyncState();
        if (!syncState?.lastIndexedHash) return null;

        // Fast path: the head extends our tip.
        if (header.parentHash === syncState.lastIndexedHash) return null;

        const newHeight = MidnightNodeProvider.parseBlockNumber(header.number);
        const lastIndexedHeight = Number(syncState.lastIndexedHeight ?? 0);

        // Head is far ahead of the index: that is a gap (e.g. subscription
        // replay backlog after a reconnect), not a fork. The caller catches
        // up; rolling back here would destroy valid data.
        if (newHeight > lastIndexedHeight + 1) return null;

        if (newHeight <= lastIndexedHeight) {
            // Old or replayed head (subscription start/reconnect re-delivers
            // already-indexed finalized heads). It sits on our chain iff its
            // parent is our block at newHeight - 1 → ignore. Only a diverging
            // parent at that height is a real fork below the tip.
            if (newHeight === 0) return null; // genesis replay: never roll back
            const localParent: any = await this.db.run(
                SELECT.one.from(Blocks).columns('hash').where({ height: newHeight - 1 })
            );
            if (localParent?.hash === header.parentHash) {
                return null;
            }
        }

        log.warn(`Reorg detected at height ${newHeight}: parent ${header.parentHash} != tip ${syncState.lastIndexedHash}`);

        const forkHeight = await this.findForkPoint(header);
        return {
            forkHeight,
            oldTipHash: syncState.lastIndexedHash,
            newTipHash: header.parentHash
        };
    }

    private async findForkPoint(header: BlockHeader): Promise<number> {
        let currentHash = header.parentHash;
        let height = MidnightNodeProvider.parseBlockNumber(header.number) - 1;

        while (height > 0) {
            const localBlock = await this.db.run(
                SELECT.one.from(Blocks).where({ hash: currentHash })
            );

            if (localBlock) {
                return height + 1;
            }

            try {
                const prevHeader = await this.nodeProvider.getHeader(currentHash);
                currentHash = prevHeader.parentHash;
                height--;
            } catch {
                return height;
            }

            if (MidnightNodeProvider.parseBlockNumber(header.number) - height > 100) {
                log.error('Reorg depth > 100 blocks, stopping search');
                return height;
            }
        }

        return 0;
    }

    private async handleReorg(reorg: ReorgInfo): Promise<string> {
        log.warn(`Handling reorg: rolling back from height ${reorg.forkHeight}`);

        const startTime = Date.now();
        const reorgLogId = cds.utils.uuid();

        await this.db.tx(async (tx: any) => {
            // Shared cascade + NightBalances repair (srv/crawler/rollback.ts);
            // also resets SyncState to the fork block with status 'syncing'.
            const result = await rollbackIndexedDataFromHeight(tx, reorg.forkHeight, {
                syncStatus: 'syncing'
            });

            if (result.blocksRolledBack === 0) return;

            await tx.run(INSERT.into(ReorgLog).entries({
                ID: reorgLogId,
                detectedAt: new Date().toISOString(),
                forkHeight: reorg.forkHeight,
                oldTipHash: reorg.oldTipHash,
                newTipHash: reorg.newTipHash,
                blocksRolledBack: result.blocksRolledBack,
                blocksReIndexed: 0,
                status: 'in_progress'
            }));
        });

        const elapsed = Date.now() - startTime;
        log.info(`Reorg handled: rolled back to height ${reorg.forkHeight - 1} in ${elapsed}ms`);
        return reorgLogId;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private async processBlockWithRetry(height: number): Promise<ProcessResult> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.processor.processBlockByHeight(height);
            } catch (err) {
                lastError = err as Error;
                const transient = isTransientError(lastError);

                if (!transient) {
                    // Permanent error, don't retry
                    log.error(`Block ${height} permanent error: ${lastError.message}`);
                    break;
                }

                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    log.warn(
                        `Block ${height} attempt ${attempt} failed (transient): ` +
                        `${lastError.message}, retrying in ${Math.round(delay)}ms`
                    );
                    await this.sleep(delay);
                }
            }
        }

        throw lastError || new Error(`Failed to process block ${height}`);
    }

    private async getSyncState(): Promise<any> {
        return this.db.run(
            SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
        );
    }

    private async recordError(message: string): Promise<void> {
        try {
            const state = await this.getSyncState();
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    lastError: message.slice(0, 500),
                    lastErrorAt: new Date().toISOString(),
                    consecutiveErrors: (state?.consecutiveErrors || 0) + 1,
                    syncStatus: 'error'
                }).where({ ID: 'SINGLETON' })
            );
        } catch {
            // Don't fail on error recording
        }
    }

    private getCatchUpStartHeight(syncState: {
        lastIndexedHeight?: number | string | null;
        lastIndexedHash?: string | null;
    } | null | undefined): number {
        if (!syncState?.lastIndexedHash) {
            return 0;
        }

        // Integer64 columns come back as STRINGS from CAP 10 databases
        // (ieee754compatible); "0" + 1 would concatenate to "01".
        return Number(syncState.lastIndexedHeight ?? -1) + 1;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
