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

    it('throws after exhausting transient retries', async () => {
        const crawler = new MidnightCrawler({} as any, {
            enabled: true,
            maxRetries: 3,
            retryDelay: 10
        });
        const processor = {
            processBlockByHeight: jest.fn().mockRejectedValue(new Error('Request timeout'))
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        try {
            (crawler as any).processor = processor;
            (crawler as any).sleep = jest.fn().mockResolvedValue(undefined);

            await expect((crawler as any).processBlockWithRetry(8)).rejects.toThrow('Request timeout');
            expect(processor.processBlockByHeight).toHaveBeenCalledTimes(3);
            expect((crawler as any).sleep).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('creates SyncState when it is missing (shared utility)', async () => {
        const { ensureSyncStateSingleton } = require('../../srv/utils/sync-state');
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(undefined)
        };

        await ensureSyncStateSingleton(db);

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

    it('does nothing when SyncState already exists (shared utility)', async () => {
        const { ensureSyncStateSingleton } = require('../../srv/utils/sync-state');
        const db = {
            run: jest.fn().mockResolvedValueOnce({ ID: 'SINGLETON' })
        };

        await expect(ensureSyncStateSingleton(db)).resolves.toBeUndefined();
        expect(db.run).toHaveBeenCalledTimes(1);
        expect(insertEntriesSpy).not.toHaveBeenCalled();
    });

    it('ignores unique-constraint races while creating SyncState (shared utility)', async () => {
        const { ensureSyncStateSingleton } = require('../../srv/utils/sync-state');
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
        };

        await expect(ensureSyncStateSingleton(db)).resolves.toBeUndefined();
    });

    it('rethrows unexpected SyncState insert failures (shared utility)', async () => {
        const { ensureSyncStateSingleton } = require('../../srv/utils/sync-state');
        const db = {
            run: jest.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('database unavailable'))
        };

        await expect(ensureSyncStateSingleton(db)).rejects.toThrow('database unavailable');
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

    it('swallows failures while recording crawler errors', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const db = {
            run: jest.fn().mockRejectedValue(new Error('db down'))
        };

        (crawler as any).db = db;

        await expect((crawler as any).recordError('boom')).resolves.toBeUndefined();
    });

    it('resolves sleep after the requested delay', async () => {
        jest.useFakeTimers();
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        let resolved = false;

        try {
            const promise = (crawler as any).sleep(25).then(() => {
                resolved = true;
            });

            await jest.advanceTimersByTimeAsync(24);
            expect(resolved).toBe(false);

            await jest.advanceTimersByTimeAsync(1);
            await promise;
            expect(resolved).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});