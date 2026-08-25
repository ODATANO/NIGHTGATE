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
                },
                // The submission bootstrap (job recovery) reads with the
                // plain form. Without it initialize() now reports the
                // submission pipeline as failed, which it would be.
                from: vi.fn((table: unknown) => ({
                    __kind: 'select',
                    __table: table,
                    columns: vi.fn().mockReturnThis(),
                    where: vi.fn().mockReturnThis(),
                    orderBy: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockReturnThis(),
                    groupBy: vi.fn().mockReturnThis()
                }))
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
    __getCacheSizeForTests:            vi.fn(() => 0),
    __clearAllFacadesForTests:         vi.fn()
}));

// The submission bootstrap (job recovery, processor, chain confirmer) is its
// own concern with its own suites. This harness mocks cds.ql minimally on
// purpose, so without these stubs the bootstrap throws and initialize()
// correctly reports the process as offline, which is not what these tests are
// about. mockRecoverJobs is flipped to throwing in one test below to pin
// exactly that path.
const mockRecoverJobs = vi.hoisted(() => (vi.fn(async () => undefined)));
const mockStartJobProcessor = vi.hoisted(() => (vi.fn(async () => undefined)));
vi.mock('../../srv/submission/background-jobs', () => ({
    recoverInterruptedJobs: mockRecoverJobs,
    dropPendingJobsForClosedSessions: vi.fn(async () => 0),
    startBackgroundJobProcessor: mockStartJobProcessor,
    stopBackgroundJobProcessor: vi.fn(async () => undefined),
    registerChainOutcomeConfirmer: vi.fn()
}));

vi.mock('../../srv/sessions/wallet-sessions', () => ({
    closeSessionsFromPreviousProcess: vi.fn(async () => 0)
}));

const mockClearAllEncryptionKeys = vi.hoisted(() => (vi.fn(async () => undefined)));
vi.mock('../../srv/submission/wallet-sync-state-store', () => ({
    clearAllEncryptionKeys: mockClearAllEncryptionKeys
}));

// The network/database binding guard has its own behavioral tests
// (sync-state-network-guard.test.ts, against a fake db). Here it is mocked so
// the fully-mocked cds.ql of this suite does not need the .where chain; one
// test below flips it to throwing to pin initialize()'s fail-closed path.
const mockEnsureSyncStateSingleton = vi.hoisted(() => (vi.fn(async () => undefined)));
vi.mock('../../srv/utils/sync-state', () => ({
    ensureSyncStateSingleton: mockEnsureSyncStateSingleton,
    SyncStateNetworkMismatchError: class SyncStateNetworkMismatchError extends Error {}
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

    it('shutdown zeroes all memoized wallet-storage keys after stopping the worker', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        try {
            await initialize();
            await shutdown();
            expect(mockClearAllEncryptionKeys).toHaveBeenCalledTimes(1);
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

    it('reports offline when the submission pipeline fails to start', async () => {
        // It used to be a log line and nothing else: initialize() carried on,
        // set initialized = true and published active/idle, so a process that
        // could not sign, submit or sponsor anything still answered ready.
        mockStartJobProcessor.mockRejectedValueOnce(new Error('worker thread refused to spawn'));

        const status = await initialize();

        expect(status).toEqual(expect.objectContaining({
            mode: 'offline',
            lastError: expect.stringContaining('submission pipeline did not start')
        }));
        expect(status.lastError).toContain('worker thread refused to spawn');
    });

    it('refuses to start on a database missing a column this release added', async () => {
        const { SchemaNotDeployedError } = await import('../../src/index.js');

        // The probe list carries each release's NEW columns, not just table
        // names: a 0.19 database passes every table probe and would then die
        // on the first connectWallet, which writes WalletSessions.label. It
        // has to fail here instead, with the migration named.
        const probesBeforeWalletSessions = 12;
        for (let i = 0; i < probesBeforeWalletSessions; i++) mockDbRun.mockResolvedValueOnce({});
        mockDbRun.mockRejectedValueOnce(new Error('no such column: label'));

        const err = await initialize().catch(e => e);
        expect(err).toBeInstanceOf(SchemaNotDeployedError);
        expect(err.missingTable).toBe('midnight.WalletSessions (needs columns: label)');
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

    it('fails closed when the database is bound to another network', async () => {
        mockEnsureSyncStateSingleton.mockRejectedValueOnce(
            new Error("This database is bound to network 'preview'"));

        await expect(initialize()).rejects.toThrow(/bound to network 'preview'/);
        expect(mockStartCrawler).not.toHaveBeenCalled();
        expect(getStatus()).toEqual(expect.objectContaining({
            initialized: false,
            mode: 'offline',
            lastError: expect.stringContaining("bound to network 'preview'")
        }));
    });
});
