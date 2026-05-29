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
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED'
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

jest.mock('../../srv/midnight/wallet-worker-client', () => ({
    startWalletWorker: jest.fn(async () => undefined),
    stopWalletWorker:  jest.fn(async () => undefined),
    setStateSaveSink:  jest.fn()
}));

jest.mock('../../srv/submission/wallet-facade-builder', () => ({
    wireWorkerStateSaveSink: jest.fn(),
    getOrBuildWalletFacade:  jest.fn(),
    evictWalletFacade:       jest.fn(async () => undefined),
    getCacheSize:            jest.fn(() => 0),
    clearAllFacades:         jest.fn()
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

    it('throws SchemaNotDeployedError when a required table is missing (no auto-deploy)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { SchemaNotDeployedError } = require('../../src/index');

        // Probes: Blocks OK, SyncState missing. initialize() should bail
        // immediately with SchemaNotDeployedError; no deploy attempt, no
        // crawler start, nothing.
        mockDbRun
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('no such table: midnight_SyncState'));

        const err = await initialize().catch(e => e);
        expect(err).toBeInstanceOf(SchemaNotDeployedError);
        expect(err.missingTable).toBe('midnight.SyncState');
        expect(err.message).toMatch(/npm run deploy/);

        // Crucially: no deploy was attempted, on either path.
        expect(mockDbDeploy).not.toHaveBeenCalled();
        expect(mockCdsDeploy).not.toHaveBeenCalled();
        // Crawler also never started — we fail before any subsequent init step.
        expect(mockStartCrawler).not.toHaveBeenCalled();
    });

    it('includes the resolved DB path in the error message', async () => {
        (cds.env as any).requires.db = { credentials: { database: 'db/midnight.db' } };
        mockDbRun.mockRejectedValueOnce(new Error('no such table: midnight_Blocks'));

        await expect(initialize()).rejects.toMatchObject({
            message: expect.stringContaining('db/midnight.db')
        });
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