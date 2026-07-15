/**
 * Tests for srv/crawler/Crawler.ts (MidnightCrawler orchestration).
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/vitest.setup.ts). Persistence (SyncState, ReorgLog, Blocks,
 * Transactions, ContractActions, …) is exercised against the real SQLite DB,
 * so reorg rollback / catch-up progress / stop are asserted BEHAVIORALLY by
 * seeding rows, running the crawler method, and SELECTing the resulting state.
 *
 * External collaborators stay MOCKED:
 *  - MidnightNodeProvider  → per-test inline fake objects (no real RPC)
 *  - BlockProcessor        → vi.mock (heavy block parsing/persistence)
 *  - ensureSyncStateSingleton → vi.mock (the real SINGLETON row is seeded
 *    directly via the DB in beforeEach)
 *
 * Only the hand-rolled vi.mock('@sap/cds') cds.ql mock was removed; the
 * crawler now uses the framework's real cds.ql against the in-memory DB.
 */

// --- External collaborators: keep mocked. vi.mock is hoisted. ---
const mockProcessorInit = vi.fn();
const mockProcessorProcessBlockByHeight = vi.fn();
const mockProcessorFetchBlockData = vi.fn();
const mockProcessorFetchBlockBatch = vi.fn();
const mockProcessorPersistPreparedBlock = vi.fn();
// Regular `function` impl: BlockProcessor is constructed with `new`, and only
// constructable (non-arrow) implementations survive that under vitest.
const mockBlockProcessorConstructor = vi.hoisted(() => (vi.fn().mockImplementation(function () {
    return {
        init: mockProcessorInit,
        processBlockByHeight: mockProcessorProcessBlockByHeight,
        fetchBlockData: mockProcessorFetchBlockData,
        fetchBlockBatch: mockProcessorFetchBlockBatch,
        persistPreparedBlock: mockProcessorPersistPreparedBlock
    };
} as any)));

vi.mock('../../srv/crawler/BlockProcessor', () => ({
    BlockProcessor: mockBlockProcessorConstructor
}));

vi.mock('../../srv/utils/sync-state', () => ({
    ensureSyncStateSingleton: vi.fn().mockResolvedValue(undefined)
}));

import cds from '@sap/cds';
import { MidnightCrawler } from '../../srv/crawler/Crawler';

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Jest's global test()).
cds.test(__dirname + '/../..');

const SYNC_STATE = 'midnight.SyncState';
const REORG_LOG = 'midnight.ReorgLog';
const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const TX_RESULTS = 'midnight.TransactionResults';
const TX_SEGMENTS = 'midnight.TransactionSegments';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const CONTRACT_BALANCES = 'midnight.ContractBalances';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const NIGHT_BALANCES = 'midnight.NightBalances';

let db: any;

/** Upsert the SINGLETON SyncState row to a known shape. */
async function setSyncState(fields: Record<string, any> = {}): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', ...fields }));
}

async function getSyncState(): Promise<any> {
    return db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
}

async function seedBlock(height: number, hash: string): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID: id,
        hash,
        height,
        protocolVersion: 1,
        timestamp: 1_700_000_000 + height,
        ledgerParameters: '0xabcd'
    }));
    return id;
}

async function seedTransaction(
    blockId: string,
    hash: string,
    txIndex = 0,
    overrides: Record<string, any> = {}
): Promise<string> {
    const id = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID: id,
        transactionId: txIndex,
        hash,
        protocolVersion: 1,
        transactionType: 'Regular',
        block_ID: blockId,
        ...overrides
    }));
    return id;
}

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    mockProcessorInit.mockReset().mockResolvedValue(undefined);
    mockProcessorProcessBlockByHeight.mockReset();
    mockProcessorFetchBlockData.mockReset();
    mockProcessorFetchBlockBatch.mockReset();
    mockProcessorPersistPreparedBlock.mockReset();
    mockBlockProcessorConstructor.mockClear();

    // Reset DB state used by these tests (children before parents).
    await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    await db.run(cds.ql.DELETE.from(CONTRACT_BALANCES));
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from(TX_SEGMENTS));
    await db.run(cds.ql.DELETE.from(TX_RESULTS));
    await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    await db.run(cds.ql.DELETE.from(REORG_LOG));
    await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, chainHeight: 0, consecutiveErrors: 0 });
});

