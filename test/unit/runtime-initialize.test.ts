const mockDbRun = vi.fn();
const mockDbDeploy = vi.fn();
const mockCdsDeployTo = vi.fn();
const mockCdsDeploy = vi.hoisted(() => (vi.fn()));
const mockConnectTo = vi.hoisted(() => (vi.fn()));
const mockStartCrawler = vi.hoisted(() => (vi.fn()));
const mockStopCrawler = vi.hoisted(() => (vi.fn()));
const mockEnsureNightgateModelLoaded = vi.hoisted(() => (vi.fn()));
const selectFromSpy = vi.hoisted(() => (vi.fn()));
const ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED',
    'NIGHTGATE_REPLICA_COUNT'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

vi.mock('@sap/cds', () => {
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
            },
            DELETE: {
                from: vi.fn((table: unknown) => ({
                    where: vi.fn((where: unknown) => ({ __kind: 'delete', __table: table, where }))
                }))
            }
        },
        deploy: mockCdsDeploy,
        log: (() => {
            const channels: Record<string, any> = {};
            return (name: string) => (channels[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })()
    };
    cds.default = cds;
    return cds;
});

vi.mock('../../srv/crawler/index', () => ({
    startCrawler: mockStartCrawler,
    stopCrawler: mockStopCrawler
}));

vi.mock('../../srv/utils/cds-model', () => ({
    ensureNightgateModelLoaded: mockEnsureNightgateModelLoaded
}));

vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    startWalletWorker: vi.fn(async () => undefined),
    stopWalletWorker:  vi.fn(async () => undefined),
    setStateSaveSink:  vi.fn()
}));

vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    wireWorkerStateSaveSink: vi.fn(),
    getOrBuildWalletFacade:  vi.fn(),
    evictWalletFacade:       vi.fn(async () => undefined),
    getCacheSize:            vi.fn(() => 0),
    clearAllFacades:         vi.fn()
}));

import cds from '@sap/cds';
import { getStatus, initialize, shutdown } from '../../src/index';

describe('runtime initialize', () => {
    beforeEach(async () => {
        vi.clearAllMocks();

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
        vi.clearAllMocks();
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
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});

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
            expect(mockDbRun).toHaveBeenCalledWith(expect.objectContaining({
                __kind: 'delete',
                where: { outcomeSource: null }
            }));
            expect(mockDbDeploy).not.toHaveBeenCalled();
            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'ws://localhost:9944',
                requestTimeout: 30000
            }));
            expect(logSpy).toHaveBeenCalledWith('Initializing crawler and starting catch-up...');
            expect(logSpy).toHaveBeenCalledWith('Startup state: syncing (crawler started)');
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
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        (cds.env as any).requires.nightgate.crawler = { enabled: false };

        try {
            const status = await initialize();

            expect(mockStartCrawler).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith('Startup state: stopped (crawler disabled)');
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
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(cds.log('nightgate'), 'warn').mockImplementation(() => {});
        mockStartCrawler.mockRejectedValue(new Error('ECONNREFUSED: connect'));

        try {
            const status = await initialize();

            expect(warnSpy).toHaveBeenCalledWith('Node not reachable at ws://localhost:9944: ECONNREFUSED: connect');
            expect(logSpy).toHaveBeenCalledWith('Startup state: offline (node unreachable)');
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
        // Same module graph as the initialize() under test: a native
        // require() would yield a different class identity for instanceof.
        const { SchemaNotDeployedError } = await import('../../src/index.js');

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
        expect(getStatus()).toEqual(expect.objectContaining({
            initialized: false,
            crawlerEnabled: true,
            network: 'testnet',
            nodeUrl: 'ws://localhost:9944',
            mode: 'offline',
            lastError: expect.stringContaining('midnight.SyncState')
        }));

        // Crucially: no deploy was attempted, on either path.
        expect(mockDbDeploy).not.toHaveBeenCalled();
        expect(mockCdsDeploy).not.toHaveBeenCalled();
        // Crawler also never started; we fail before any subsequent init step.
        expect(mockStartCrawler).not.toHaveBeenCalled();
    });

    it('fails closed before schema or worker startup when multiple replicas are declared', async () => {
        process.env.NIGHTGATE_REPLICA_COUNT = '2';

        const err = await initialize().catch(e => e);

        expect(err.name).toBe('UnsupportedRuntimeTopologyError');
        expect(err.message).toMatch(/replicaCount is 2/);
        expect(mockDbRun).not.toHaveBeenCalled();
        expect(mockStartCrawler).not.toHaveBeenCalled();
        expect(getStatus()).toEqual(expect.objectContaining({
            initialized: false,
            mode: 'offline',
            runtimeMode: 'single-instance',
            replicaCount: 2,
            lastError: expect.stringContaining('replicaCount is 2')
        }));
    });

    it('includes the resolved DB path in the error message', async () => {
        (cds.env as any).requires.db = { credentials: { database: 'db/midnight.db' } };
        mockDbRun.mockRejectedValueOnce(new Error('no such table: midnight_Blocks'));

        await expect(initialize()).rejects.toMatchObject({
            message: expect.stringContaining('db/midnight.db')
        });
    });

    it('uses env overrides for preprod startup even when package config has no network', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
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
            expect(logSpy).toHaveBeenCalledWith('Network: preprod');
            expect(logSpy).toHaveBeenCalledWith('Node: wss://node.example.test');
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
