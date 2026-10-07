/** Indexes finalized blocks. It first catches up to the finalized head, then follows new finalized heads. */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { MidnightNodeProvider, BlockHeader } from '../providers/MidnightNodeProvider';
import { BlockProcessor, ProcessResult } from './BlockProcessor';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { isTransientError, calcBackoff } from '../utils/retry';
import { ensureSyncStateSingleton } from '../utils/sync-state';
const log = cds.log('nightgate:crawler');
import { rollbackIndexedDataFromHeight } from './rollback';
import { LedgerPayloadDecoder } from './LedgerPayloadDecoder';
import { decodeLedgerPayloadInWorker } from '../midnight/decode-worker-client';
import { IndexerSupplement } from './IndexerSupplement';
import { contractStatePolicy } from './contract-state';
import { SyncState, ReorgLog, Blocks, type Block } from '#cds-models/midnight';

export interface CrawlerConfig {
    enabled: boolean;
    nodeUrl?: string;
    batchSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    requestTimeout?: number;
    fetchConcurrency?: number;  // Number of block batches fetched at the same time
    rpcBatchSize?: number; // Number of heights fetched in one JSON-RPC batch request
    startHeight?: number;  // First height to index. Used only when the index is empty.
    maxBlocksPerSecond?: number;  // 0 means no limit
    decodePayloads?: boolean;
    indexerSupplement?: boolean;  // Add data the blocks do not contain from the Midnight indexer
    indexerUrl?: string;
    supplementBlocksPerSecond?: number;
    contractStateHistory?: string;  // Which actions keep their full contract state: none, watched or all
    contractStateWatch?: string[];  // Contract addresses for `watched`
}

interface ReorgInfo {
    forkHeight: number;
    oldTipHash: string;
    newTipHash: string;
}

/** stop() waits this long for the in-flight batch or live block before unsubscribing. */
const STOP_DRAIN_MS = 30_000;
// Pause before a pipeline that failed on a transient error is driven again.
const INGEST_REDRIVE_MS = 30_000;

export class MidnightCrawler {
    private isRunning: boolean = false;
    private isCatchingUp: boolean = false;
    private ingestActive: boolean = false;
    private pendingRedrive: boolean = false;  // Set when a start request arrives while a pipeline is still running
    private processing: boolean = false;
    private pendingHeights: number[] = [];  // Live heads that arrived while a block was being processed
    private ingestPromise: Promise<void> | null = null;
    private redriveTimer: NodeJS.Timeout | null = null;
    private liveProcessing: Promise<void> | null = null;
    private subscriptionId: string | null = null;
    private db!: cds.DatabaseService;
    private processor!: BlockProcessor;
    private startTime: number = 0;
    private blocksProcessed: number = 0;

    /** A block that fails every time. Once set, the crawler stops retrying it on every new head. */
    private poisonBlock: { height: number; message: string } | null = null;

    /** The running catch-up. A second caller waits for it instead of starting another one. */
    private catchUpInFlight: Promise<number> | null = null;

