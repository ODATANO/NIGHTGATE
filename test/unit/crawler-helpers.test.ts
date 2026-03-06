const selectWhereSpy = jest.fn();
const insertEntriesSpy = jest.fn();
const updateWhereSpy = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    network: 'testnet'
                }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        where: selectWhereSpy
                    })
                }
            },
            INSERT: {
                into: jest.fn().mockReturnValue({
                    entries: insertEntriesSpy
                })
            },
            UPDATE: {
                entity: jest.fn().mockReturnValue({
                    set: jest.fn().mockReturnValue({
                        where: updateWhereSpy
                    })
                })
            },
            DELETE: {}
        }
    };
    cds.default = cds;
    return cds;
});

import { MidnightCrawler } from '../../srv/crawler/Crawler';

describe('MidnightCrawler helper paths', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('retries transient block-processing failures before succeeding', async () => {
        const crawler = new MidnightCrawler({} as any, {
            enabled: true,
            maxRetries: 3,
            retryDelay: 10
        });
        const processor = {
            processBlockByHeight: jest.fn()
                .mockRejectedValueOnce(new Error('Request timeout'))
                .mockResolvedValueOnce({
                    blockHeight: 5,
                    blockHash: '0x5',
                    transactionCount: 1,
                    contractActionCount: 0,
                    processingTimeMs: 12
                })
        };

        (crawler as any).processor = processor;
        (crawler as any).sleep = jest.fn().mockResolvedValue(undefined);

        await expect((crawler as any).processBlockWithRetry(5)).resolves.toEqual(expect.objectContaining({
            blockHeight: 5,
            blockHash: '0x5'
        }));
        expect(processor.processBlockByHeight).toHaveBeenCalledTimes(2);
        expect((crawler as any).sleep).toHaveBeenCalledTimes(1);
    });

    it('does not retry permanent block-processing failures', async () => {
        const crawler = new MidnightCrawler({} as any, {
            enabled: true,
            maxRetries: 3,
            retryDelay: 10
        });
        const processor = {
            processBlockByHeight: jest.fn().mockRejectedValue(new Error('Invalid block data at height 7'))
        };
        const errorSpy = jest.spyOn(console, 'error').mockImplementation();

        try {
            (crawler as any).processor = processor;
            (crawler as any).sleep = jest.fn().mockResolvedValue(undefined);

            await expect((crawler as any).processBlockWithRetry(7)).rejects.toThrow('Invalid block data at height 7');
            expect(processor.processBlockByHeight).toHaveBeenCalledTimes(1);
            expect((crawler as any).sleep).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('creates SyncState when it is missing', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(undefined)
        };

        (crawler as any).db = db;

        await (crawler as any).ensureSyncState();

        expect(db.run).toHaveBeenCalledTimes(2);
        expect(selectWhereSpy).toHaveBeenCalledWith({ ID: 'SINGLETON' });
        expect(insertEntriesSpy).toHaveBeenCalledWith(expect.objectContaining({
            ID: 'SINGLETON',
            networkId: 'testnet',
            syncStatus: 'stopped',
            chainHeight: 0,
            consecutiveErrors: 0
        }));
    });

    it('ignores unique-constraint races while creating SyncState', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
        };

        (crawler as any).db = db;

        await expect((crawler as any).ensureSyncState()).resolves.toBeUndefined();
    });

    it('records crawler errors without throwing back to the caller', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce({ consecutiveErrors: 2 })
                .mockResolvedValueOnce(undefined)
        };

        (crawler as any).db = db;

        await expect((crawler as any).recordError('x'.repeat(600))).resolves.toBeUndefined();
        expect(updateWhereSpy).toHaveBeenCalledWith({ ID: 'SINGLETON' });
    });
});