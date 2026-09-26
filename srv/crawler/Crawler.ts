/** Crawler: catch-up from lastIndexedHeight to the finalized head, then live finalized-head subscription. */

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
import { IndexerSupplement } from './IndexerSupplement';
import { SyncState, ReorgLog, Blocks } from '#cds-models/midnight';

export interface CrawlerConfig {
    enabled: boolean;
    nodeUrl?: string;           // ws://localhost:9944
    batchSize?: number;         // blocks per batch during catch-up (default: 10)
    maxRetries?: number;        // max retries per block (default: 3)
    retryDelay?: number;        // ms between retries (default: 2000)
    requestTimeout?: number;    // RPC timeout ms (default: 30000)
    fetchConcurrency?: number;  // Number of block-fetch BATCHES kept in flight  (default: 8)
    rpcBatchSize?: number; // Number of consecutive heights bundled into one JSON-RPC batch frame (default: 32)
    startHeight?: number;  // First height to index on an EMPTY index (default: 0, from genesis)
    maxBlocksPerSecond?: number;  // Catch-up rate cap (default: 0, unlimited)
    decodePayloads?: boolean;  // Decode stored ledger payloads in a trailing pass (default: false)
    indexerSupplement?: boolean;  // Fill what a block lacks from the indexer (default: false)
    indexerUrl?: string;  // GraphQL endpoint for the supplement pass
    supplementBlocksPerSecond?: number;  // Indexer requests per second of the supplement pass, one per block (default: 2)
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
    private pendingRedrive: boolean = false;  // A drive request that arrived while a pipeline was still unwinding
    private processing: boolean = false;  // Mutex: prevent concurrent block processing
    private pendingHeights: number[] = [];  // Queued live block heights received during processing
    private ingestPromise: Promise<void> | null = null;  // The running pipeline, awaited by stop()
    private redriveTimer: NodeJS.Timeout | null = null;
    private liveProcessing: Promise<void> | null = null;  // The live block being persisted, awaited by stop()
    private subscriptionId: string | null = null;
    private db!: cds.DatabaseService;
    private processor!: BlockProcessor;
    private startTime: number = 0;
    private blocksProcessed: number = 0;

    /** A block that fails deterministically; set to stop retrying it on every finalized head. */
    private poisonBlock: { height: number; message: string } | null = null;

    /** The catch-up in flight; a second caller joins it instead of running a twin over the same range. */
    private catchUpInFlight: Promise<number> | null = null;

    /** Passes that trail the indexed tip; both off unless configured. */
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
            supplementBlocksPerSecond: config.supplementBlocksPerSecond ?? 2
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