    /** Background passes that run behind the indexed tip. Both are off unless configured. */
    private decoder: LedgerPayloadDecoder | null = null;
    private supplement: IndexerSupplement | null = null;

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
            rpcBatchSize: config.rpcBatchSize ?? 32,
            startHeight: config.startHeight ?? 0,
            maxBlocksPerSecond: config.maxBlocksPerSecond ?? 0,
            decodePayloads: config.decodePayloads ?? false,
            indexerSupplement: config.indexerSupplement ?? false,
            indexerUrl: config.indexerUrl || '',
            supplementBlocksPerSecond: config.supplementBlocksPerSecond ?? 2,
            contractStateHistory: config.contractStateHistory || 'none',
            contractStateWatch: config.contractStateWatch ?? []
        };
    }

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

            await ensureSyncStateSingleton(this.db, this.config.nodeUrl);

            if (!this.nodeProvider.isConnected()) {
                await this.nodeProvider.connect();
            }

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

            await this.startTrailingPasses();
            this.driveIngest();
        } catch (err) {
            this.isRunning = false;
            throw err;
        }
    }

    /** Neither pass blocks indexing, and a failure in either leaves the indexed blocks untouched. */
    private async startTrailingPasses(): Promise<void> {
        if (this.config.decodePayloads) {
            this.decoder = new LedgerPayloadDecoder({ batchSize: 25, intervalMs: 1000, lagBlocks: 10, decode: decodeLedgerPayloadInWorker });
            await this.decoder.init(this.db);
            this.decoder.start();
            log.info('Ledger payload decoding enabled (trailing pass)');
        }
        if (this.config.indexerSupplement) {
            if (!this.config.indexerUrl) {
                log.warn('Indexer supplement requested without an indexer URL; the pass stays off');
            } else {
                this.supplement = new IndexerSupplement({
                    url: this.config.indexerUrl,
                    batchSize: 25,
                    intervalMs: 1000,
                    lagBlocks: 10,
                    requestTimeoutMs: this.config.requestTimeout,
                    maxBlocksPerSecond: this.config.supplementBlocksPerSecond,
                    contractState: contractStatePolicy(this.config.contractStateHistory, this.config.contractStateWatch)
                });
                await this.supplement.init(this.db);
                this.supplement.start();
                let host = this.config.indexerUrl;
                try { host = new URL(this.config.indexerUrl).host; } catch { /* logged as given */ }
                log.info(`Indexer supplement enabled (trailing pass, ${this.config.supplementBlocksPerSecond} blocks/s, ${host}, contract state history: ${this.config.contractStateHistory})`);
            }
        }
    }

    private async runIngestPipeline(): Promise<void> {
        await this.catchUp();

        if (this.isRunning) {
            await this.subscribeLive();
        }

        // Second catch-up for blocks finalized between the first catch-up and the subscription.
        if (this.isRunning) {
            const gapBlocks = await this.catchUp();
            if (gapBlocks > 0) {
                log.info(`Gap catch-up: ${gapBlocks} blocks indexed`);
            }
        }
    }

    /** Does not wait. A call while the pipeline runs starts it again once the current run has ended. */
    private driveIngest(): void {
        if (this.ingestActive) { this.pendingRedrive = true; return; }
        this.ingestActive = true;
        this.pendingRedrive = false;
        this.ingestPromise = this.runIngestPipeline()
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (this.isRunning && this.isConnectionLossError(err)) {
                    log.warn(`Ingest interrupted by connection loss; awaiting reconnect: ${msg}`);
                } else if (this.isRunning && isTransientError(err as Error)) {
                    log.warn(`Ingest pipeline failed on a transient error; driving it again in ${INGEST_REDRIVE_MS / 1000}s: ${msg}`);
                    void this.recordError(msg, false);
                    this.scheduleRedrive();
                } else {
                    log.error('Ingest pipeline failed:', err);
                    if (this.isRunning) void this.recordError(msg);
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

    private scheduleRedrive(): void {
        if (this.redriveTimer) return;
        this.redriveTimer = setTimeout(() => {
            this.redriveTimer = null;
            if (this.isRunning) this.driveIngest();
        }, INGEST_REDRIVE_MS);
        this.redriveTimer.unref?.();
    }

    isActive(): boolean {
        return this.isRunning;
    }

    private isConnectionLossError(err: unknown): boolean {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        return /not connected|connection closed|websocket closed|closed before|disconnect|econnreset|socket hang up/.test(msg);
    }

    async stop(): Promise<void> {
        log.info('Stopping...');
        this.isRunning = false;
        if (this.redriveTimer) { clearTimeout(this.redriveTimer); this.redriveTimer = null; }

        await Promise.allSettled([this.decoder?.stop(), this.supplement?.stop()]);
        this.decoder = null;
        this.supplement = null;

        const inflight = [this.ingestPromise, this.liveProcessing].filter((p): p is Promise<void> => !!p);
        if (inflight.length > 0) {
            await Promise.race([
                Promise.allSettled(inflight),
                new Promise<void>(resolve => { const t = setTimeout(resolve, STOP_DRAIN_MS); (t as any).unref?.(); })
            ]);
        }

        if (this.subscriptionId) {
            try {
                await this.nodeProvider.unsubscribeFinalizedHeads(this.subscriptionId);
            } catch {
                // best effort during shutdown
            }
            this.subscriptionId = null;
        }

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

    /**
     * Allows one catch-up at a time. The pipeline and the live handler can call this almost at once.
     * Two runs over the same range would store the same blocks, and one would fail on the unique block hash.
     */
    private catchUp(): Promise<number> {
        if (this.catchUpInFlight) {
            log.debug('Catch-up already in flight; joining it');
            return this.catchUpInFlight;
        }
        const run = this.runCatchUp().finally(() => { this.catchUpInFlight = null; });
        this.catchUpInFlight = run;
        return run;
    }

    private async runCatchUp(): Promise<number> {
        if (this.poisonBlock) {
            log.debug(`Catch-up skipped: block ${this.poisonBlock.height} fails deterministically`);
            return 0;
        }

        this.isCatchingUp = true;
        try {
            const syncState = await this.getSyncState();
            let startHeight = this.getCatchUpStartHeight(syncState);

            // Use the finalized head, not the chain tip, so no indexed block can be reverted.
            const finalizedHash = await this.withRetry('Finalized head', () => this.nodeProvider.getFinalizedHead());
            const finalizedHeader = await this.withRetry('Finalized header', () => this.nodeProvider.getHeader(finalizedHash));
            const tipHeight = MidnightNodeProvider.parseBlockNumber(finalizedHeader.number);

            // Height 0 means nothing is indexed yet. Only then does startHeight apply.
            if (startHeight === 0 && this.config.startHeight > 0) {
                const seeded = await this.seedStartHeight(tipHeight);
                if (seeded === 'unfinalized') return 0;
                startHeight = seeded ?? startHeight;
            }

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
     * Stores block `startHeight - 1` as the first block of an empty index, so catch-up can start mid-chain.
     * This first block, the anchor, is the only block stored without its parent.
     * Returns null when the index already has blocks, and 'unfinalized' when the anchor is not finalized yet.
     */
    private async seedStartHeight(tipHeight: number): Promise<number | null | 'unfinalized'> {
        const indexed = await this.db.run(SELECT.one.from(Blocks).columns('ID'));
        if (indexed) {
            log.info(`startHeight ${this.config.startHeight} ignored: the index already holds blocks`);
            return null;
        }

        const anchorHeight = this.config.startHeight - 1;
        // The anchor has no parent, so a reorg of it would go unnoticed. Wait until it is finalized.
        if (anchorHeight > tipHeight) {
            log.warn(`startHeight ${this.config.startHeight} is above the finalized head (${tipHeight}); waiting`);
            return 'unfinalized';
        }

        log.info(`Seeding empty index with anchor block ${anchorHeight} (startHeight ${this.config.startHeight})`);

        const anchorHash = await this.withRetry(
            `Anchor hash ${anchorHeight}`,
            async () => {
                const hash = await this.nodeProvider.getBlockHash(anchorHeight);
                if (!hash) throw new Error(`No block at height ${anchorHeight}`);
                return hash;
            }
        );
        // By hash, not by height, because only this path accepts a block without a parent.
        await this.withRetry(`Anchor block ${anchorHeight}`, () => this.processor.processBlockByHash(anchorHash));

        log.info(`Anchor block ${anchorHeight} indexed (${anchorHash})`);
        return this.config.startHeight;
    }

    /**
     * Fetches several batches at the same time, but stores blocks one by one in height order.
     * Reorg detection relies on that order.
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

        let acc = { fetchMsTotal: 0, persistMsTotal: 0, waitedForFetchMs: 0, samples: 0 };

        // Batches being fetched, processed in order. `retried` marks a batch that was queued a second time.
        const queue: Array<{ from: number; to: number; data: Promise<any[]>; retried?: boolean }> = [];

        /**
         * A prefetch can fail before the loop awaits it. That rejection would be unhandled and end the process.
         * The empty catch prevents this. The loop's own `await` still sees the error.
         */
        const prefetch = (heights: number[]): Promise<any[]> => {
            const data = this.fetchBlockBatchWithRetry(heights);
            data.catch(() => { /* the queue reports it when it drains */ });
            return data;
        };

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
                queue.push({ from, to, data: prefetch(heights) });
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
                    await this.pace(processed, batchStart);

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
                                // Progress against the whole chain, not this run, so it does not drop after a restart.
                                // A chain with only genesis counts as 100%, because 0/0 would store null.
                                syncProgress: tipHeight > 0 ? Math.min(100, (h / tipHeight) * 100) : 100,
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

                // Never skip a failed range, or the index would have a gap.
                if (!head.retried) {
                    log.warn(`Re-queueing batch ${head.from}-${head.to} for a final retry`);
                    const heights: number[] = [];
                    for (let h = head.from; h <= head.to; h++) heights.push(h);
                    queue.unshift({
                        from: head.from,
                        to: head.to,
                        retried: true,
                        data: prefetch(heights)
                    });
                } else {
                    log.error(
                        `Batch ${head.from}-${head.to} failed after retry; ` +
                        'stopping catch-up to avoid index gaps'
                    );
                    // Only a permanent error stops retries for this block.
                    // A node outage must stay retryable, so indexing resumes after a reconnect.
                    if (!isTransientError(err as Error)) {
                        this.poisonBlock = { height: nextHeightToPersist, message: (err as Error).message };
                        log.error(
                            `Block ${nextHeightToPersist} does not index; halting until ` +
                            'pauseCrawler + resumeCrawler, reindexFromHeight or a restart retries it'
                        );
                    }
                    await this.db.run(
                        UPDATE.entity(SyncState).set({ syncStatus: 'error' }).where({ ID: 'SINGLETON' })
                    );
                    break outer;
                }
            }

            pumpFetches();
        }

        // Ignore errors of prefetches that were never stored.
        for (const item of queue) {
            item.data.catch(() => { /* discard */ });
        }

        log.info(`Catch-up complete: ${processed} blocks in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
        return processed;
    }

    private async fetchBlockBatchWithRetry(heights: number[]): Promise<any[]> {
        return this.withRetry(
            `Batch ${heights[0]}-${heights[heights.length - 1]}`,
            () => this.processor.fetchBlockBatch(heights)
        );
    }

    private async withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await run();
            } catch (err) {
                lastError = err as Error;
                if (!isTransientError(lastError)) {
                    log.error(`${label} permanent error: ${lastError.message}`);
                    break;
                }
                if (attempt < this.config.maxRetries) {
                    const delay = calcBackoff(attempt, this.config.retryDelay);
                    log.warn(
                        `${label} attempt ${attempt} failed (transient): ` +
                        `${lastError.message}, retrying in ${Math.round(delay)}ms`
                    );
                    await this.sleep(delay);
                }
            }
        }
        throw lastError || new Error(`${label} failed`);
    }

    /** Limits catch-up to `maxBlocksPerSecond`, so indexing can share the machine with the API. */
    private async pace(processed: number, since: number): Promise<void> {
        const cap = this.config.maxBlocksPerSecond;
        if (cap <= 0) return;
        const owed = (processed / cap) * 1000 - (Date.now() - since);
        if (owed > 0) await this.sleep(owed);
    }

    private async subscribeLive(): Promise<void> {
        log.info('Starting live subscription...');

        // A restarted pipeline can overlap the end of the previous one, which would subscribe twice.
        if (this.subscriptionId) {
            const stale = this.subscriptionId;
            this.subscriptionId = null;
            try { await this.nodeProvider.unsubscribeFinalizedHeads(stale); } catch { /* the socket it lived on may be gone */ }
        }

        // After a reconnect, setOnReconnect in start() runs the pipeline again.
        this.subscriptionId = await this.nodeProvider.subscribeFinalizedHeads(async (header: BlockHeader) => {
            if (!this.isRunning || this.isCatchingUp) return;

            const height = MidnightNodeProvider.parseBlockNumber(header.number);

            if (this.processing) {
                this.pendingHeights.push(height);
                return;
            }

            this.processing = true;

            this.liveProcessing = (async () => {
                try {
                    await this.processLiveBlock(header, height);

                    // Queued heads are not processed one by one. catchUp() fetches all missing blocks.
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
            })();
            await this.liveProcessing;
        });

        // Keep an error status from the catch-up. Being subscribed does not mean being in sync.
        await this.db.run(
            UPDATE.entity(SyncState).set({
                syncStatus: 'synced'
            }).where({ ID: 'SINGLETON' }).and({ syncStatus: { '!=': 'error' } })
        );

        log.info('Live subscription active');
    }

    private async processLiveBlock(header: BlockHeader, height: number): Promise<void> {
        try {
            const tipState = await this.getSyncState();

            const currentChainHeight = Number(tipState?.chainHeight ?? 0);
            if (height > currentChainHeight) {
                await this.db.run(
                    UPDATE.entity(SyncState).set({
                        chainHeight: height
                    }).where({ ID: 'SINGLETON' })
                );
            }

            if (this.poisonBlock) {
                log.debug(`Live: head ${height} seen; indexing halted at block ${this.poisonBlock.height}`);
                return;
            }

            // An empty index has no parent for this head.
            // Catch-up starts the index and reaches this head on the way.
            if (!tipState?.lastIndexedHash) {
                log.info(`Live: head ${height} on an empty index; catching up`);
                await this.catchUp();
                return;
            }

            // A head more than one block ahead is a gap, not a fork, so catch up.
            const lastIndexedHeight = Number(tipState.lastIndexedHeight ?? 0);
            if (height > lastIndexedHeight + 1) {
                log.info(`Live: gap detected (head ${height}, indexed ${lastIndexedHeight}); catching up`);
                await this.catchUp();
                return;
            }

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

            const result = await this.processBlockWithRetry(height);
            this.blocksProcessed++;

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

    private async checkForReorg(header: BlockHeader): Promise<ReorgInfo | null> {
        const syncState = await this.getSyncState();
        if (!syncState?.lastIndexedHash) return null;

        if (header.parentHash === syncState.lastIndexedHash) return null;

        const newHeight = MidnightNodeProvider.parseBlockNumber(header.number);
        const lastIndexedHeight = Number(syncState.lastIndexedHeight ?? 0);

        // A gap, not a fork. Rolling back here would delete valid data.
        if (newHeight > lastIndexedHeight + 1) return null;

        if (newHeight <= lastIndexedHeight) {
            // A head at or below our tip is on our chain if its parent is our block at newHeight - 1.
            // Only a different parent means a fork.
            if (newHeight === 0) return null; // never roll back genesis
            const localParent: Block | undefined = await this.db.run(
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

            // A failed lookup is not a fork point. Throw instead of rolling back too far.
            // The next head tries the search again.
            const prevHeader = await this.nodeProvider.getHeader(currentHash);
            if (!prevHeader?.parentHash) {
                throw new Error(`No header for ${currentHash} during fork search (pruned or racing node)`);
            }
            currentHash = prevHeader.parentHash;
            height--;

            // Without a common ancestor, the rollback point could still be on the old fork.
            if (MidnightNodeProvider.parseBlockNumber(header.number) - height > 100) {
                throw new Error(`Reorg deeper than 100 blocks below ${header.number}: no common ancestor found, refusing to roll back to an unverified height`);
            }
        }

        return 0;
    }

    private async handleReorg(reorg: ReorgInfo): Promise<string> {
        log.warn(`Handling reorg: rolling back from height ${reorg.forkHeight}`);

        const startTime = Date.now();
        const reorgLogId = cds.utils.uuid();

        await this.db.tx(async (tx) => {
            // Also resets SyncState to the fork block with status 'syncing'.
            const result = await rollbackIndexedDataFromHeight(tx, reorg.forkHeight, {
                syncStatus: 'syncing'
            });

            if (result.blocksRolledBack === 0) return;
            if (result.submissionsReverted || result.jobsReverted) {
                log.warn(`Reorg at ${reorg.forkHeight}: ${result.submissionsReverted} submission(s) and ${result.jobsReverted} job outcome(s) returned to pending`);
            }

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

    private async processBlockWithRetry(height: number): Promise<ProcessResult> {
        return this.withRetry(`Block ${height}`, () => this.processor.processBlockByHeight(height));
    }

    private async getSyncState(): Promise<any> {
        return this.db.run(
            SELECT.one.from(SyncState).where({ ID: 'SINGLETON' })
        );
    }

    /** With `markErrored` false, the error is recorded but syncStatus is not changed, because a retry follows. */
    private async recordError(message: string, markErrored: boolean = true): Promise<void> {
        try {
            // Incremented inside the SQL statement, so two failures recorded at once both count.
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    lastError: message.slice(0, 500),
                    lastErrorAt: new Date().toISOString(),
                    consecutiveErrors: { xpr: [{ func: 'coalesce', args: [{ ref: ['consecutiveErrors'] }, { val: 0 }] }, '+', { val: 1 }] } as any,
                    ...(markErrored ? { syncStatus: 'error' } : {})
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

        // Integer64 can come back as a string, and "0" + 1 would be "01".
        return Number(syncState.lastIndexedHeight ?? -1) + 1;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
