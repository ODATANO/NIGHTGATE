const mockDbRun = jest.fn();
const mockDbTx = jest.fn();
const mockConnectTo = jest.fn();
const mockUuid = jest.fn();

function createSelectBuilder(kind: 'one' | 'many', table: string) {
    const builder: any = {
        __kind: kind,
        __table: table
    };

    builder.columns = jest.fn().mockImplementation((...value: unknown[]) => {
        builder.__columns = value;
        return builder;
    });
    builder.where = jest.fn().mockImplementation((value: unknown) => {
        builder.__where = value;
        return builder;
    });
    builder.orderBy = jest.fn().mockImplementation((value: unknown) => {
        builder.__orderBy = value;
        return builder;
    });
    builder.limit = jest.fn().mockImplementation((value: unknown) => {
        builder.__limit = value;
        return builder;
    });

    return builder;
}

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    network: 'testnet'
                }
            }
        },
        connect: {
            to: mockConnectTo
        },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockImplementation((table: string) => createSelectBuilder('one', table))
                },
                from: jest.fn().mockImplementation((table: string) => createSelectBuilder('many', table))
            },
            INSERT: {
                into: jest.fn().mockImplementation((table: string) => ({
                    entries: jest.fn().mockImplementation((value: unknown) => ({
                        __type: 'insert',
                        __table: table,
                        __entries: value
                    }))
                }))
            },
            UPDATE: {
                entity: jest.fn().mockImplementation((table: string) => ({
                    set: jest.fn().mockImplementation((value: unknown) => ({
                        where: jest.fn().mockImplementation((where: unknown) => ({
                            __type: 'update',
                            __table: table,
                            __set: value,
                            __where: where
                        }))
                    }))
                }))
            },
            DELETE: {
                from: jest.fn().mockImplementation((table: string) => ({
                    where: jest.fn().mockImplementation((where: unknown) => ({
                        __type: 'delete',
                        __table: table,
                        __where: where
                    }))
                }))
            }
        },
        utils: {
            uuid: mockUuid
        }
    };
    cds.default = cds;
    return cds;
});

const mockProcessorInit = jest.fn();
const mockProcessorProcessBlockByHeight = jest.fn();
const mockBlockProcessorConstructor = jest.fn().mockImplementation(() => ({
    init: mockProcessorInit,
    processBlockByHeight: mockProcessorProcessBlockByHeight
}));

jest.mock('../../srv/crawler/BlockProcessor', () => ({
    BlockProcessor: mockBlockProcessorConstructor
}));

import { MidnightCrawler } from '../../srv/crawler/Crawler';

