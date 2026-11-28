const mockDbRun = vi.fn();
const mockDbDeploy = vi.fn();
const mockCdsDeployTo = vi.fn();
const mockCdsDeploy = vi.hoisted(() => (vi.fn()));
const mockConnectTo = vi.hoisted(() => (vi.fn()));
const mockStartCrawler = vi.hoisted(() => (vi.fn()));
const mockPendingReindexHeight = vi.hoisted(() => (vi.fn()));
const mockStartReindex = vi.hoisted(() => (vi.fn()));
const mockStopCrawler = vi.hoisted(() => (vi.fn()));
const selectFromSpy = vi.hoisted(() => (vi.fn()));
const TABLE_COLUMNS = vi.hoisted((): Record<string, string[]> => ({}));
const catalog = (query: unknown, columns: Record<string, string[]> = TABLE_COLUMNS) => {
    const table = typeof query === 'string' ? /pragma_table_info\('(\w+)'\)/.exec(query)?.[1] : undefined;
    return table === undefined ? undefined : (columns[table] ?? []).map(name => ({ name }));
};
const ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_CRAWLER_ENABLED',
    'NIGHTGATE_REPLICA_COUNT',
    'NIGHTGATE_INDEXER_HTTP_URL',
    'NIGHTGATE_INDEXER_WS_URL'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    kind: 'nightgate',
                    network: 'undeployed',
                    nodeUrl: 'ws://localhost:9944'
                }
            }
        },
        connect: {
            to: mockConnectTo
        },
        model: {
            *each() {
                yield { name: 'midnight.Blocks', elements: { ID: { name: 'ID' }, height: { name: 'height' } } };
                yield { name: 'midnight.WalletSessions', elements: { sessionId: { name: 'sessionId' }, label: { name: 'label' } } };
            }
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
                // plain form. Without it initialize() reports the
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

vi.mock('../../srv/crawler/reindex', () => ({
    pendingReindexHeight: mockPendingReindexHeight,
    startReindex: mockStartReindex
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
const mockStopJobProcessor = vi.hoisted(() => (vi.fn(async () => undefined)));
vi.mock('../../srv/submission/background-jobs', () => ({
    recoverInterruptedJobs: mockRecoverJobs,
    dropPendingJobsForClosedSessions: vi.fn(async () => 0),
    startBackgroundJobProcessor: mockStartJobProcessor,
    stopBackgroundJobProcessor: mockStopJobProcessor,
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

// The retirement has its own test against a real database (swap-offers.test.ts).
const mockRetireOffers = vi.hoisted(() => (vi.fn(async (..._args: unknown[]) => 0)));
vi.mock('../../srv/submission/swap-offers', () => ({
    retireOffersForOneTaker: mockRetireOffers
}));

// Both steps have their own tests against a real database (nightgate-service.test.ts, column-renames.test.ts).
const mockBackfillOwners = vi.hoisted(() => (vi.fn(async (..._args: unknown[]) => 0)));
const mockSortTxValues = vi.hoisted(() => (vi.fn(async (..._args: unknown[]) => 0)));
const mockRenameActions = vi.hoisted(() => (vi.fn(async (..._args: unknown[]) => 0)));
vi.mock('../../srv/submission/job-store', () => ({
    backfillRowOwners: mockBackfillOwners,
    sortStoredTxValues: mockSortTxValues,
    renameStoredActions: mockRenameActions,
    renameStoredErrorCodes: vi.fn(async () => 0),
    moveStoredDiffCounts: vi.fn(async () => 0)
}));

// The lease has its own tests against a real database (instance-lease.test.ts).
const mockAcquireLease = vi.hoisted(() => (vi.fn(async (..._args: unknown[]) => undefined)));
const mockReleaseLease = vi.hoisted(() => (vi.fn(async () => undefined)));
const mockFence = vi.hoisted(() => (vi.fn()));
const leaseLost = vi.hoisted(() => ({ fire: undefined as undefined | (() => void) }));
vi.mock('../../srv/utils/instance-lease', () => ({
    BACKGROUND_LEASE_ROLE: 'background',
    acquireInstanceLease: mockAcquireLease,
    releaseInstanceLease: mockReleaseLease,
    setActiveLease: vi.fn(),
    clearActiveLease: vi.fn(),
    fenceBackgroundWork: mockFence,
    isBackgroundFenced: vi.fn(() => false),
    startInstanceLeaseHeartbeat: vi.fn((_db: unknown, _role: unknown, _holder: unknown, _ms: unknown, onLost: () => void) => {
        leaseLost.fire = onLost;
        return () => undefined;
    })
}));

import cds from '@sap/cds';
import { getStatus, initialize, shutdown } from '../../src/index';
import { stopWalletWorker } from '../../srv/midnight/wallet-worker-client';

describe('runtime initialize', () => {
    beforeEach(async () => {
        vi.clearAllMocks();

        for (const key of ENV_KEYS) {
            delete process.env[key];
        }

        (cds.env as any).requires = {
            nightgate: {
                kind: 'nightgate',
                network: 'undeployed',
                nodeUrl: 'ws://localhost:9944'
            }
        };

        Object.assign(TABLE_COLUMNS, { midnight_Blocks: ['ID', 'height'], midnight_WalletSessions: ['sessionId', 'label'] });
        mockDbRun.mockImplementation(async (query: unknown) => catalog(query) ?? {});
        mockDbDeploy.mockResolvedValue(undefined);
        mockCdsDeployTo.mockResolvedValue(undefined);
        mockCdsDeploy.mockReturnValue({ to: mockCdsDeployTo });
        mockConnectTo.mockResolvedValue({ run: mockDbRun, deploy: mockDbDeploy });
        mockStartCrawler.mockResolvedValue(undefined);
        mockPendingReindexHeight.mockResolvedValue(null);
        mockStartReindex.mockReset();
        mockStopCrawler.mockResolvedValue(undefined);

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

    it('finishes an interrupted reindex before the crawler starts', async () => {
        mockPendingReindexHeight.mockResolvedValue(1234);
        mockStartReindex.mockResolvedValue(undefined);

        await initialize();

        expect(mockStartCrawler).not.toHaveBeenCalled();
        expect(mockStartReindex.mock.calls[0][1]).toBe(1234);
        const crawler = mockStartReindex.mock.calls[0][2];
        await expect(crawler.stop()).resolves.toBe(true);
        await crawler.start();
        expect(mockStartCrawler).toHaveBeenCalledTimes(1);
    });

    it('connects the DB and starts the crawler', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});

        try {
            const status = await initialize();

            expect(mockConnectTo).toHaveBeenCalledWith('db');
            expect(mockDbRun).toHaveBeenNthCalledWith(1, expect.stringContaining("pragma_table_info('midnight_Blocks')"));
            expect(mockDbRun).toHaveBeenNthCalledWith(2, expect.stringContaining("pragma_table_info('midnight_WalletSessions')"));
            expect(mockDbDeploy).not.toHaveBeenCalled();
            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'ws://localhost:9944'
            }));
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
            expect(mockAcquireLease).toHaveBeenCalledTimes(1);
            expect(mockReleaseLease).toHaveBeenCalledWith(expect.anything(), 'background', mockAcquireLease.mock.calls[0]?.[2]);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('shutdown stops the wallet worker while the crawler is still stopping', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        try {
            await initialize();
            let finishCrawler: () => void = () => {};
            mockStopCrawler.mockReturnValueOnce(new Promise<void>(resolve => { finishCrawler = resolve; }));
            const stopping = shutdown();
            await new Promise(r => setImmediate(r));
            expect(stopWalletWorker).toHaveBeenCalledTimes(1);
            expect(mockClearAllEncryptionKeys).not.toHaveBeenCalled();
            finishCrawler();
            await stopping;
            expect(mockClearAllEncryptionKeys).toHaveBeenCalledTimes(1);
        } finally {
            logSpy.mockRestore();
        }
    });

    it('returns idle mode when the crawler is disabled', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        (cds.env as any).requires.nightgate.crawler = { enabled: false };

        try {
            const status = await initialize();

            expect(mockStartCrawler).not.toHaveBeenCalled();
            expect(status).toEqual(expect.objectContaining({
                initialized: true,
                crawlerEnabled: false,
                mode: 'idle'
            }));
        } finally {
            logSpy.mockRestore();
        }
    });

    it('reports offline when crawler startup fails with a node error', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(cds.log('nightgate'), 'warn').mockImplementation(() => {});
        mockStartCrawler.mockRejectedValue(new Error('ECONNREFUSED: connect'));

        try {
            const status = await initialize();

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

        // Blocks is there, WalletSessions is not. No deploy attempt, no crawler start.
        mockDbRun.mockImplementation(async (query: unknown) => catalog(query, { midnight_Blocks: ['ID', 'height'] }) ?? {});

        const err = await initialize().catch(e => e);
        expect(err).toBeInstanceOf(SchemaNotDeployedError);
        expect(err.missingTable).toBe('midnight.WalletSessions');
        expect(err.message).toMatch(/npm run deploy/);
        expect(getStatus()).toEqual(expect.objectContaining({
            initialized: false,
            crawlerEnabled: true,
            network: 'undeployed',
            nodeUrl: 'ws://localhost:9944',
            mode: 'offline',
            lastError: expect.stringContaining('midnight.WalletSessions')
        }));

        // Crucially: no deploy was attempted, on either path.
        expect(mockDbDeploy).not.toHaveBeenCalled();
        expect(mockCdsDeploy).not.toHaveBeenCalled();
        // Crawler also never started; we fail before any subsequent init step.
        expect(mockStartCrawler).not.toHaveBeenCalled();
    });

    it('reports offline when the submission pipeline fails to start', async () => {
        // A failed submission bootstrap must not leave initialize() publishing
        // active/idle: a process that cannot sign, submit or sponsor anything
        // must not answer ready.
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

        // A database of an earlier release has the table without the new column. It fails here, not at the first write.
        mockDbRun.mockImplementation(async (query: unknown) => catalog(query, { midnight_Blocks: ['ID', 'height'], midnight_WalletSessions: ['sessionId'] }) ?? {});

        const err = await initialize().catch(e => e);
        expect(err).toBeInstanceOf(SchemaNotDeployedError);
        expect(err.missingTable).toBe('midnight.WalletSessions (needs columns: label)');
        expect(mockStartCrawler).not.toHaveBeenCalled();
    });

    it('refuses to start on a database whose wallet sessions still have their former key column', async () => {
        const { SchemaNotDeployedError } = await import('../../src/index.js');
        mockDbRun.mockImplementation(async (query: unknown) => catalog(query, { midnight_Blocks: ['ID', 'height'], midnight_WalletSessions: ['ID', 'sessionId', 'label'] }) ?? {});

        const err = await initialize().catch(e => e);
        expect(err).toBeInstanceOf(SchemaNotDeployedError);
        expect(err.missingTable).toBe('midnight.WalletSessions (its key is sessionId)');
        expect(err.message).toContain('the former key column ID is still there');
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
        mockDbRun.mockImplementation(async (query: unknown) => catalog(query, {}) ?? {});

        await expect(initialize()).rejects.toMatchObject({
            message: expect.stringContaining('db/midnight.db')
        });
    });

    it('uses env overrides for preprod startup even when package config has no network', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        delete (cds.env as any).requires.nightgate.network;
        process.env.NIGHTGATE_NETWORK = 'preprod';
        process.env.NIGHTGATE_NODE_URL = 'wss://node.example.test';
        process.env.NIGHTGATE_INDEXER_HTTP_URL = 'https://indexer.example.test/api/v4/graphql';
        process.env.NIGHTGATE_CRAWLER_NODE_URL = 'wss://crawler.example.test';

        try {
            const status = await initialize();

            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'wss://crawler.example.test'
            }));
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

    it('a lease taken over later fences the process, stops the loops and reports offline', async () => {
        const logSpy = vi.spyOn(cds.log('nightgate'), 'info').mockImplementation(() => {});
        const errSpy = vi.spyOn(cds.log('nightgate'), 'error').mockImplementation(() => {});
        try {
            await initialize();
            mockStopJobProcessor.mockClear();
            mockStopCrawler.mockClear();
            leaseLost.fire!();
            expect(mockFence).toHaveBeenCalledTimes(1);
            expect(mockStopJobProcessor).toHaveBeenCalledTimes(1);
            expect(mockStopCrawler).toHaveBeenCalledTimes(1);
            expect(getStatus()).toEqual(expect.objectContaining({ mode: 'offline', lastError: expect.stringMatching(/lease/) }));
        } finally {
            logSpy.mockRestore();
            errSpy.mockRestore();
        }
    });

    it('fails closed before recovery and job loops when another process holds the lease', async () => {
        mockAcquireLease.mockRejectedValueOnce(new Error('another NIGHTGATE instance (host-a/1) runs the background work on this database'));

        await expect(initialize()).rejects.toThrow(/another NIGHTGATE instance/);
        expect(mockRecoverJobs).not.toHaveBeenCalled();
        expect(mockStartJobProcessor).not.toHaveBeenCalled();
        expect(mockStartCrawler).not.toHaveBeenCalled();
        expect(getStatus()).toEqual(expect.objectContaining({ initialized: false, mode: 'offline' }));
        // A process that does not hold the lease only reads: no index is created, no row deleted.
        const writes = mockDbRun.mock.calls.map(([q]) => q).filter((q) => (typeof q === 'string' && /^\s*(CREATE|DROP)/i.test(q)) || q?.DELETE || q?.INSERT || q?.UPDATE);
        expect(writes).toEqual([]);
        expect(mockRetireOffers).not.toHaveBeenCalled();
        expect(mockBackfillOwners).not.toHaveBeenCalled();
        expect(mockSortTxValues).not.toHaveBeenCalled();
        expect(mockRenameActions).not.toHaveBeenCalled();
    });

    it('retires the offers posted for one taker, sorts stored transaction values and records row owners only after it holds the lease', async () => {
        await initialize();
        for (const step of [mockRetireOffers, mockRenameActions, mockSortTxValues, mockBackfillOwners]) {
            expect(step).toHaveBeenCalledTimes(1);
            expect(mockAcquireLease.mock.invocationCallOrder[0]).toBeLessThan(step.mock.invocationCallOrder[0]);
        }
    });

    it('creates the indexes only after it holds the lease', async () => {
        await initialize();
        const firstIndex = mockDbRun.mock.calls.findIndex(([q]) => typeof q === 'string' && /^\s*CREATE (UNIQUE )?INDEX/i.test(q));
        expect(firstIndex).toBeGreaterThanOrEqual(0);
        expect(mockAcquireLease.mock.invocationCallOrder[0]).toBeLessThan(mockDbRun.mock.invocationCallOrder[firstIndex]);
    });

    it('stays offline when the database cannot be prepared', async () => {
        mockRenameActions.mockRejectedValueOnce(new Error('database is locked'));

        await expect(initialize()).rejects.toThrow(/database is locked/);
        expect(mockRecoverJobs).not.toHaveBeenCalled();
        expect(mockStartJobProcessor).not.toHaveBeenCalled();
        expect(mockStartCrawler).not.toHaveBeenCalled();
        expect(getStatus()).toEqual(expect.objectContaining({ initialized: false, mode: 'offline', lastError: 'database is locked' }));
    });
});
