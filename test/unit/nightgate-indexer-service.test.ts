const mockDbRun = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({ run: mockDbRun });
const registeredHandlers = new Map<string, Function>();

const mockEnv: any = {
    requires: {
        nightgate: {
            network: 'testnet',
            nodeUrl: 'ws://localhost:9944'
        }
    }
};

function createSelectBuilder(kind: 'one' | 'many', table: string) {
    const builder: any = {
        __kind: kind,
        __table: table
    };

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
        connect: { to: mockDbConnect },
        env: mockEnv,
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
            }
        },
        ApplicationService: class {
            on(event: string, handler: Function) {
                registeredHandlers.set(event, handler);
            }

            async init() {}
        }
    };
    cds.default = cds;
    return cds;
});

import NightgateIndexerService from '../../srv/nightgate-indexer-service';

function getHandler(name: string): Function {
    const handler = registeredHandlers.get(name);
    expect(handler).toBeDefined();
    return handler as Function;
}

async function initService(existingSyncState: any = { ID: 'SINGLETON' }) {
    mockDbRun.mockResolvedValueOnce(existingSyncState);
    const service = new NightgateIndexerService();
    await service.init();
    return service;
}

describe('NightgateIndexerService comprehensive coverage', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        registeredHandlers.clear();
        mockEnv.requires = {
            nightgate: {
                network: 'testnet',
                nodeUrl: 'ws://localhost:9944'
            }
        };
    });

    it('creates SyncState at init using the configured nightgate settings', async () => {
        mockDbRun
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(undefined);

        const service = new NightgateIndexerService();
        await service.init();

        expect(mockDbConnect).toHaveBeenCalledWith('db');
        expect(mockDbRun).toHaveBeenCalledTimes(2);
        expect(mockDbRun.mock.calls[1][0]).toEqual(expect.objectContaining({
            __type: 'insert',
            __table: 'midnight.SyncState',
            __entries: expect.objectContaining({
                ID: 'SINGLETON',
                networkId: 'testnet',
                nodeUrl: 'ws://localhost:9944',
                syncStatus: 'stopped',
                consecutiveErrors: 0
            })
        }));
        expect(service).toBeInstanceOf(NightgateIndexerService);
    });

    it('uses default sync-state values when no nightgate config is present', async () => {
        mockEnv.requires = {};
        mockDbRun
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(undefined);

        const service = new NightgateIndexerService();
        await service.init();

        expect(mockDbRun.mock.calls[1][0]).toEqual(expect.objectContaining({
            __entries: expect.objectContaining({
                networkId: 'testnet',
                nodeUrl: ''
            })
        }));
        expect(service).toBeInstanceOf(NightgateIndexerService);
    });

    it('logs and continues when SyncState init fails', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        mockDbRun.mockRejectedValueOnce(new Error('table not found'));

        try {
            const service = new NightgateIndexerService();
            await service.init();

            expect(warnSpy).toHaveBeenCalledWith('[IndexerService] SyncState init skipped:', 'table not found');
            expect(service).toBeInstanceOf(NightgateIndexerService);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('returns the persisted sync state when getSyncStatus is requested', async () => {
        await initService();
        const handler = getHandler('getSyncStatus');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'synced',
            lastIndexedHeight: 42,
            chainHeight: 50,
            consecutiveErrors: 0
        });

        await expect(handler()).resolves.toEqual(expect.objectContaining({
            syncStatus: 'synced',
            lastIndexedHeight: 42,
            chainHeight: 50
        }));
    });

    it('getSyncStatus returns stopped defaults when SyncState is absent', async () => {
        await initService();
        const handler = getHandler('getSyncStatus');

        mockDbRun.mockResolvedValueOnce(null);

        await expect(handler()).resolves.toEqual(expect.objectContaining({
            ID: 'SINGLETON',
            syncStatus: 'stopped',
            lastIndexedHeight: 0,
            chainHeight: 0,
            consecutiveErrors: 0
        }));
    });

    it('getHealth returns unknown defaults when SyncState is absent', async () => {
        await initService();
        const handler = getHandler('getHealth');

        mockDbRun.mockResolvedValueOnce(null);

        await expect(handler()).resolves.toEqual({
            status: 'unknown',
            chainHeight: 0,
            indexedHeight: 0,
            finalizedHeight: 0,
            lag: 0,
            finalizedLag: 0,
            blocksPerSecond: 0,
            syncStatus: 'stopped'
        });
    });

    it('getHealth reports healthy status and clamps negative lag to zero', async () => {
        await initService();
        const handler = getHandler('getHealth');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 8,
            lastIndexedHeight: 12,
            lastFinalizedHeight: 10,
            blocksPerSecond: 0,
            syncStatus: undefined
        });

        await expect(handler()).resolves.toEqual(expect.objectContaining({
            status: 'healthy',
            lag: 0,
            finalizedLag: 0,
            syncStatus: 'stopped'
        }));
    });

    it('getHealth reports degraded status when lag exceeds 10 blocks', async () => {
        await initService();
        const handler = getHandler('getHealth');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 25,
            lastIndexedHeight: 12,
            lastFinalizedHeight: 20,
            blocksPerSecond: 1.5,
            syncStatus: 'syncing'
        });

        await expect(handler()).resolves.toEqual(expect.objectContaining({
            status: 'degraded',
            lag: 13,
            finalizedLag: 5,
            blocksPerSecond: 1.5
        }));
    });

    it('getHealth reports unhealthy status when lag exceeds 100 blocks', async () => {
        await initService();
        const handler = getHandler('getHealth');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 250,
            lastIndexedHeight: 100,
            lastFinalizedHeight: 150,
            blocksPerSecond: 0,
            syncStatus: 'error'
        });

        await expect(handler()).resolves.toEqual(expect.objectContaining({
            status: 'unhealthy',
            lag: 150,
            finalizedLag: 100,
            syncStatus: 'error'
        }));
    });

    it('returns reorg history ordered by newest first and honors a custom limit', async () => {
        await initService();
        const handler = getHandler('getReorgHistory');
        const req: any = { data: { limit: 25 } };

        mockDbRun.mockResolvedValueOnce([{ ID: 'reorg-1' }]);

        await expect(handler(req)).resolves.toEqual([{ ID: 'reorg-1' }]);
        expect(mockDbRun.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            __kind: 'many',
            __table: 'midnight.ReorgLog',
            __orderBy: 'detectedAt desc',
            __limit: 25
        }));
    });

    it('uses the default reorg history limit when no limit is provided', async () => {
        await initService();
        const handler = getHandler('getReorgHistory');
        const req: any = { data: {} };

        mockDbRun.mockResolvedValueOnce([]);

        await expect(handler(req)).resolves.toEqual([]);
        expect(mockDbRun.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            __limit: 10
        }));
    });

    it('returns liveness with an ISO timestamp and non-negative uptime', async () => {
        await initService();
        const handler = getHandler('getLiveness');

        const result = await handler();

        expect(result.status).toBe('alive');
        expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
        expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it('getReadiness returns false when SyncState is missing after the database check', async () => {
        await initService();
        const handler = getHandler('getReadiness');

        mockDbRun.mockResolvedValueOnce(null);

        await expect(handler()).resolves.toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: false,
                node: false
            }
        });
    });

    it('getReadiness returns ready when crawler is active and node activity is fresh', async () => {
        await initService();
        const handler = getHandler('getReadiness');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'synced',
            lastIndexedAt: new Date().toISOString()
        });

        await expect(handler()).resolves.toEqual({
            ready: true,
            checks: {
                database: true,
                crawler: true,
                node: true
            }
        });
    });

    it('getReadiness reports stale node activity separately from crawler readiness', async () => {
        await initService();
        const handler = getHandler('getReadiness');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'syncing',
            lastIndexedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        });

        await expect(handler()).resolves.toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: true,
                node: false
            }
        });
    });

    it('getReadiness keeps crawler false when syncStatus is stopped', async () => {
        await initService();
        const handler = getHandler('getReadiness');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'stopped',
            lastIndexedAt: new Date().toISOString()
        });

        await expect(handler()).resolves.toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: false,
                node: true
            }
        });
    });

    it('getReadiness returns false when the database check throws', async () => {
        await initService();
        const handler = getHandler('getReadiness');

        mockDbRun.mockRejectedValueOnce(new Error('db unavailable'));

        await expect(handler()).resolves.toEqual({
            ready: false,
            checks: {
                database: false,
                crawler: false,
                node: false
            }
        });
    });

    it('renders Prometheus metrics for sync state and error status', async () => {
        await initService();
        const handler = getHandler('getMetrics');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 120,
            lastIndexedHeight: 100,
            blocksPerSecond: 3.5,
            consecutiveErrors: 2,
            syncStatus: 'error'
        });

        const result = await handler();

        expect(result).toContain('odatano_nightgate_chain_height 120');
        expect(result).toContain('odatano_nightgate_indexed_height 100');
        expect(result).toContain('odatano_nightgate_sync_lag 20');
        expect(result).toContain('odatano_nightgate_blocks_per_second 3.5');
        expect(result).toContain('odatano_nightgate_consecutive_errors 2');
        expect(result).toContain('odatano_nightgate_sync_status 3');
        expect(result.endsWith('\n')).toBe(true);
    });

    it('metrics fall back to zero values when sync state is absent or unknown', async () => {
        await initService();
        const handler = getHandler('getMetrics');

        mockDbRun.mockResolvedValueOnce(null);
        const result = await handler();

        expect(result).toContain('odatano_nightgate_chain_height 0');
        expect(result).toContain('odatano_nightgate_indexed_height 0');
        expect(result).toContain('odatano_nightgate_sync_lag 0');
        expect(result).toContain('odatano_nightgate_sync_status 0');
    });

    it('metrics map unknown sync statuses to zero', async () => {
        await initService();
        const handler = getHandler('getMetrics');

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 5,
            lastIndexedHeight: 7,
            blocksPerSecond: 0,
            consecutiveErrors: 0,
            syncStatus: 'mystery'
        });

        const result = await handler();

        expect(result).toContain('odatano_nightgate_sync_lag -2');
        expect(result).toContain('odatano_nightgate_sync_status 0');
    });
});