describe('MidnightCrawler orchestration', () => {
    beforeEach(() => {
        mockDbRun.mockReset();
        mockDbTx.mockReset();
        mockConnectTo.mockReset().mockResolvedValue({ run: mockDbRun, tx: mockDbTx });
        mockUuid.mockReset().mockReturnValue('reorg-log-1');
        mockProcessorInit.mockReset().mockResolvedValue(undefined);
        mockProcessorProcessBlockByHeight.mockReset();
        mockBlockProcessorConstructor.mockClear();
    });

    it('starts the crawler by connecting the DB and node, initializing the processor, and entering both phases', async () => {
        const provider = {
            isConnected: jest.fn().mockReturnValue(false),
            connect: jest.fn().mockResolvedValue(undefined)
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        const ensureSyncStateSpy = jest.spyOn(crawler as any, 'ensureSyncState').mockResolvedValue(undefined);
        const catchUpSpy = jest.spyOn(crawler as any, 'catchUp').mockResolvedValue(0);
        const subscribeLiveSpy = jest.spyOn(crawler as any, 'subscribeLive').mockResolvedValue(undefined);

        await crawler.start();

        expect(mockConnectTo).toHaveBeenCalledWith('db');
        expect(ensureSyncStateSpy).toHaveBeenCalled();
        expect(provider.connect).toHaveBeenCalled();
        expect(mockBlockProcessorConstructor).toHaveBeenCalledWith(provider);
        expect(mockProcessorInit).toHaveBeenCalled();
        expect(catchUpSpy).toHaveBeenCalled();
        expect(subscribeLiveSpy).toHaveBeenCalled();
    });

    it('skips reconnecting an already-connected node and does not subscribe live after shutdown during catch-up', async () => {
        const provider = {
            isConnected: jest.fn().mockReturnValue(true),
            connect: jest.fn().mockResolvedValue(undefined)
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        jest.spyOn(crawler as any, 'ensureSyncState').mockResolvedValue(undefined);
        jest.spyOn(crawler as any, 'catchUp').mockImplementation(async () => {
            (crawler as any).isRunning = false;
            return 0;
        });
        const subscribeLiveSpy = jest.spyOn(crawler as any, 'subscribeLive').mockResolvedValue(undefined);

        await crawler.start();

        expect(provider.connect).not.toHaveBeenCalled();
        expect(subscribeLiveSpy).not.toHaveBeenCalled();
    });

    it('does nothing when start is called while the crawler is already running', async () => {
        const provider = {
            isConnected: jest.fn(),
            connect: jest.fn()
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        try {
            (crawler as any).isRunning = true;
            await crawler.start();

            expect(mockConnectTo).not.toHaveBeenCalled();
            expect(provider.connect).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith('[Crawler] Already running');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('stops the crawler by unsubscribing and marking sync state as stopped', async () => {
        const provider = {
            unsubscribeFinalizedHeads: jest.fn().mockResolvedValue(true)
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).subscriptionId = 'sub-1';

        await crawler.stop();

        expect(provider.unsubscribeFinalizedHeads).toHaveBeenCalledWith('sub-1');
        expect((crawler as any).subscriptionId).toBeNull();
        expect(mockDbRun).toHaveBeenCalledTimes(1);
        expect(mockDbRun.mock.calls[0][0]).toEqual(expect.objectContaining({
            __type: 'update',
            __table: 'midnight.SyncState',
            __set: { syncStatus: 'stopped' },
            __where: { ID: 'SINGLETON' }
        }));
    });

    it('stops cleanly even when no live subscription exists', async () => {
        const provider = {
            unsubscribeFinalizedHeads: jest.fn()
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };

        await crawler.stop();

        expect(provider.unsubscribeFinalizedHeads).not.toHaveBeenCalled();
        expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it('swallows unsubscribe and DB errors during stop', async () => {
        const provider = {
            unsubscribeFinalizedHeads: jest.fn().mockRejectedValue(new Error('unsubscribe failed'))
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: jest.fn().mockRejectedValue(new Error('db closed')) };
        (crawler as any).subscriptionId = 'sub-1';

        await expect(crawler.stop()).resolves.toBeUndefined();
        expect((crawler as any).subscriptionId).toBeNull();
    });

    it('catches up over finalized blocks and updates progress', async () => {
        const provider = {
            getFinalizedHead: jest.fn().mockResolvedValue('0x2'),
            getHeader: jest.fn().mockResolvedValue({ number: '0x2' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true, batchSize: 10 });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({
            lastIndexedHeight: 0,
            lastIndexedHash: '0x0'
        });
        const processSpy = jest.spyOn(crawler as any, 'processBlockWithRetry')
            .mockResolvedValue({
                blockHeight: 1,
                blockHash: '0x1',
                transactionCount: 1,
                contractActionCount: 0,
                processingTimeMs: 5
            });

        await expect((crawler as any).catchUp()).resolves.toBe(2);

        expect(provider.getFinalizedHead).toHaveBeenCalled();
        expect(provider.getHeader).toHaveBeenCalledWith('0x2');
        expect(processSpy).toHaveBeenNthCalledWith(1, 1);
        expect(processSpy).toHaveBeenNthCalledWith(2, 2);
        expect((crawler as any).isCatchingUp).toBe(false);
        expect(mockDbRun).toHaveBeenCalled();
    });

    it('returns early from catch-up when already synced past the finalized head', async () => {
        const provider = {
            getFinalizedHead: jest.fn().mockResolvedValue('0x2'),
            getHeader: jest.fn().mockResolvedValue({ number: '0x2' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };

        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({
            lastIndexedHeight: 5,
            lastIndexedHash: '0x5'
        });

        await expect((crawler as any).catchUp()).resolves.toBe(0);
        expect((crawler as any).isCatchingUp).toBe(false);
        expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('stops catch-up after repeated block-processing errors exceed the circuit breaker threshold', async () => {
        const provider = {
            getFinalizedHead: jest.fn().mockResolvedValue('0x1'),
            getHeader: jest.fn().mockResolvedValue({ number: '0x1' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        const getSyncStateSpy = jest.spyOn(crawler as any, 'getSyncState');
        getSyncStateSpy
            .mockResolvedValueOnce({ lastIndexedHeight: 0, lastIndexedHash: null })
            .mockResolvedValueOnce({ consecutiveErrors: 11 });
        jest.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValue(new Error('Request timeout'));
        const recordErrorSpy = jest.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

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
            getFinalizedHead: jest.fn().mockResolvedValue('0x1'),
            getHeader: jest.fn().mockResolvedValue({ number: '0x1' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        const getSyncStateSpy = jest.spyOn(crawler as any, 'getSyncState');
        getSyncStateSpy
            .mockResolvedValueOnce({ lastIndexedHeight: 0, lastIndexedHash: null })
            .mockResolvedValueOnce({ consecutiveErrors: 2 });
        jest.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValueOnce(new Error('Request timeout'));
        const recordErrorSpy = jest.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            await expect((crawler as any).catchUp()).resolves.toBe(0);
            expect(recordErrorSpy).toHaveBeenCalledWith('Request timeout');
            expect(errorSpy).not.toHaveBeenCalledWith('[Crawler] Too many consecutive errors, stopping catch-up');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('subscribes live, re-subscribes after reconnect, and processes live blocks', async () => {
        let liveCallback: ((header: any) => Promise<void>) | undefined;
        let reconnectCallback: (() => Promise<void>) | undefined;
        const provider = {
            setOnReconnect: jest.fn().mockImplementation((callback: () => Promise<void>) => {
                reconnectCallback = callback;
            }),
            subscribeFinalizedHeads: jest.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                liveCallback = callback;
                return 'sub-1';
            }),
            getBlockHash: jest.fn().mockResolvedValue('0x2hash')
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;
        (crawler as any).startTime = Date.now() - 1000;

        const checkForReorgSpy = jest.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
        const processSpy = jest.spyOn(crawler as any, 'processBlockWithRetry').mockResolvedValue({
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

        mockDbRun.mockClear();
        await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

        expect(checkForReorgSpy).toHaveBeenCalled();
        expect(provider.getBlockHash).toHaveBeenCalledWith(2);
        expect(processSpy).toHaveBeenCalledWith(2);
        expect((crawler as any).processing).toBe(false);

        await reconnectCallback!();
        expect(provider.subscribeFinalizedHeads).toHaveBeenCalledTimes(2);
    });

    it('ignores live callbacks while catch-up is running or a block is already processing', async () => {
        let liveCallback: ((header: any) => Promise<void>) | undefined;
        const provider = {
            subscribeFinalizedHeads: jest.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                liveCallback = callback;
                return 'sub-1';
            })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        await (crawler as any).subscribeLive();
        mockDbRun.mockClear();

        (crawler as any).isCatchingUp = true;
        await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });
        expect(mockDbRun).not.toHaveBeenCalled();

        (crawler as any).isCatchingUp = false;
        (crawler as any).processing = true;
        await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });
        expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('records transient live-processing failures and pauses when the live breaker trips', async () => {
        let liveCallback: ((header: any) => Promise<void>) | undefined;
        const provider = {
            subscribeFinalizedHeads: jest.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                liveCallback = callback;
                return 'sub-1';
            }),
            getBlockHash: jest.fn().mockResolvedValue('0x2hash')
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        jest.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
        jest.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValue(new Error('Request timeout'));
        const recordErrorSpy = jest.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ consecutiveErrors: 11 });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            await (crawler as any).subscribeLive();
            mockDbRun.mockClear();

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
            subscribeFinalizedHeads: jest.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                liveCallback = callback;
                return 'sub-1';
            }),
            getBlockHash: jest.fn().mockResolvedValue('0x2hash')
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        jest.spyOn(crawler as any, 'checkForReorg').mockResolvedValue(null);
        jest.spyOn(crawler as any, 'processBlockWithRetry').mockRejectedValue(new Error('Invalid block data'));
        const recordErrorSpy = jest.spyOn(crawler as any, 'recordError').mockResolvedValue(undefined);
        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ consecutiveErrors: 1 });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            await (crawler as any).subscribeLive();
            mockDbRun.mockClear();

            await liveCallback!({ number: '0x2', parentHash: '0x1', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

            expect(recordErrorSpy).toHaveBeenCalledWith('Invalid block data');
            expect(errorSpy).toHaveBeenCalledWith('[Crawler] Live: failed to process block 2 (permanent): Invalid block data');
            expect(errorSpy).not.toHaveBeenCalledWith('[Crawler] Too many consecutive errors in live mode, pausing...');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('handles reorgs during live processing and updates the reorg log', async () => {
        let liveCallback: ((header: any) => Promise<void>) | undefined;
        const provider = {
            setOnReconnect: jest.fn(),
            subscribeFinalizedHeads: jest.fn().mockImplementation(async (callback: (header: any) => Promise<void>) => {
                liveCallback = callback;
                return 'sub-1';
            }),
            getBlockHash: jest.fn()
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = { run: mockDbRun };
        (crawler as any).isRunning = true;

        jest.spyOn(crawler as any, 'checkForReorg').mockResolvedValue({
            forkHeight: 9,
            oldTipHash: '0xold',
            newTipHash: '0xnew'
        });
        const handleReorgSpy = jest.spyOn(crawler as any, 'handleReorg').mockResolvedValue('reorg-log-1');
        const catchUpSpy = jest.spyOn(crawler as any, 'catchUp').mockResolvedValue(4);
        const processSpy = jest.spyOn(crawler as any, 'processBlockWithRetry').mockResolvedValue({
            blockHeight: 10,
            blockHash: '0x10',
            transactionCount: 0,
            contractActionCount: 0,
            processingTimeMs: 0
        });

        await (crawler as any).subscribeLive();
        mockDbRun.mockClear();

        await liveCallback!({ number: '0xa', parentHash: '0x9', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } });

        expect(handleReorgSpy).toHaveBeenCalled();
        expect(catchUpSpy).toHaveBeenCalled();
        expect(processSpy).not.toHaveBeenCalled();
        expect(provider.getBlockHash).not.toHaveBeenCalled();
        expect(mockDbRun).toHaveBeenCalledWith(expect.objectContaining({
            __type: 'update',
            __table: 'midnight.ReorgLog',
            __set: { blocksReIndexed: 4, status: 'completed' },
            __where: { ID: 'reorg-log-1' }
        }));
    });

    it('detects reorgs only when the parent hash no longer matches the indexed tip', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const header = { number: '0x2a', parentHash: '0xold', stateRoot: '', extrinsicsRoot: '', digest: { logs: [] } };

        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: '0xcurrent' });
        const findForkPointSpy = jest.spyOn(crawler as any, 'findForkPoint').mockResolvedValue(40);

        await expect((crawler as any).checkForReorg(header)).resolves.toEqual({
            forkHeight: 40,
            oldTipHash: '0xcurrent',
            newTipHash: '0xold'
        });
        expect(findForkPointSpy).toHaveBeenCalledWith(header);

        findForkPointSpy.mockClear();
        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValueOnce({ lastIndexedHash: '0xold' });
        await expect((crawler as any).checkForReorg(header)).resolves.toBeNull();
        expect(findForkPointSpy).not.toHaveBeenCalled();
    });

    it('does not report a reorg before any block has been indexed', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        jest.spyOn(crawler as any, 'getSyncState').mockResolvedValue({ lastIndexedHash: null });

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
            getHeader: jest.fn().mockRejectedValue(new Error('header unavailable'))
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = {
            run: jest.fn()
                .mockResolvedValueOnce({ ID: 'local-block' })
                .mockResolvedValueOnce(null)
        };

        await expect((crawler as any).findForkPoint({
            number: '0x6',
            parentHash: '0x5',
            stateRoot: '',
            extrinsicsRoot: '',
            digest: { logs: [] }
        })).resolves.toBe(6);

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
            getHeader: jest.fn().mockResolvedValue({ parentHash: '0x5' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ ID: 'block-5' })
        };

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
            getHeader: jest.fn().mockResolvedValue({ parentHash: '0xloop' })
        };
        const crawler = new MidnightCrawler(provider as any, { enabled: true });
        (crawler as any).db = {
            run: jest.fn().mockResolvedValue(null)
        };
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            await expect((crawler as any).findForkPoint({
                number: '0x66',
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

    it('rolls back indexed blocks and records a reorg transactionally', async () => {
        const txRun = jest.fn()
            .mockResolvedValueOnce([
                { ID: 'block-10', height: 10 },
                { ID: 'block-11', height: 11 }
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({ height: 9, hash: '0x9' })
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined);
        const db = {
            tx: jest.fn().mockImplementation(async (callback: (tx: { run: typeof txRun }) => Promise<void>) => {
                await callback({ run: txRun });
            })
        };
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        (crawler as any).db = db;

        await expect((crawler as any).handleReorg({
            forkHeight: 10,
            oldTipHash: '0xold',
            newTipHash: '0xnew'
        })).resolves.toBe('reorg-log-1');

        expect(db.tx).toHaveBeenCalled();
        expect(txRun).toHaveBeenCalledTimes(9);
        expect(txRun.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            __type: 'insert',
            __table: 'midnight.ReorgLog',
            __entries: expect.objectContaining({
                ID: 'reorg-log-1',
                forkHeight: 10,
                oldTipHash: '0xold',
                newTipHash: '0xnew',
                blocksRolledBack: 2,
                blocksReIndexed: 0,
                status: 'in_progress'
            })
        }));
    });

    it('returns early from reorg handling when there are no indexed blocks to roll back', async () => {
        const txRun = jest.fn().mockResolvedValue([]);
        const db = {
            tx: jest.fn().mockImplementation(async (callback: (tx: { run: typeof txRun }) => Promise<void>) => {
                await callback({ run: txRun });
            })
        };
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        (crawler as any).db = db;

        await expect((crawler as any).handleReorg({
            forkHeight: 10,
            oldTipHash: '0xold',
            newTipHash: '0xnew'
        })).resolves.toBe('reorg-log-1');

        expect(txRun).toHaveBeenCalledTimes(1);
    });

    it('removes transaction-linked records during deep reorg rollback', async () => {
        const txRun = jest.fn(async (query: any) => {
            if (query?.__kind === 'many' && query.__table === 'midnight.Blocks' && query.__columns?.includes('ID')) {
                return [{ ID: 'block-10', height: 10 }];
            }
            if (query?.__kind === 'many' && query.__table === 'midnight.Transactions' && query.__columns?.includes('ID')) {
                return [{ ID: 'tx-10' }];
            }
            if (query?.__kind === 'many' && query.__table === 'midnight.ContractActions' && query.__columns?.includes('ID')) {
                return [{ ID: 'action-10' }];
            }
            if (query?.__kind === 'many' && query.__table === 'midnight.TransactionResults') {
                return [{ ID: 'result-10' }];
            }
            if (query?.__kind === 'one' && query.__table === 'midnight.Blocks' && query.__orderBy === 'height desc') {
                return { height: 9, hash: '0x9' };
            }
            return undefined;
        });
        const db = {
            tx: jest.fn().mockImplementation(async (callback: (tx: { run: typeof txRun }) => Promise<void>) => {
                await callback({ run: txRun });
            })
        };
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        (crawler as any).db = db;

        await expect((crawler as any).handleReorg({
            forkHeight: 10,
            oldTipHash: '0xold',
            newTipHash: '0xnew'
        })).resolves.toBe('reorg-log-1');

        const queries = txRun.mock.calls.map(([query]) => query);
        expect(queries).toContainEqual(expect.objectContaining({
            __type: 'delete',
            __table: 'midnight.ContractBalances',
            __where: { contractAction_ID: 'action-10' }
        }));
        expect(queries).toContainEqual(expect.objectContaining({
            __type: 'delete',
            __table: 'midnight.ContractActions',
            __where: { transaction_ID: 'tx-10' }
        }));
        expect(queries).toContainEqual(expect.objectContaining({
            __type: 'delete',
            __table: 'midnight.TransactionSegments',
            __where: { transactionResult_ID: 'result-10' }
        }));
        expect(queries).toContainEqual(expect.objectContaining({
            __type: 'update',
            __table: 'midnight.UnshieldedUtxos',
            __set: { spentAtTransaction_ID: null },
            __where: { spentAtTransaction_ID: 'tx-10' }
        }));
        expect(queries).toContainEqual(expect.objectContaining({
            __type: 'insert',
            __table: 'midnight.ReorgLog',
            __entries: expect.objectContaining({
                blocksRolledBack: 1,
                status: 'in_progress'
            })
        }));
    });
});