describe('MidnightCrawler orchestration', () => {
    // ========================================================================
    // Lifecycle: start
    // ========================================================================
    describe('start', () => {
        it('connects the DB and node, initializes the processor, and enters both phases', async () => {
            const provider = {
                isConnected: vi.fn().mockReturnValue(false),
                connect: vi.fn().mockResolvedValue(undefined)
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            const catchUpSpy = vi.spyOn(crawler as any, 'catchUp').mockResolvedValue(0);
            const subscribeLiveSpy = vi.spyOn(crawler as any, 'subscribeLive').mockResolvedValue(undefined);

            await crawler.start();
            // start() fires the ingest pipeline as fire-and-forget; let microtasks flush.
            await new Promise(resolve => setImmediate(resolve));

            // The crawler connected the real in-memory DB.
            expect((crawler as any).db).toBeTruthy();
            expect(provider.connect).toHaveBeenCalled();
            expect(mockBlockProcessorConstructor).toHaveBeenCalledWith(provider);
            expect(mockProcessorInit).toHaveBeenCalled();
            expect(catchUpSpy).toHaveBeenCalled();
            expect(subscribeLiveSpy).toHaveBeenCalled();

            await crawler.stop();
        });

        it('skips reconnecting an already-connected node and does not subscribe live after shutdown during catch-up', async () => {
            const provider = {
                isConnected: vi.fn().mockReturnValue(true),
                connect: vi.fn().mockResolvedValue(undefined)
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            vi.spyOn(crawler as any, 'catchUp').mockImplementation(async () => {
                (crawler as any).isRunning = false;
                return 0;
            });
            const subscribeLiveSpy = vi.spyOn(crawler as any, 'subscribeLive').mockResolvedValue(undefined);

            await crawler.start();
            await new Promise(resolve => setImmediate(resolve));

            expect(provider.connect).not.toHaveBeenCalled();
            expect(subscribeLiveSpy).not.toHaveBeenCalled();
        });

        it('does nothing when start is called while the crawler is already running', async () => {
            const provider = {
                isConnected: vi.fn(),
                connect: vi.fn()
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            try {
                (crawler as any).isRunning = true;
                await crawler.start();

                expect(provider.connect).not.toHaveBeenCalled();
                expect(mockBlockProcessorConstructor).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith('[Crawler] Already running');
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    // ========================================================================
    // Lifecycle: stop
    // ========================================================================
    describe('stop', () => {
        it('unsubscribes and marks sync state as stopped', async () => {
            await setSyncState({ syncStatus: 'synced', lastIndexedHeight: 5 });
            const provider = {
                unsubscribeFinalizedHeads: vi.fn().mockResolvedValue(true)
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).subscriptionId = 'sub-1';

            await crawler.stop();

            expect(provider.unsubscribeFinalizedHeads).toHaveBeenCalledWith('sub-1');
            expect((crawler as any).subscriptionId).toBeNull();

            // Behavioral: the SINGLETON row was actually flipped to 'stopped'.
            const row = await getSyncState();
            expect(row.syncStatus).toBe('stopped');
        });

        it('stops cleanly even when no live subscription exists', async () => {
            await setSyncState({ syncStatus: 'synced' });
            const provider = {
                unsubscribeFinalizedHeads: vi.fn()
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;

            await crawler.stop();

            expect(provider.unsubscribeFinalizedHeads).not.toHaveBeenCalled();
            const row = await getSyncState();
            expect(row.syncStatus).toBe('stopped');
        });

        it('swallows unsubscribe and DB errors during stop', async () => {
            const provider = {
                unsubscribeFinalizedHeads: vi.fn().mockRejectedValue(new Error('unsubscribe failed'))
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            // db.run rejects (simulates a closed DB); stop() must swallow it.
            (crawler as any).db = { run: vi.fn().mockRejectedValue(new Error('db closed')) };
            (crawler as any).subscriptionId = 'sub-1';

            await expect(crawler.stop()).resolves.toBeUndefined();
            expect((crawler as any).subscriptionId).toBeNull();
        });
    });

    // ========================================================================
    // Phase 1: Catch-Up
    // ========================================================================
    describe('catchUp', () => {
        it('catches up over finalized blocks and updates progress in SyncState', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x2'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x2' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true, batchSize: 10 });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).processor = {
                fetchBlockBatch: mockProcessorFetchBlockBatch,
                persistPreparedBlock: mockProcessorPersistPreparedBlock
            };

            // lastIndexedHeight 0 with a non-null hash → catch-up resumes at height 1.
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: '0x0' });

            // Spy the batch retry shim so we can assert the height ranges requested.
            const fetchSpy = vi.spyOn(crawler as any, 'fetchBlockBatchWithRetry')
                .mockImplementation(async (...args: any[]) => {
                    const heights = args[0] as number[];
                    return heights.map(h => ({
                        blockHash: `0x${h}`,
                        height: h,
                        signedBlock: null,
                        protocolVersion: 1,
                        timestamp: 0,
                        fetchStartedAt: Date.now(),
                        fetchCompletedAt: Date.now(),
                        alreadyIndexed: false
                    }));
                });
            mockProcessorPersistPreparedBlock.mockResolvedValue({
                blockHeight: 1,
                blockHash: '0x1',
                transactionCount: 1,
                contractActionCount: 0,
                processingTimeMs: 5
            });

            await expect((crawler as any).catchUp()).resolves.toBe(2);

            expect(provider.getFinalizedHead).toHaveBeenCalled();
            expect(provider.getHeader).toHaveBeenCalledWith('0x2');
            // First (and only) batch should cover heights [1, 2].
            expect(fetchSpy).toHaveBeenCalledWith([1, 2]);
            expect(mockProcessorPersistPreparedBlock).toHaveBeenCalledTimes(2);
            expect((crawler as any).isCatchingUp).toBe(false);

            // Behavioral: SyncState was advanced to the finalized tip during catch-up.
            const row = await getSyncState();
            expect(Number(row.chainHeight)).toBe(2);
            expect(Number(row.lastFinalizedHeight)).toBe(2);
            expect(row.lastFinalizedHash).toBe('0x2');
            expect(row.syncStatus).toBe('syncing');
        });

        it('returns early from catch-up when already synced past the finalized head', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x2'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x2' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;

            // Already indexed up to height 5 (> finalized head 2).
            await setSyncState({ syncStatus: 'synced', lastIndexedHeight: 5, lastIndexedHash: '0x5' });

            await expect((crawler as any).catchUp()).resolves.toBe(0);
            expect((crawler as any).isCatchingUp).toBe(false);

            // No progress write happened: SyncState unchanged.
            const row = await getSyncState();
            expect(row.syncStatus).toBe('synced');
            expect(Number(row.lastIndexedHeight)).toBe(5);
        });

        it('always clears catch-up mode when finalized head lookup throws', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockRejectedValue(new Error('rpc down')),
                getHeader: vi.fn()
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: null });

            await expect((crawler as any).catchUp()).rejects.toThrow('rpc down');
            expect((crawler as any).isCatchingUp).toBe(false);
        });

        it('stops catch-up after repeated block-processing errors exceed the circuit breaker threshold', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x1'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x1' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).processor = {
                fetchBlockBatch: mockProcessorFetchBlockBatch,
                persistPreparedBlock: mockProcessorPersistPreparedBlock
            };
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: null });

            // getSyncState is consulted after recordError; force it over-threshold.
            // recordError stays real but the breaker check reads consecutiveErrors,
            // so we drive it via a spy returning 11.
            const getSyncStateSpy = vi.spyOn(crawler as any, 'getSyncState');
            getSyncStateSpy
                .mockResolvedValueOnce({ lastIndexedHeight: 0, lastIndexedHash: null })
                .mockResolvedValueOnce({ consecutiveErrors: 11 });
            vi.spyOn(crawler as any, 'fetchBlockBatchWithRetry').mockRejectedValue(new Error('Request timeout'));
            const recordErrorSpy = vi.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await expect((crawler as any).catchUp()).resolves.toBe(0);
                expect(recordErrorSpy).toHaveBeenCalledWith('Request timeout');
                expect(errorSpy).toHaveBeenCalledWith('[Crawler] Too many consecutive errors, stopping catch-up');
            } finally {
                errorSpy.mockRestore();
            }
        });

        it('continues catch-up after a recoverable block-processing failure below the breaker threshold', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x1'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x1' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).processor = {
                fetchBlockBatch: mockProcessorFetchBlockBatch,
                persistPreparedBlock: mockProcessorPersistPreparedBlock
            };
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: null });

            const getSyncStateSpy = vi.spyOn(crawler as any, 'getSyncState');
            getSyncStateSpy
                .mockResolvedValueOnce({ lastIndexedHeight: 0, lastIndexedHash: null })
                .mockResolvedValueOnce({ consecutiveErrors: 2 });
            vi.spyOn(crawler as any, 'fetchBlockBatchWithRetry').mockRejectedValue(new Error('Request timeout'));
            const recordErrorSpy = vi.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await expect((crawler as any).catchUp()).resolves.toBe(0);
                expect(recordErrorSpy).toHaveBeenCalledWith('Request timeout');
                expect(errorSpy).not.toHaveBeenCalledWith('[Crawler] Too many consecutive errors, stopping catch-up');
            } finally {
                errorSpy.mockRestore();
            }
        });

        /** Prepared-block stub matching the pipeline's PreparedBlockFetched shape. */
        function preparedBlocks(heights: number[]): any[] {
            return heights.map(h => ({
                blockHash: `0x${h}`,
                height: h,
                signedBlock: null,
                protocolVersion: 1,
                timestamp: 0,
                fetchStartedAt: Date.now(),
                fetchCompletedAt: Date.now(),
                alreadyIndexed: false
            }));
        }

        it('re-queues a failed batch once and persists every height without gaps', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x3'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x3' })
            };
            // rpcBatchSize 1 → one batch per height; concurrency 1 keeps the
            // submission order deterministic.
            const crawler = new MidnightCrawler(provider as any, { enabled: true, rpcBatchSize: 1, fetchConcurrency: 1 });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).processor = {
                fetchBlockBatch: mockProcessorFetchBlockBatch,
                persistPreparedBlock: mockProcessorPersistPreparedBlock
            };
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: '0x0', consecutiveErrors: 0 });

            // Height 2 fails once (transient outage), then succeeds on the re-queue.
            let failedOnce = false;
            vi.spyOn(crawler as any, 'fetchBlockBatchWithRetry')
                .mockImplementation(async (...args: any[]) => {
                    const heights = args[0] as number[];
                    if (heights[0] === 2 && !failedOnce) {
                        failedOnce = true;
                        throw new Error('Request timeout');
                    }
                    return preparedBlocks(heights);
                });
            mockProcessorPersistPreparedBlock.mockImplementation(async (prep: any) => ({
                blockHeight: prep.height,
                blockHash: prep.blockHash,
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: 1
            }));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            try {
                await expect((crawler as any).catchUp()).resolves.toBe(3);

                // All three heights persisted, strictly in order, nothing skipped.
                const persisted = mockProcessorPersistPreparedBlock.mock.calls.map(c => (c[0] as any).height);
                expect(persisted).toEqual([1, 2, 3]);
            } finally {
                errorSpy.mockRestore();
                warnSpy.mockRestore();
            }
        });

        it('stops catch-up instead of skipping a range when the re-queued batch fails again', async () => {
            const provider = {
                getFinalizedHead: vi.fn().mockResolvedValue('0x3'),
                getHeader: vi.fn().mockResolvedValue({ number: '0x3' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true, rpcBatchSize: 1, fetchConcurrency: 1 });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).processor = {
                fetchBlockBatch: mockProcessorFetchBlockBatch,
                persistPreparedBlock: mockProcessorPersistPreparedBlock
            };
            await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, lastIndexedHash: '0x0', consecutiveErrors: 0 });

            // Height 2 fails on every attempt.
            vi.spyOn(crawler as any, 'fetchBlockBatchWithRetry')
                .mockImplementation(async (...args: any[]) => {
                    const heights = args[0] as number[];
                    if (heights[0] === 2) throw new Error('Request timeout');
                    return preparedBlocks(heights);
                });
            mockProcessorPersistPreparedBlock.mockImplementation(async (prep: any) => ({
                blockHeight: prep.height,
                blockHash: prep.blockHash,
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: 1
            }));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            try {
                // Only height 1 makes it; the failed range is NEVER jumped over.
                await expect((crawler as any).catchUp()).resolves.toBe(1);

                const persisted = mockProcessorPersistPreparedBlock.mock.calls.map(c => (c[0] as any).height);
                expect(persisted).toEqual([1]);
                expect(errorSpy).toHaveBeenCalledWith(
                    '[Crawler] Batch 2-2 failed after retry; stopping catch-up to avoid index gaps'
                );

                // The run is marked as errored so operators see the stall.
                const row = await getSyncState();
                expect(row.syncStatus).toBe('error');
            } finally {
                errorSpy.mockRestore();
                warnSpy.mockRestore();
            }
        });
    });

    // ========================================================================
    // Phase 2: Live Subscription
    // ========================================================================
    describe('subscribeLive', () => {
        it('subscribes live, re-subscribes after reconnect, and processes live blocks', async () => {
            let liveCallback: ((header: any) => Promise<void>) | undefined;
            let reconnectCallback: (() => Promise<void>) | undefined;
            const provider = {
                setOnReconnect: vi.fn().mockImplementation((callback: () => Promise<void>) => {
                    reconnectCallback = callback;
                }),
                subscribeFinalizedHeads: vi.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                    liveCallback = callback;
                    return 'sub-1';
                }),
                getBlockHash: vi.fn().mockResolvedValue('0x2hash')
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;
            (crawler as any).startTime = Date.now() - 1000;

            const checkForReorgSpy = vi.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0x2hash', lastIndexedHeight: 1 });
            const processSpy = vi.spyOn(crawler as any, 'processBlockWithRetry').mockResolvedValue({
                blockHeight: 2,
                blockHash: '0x2hash',
                transactionCount: 3,
                contractActionCount: 0,
                processingTimeMs: 7
            });

            await (crawler as any).subscribeLive();
            expect(provider.subscribeFinalizedHeads).toHaveBeenCalledTimes(1);
            expect((crawler as any).subscriptionId).toBe('sub-1');
            expect(reconnectCallback).toBeDefined();

            // subscribeLive set syncStatus='synced' on the real DB.
            expect((await getSyncState()).syncStatus).toBe('synced');

            await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

            expect(checkForReorgSpy).toHaveBeenCalled();
            expect(processSpy).toHaveBeenCalledWith(2);
            expect((crawler as any).processing).toBe(false);

            await reconnectCallback!();
            expect(provider.subscribeFinalizedHeads).toHaveBeenCalledTimes(2);
        });

        it('ignores live callbacks while catch-up is running and queues blocks while processing', async () => {
            let liveCallback: ((header: any) => Promise<void>) | undefined;
            const provider = {
                subscribeFinalizedHeads: vi.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                    liveCallback = callback;
                    return 'sub-1';
                })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;

            // Spy processLiveBlock so we can prove it's NOT called while catching up.
            const processLiveSpy = vi.spyOn(crawler as any, 'processLiveBlock').mockResolvedValue(undefined);

            await (crawler as any).subscribeLive();

            // During catch-up, live callbacks are fully ignored.
            (crawler as any).isCatchingUp = true;
            await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });
            expect(processLiveSpy).not.toHaveBeenCalled();

            // During processing, blocks are queued (not dropped).
            (crawler as any).isCatchingUp = false;
            (crawler as any).processing = true;
            await liveCallback!({ number: '0x3', parentHash: '0x2', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });
            expect((crawler as any).pendingHeights).toContain(3);
        });

        it('records transient live-processing failures and pauses when the live breaker trips', async () => {
            let liveCallback: ((header: any) => Promise<void>) | undefined;
            const provider = {
                subscribeFinalizedHeads: vi.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                    liveCallback = callback;
                    return 'sub-1';
                }),
                getBlockHash: vi.fn().mockResolvedValue('0x2hash')
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;

            vi.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
            vi.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValue(new Error('Request timeout'));
            const recordErrorSpy = vi.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ consecutiveErrors: 11 });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await (crawler as any).subscribeLive();

                await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

                expect(recordErrorSpy).toHaveBeenCalledWith('Request timeout');
                expect(errorSpy).toHaveBeenCalledWith('[Crawler] Live: failed to process block 2 (transient): Request timeout');
                expect(errorSpy).toHaveBeenCalledWith('[Crawler] Too many consecutive errors in live mode, pausing...');
                expect((crawler as any).processing).toBe(false);
            } finally {
                errorSpy.mockRestore();
            }
        });

        it('records permanent live-processing failures without tripping the breaker', async () => {
            let liveCallback: ((header: any) => Promise<void>) | undefined;
            const provider = {
                subscribeFinalizedHeads: vi.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                    liveCallback = callback;
                    return 'sub-1';
                }),
                getBlockHash: vi.fn().mockResolvedValue('0x2hash')
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;

            vi.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
            vi.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValue(new Error('Invalid block data'));
            const recordErrorSpy = vi.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ consecutiveErrors: 1 });
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await (crawler as any).subscribeLive();

                await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

                expect(recordErrorSpy).toHaveBeenCalledWith('Invalid block data');
                expect(errorSpy).toHaveBeenCalledWith('[Crawler] Live: failed to process block 2 (permanent): Invalid block data');
                expect(errorSpy).not.toHaveBeenCalledWith('[Crawler] Too many consecutive errors in live mode, pausing...');
            } finally {
                errorSpy.mockRestore();
            }
        });

        it('catches up instead of single-block processing when the live head is ahead of the index (gap)', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;

            await setSyncState({ syncStatus: 'synced', lastIndexedHeight: 5, lastIndexedHash: '0x5' });

            const catchUpSpy = vi.spyOn(crawler as any, 'catchUp').mockResolvedValue(4);
            const checkForReorgSpy = vi.spyOn(crawler as any, 'checkForReorg');
            const processSpy = vi.spyOn(crawler as any, 'processBlockWithRetry');

            // Head 10 while the index sits at 5 → gap, not a fork.
            await (crawler as any).processLiveBlock(
                { number: '0xa', parentHash: '0x9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } },
                10
            );

            expect(catchUpSpy).toHaveBeenCalled();
            expect(checkForReorgSpy).not.toHaveBeenCalled();
            expect(processSpy).not.toHaveBeenCalled();
        });

        it('handles reorgs during live processing and updates the reorg log', async () => {
            let liveCallback: ((header: any) => Promise<void>) | undefined;
            const provider = {
                setOnReconnect: vi.fn(),
                subscribeFinalizedHeads: vi.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                    liveCallback = callback;
                    return 'sub-1';
                }),
                getBlockHash: vi.fn()
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;
            (crawler as any).isRunning = true;

            // Seed a real ReorgLog row that handleReorg "created"; the live handler
            // then updates it to completed with the re-indexed count.
            const reorgLogId = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(REORG_LOG).entries({
                ID: reorgLogId,
                detectedAt: new Date().toISOString(),
                forkHeight: 9,
                oldTipHash: '0xold',
                newTipHash: '0xnew',
                blocksRolledBack: 1,
                blocksReIndexed: 0,
                status: 'in_progress'
            }));

            vi.spyOn(crawler as any, 'checkForReorg').mockResolvedValue({
                forkHeight: 9,
                oldTipHash: '0xold',
                newTipHash: '0xnew'
            });
            const handleReorgSpy = vi.spyOn(crawler as any, 'handleReorg').mockResolvedValue(reorgLogId);
            const catchUpSpy = vi.spyOn(crawler as any, 'catchUp').mockResolvedValue(4);
            const processSpy = vi.spyOn(crawler as any, 'processBlockWithRetry').mockResolvedValue({
                blockHeight: 10,
                blockHash: '0x10',
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: 0
            });

            await (crawler as any).subscribeLive();

            await liveCallback!({ number: '0xa', parentHash: '0x9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

            expect(handleReorgSpy).toHaveBeenCalled();
            expect(catchUpSpy).toHaveBeenCalled();
            expect(processSpy).not.toHaveBeenCalled();
            expect(provider.getBlockHash).not.toHaveBeenCalled();

            // Behavioral: the ReorgLog row was updated to completed with the re-index count.
            const row = await db.run(cds.ql.SELECT.one.from(REORG_LOG).where({ ID: reorgLogId }));
            expect(row.status).toBe('completed');
            expect(Number(row.blocksReIndexed)).toBe(4);
        });
    });

    // ========================================================================
    // Reorg detection
    // ========================================================================
    describe('checkForReorg / findForkPoint', () => {
        it('detects reorgs only when the parent hash no longer matches the indexed tip', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            // Header at tip+1 (0x2a = 42, indexed tip 41) with a diverging parent.
            const header = { number: '0x2a', parentHash: '0xold', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } };

            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0xcurrent', lastIndexedHeight: 41 });
            const findForkPointSpy = vi.spyOn(crawler as any, 'findForkPoint').mockResolvedValue(40);

            await expect((crawler as any).checkForReorg(header)).resolves.toEqual({
                forkHeight: 40,
                oldTipHash: '0xcurrent',
                newTipHash: '0xold'
            });
            expect(findForkPointSpy).toHaveBeenCalledWith(header);

            findForkPointSpy.mockClear();
            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValueOnce({ lastIndexedHash: '0xold', lastIndexedHeight: 41 });
            await expect((crawler as any).checkForReorg(header)).resolves.toBeNull();
            expect(findForkPointSpy).not.toHaveBeenCalled();
        });

        it('ignores a replayed already-indexed head whose parent matches our chain', async () => {
            // Subscription start/reconnect re-delivers finalized head 10 while
            // our index is already at 12. Its parent (block 9) is ours, so
            // this must NOT be classified as a reorg.
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;
            await seedBlock(9, '0x9');

            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0x12', lastIndexedHeight: 12 });
            const findForkPointSpy = vi.spyOn(crawler as any, 'findForkPoint');

            await expect((crawler as any).checkForReorg({
                number: '0xa', parentHash: '0x9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] }
            })).resolves.toBeNull();
            expect(findForkPointSpy).not.toHaveBeenCalled();
        });

        it('still detects a real fork below the tip (replayed height, diverging parent)', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;
            await seedBlock(9, '0x9');

            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0x12', lastIndexedHeight: 12 });
            const findForkPointSpy = vi.spyOn(crawler as any, 'findForkPoint').mockResolvedValue(10);

            await expect((crawler as any).checkForReorg({
                number: '0xa', parentHash: '0xforeign-9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] }
            })).resolves.toEqual({
                forkHeight: 10,
                oldTipHash: '0x12',
                newTipHash: '0xforeign-9'
            });
            expect(findForkPointSpy).toHaveBeenCalled();
        });

        it('treats a head far ahead of the index as a gap, not a reorg', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });

            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0x5', lastIndexedHeight: 5 });
            const findForkPointSpy = vi.spyOn(crawler as any, 'findForkPoint');

            await expect((crawler as any).checkForReorg({
                number: '0xa', parentHash: '0x9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] }
            })).resolves.toBeNull();
            expect(findForkPointSpy).not.toHaveBeenCalled();
        });

        it('never rolls back on a replayed genesis head', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;

            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0x5', lastIndexedHeight: 5 });

            await expect((crawler as any).checkForReorg({
                number: '0x0', parentHash: '0x0000', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] }
            })).resolves.toBeNull();
        });

        it('does not report a reorg before any block has been indexed', async () => {
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            vi.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: null });

            await expect((crawler as any).checkForReorg({
                number: '0x2a',
                parentHash: '0xold',
                stateRoot: '',
                extrinsicsRoot: '',
                digest: { logs: [] }
            })).resolves.toBeNull();
        });

        it('finds fork points from local blocks and falls back when the node lookup fails', async () => {
            const provider = {
                getHeader: vi.fn().mockRejectedValue(new Error('header unavailable'))
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;

            // header number 0x6 (6); parent 0x5. The fork search looks for a local
            // block with hash === parentHash. Seed one so the first lookup hits.
            await seedBlock(5, '0x5');
            await expect((crawler as any).findForkPoint({
                number: '0x6',
                parentHash: '0x5',
                stateRoot: '',
                extrinsicsRoot: '',
                digest: { logs: [] }
            })).resolves.toBe(6); // height (5) + 1

            // No local block for the parent: the node lookup throws → fall back to
            // the current height (5).
            await db.run(cds.ql.DELETE.from(BLOCKS));
            await expect((crawler as any).findForkPoint({
                number: '0x6',
                parentHash: '0x5',
                stateRoot: '',
                extrinsicsRoot: '',
                digest: { logs: [] }
            })).resolves.toBe(5);
        });

        it('walks backward through remote headers until it finds the local fork point', async () => {
            const provider = {
                getHeader: vi.fn().mockResolvedValue({ parentHash: '0x5' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            (crawler as any).db = db;

            // header 0x7 (7), parent 0x6. No local block at hash 0x6, so it walks one
            // step back via the node header (parentHash 0x5) and finds local block 0x5.
            await seedBlock(5, '0x5');
            await expect((crawler as any).findForkPoint({
                number: '0x7',
                parentHash: '0x6',
                stateRoot: '',
                extrinsicsRoot: '',
                digest: { logs: [] }
            })).resolves.toBe(6);
            expect(provider.getHeader).toHaveBeenCalledWith('0x6');
        });

        it('stops fork-point search when the reorg depth exceeds 100 blocks', async () => {
            const provider = {
                getHeader: vi.fn().mockResolvedValue({ parentHash: '0xloop' })
            };
            const crawler = new MidnightCrawler(provider as any, { enabled: true });
            // No local block ever matches, so it walks back until depth > 100.
            (crawler as any).db = db;
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                await expect((crawler as any).findForkPoint({
                    number: '0x66', // 102
                    parentHash: '0x65',
                    stateRoot: '',
                    extrinsicsRoot: '',
                    digest: { logs: [] }
                })).resolves.toBe(1);
                expect(errorSpy).toHaveBeenCalledWith('[Crawler] Reorg depth > 100 blocks, stopping search');
            } finally {
                errorSpy.mockRestore();
            }
        });
    });

    // ========================================================================
    // Reorg rollback (handleReorg): behavioral against the real DB
    // ========================================================================
    describe('handleReorg', () => {
        it('rolls back indexed blocks and records a reorg transactionally', async () => {
            // Chain: blocks 8,9 stay; 10,11 roll back. Block 10 has a transaction.
            await seedBlock(8, '0x8');
            await seedBlock(9, '0x9');
            const block10 = await seedBlock(10, '0x10');
            await seedBlock(11, '0x11');
            await seedTransaction(block10, '0xtx10');

            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;

            const reorgLogId = await (crawler as any).handleReorg({
                forkHeight: 10,
                oldTipHash: '0xold',
                newTipHash: '0xnew'
            });
            expect(typeof reorgLogId).toBe('string');

            // Blocks 10/11 gone; 8/9 remain.
            const remaining = await db.run(cds.ql.SELECT.from(BLOCKS).columns('height'));
            const heights = remaining.map((b: any) => Number(b.height)).sort((a: number, b: number) => a - b);
            expect(heights).toEqual([8, 9]);

            // The transaction on block 10 was deleted.
            expect((await db.run(cds.ql.SELECT.from(TRANSACTIONS))).length).toBe(0);

            // SyncState reset to the fork block (height 9, hash 0x9).
            const sync = await getSyncState();
            expect(Number(sync.lastIndexedHeight)).toBe(9);
            expect(sync.lastIndexedHash).toBe('0x9');
            expect(sync.syncStatus).toBe('syncing');

            // ReorgLog row recorded with rollback count 2 and status in_progress.
            const log = await db.run(cds.ql.SELECT.one.from(REORG_LOG).where({ ID: reorgLogId }));
            expect(log).toMatchObject({
                oldTipHash: '0xold',
                newTipHash: '0xnew',
                blocksRolledBack: 2,
                blocksReIndexed: 0,
                status: 'in_progress'
            });
            // Integer64: number on CAP 9, string on CAP 10 (ieee754compatible).
            expect(Number(log.forkHeight)).toBe(10);
        });

        it('returns a reorg-log id but writes no log when there are no indexed blocks to roll back', async () => {
            // No blocks at/above the fork height → the tx returns early before
            // inserting a ReorgLog row, but handleReorg still returns its id.
            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;

            const reorgLogId = await (crawler as any).handleReorg({
                forkHeight: 10,
                oldTipHash: '0xold',
                newTipHash: '0xnew'
            });
            expect(typeof reorgLogId).toBe('string');

            // No ReorgLog row was written (early return), no blocks/sync touched.
            expect((await db.run(cds.ql.SELECT.from(REORG_LOG))).length).toBe(0);
            const sync = await getSyncState();
            expect(sync.syncStatus).toBe('stopped'); // untouched from beforeEach
        });

        it('removes transaction-linked records during deep reorg rollback', async () => {
            // Seed block 10 with a tx that has a contract action (+ balance), a UTXO
            // it created, another tx's UTXO it spent, and a tx-result with a segment.
            const block10 = await seedBlock(10, '0x10');
            await seedBlock(9, '0x9'); // fork block survives
            const tx10 = await seedTransaction(block10, '0xtx10');

            // Contract action + balance
            const actionId = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
                ID: actionId,
                address: '0xcontract',
                actionType: 'Call',
                transaction_ID: tx10
            }));
            const balanceId = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(CONTRACT_BALANCES).entries({
                ID: balanceId,
                tokenType: '0xtoken',
                amount: '100',
                contractAction_ID: actionId
            }));

            // Tx result + segment
            const resultId = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(TX_RESULTS).entries({
                ID: resultId,
                status: 'SUCCESS',
                transaction_ID: tx10
            }));
            const segmentId = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(TX_SEGMENTS).entries({
                ID: segmentId,
                segmentId: 0,
                success: true,
                transactionResult_ID: resultId
            }));

            // A UTXO created by tx10 (cascades) and a UTXO spent by tx10 (unlinks).
            const createdUtxo = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
                ID: createdUtxo,
                owner: 'addr_created',
                tokenType: '0xtoken',
                value: '50',
                intentHash: '0xintent1',
                outputIndex: 0,
                initialNonce: '0xnonce1',
                createdAtTransaction_ID: tx10
            }));
            // A UTXO created earlier (different tx, not rolled back) but spent by tx10.
            const survivingBlockTx = await seedTransaction(await seedBlock(8, '0x8'), '0xtx8');
            const spentUtxo = cds.utils.uuid();
            await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
                ID: spentUtxo,
                owner: 'addr_spent',
                tokenType: '0xtoken',
                value: '25',
                intentHash: '0xintent2',
                outputIndex: 0,
                initialNonce: '0xnonce2',
                createdAtTransaction_ID: survivingBlockTx,
                spentAtTransaction_ID: tx10
            }));

            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;

            const reorgLogId = await (crawler as any).handleReorg({
                forkHeight: 10,
                oldTipHash: '0xold',
                newTipHash: '0xnew'
            });

            // Tx-linked children of the rolled-back tx10 are gone.
            expect((await db.run(cds.ql.SELECT.from(CONTRACT_BALANCES))).length).toBe(0);
            expect((await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS))).length).toBe(0);
            expect((await db.run(cds.ql.SELECT.from(TX_SEGMENTS))).length).toBe(0);
            expect((await db.run(cds.ql.SELECT.from(TX_RESULTS))).length).toBe(0);

            // The UTXO created by tx10 is deleted; the surviving UTXO it spent is
            // unlinked (spentAtTransaction_ID nulled) but still present.
            const utxos = await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS));
            expect(utxos.length).toBe(1);
            expect(utxos[0].ID).toBe(spentUtxo);
            expect(utxos[0].spentAtTransaction_ID).toBeNull();

            // Block 10 + its tx gone; blocks 8/9 remain.
            const remaining = await db.run(cds.ql.SELECT.from(BLOCKS).columns('height'));
            const heights = remaining.map((b: any) => Number(b.height)).sort((a: number, b: number) => a - b);
            expect(heights).toEqual([8, 9]);

            // ReorgLog recorded with one rolled-back block.
            const log = await db.run(cds.ql.SELECT.one.from(REORG_LOG).where({ ID: reorgLogId }));
            expect(log).toMatchObject({ blocksRolledBack: 1, status: 'in_progress' });
        });

        it('recomputes NightBalances for affected addresses so a re-index cannot double-count', async () => {
            // addr_b received 50 in block 9 (survives) and 100 in block 10
            // (rolled back); addr_a only SENT the block-10 transfer.
            const block9 = await seedBlock(9, '0x9');
            const block10 = await seedBlock(10, '0x10');
            const tx9 = await seedTransaction(block9, '0xtx9', 0, {
                receiverAddress: 'addr_b', nightAmount: '50'
            });
            const tx10 = await seedTransaction(block10, '0xtx10', 0, {
                senderAddress: 'addr_a', receiverAddress: 'addr_b', nightAmount: '100'
            });
            for (const [txId, value, nonce] of [[tx9, '50', '0xn9'], [tx10, '100', '0xn10']] as const) {
                await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
                    ID: cds.utils.uuid(),
                    owner: 'addr_b',
                    tokenType: '0xtoken',
                    value,
                    intentHash: '0xintent',
                    outputIndex: 0,
                    initialNonce: nonce,
                    createdAtTransaction_ID: txId
                }));
            }
            // Balances exactly as the delta-based ingest left them.
            await db.run(cds.ql.INSERT.into(NIGHT_BALANCES).entries([
                {
                    address: 'addr_b', balance: '150', utxoCount: 2,
                    txSentCount: 0, txReceivedCount: 2, totalSent: '0', totalReceived: '150',
                    firstSeenHeight: 9, lastActivityHeight: 10
                },
                {
                    address: 'addr_a', balance: '0', utxoCount: 0,
                    txSentCount: 1, txReceivedCount: 0, totalSent: '100', totalReceived: '0',
                    firstSeenHeight: 10, lastActivityHeight: 10
                }
            ]));

            const crawler = new MidnightCrawler({} as any, { enabled: true });
            (crawler as any).db = db;

            await (crawler as any).handleReorg({
                forkHeight: 10,
                oldTipHash: '0xold',
                newTipHash: '0xnew'
            });

            // addr_b is back to its exact pre-block-10 state, so re-indexing
            // block 10 re-applies its deltas without double-counting.
            const b = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: 'addr_b' }));
            expect(Number(b.balance)).toBe(50);
            expect(b.utxoCount).toBe(1);
            expect(b.txReceivedCount).toBe(1);
            expect(Number(b.totalReceived)).toBe(50);
            expect(b.txSentCount).toBe(0);
            expect(Number(b.totalSent)).toBe(0);
            expect(Number(b.firstSeenHeight)).toBe(9);
            expect(Number(b.lastActivityHeight)).toBe(9);

            // addr_a had no surviving activity → its projection row is gone.
            const a = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: 'addr_a' }));
            expect(a).toBeFalsy();
        });
    });
});
