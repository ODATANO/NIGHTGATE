/**
 * MidnightCrawler — Blockchain Crawler Orchestrator
 *
 * Two-phase operation:
 * 1. Catch-Up: Sync historical blocks from lastIndexedHeight to chain tip
 * 2. Live: Subscribe to new block headers and process in real-time
 *
 * Features:
 * - Reorg detection and recovery
 * - Configurable batch size for catch-up
 * - Automatic retry with backoff
 * - SyncState tracking
 * - Graceful shutdown
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import { MidnightNodeProvider, BlockHeader } from '../providers/MidnightNodeProvider';
import { BlockProcessor, ProcessResult } from './BlockProcessor';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { isTransientError, calcBackoff } from '../utils/retry';
import { ensureSyncStateSingleton } from '../utils/sync-state';

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
    private db: any;
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
            requestTimeout: config.requestTimeout || 30000
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
        } catch (err) {
            this.isRunning = false;
            throw err;
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
                UPDATE.entity('midnight.SyncState').set({
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

            // Target finalized head (not chain tip) — avoids ingesting soon-reverted blocks
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
                UPDATE.entity('midnight.SyncState').set({
                    syncStatus: 'syncing',
                    chainHeight: tipHeight,
                    lastFinalizedHeight: tipHeight,
                    lastFinalizedHash: finalizedHash
                }).where({ ID: 'SINGLETON' })
            );

            let processed = 0;
            const batchStart = Date.now();

            for (let h = startHeight; h <= tipHeight && this.isRunning; h++) {
                try {
                    const result = await this.processBlockWithRetry(h);
                    processed++;
                    this.blocksProcessed++;

                    // Progress logging
                    if (processed % this.config.batchSize === 0 || h === tipHeight) {
                        const elapsed = (Date.now() - batchStart) / 1000;
                        const bps = elapsed > 0 ? processed / elapsed : 0;
                        const remaining = tipHeight - h;
                        const eta = bps > 0 ? remaining / bps : 0;

                        console.log(
                            `[Crawler] Catch-up: ${h}/${tipHeight} ` +
                            `(${((h - startHeight + 1) / totalBlocks * 100).toFixed(1)}%) ` +
                            `${bps.toFixed(1)} blocks/s, ETA: ${Math.ceil(eta)}s`
                        );

                        // Update SyncState with progress
                        await this.db.run(
                            UPDATE.entity('midnight.SyncState').set({
                                syncProgress: ((h - startHeight + 1) / totalBlocks * 100),
                                blocksPerSecond: bps,
                                consecutiveErrors: 0
                            }).where({ ID: 'SINGLETON' })
                        );
                    }
                } catch (err) {
                    console.error(`[Crawler] Failed to process block ${h} after ${this.config.maxRetries} retries:`, (err as Error).message);
                    await this.recordError((err as Error).message);

                    // Check if we should continue
                    const state = await this.getSyncState();
                    if ((state?.consecutiveErrors || 0) > 10) {
                        console.error('[Crawler] Too many consecutive errors, stopping catch-up');
                        break;
                    }
                }
            }

            console.log(`[Crawler] Catch-up complete: ${processed} blocks in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
            return processed;
        } finally {
            this.isCatchingUp = false;
        }
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

            // Queue block height if already processing — don't drop it
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
            UPDATE.entity('midnight.SyncState').set({
                syncStatus: 'synced'
            }).where({ ID: 'SINGLETON' })
        );

        console.log('[Crawler] Live subscription active');
    }

    private async processLiveBlock(header: BlockHeader, height: number): Promise<void> {
        try {
            // Update chain height
            await this.db.run(
                UPDATE.entity('midnight.SyncState').set({
                    chainHeight: height
                }).where({ ID: 'SINGLETON' })
            );

            // Check for reorg
            const reorg = await this.checkForReorg(header);
            if (reorg) {
                const reorgLogId = await this.handleReorg(reorg);
                const reIndexedCount = await this.catchUp();
                await this.db.run(
                    UPDATE.entity('midnight.ReorgLog').set({
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
                UPDATE.entity('midnight.SyncState').set({
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

        // If parent hash doesn't match our tip, we have a reorg
        if (header.parentHash !== syncState.lastIndexedHash) {
            const newHeight = MidnightNodeProvider.parseBlockNumber(header.number);
            console.warn(`[Crawler] Reorg detected at height ${newHeight}: parent ${header.parentHash} != tip ${syncState.lastIndexedHash}`);

            const forkHeight = await this.findForkPoint(header);
            return {
                forkHeight,
                oldTipHash: syncState.lastIndexedHash,
                newTipHash: header.parentHash
            };
        }

        return null;
    }

    private async findForkPoint(header: BlockHeader): Promise<number> {
        let currentHash = header.parentHash;
        let height = MidnightNodeProvider.parseBlockNumber(header.number) - 1;

        while (height > 0) {
            const localBlock = await this.db.run(
                SELECT.one.from('midnight.Blocks').where({ hash: currentHash })
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
            const blocksToRollback: any[] = await tx.run(
                SELECT.from('midnight.Blocks').columns('ID', 'height')
                    .where({ height: { '>=': reorg.forkHeight } })
            ) || [];
            const rollbackCount = blocksToRollback.length;
            const blockIds = blocksToRollback.map((b: any) => b.ID);

            if (blockIds.length === 0) return;

            const txsToDelete: any[] = await tx.run(
                SELECT.from('midnight.Transactions').columns('ID')
                    .where({ block_ID: { in: blockIds } })
            ) || [];

            if (txsToDelete.length > 0) {
                const txIds = txsToDelete.map((t: any) => t.ID);

                // Batch delete contract balances via action IDs
                const actionsToDelete: any[] = await tx.run(
                    SELECT.from('midnight.ContractActions').columns('ID')
                        .where({ transaction_ID: { in: txIds } })
                ) || [];
                if (actionsToDelete.length > 0) {
                    const actionIds = actionsToDelete.map((a: any) => a.ID);
                    await tx.run(DELETE.from('midnight.ContractBalances').where({ contractAction_ID: { in: actionIds } }));
                }

                // Batch delete all tx-child tables
                await tx.run(DELETE.from('midnight.ContractActions').where({ transaction_ID: { in: txIds } }));
                await tx.run(DELETE.from('midnight.UnshieldedUtxos').where({ createdAtTransaction_ID: { in: txIds } }));
                await tx.run(DELETE.from('midnight.ZswapLedgerEvents').where({ transaction_ID: { in: txIds } }));
                await tx.run(DELETE.from('midnight.DustLedgerEvents').where({ transaction_ID: { in: txIds } }));
                await tx.run(DELETE.from('midnight.TransactionFees').where({ transaction_ID: { in: txIds } }));

                // Batch delete transaction segments via result IDs
                const resultsToDelete: any[] = await tx.run(
                    SELECT.from('midnight.TransactionResults').columns('ID').where({ transaction_ID: { in: txIds } })
                ) || [];
                if (resultsToDelete.length > 0) {
                    const resultIds = resultsToDelete.map((r: any) => r.ID);
                    await tx.run(DELETE.from('midnight.TransactionSegments').where({ transactionResult_ID: { in: resultIds } }));
                }
                await tx.run(DELETE.from('midnight.TransactionResults').where({ transaction_ID: { in: txIds } }));

                // Unlink spent UTXOs
                await tx.run(
                    UPDATE.entity('midnight.UnshieldedUtxos')
                        .set({ spentAtTransaction_ID: null })
                        .where({ spentAtTransaction_ID: { in: txIds } })
                );
            }

            // Batch delete transactions and blocks
            await tx.run(DELETE.from('midnight.Transactions').where({ block_ID: { in: blockIds } }));
            await tx.run(DELETE.from('midnight.Blocks').where({ ID: { in: blockIds } }));

            const forkBlock = await tx.run(
                SELECT.one.from('midnight.Blocks')
                    .where({ height: { '<': reorg.forkHeight } })
                    .orderBy('height desc')
            );
            await tx.run(
                UPDATE.entity('midnight.SyncState').set({
                    lastIndexedHeight: forkBlock?.height ?? 0,
                    lastIndexedHash: forkBlock?.hash ?? null,
                    lastIndexedAt: new Date().toISOString(),
                    syncStatus: 'syncing'
                }).where({ ID: 'SINGLETON' })
            );

            await tx.run(INSERT.into('midnight.ReorgLog').entries({
                ID: reorgLogId,
                detectedAt: new Date().toISOString(),
                forkHeight: reorg.forkHeight,
                oldTipHash: reorg.oldTipHash,
                newTipHash: reorg.newTipHash,
                blocksRolledBack: rollbackCount,
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
                    // Permanent error — don't retry
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
            SELECT.one.from('midnight.SyncState').where({ ID: 'SINGLETON' })
        );
    }

    private async recordError(message: string): Promise<void> {
        try {
            const state = await this.getSyncState();
            await this.db.run(
                UPDATE.entity('midnight.SyncState').set({
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
