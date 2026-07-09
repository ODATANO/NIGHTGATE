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
            console.warn('[Crawler] Already running');
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

            console.log('[Crawler] Starting...');

            // Run the catch-up + live-subscription pipeline in the background.
            // Awaiting it here would block the caller (cds.on('served') callback)
            // until catch-up completes, which can take hours on a fresh DB. That
            // prevents CAP's HTTP server from binding to its port. Fire-and-forget
            // so the OData services come online immediately; the crawler keeps
            // ingesting in parallel.
            this.runIngestPipeline().catch(err => {
                console.error('[Crawler] Ingest pipeline failed:', err);
                this.isRunning = false;
            });
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
                console.log(`[Crawler] Gap catch-up: ${gapBlocks} blocks indexed`);
            }
        }
    }

    async stop(): Promise<void> {
        console.log('[Crawler] Stopping...');
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

        console.log('[Crawler] Stopped');
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
                console.log(`[Crawler] Already synced to finalized head (height ${tipHeight})`);
                return 0;
            }

            const totalBlocks = tipHeight - startHeight + 1;
            console.log(`[Crawler] Catch-up: ${startHeight} → ${tipHeight} (${totalBlocks} blocks, finalized)`);

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
     * Pipelined catch-up with JSON-RPC batching.
     *
     * Each in-flight unit is now a BATCH of K consecutive heights. Each batch
     * does exactly 2 WSS round-trips (one for hashes, one for blocks+timestamps).
     * `fetchConcurrency` batches stay in flight at once.
     *
     * Throughput model: bps ≈ K × concurrency × (1 / (2 × RTT)). For RTT=200ms,
     * K=32, concurrency=8: 32×8/0.4 = 640 bps theoretical. Real-world ceiling
     * comes from public-endpoint rate limits.
     *
     * Persist is serial in height order (reorg detection requires monotonic
     * progression). With persist at ~15ms/block we get a write ceiling of
     * ~65 bps per persister thread. If fetch outpaces persist, `wait=0` in the
     * diagnostic line and persist becomes the floor.
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

                        console.log(
                            `[Crawler] Catch-up: ${h}/${tipHeight} ` +
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
                console.error(
                    `[Crawler] Failed to process batch ${head.from}-${head.to}:`,
                    (err as Error).message
                );
                await this.recordError((err as Error).message);

                const state = await this.getSyncState();
                if ((state?.consecutiveErrors || 0) > 10) {
                    console.error('[Crawler] Too many consecutive errors, stopping catch-up');
                    break outer;
                }

                // A failed range must never be skipped: skipping would leave a
                // hole in the index while lastIndexedHeight keeps advancing.
                // Re-queue the batch once at the FRONT (height order stays
                // monotonic); a second failure aborts this catch-up run so the
                // next run resumes at lastIndexedHeight + 1.
                if (!head.retried) {
                    console.warn(`[Crawler] Re-queueing batch ${head.from}-${head.to} for a final retry`);
                    const heights: number[] = [];
                    for (let h = head.from; h <= head.to; h++) heights.push(h);
                    queue.unshift({
                        from: head.from,
                        to: head.to,
                        retried: true,
                        data: this.fetchBlockBatchWithRetry(heights)
                    });
                } else {
                    console.error(
                        `[Crawler] Batch ${head.from}-${head.to} failed after retry; ` +
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

        console.log(`[Crawler] Catch-up complete: ${processed} blocks in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
        return processed;
    }

    /**
     * Batch fetch with the same transient-error retry policy as
     * `fetchBlockWithRetry`. On retry, the entire batch is re-fetched.
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
                    console.error(`[Crawler] Batch ${heights[0]}-${heights[heights.length - 1]} permanent error: ${lastError.message}`);
                    break;
                }
                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    console.warn(
                        `[Crawler] Batch ${heights[0]}-${heights[heights.length - 1]} attempt ${attempt} failed (transient): ` +
                        `${lastError.message}, retrying in ${Math.round(delay)}ms`
                    );
                    await this.sleep(delay);
                }
            }
        }
        throw lastError || new Error(`Failed to fetch batch starting at ${heights[0]}`);
    }

    /**
     * Fetch a block's data (no DB write) with the same transient-error retry
     * policy used by the legacy `processBlockWithRetry`.
     */
    private async fetchBlockWithRetry(height: number): Promise<any> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.processor.fetchBlockData(height);
            } catch (err) {
                lastError = err as Error;
                const transient = isTransientError(lastError);
                if (!transient) {
                    console.error(`[Crawler] Block ${height} permanent error: ${lastError.message}`);
                    break;
                }
                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    console.warn(
                        `[Crawler] Block ${height} fetch attempt ${attempt} failed (transient): ` +
                        `${lastError.message}, retrying in ${Math.round(delay)}ms`
                    );
                    await this.sleep(delay);
                }
            }
        }
        throw lastError || new Error(`Failed to fetch block ${height}`);
    }

    // ========================================================================
    // Phase 2: Live Subscription
    // ========================================================================

    private async subscribeLive(): Promise<void> {
        console.log('[Crawler] Starting live subscription...');

        // Register reconnect handler to re-subscribe after connection loss
        if (typeof this.nodeProvider.setOnReconnect === 'function') {
            this.nodeProvider.setOnReconnect(async () => {
                if (this.isRunning) {
                    console.log('[Crawler] Re-subscribing after reconnect...');
                    this.subscriptionId = null;
                    await this.subscribeLive();
                }
            });
        }

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

                // Drain queued heights (process highest, then catch-up gaps)
                while (this.pendingHeights.length > 0 && this.isRunning) {
                    const maxHeight = Math.max(...this.pendingHeights);
                    this.pendingHeights = [];
                    // Catch up any gaps between current tip and maxHeight
                    const gapBlocks = await this.catchUp();
                    if (gapBlocks > 0) {
                        console.log(`[Crawler] Drained ${gapBlocks} queued blocks`);
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

        console.log('[Crawler] Live subscription active');
    }

    private async processLiveBlock(header: BlockHeader, height: number): Promise<void> {
        try {
            // Update chain height
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    chainHeight: height
                }).where({ ID: 'SINGLETON' })
            );

            // Gap: the head is more than one block ahead of the index (e.g.
            // heads buffered during a reconnect). Not a fork; run a normal
            // catch-up to the finalized tip instead of single-block processing.
            const tipState = await this.getSyncState();
            const lastIndexedHeight = Number(tipState?.lastIndexedHeight ?? 0);
            if (tipState?.lastIndexedHash && height > lastIndexedHeight + 1) {
                console.log(`[Crawler] Live: gap detected (head ${height}, indexed ${lastIndexedHeight}); catching up`);
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

            console.log(
                `[Crawler] Live: block ${height} ` +
                `(${result.transactionCount} txs, ${result.processingTimeMs}ms)`
            );
        } catch (err) {
            const error = err as Error;
            const transient = isTransientError(error);
            console.error(
                `[Crawler] Live: failed to process block ${height} ` +
                `(${transient ? 'transient' : 'permanent'}): ${error.message}`
            );
            await this.recordError(error.message);

            const state = await this.getSyncState();
            if ((state?.consecutiveErrors || 0) > 10) {
                console.error('[Crawler] Too many consecutive errors in live mode, pausing...');
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

        console.warn(`[Crawler] Reorg detected at height ${newHeight}: parent ${header.parentHash} != tip ${syncState.lastIndexedHash}`);

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
                console.error('[Crawler] Reorg depth > 100 blocks, stopping search');
                return height;
            }
        }

        return 0;
    }

    private async handleReorg(reorg: ReorgInfo): Promise<string> {
        console.warn(`[Crawler] Handling reorg: rolling back from height ${reorg.forkHeight}`);

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
        console.log(`[Crawler] Reorg handled: rolled back to height ${reorg.forkHeight - 1} in ${elapsed}ms`);
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
                    console.error(`[Crawler] Block ${height} permanent error: ${lastError.message}`);
                    break;
                }

                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    console.warn(
                        `[Crawler] Block ${height} attempt ${attempt} failed (transient): ` +
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
        lastIndexedHeight?: number | null;
        lastIndexedHash?: string | null;
    } | null | undefined): number {
        if (!syncState?.lastIndexedHash) {
            return 0;
        }

        return (syncState.lastIndexedHeight ?? -1) + 1;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