    /**
     * The decode and supplement passes run behind the indexed tip, independent
     * of the ingest pipeline: neither blocks indexing, and a failure in either
     * leaves the index itself untouched.
     */
    private async startTrailingPasses(): Promise<void> {
        if (this.config.decodePayloads) {
            this.decoder = new LedgerPayloadDecoder({ batchSize: 25, intervalMs: 1000, lagBlocks: 10 });
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
                    maxBlocksPerSecond: this.config.supplementBlocksPerSecond
                });
                await this.supplement.init(this.db);
                this.supplement.start();
                let host = this.config.indexerUrl;
                try { host = new URL(this.config.indexerUrl).host; } catch { /* logged as given */ }
                log.info(`Indexer supplement enabled (trailing pass, ${this.config.supplementBlocksPerSecond} blocks/s, ${host})`);
            }
        }
    }

    private async runIngestPipeline(): Promise<void> {
        await this.catchUp();

        if (this.isRunning) {
            await this.subscribeLive();
        }

        // Second catch-up: blocks finalized between the first one and the subscription.
        if (this.isRunning) {
            const gapBlocks = await this.catchUp();
            if (gapBlocks > 0) {
                log.info(`Gap catch-up: ${gapBlocks} blocks indexed`);
            }
        }
    }

    /** Fire-and-forget; a request while a pipeline runs re-drives once it has unwound. */
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

    /** False once a permanent ingest failure or a stop ended the crawl. */
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
     * One catch-up at a time. The pipeline's second pass and the live gap
     * handler call this within milliseconds of each other once the first pass
     * ends; two runs over the same range persist the same blocks, and the one
     * that loses the unique block hash used to latch as a poison block.
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

            // Finalized head, not chain tip: never ingest blocks that may revert.
            const finalizedHash = await this.withRetry('Finalized head', () => this.nodeProvider.getFinalizedHead());
            const finalizedHeader = await this.withRetry('Finalized header', () => this.nodeProvider.getHeader(finalizedHash));
            const tipHeight = MidnightNodeProvider.parseBlockNumber(finalizedHeader.number);

            // Height 0 means nothing is indexed yet, which is where startHeight applies.
            if (startHeight === 0 && this.config.startHeight > 0) {
                const seeded = await this.seedStartHeight(tipHeight);
                if (seeded === 'unfinalized') return 0;
                startHeight = seeded ?? startHeight;
            }

            if (startHeight > tipHeight) {
                log.info(`Already synced to finalized head (height ${tipHeight})`);
                return 0;
            }

            // How far THIS run has to go. Not the same as the share of the
            // chain that is indexed, which is what syncProgress reports.
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
     * Anchor an empty index at `startHeight - 1`, the one block persisted without a
     * parent, so catch-up can begin mid-chain and every later block still resolves
     * its parent. Returns the height to catch up from, null when the index already
     * holds blocks (the cursor decides then, not the configuration), or
     * 'unfinalized' when the anchor is not finalized yet.
     */
    private async seedStartHeight(tipHeight: number): Promise<number | null | 'unfinalized'> {
        const indexed = await this.db.run(SELECT.one.from(Blocks).columns('ID'));
        if (indexed) {
            log.info(`startHeight ${this.config.startHeight} ignored: the index already holds blocks`);
            return null;
        }

        const anchorHeight = this.config.startHeight - 1;
        // The anchor carries no parent, so nothing downstream would notice it reverting.
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
        // processBlockByHash, not by height: the anchor is the one block allowed no parent.
        await this.withRetry(`Anchor block ${anchorHeight}`, () => this.processor.processBlockByHash(anchorHash));

        log.info(`Anchor block ${anchorHeight} indexed (${anchorHash})`);
        return this.config.startHeight;
    }

    /**
     * `fetchConcurrency` batch fetches of `rpcBatchSize` heights stay in flight;
     * persist is serial in height order, which reorg detection relies on.
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

        // Reset per progress log line.
        let acc = { fetchMsTotal: 0, persistMsTotal: 0, waitedForFetchMs: 0, samples: 0 };

        // In-flight batches, drained in submission order; `retried` = re-queued once.
        const queue: Array<{ from: number; to: number; data: Promise<any[]>; retried?: boolean }> = [];

        /**
         * A prefetch sits in the queue until the loop reaches it, and it can
         * reject while the loop is still persisting an earlier batch. Nothing
         * is awaiting it at that moment, so the rejection would be unhandled
         * and an unhandled rejection ends the process. The no-op catch marks it
         * handled; the queue's own `await` still sees the rejection.
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
                                // Against the CHAIN, not against this run: the run
                                // starts wherever the cursor left off, so a
                                // run-relative figure drops on every restart while
                                // the index keeps growing.
                                // tipHeight 0 is a genesis-only chain: 0/0 would
                                // store null, which reads as "unknown".
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

                // Never skip a failed range: lastIndexedHeight would advance over a hole.
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
                    // Only a deterministic failure latches: a node outage is transient and
                    // must stay retryable, or a reconnect would find indexing switched off.
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

        // Unpersisted prefetches: swallow their rejections.
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

    /** Retries transient failures with the configured backoff; a permanent one fails at once. */
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

    /** Holds catch-up at `maxBlocksPerSecond` so block ingestion can share a box with the API. */
    private async pace(processed: number, since: number): Promise<void> {
        const cap = this.config.maxBlocksPerSecond;
        if (cap <= 0) return;
        const owed = (processed / cap) * 1000 - (Date.now() - since);
        if (owed > 0) await this.sleep(owed);
    }

    private async subscribeLive(): Promise<void> {
        log.info('Starting live subscription...');

        // A re-drive racing the previous pipeline's tail would subscribe twice.
        if (this.subscriptionId) {
            const stale = this.subscriptionId;
            this.subscriptionId = null;
            try { await this.nodeProvider.unsubscribeFinalizedHeads(stale); } catch { /* the socket it lived on may be gone */ }
        }

        // Reconnects re-drive via setOnReconnect in start().
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

                    // Queued heights are not processed singly: catchUp() closes the gap.
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

        // A catch-up that ended in error keeps its status: subscribing is not being synced.
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

            // An empty index has no parent for this head; catch-up seeds the anchor
            // (or walks from genesis) and indexes the head on the way.
            if (!tipState?.lastIndexedHash) {
                log.info(`Live: head ${height} on an empty index; catching up`);
                await this.catchUp();
                return;
            }

            // Head more than one block ahead is a gap, not a fork: catch up.
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

        // A gap, not a fork: rolling back here would destroy valid data.
        if (newHeight > lastIndexedHeight + 1) return null;

        if (newHeight <= lastIndexedHeight) {
            // Replayed head: on our chain iff its parent is our block at
            // newHeight - 1; only a diverging parent is a fork below the tip.
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

            // A failed lookup is not a fork point: throw instead of rolling back
            // to wherever the RPC failed; the next head retries the search.
            const prevHeader = await this.nodeProvider.getHeader(currentHash);
            if (!prevHeader?.parentHash) {
                throw new Error(`No header for ${currentHash} during fork search (pruned or racing node)`);
            }
            currentHash = prevHeader.parentHash;
            height--;

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

    /** `markErrored` false records the error without flipping syncStatus (a retry follows). */
    private async recordError(message: string, markErrored: boolean = true): Promise<void> {
        try {
            const state = await this.getSyncState();
            await this.db.run(
                UPDATE.entity(SyncState).set({
                    lastError: message.slice(0, 500),
                    lastErrorAt: new Date().toISOString(),
                    consecutiveErrors: (state?.consecutiveErrors || 0) + 1,
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

        // Integer64 reads back as a string (ieee754compatible): "0" + 1 is "01".
        return Number(syncState.lastIndexedHeight ?? -1) + 1;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
