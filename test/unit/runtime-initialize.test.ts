const mockDbRun = jest.fn();
const mockDbDeploy = jest.fn();
const mockCdsDeployTo = jest.fn();
const mockCdsDeploy = jest.fn();
const mockConnectTo = jest.fn();
const mockStartCrawler = jest.fn();
const mockStopCrawler = jest.fn();
const mockEnsureNightgateModelLoaded = jest.fn();
const selectFromSpy = jest.fn();
const ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'MIDNIGHT_NETWORK',
    'NIGHTGATE_NODE_URL',
    'MIDNIGHT_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'MIDNIGHT_CRAWLER_NODE_URL'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    kind: 'nightgate',
                    network: 'testnet',
                    nodeUrl: 'ws://localhost:9944'
                }
            }
        },
        connect: {
            to: mockConnectTo
        },
        ql: {
            SELECT: {
                one: {
                    from: selectFromSpy.mockImplementation((table: string) => ({
                        __kind: 'one',
                        __table: table
                    }))
                }
            }
        },
        deploy: mockCdsDeploy
    };
    cds.default = cds;
    return cds;
});

jest.mock('../../srv/crawler/index', () => ({
    startCrawler: mockStartCrawler,
    stopCrawler: mockStopCrawler
}));

jest.mock('../../srv/utils/cds-model', () => ({
    ensureNightgateModelLoaded: mockEnsureNightgateModelLoaded
}));

import cds from '@sap/cds';
import { initialize, shutdown } from '../../src/index';

describe('runtime initialize', () => {
    beforeEach(async () => {
        jest.clearAllMocks();

        for (const key of ENV_KEYS) {
            delete process.env[key];
        }

        (cds.env as any).requires = {
            nightgate: {
                kind: 'nightgate',
                network: 'testnet',
                nodeUrl: 'ws://localhost:9944'
            }
        };

        mockDbRun.mockResolvedValue({});
        mockDbDeploy.mockResolvedValue(undefined);
        mockCdsDeployTo.mockResolvedValue(undefined);
        mockCdsDeploy.mockReturnValue({ to: mockCdsDeployTo });
        mockConnectTo.mockResolvedValue({ run: mockDbRun, deploy: mockDbDeploy });
        mockStartCrawler.mockResolvedValue(undefined);
        mockStopCrawler.mockResolvedValue(undefined);
        mockEnsureNightgateModelLoaded.mockResolvedValue(undefined);

        await shutdown();
        jest.clearAllMocks();
    });

    afterAll(() => {
        for (const key of ENV_KEYS) {
            const value = originalEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('loads the model before DB access, starts the crawler, and logs syncing startup state', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        try {
            const status = await initialize();

            expect(mockEnsureNightgateModelLoaded).toHaveBeenCalledTimes(1);
            expect(mockEnsureNightgateModelLoaded.mock.invocationCallOrder[0]).toBeLessThan(mockConnectTo.mock.invocationCallOrder[0]);
            expect(mockConnectTo).toHaveBeenCalledWith('db');
            expect(selectFromSpy).toHaveBeenCalledWith('midnight.Blocks');
            expect(selectFromSpy).toHaveBeenCalledWith('midnight.SyncState');
            expect(mockDbRun).toHaveBeenNthCalledWith(1, expect.objectContaining({
                __kind: 'one',
                __table: 'midnight.Blocks'
            }));
            expect(mockDbRun).toHaveBeenNthCalledWith(2, expect.objectContaining({
                __kind: 'one',
                __table: 'midnight.SyncState'
            }));
            expect(mockDbDeploy).not.toHaveBeenCalled();
            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'ws://localhost:9944',
                requestTimeout: 30000
            }));
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Initializing crawler and starting catch-up...');
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: syncing (crawler started)');
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: true,
                mode: 'active'
            }));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('returns idle mode and logs a stopped startup state when the crawler is disabled', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        (cds.env as any).requires.nightgate.crawler = { enabled: false };

        try {
            const status = await initialize();

            expect(mockStartCrawler).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: stopped (crawler disabled)');
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: false,
                mode: 'idle'
            }));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('logs an offline startup state when crawler startup fails with a node error', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        mockStartCrawler.mockRejectedValue(new Error('ECONNREFUSED: connect'));

        try {
            const status = await initialize();

            expect(warnSpy).toHaveBeenCalledWith('[odatano-nightgate] Node not reachable at ws://localhost:9944: ECONNREFUSED: connect');
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: offline (node unreachable)');
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: true,
                mode: 'offline',
                lastError: 'ECONNREFUSED: connect'
            }));
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('auto-deploys when SyncState table is missing but Blocks exists', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        mockDbRun
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('no such table: midnight_SyncState'))
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({});

        try {
            const status = await initialize();

            expect(mockDbDeploy).toHaveBeenCalledWith('*');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Required DB tables missing/incomplete'));
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] DB schema deployed');
            expect(mockStartCrawler).toHaveBeenCalledTimes(1);
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: true,
                mode: 'active'
            }));
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('falls back to cds.deploy(...).to(db) when db.deploy is unavailable', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        const dbWithoutDeploy = { run: mockDbRun };

        mockConnectTo.mockResolvedValue(dbWithoutDeploy);
        mockDbRun
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('no such table: midnight_SyncState'))
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({});

        try {
            const status = await initialize();

            expect(mockDbDeploy).not.toHaveBeenCalled();
            expect(mockCdsDeploy).toHaveBeenCalledWith('*');
            expect(mockCdsDeployTo).toHaveBeenCalledWith(dbWithoutDeploy);
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] DB schema deployed');
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: true,
                mode: 'active'
            }));
        } finally {
            warnSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('uses env overrides for preprod startup even when package config has no network', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        delete (cds.env as any).requires.nightgate.network;
        process.env.NIGHTGATE_NETWORK = 'preprod';
        process.env.NIGHTGATE_NODE_URL = 'wss://node.example.test';
        process.env.NIGHTGATE_CRAWLER_NODE_URL = 'wss://crawler.example.test';

        try {
            const status = await initialize();

            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'wss://crawler.example.test',
                requestTimeout: 30000
            }));
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Network: preprod');
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Node: wss://node.example.test');
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: true,
                network: 'preprod',
                nodeUrl: 'wss://node.example.test',
                mode: 'active'
            }));
        } finally {
            logSpy.mockRestore();
        }
    });
});