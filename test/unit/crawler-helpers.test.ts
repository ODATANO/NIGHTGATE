const selectWhereSpy = vi.hoisted(() => (vi.fn()));
const insertEntriesSpy = vi.hoisted(() => (vi.fn()));
const updateWhereSpy = vi.hoisted(() => (vi.fn()));

vi.mock('@sap/cds', () => {
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
                    from: vi.fn().mockReturnValue({
                        where: selectWhereSpy
                    })
                }
            },
            INSERT: {
                into: vi.fn().mockReturnValue({
                    entries: insertEntriesSpy
                })
            },
            UPDATE: {
                entity: vi.fn().mockReturnValue({
                    set: vi.fn().mockReturnValue({
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

const NIGHTGATE_ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED'
] as const;
const originalNightgateEnv = Object.fromEntries(
    NIGHTGATE_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof NIGHTGATE_ENV_KEYS)[number], string | undefined>;

describe('MidnightCrawler helper paths', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The project's .env sets NIGHTGATE_NETWORK / NODE_URL for live runs;
        // VS Code's Jest extension propagates those into the test process, where
        // they'd override the mocked cds.env.requires.nightgate above and break
        // these assertions. Clear them per-test so the mocked config wins.
        for (const key of NIGHTGATE_ENV_KEYS) {
            delete process.env[key];
        }
    });

    afterAll(() => {
        for (const key of NIGHTGATE_ENV_KEYS) {
            const value = originalNightgateEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('retries transient block-processing failures before succeeding', async () => {
        const crawler = new MidnightCrawler({} as any, {
            enabled: true,
            maxRetries: 3,
            retryDelay: 10
        });
        const processor = {
            processBlockByHeight: vi.fn()
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
        (crawler as any).sleep = vi.fn().mockResolvedValue(undefined);

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
            processBlockByHeight: vi.fn().mockRejectedValue(new Error('Invalid block data at height 7'))
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            (crawler as any).processor = processor;
            (crawler as any).sleep = vi.fn().mockResolvedValue(undefined);

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
            processBlockByHeight: vi.fn().mockRejectedValue(new Error('Request timeout'))
        };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            (crawler as any).processor = processor;
            (crawler as any).sleep = vi.fn().mockResolvedValue(undefined);

            await expect((crawler as any).processBlockWithRetry(8)).rejects.toThrow('Request timeout');
            expect(processor.processBlockByHeight).toHaveBeenCalledTimes(3);
            expect((crawler as any).sleep).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('creates SyncState when it is missing (shared utility)', async () => {
        const { ensureSyncStateSingleton } = await import('../../srv/utils/sync-state.js');
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(undefined)
        };

        await ensureSyncStateSingleton(db as any);

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
        const { ensureSyncStateSingleton } = await import('../../srv/utils/sync-state.js');
        const db = {
            run: vi.fn().mockResolvedValueOnce({ ID: 'SINGLETON' })
        };

        await expect(ensureSyncStateSingleton(db as any)).resolves.toBeUndefined();
        expect(db.run).toHaveBeenCalledTimes(1);
        expect(insertEntriesSpy).not.toHaveBeenCalled();
    });

    it('ignores unique-constraint races while creating SyncState (shared utility)', async () => {
        const { ensureSyncStateSingleton } = await import('../../srv/utils/sync-state.js');
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
        };

        await expect(ensureSyncStateSingleton(db as any)).resolves.toBeUndefined();
    });

    it('rethrows unexpected SyncState insert failures (shared utility)', async () => {
        const { ensureSyncStateSingleton } = await import('../../srv/utils/sync-state.js');
        const db = {
            run: vi.fn()
                .mockResolvedValueOnce(null)
                .mockRejectedValueOnce(new Error('database unavailable'))
        };

        await expect(ensureSyncStateSingleton(db as any)).rejects.toThrow('database unavailable');
    });

    it('records crawler errors without throwing back to the caller', async () => {
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        const db = {
            run: vi.fn()
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
            run: vi.fn().mockRejectedValue(new Error('db down'))
        };

        (crawler as any).db = db;

        await expect((crawler as any).recordError('boom')).resolves.toBeUndefined();
    });

    it('resolves sleep after the requested delay', async () => {
        vi.useFakeTimers();
        const crawler = new MidnightCrawler({} as any, { enabled: true });
        let resolved = false;

        try {
            const promise = (crawler as any).sleep(25).then(() => {
                resolved = true;
            });

            await vi.advanceTimersByTimeAsync(24);
            expect(resolved).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await promise;
            expect(resolved).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
describe('fetch retry wrappers (parallel catch-up pipeline)', () => {
    function makeCrawler(processor: any) {
        const crawler = new MidnightCrawler({} as any, {
            enabled: true,
            maxRetries: 3,
            retryDelay: 10
        });
        (crawler as any).processor = processor;
        (crawler as any).sleep = vi.fn().mockResolvedValue(undefined);
        return crawler as any;
    }

    it('fetchBlockBatchWithRetry retries the WHOLE batch on transient errors', async () => {
        const batch = [{ blockHash: '0xa', height: 10, alreadyIndexed: true, fetchStartedAt: 1 }];
        const processor = {
            fetchBlockBatch: vi.fn()
                .mockRejectedValueOnce(new Error('Request timeout'))
                .mockResolvedValueOnce(batch)
        };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const crawler = makeCrawler(processor);
            await expect(crawler.fetchBlockBatchWithRetry([10])).resolves.toBe(batch);
            expect(processor.fetchBlockBatch).toHaveBeenCalledTimes(2);
            expect(crawler.sleep).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/attempt 1 failed \(transient\)/));
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('fetchBlockBatchWithRetry aborts immediately on permanent errors', async () => {
        const processor = {
            fetchBlockBatch: vi.fn().mockRejectedValue(new Error('No block at height 11'))
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const crawler = makeCrawler(processor);
            await expect(crawler.fetchBlockBatchWithRetry([10, 11])).rejects.toThrow('No block at height 11');
            expect(processor.fetchBlockBatch).toHaveBeenCalledTimes(1);
            expect(crawler.sleep).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/permanent error/));
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('fetchBlockBatchWithRetry rethrows the last error after exhausting retries', async () => {
        const processor = {
            fetchBlockBatch: vi.fn().mockRejectedValue(new Error('ECONNRESET: connection reset by peer'))
        };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const crawler = makeCrawler(processor);
            await expect(crawler.fetchBlockBatchWithRetry([10])).rejects.toThrow('connection reset');
            expect(processor.fetchBlockBatch).toHaveBeenCalledTimes(3);
            expect(crawler.sleep).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('fetchBlockWithRetry mirrors the same policy for single blocks', async () => {
        const prepared = { blockHash: '0xb', height: 12, alreadyIndexed: false };
        const processor = {
            fetchBlockData: vi.fn()
                .mockRejectedValueOnce(new Error('Request timeout'))
                .mockResolvedValueOnce(prepared)
        };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const crawler = makeCrawler(processor);
            await expect(crawler.fetchBlockWithRetry(12)).resolves.toBe(prepared);
            expect(processor.fetchBlockData).toHaveBeenCalledTimes(2);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
