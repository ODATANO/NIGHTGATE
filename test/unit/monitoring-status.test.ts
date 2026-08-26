/**
 * srv/monitoring/status.ts: the builders behind BOTH the OData status
 * functions and the plain /health, /ready and /metrics routes, plus the two
 * new reads (getRuntimeInfo, getWorkerStatus).
 */

const selectOneWhereSpy = vi.hoisted(() => vi.fn());
const selectColumnsWhereSpy = vi.hoisted(() => vi.fn());
const mockDbRun = vi.hoisted(() => vi.fn());

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                one: { from: vi.fn().mockReturnValue({ where: selectOneWhereSpy }) },
                // The job gauges aggregate in SQL: .columns().where().groupBy(),
                // and the oldest-pending read stops after .where().
                from: vi.fn().mockReturnValue({
                    columns: vi.fn().mockReturnValue({
                        where: (...args: unknown[]) => {
                            selectColumnsWhereSpy(...args);
                            return { groupBy: vi.fn() };
                        }
                    })
                })
            }
        }
    };
    cds.default = cds;
    return cds;
});

const mockTopology = vi.hoisted(() => vi.fn());
vi.mock('../../srv/utils/runtime-topology', () => ({ getRuntimeTopology: mockTopology }));

const mockListContracts = vi.hoisted(() => vi.fn());
const mockGetRegistration = vi.hoisted(() => vi.fn());
const mockGetDigest = vi.hoisted(() => vi.fn());
const mockGetCurrentDigest = vi.hoisted(() => vi.fn());
vi.mock('../../srv/submission/contract-registry', () => ({
    listRegisteredContracts: mockListContracts,
    getContractRegistration: mockGetRegistration,
    getArtifactGenerationDigest: mockGetDigest,
    getCurrentArtifactDigest: mockGetCurrentDigest,
    slotWidthOf: (reg: any) => reg?.slotWidth ?? 16
}));

const mockWorkerStatus = vi.hoisted(() => vi.fn());
vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    getWalletWorkerStatus: mockWorkerStatus
}));

// Readiness reads the plugin's initialisation state from the flat holder in
// srv/utils, which src/index publishes into. No cycle, no SDK graph.
const mockGetStatus = vi.hoisted(() => vi.fn(() => ({ initialized: true, mode: 'active' })));
vi.mock('../../srv/utils/runtime-state', () => ({ readRuntimeState: mockGetStatus }));

const mockListFacades = vi.hoisted(() => vi.fn(() => [] as string[]));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({ listWalletFacades: mockListFacades }));

const mockPluginConfig = vi.hoisted(() => vi.fn(() => ({})));
const mockRuntimeConfig = vi.hoisted(() => vi.fn(() => ({ crawlerConfig: { enabled: true } })));
vi.mock('../../srv/utils/nightgate-config', () => ({
    getNightgatePluginConfig: mockPluginConfig,
    resolveNightgateRuntimeConfig: mockRuntimeConfig,
    getConfiguredNightgateNetwork: () => 'preprod',
    resolveEffectiveProvingMode: () => 'wasm'
}));

import { describe, it, expect, beforeEach } from 'vitest';
import {
    buildHealth,
    buildLiveness,
    buildMetricsText,
    buildReadiness,
    buildRuntimeInfo,
    buildWorkerStatus
} from '../../srv/monitoring/status';

const db = { run: mockDbRun } as any;

const TOPOLOGY = {
    valid: true,
    instanceId: 'inst-1',
    runtimeMode: 'single-instance',
    replicaCount: 1,
    databaseKind: 'sqlite',
    errors: [] as string[],
    warnings: [] as string[]
};

const WORKER = {
    started: true,
    running: true,
    inFlightRpcs: 0,
    exitCount: 0,
    rotationCount: 0,
    lastExitCode: null,
    lastExitAt: null,
    rpcTimeoutMs: 1_800_000,
    facades: []
};

beforeEach(() => {
    vi.clearAllMocks();
    mockTopology.mockReturnValue({ ...TOPOLOGY });
    mockWorkerStatus.mockReturnValue({ ...WORKER });
    mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: true } });
    mockListContracts.mockReturnValue([]);
    mockGetStatus.mockReturnValue({ initialized: true, mode: 'active' } as any);
    mockDbRun.mockResolvedValue(null);
});

describe('buildHealth', () => {
    it('coerces the CAP 10 string columns and derives lag', async () => {
        mockDbRun.mockResolvedValueOnce({
            chainHeight: '1000',
            lastIndexedHeight: '940',
            lastFinalizedHeight: '900',
            blocksPerSecond: '2.5',
            syncStatus: 'syncing'
        });
        const health = await buildHealth(db);
        expect(health.chainHeight).toBe(1000);
        expect(health.lag).toBe(60);
        expect(health.finalizedLag).toBe(100);
        expect(health.blocksPerSecond).toBe(2.5);
        // 60 blocks behind is degraded, not unhealthy (the wall is 100).
        expect(health.status).toBe('degraded');
    });

    it('never reports a negative lag when the indexer is ahead of a stale chain height', async () => {
        mockDbRun.mockResolvedValueOnce({ chainHeight: '10', lastIndexedHeight: '12' });
        expect((await buildHealth(db)).lag).toBe(0);
    });

    it('answers `unknown` rather than throwing when there is no sync state row', async () => {
        const health = await buildHealth(db);
        expect(health.status).toBe('unknown');
        expect(health.chainHeight).toBe(0);
    });
});

describe('buildReadiness', () => {
    it('passes crawler and node as not-applicable when the crawler is disabled', async () => {
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });
        const readiness = await buildReadiness(db);
        expect(readiness.crawlerEnabled).toBe(false);
        expect(readiness.ready).toBe(true);
        expect(readiness.checks).toMatchObject({ crawler: true, node: true, database: true });
    });

    it('is not ready when the database read fails', async () => {
        mockDbRun.mockRejectedValueOnce(new Error('no such table'));
        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(false);
        expect((readiness.checks as any).database).toBe(false);
    });

    it('is not ready when the crawler is enabled but stopped', async () => {
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });
        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(false);
    });

    it('does NOT gate on the wallet worker, however dead the worker is', async () => {
        // The whole reason getWorkerStatus is its own function: a busy or
        // crashed worker must not take the process out of rotation.
        mockWorkerStatus.mockReturnValue({ ...WORKER, running: false, exitCount: 7 });
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });
        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(true);
        expect(Object.keys(readiness.checks as object)).toEqual([
            'database', 'crawler', 'node', 'runtime', 'initialization'
        ]);
    });

    it('is NOT ready when initialisation failed, even with the crawler disabled', async () => {
        // The case this exists for: an un-migrated database makes the schema
        // preflight put NIGHTGATE offline, while a plain SELECT on the old
        // SyncState table still succeeds. Without the initialisation check the
        // pod took traffic with submission and sessions never wired up.
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockGetStatus.mockReturnValue({
            initialized: false,
            mode: 'offline',
            // The real SchemaNotDeployedError text, path and SQL included.
            lastError:
                'Nightgate schema is not deployed (or out of date): missing table or column for ' +
                "'midnight.WalletSessions (needs columns: label)' in /data/nightgate.db. " +
                'Underlying error: no such column: $W.label in:\nSELECT json_insert(...) FROM midnight_WalletSessions'
        } as any);
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });

        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(false);
        expect((readiness.checks as any).initialization).toBe(false);
        expect(readiness.initializationMode).toBe('offline');

        // The reason travels with the answer, but SANITISED. This payload is
        // reachable anonymously when an operator chooses
        // NIGHTGATE_STATUS_ROUTES=public, and SchemaNotDeployedError carries
        // the absolute database path plus the driver's SQL.
        const warnings = (readiness.runtimeWarnings as string[]).join(' ');
        expect(warnings).toContain('schema is not deployed');
        expect(warnings).toContain('nightgate-schema-delta');
        expect(warnings).not.toContain('/data/nightgate.db');
        expect(warnings).not.toContain('SELECT');
        expect(warnings).not.toContain('label');
    });

    it('is NOT ready while the process has not finished initialising', async () => {
        // The startup phase, SKIP_AUTO_INIT, a host that never started the
        // plugin, and the state after shutdown() all look like mode 'idle'.
        // None of them can serve, so the load-bearing bit is `initialized`,
        // not the mode: a successful crawler-less start publishes
        // initialized:true with the very same 'idle'.
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockGetStatus.mockReturnValue({ initialized: false, mode: 'idle' } as any);
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });

        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(false);
        expect((readiness.checks as any).initialization).toBe(false);
        expect((readiness.runtimeWarnings as string[]).join(' ')).toContain('not completed startup');
    });

    it('is NOT ready when initialize() finished but went offline', async () => {
        // The gap between the two guards: a failed crawler start or a failed
        // submission bootstrap still sets initialized = true and then reports
        // mode 'offline'. Checking only the flag passed those; checking only
        // the mode passed the never-initialised ones.
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockGetStatus.mockReturnValue({
            initialized: true,
            mode: 'offline',
            lastError: 'submission pipeline did not start: worker thread refused to spawn'
        } as any);
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });

        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(false);
        expect((readiness.checks as any).initialization).toBe(false);
        expect((readiness.runtimeWarnings as string[]).join(' ')).toContain('submission pipeline');
    });

    it('is ready after a successful crawler-less start, which also reports idle', async () => {
        mockRuntimeConfig.mockReturnValue({ crawlerConfig: { enabled: false } });
        mockGetStatus.mockReturnValue({ initialized: true, mode: 'idle' } as any);
        mockDbRun.mockResolvedValueOnce({ syncStatus: 'stopped' });

        const readiness = await buildReadiness(db);
        expect(readiness.ready).toBe(true);
        expect((readiness.checks as any).initialization).toBe(true);
    });
});

describe('buildMetricsText', () => {
    it('emits parseable Prometheus text with the job gauges', async () => {
        // The job gauges are SQL aggregates, not a row read: this path is
        // scraped on a schedule, and reading every open job would cost memory
        // proportional to the backlog exactly when a backlog exists.
        mockDbRun
            .mockResolvedValueOnce({ chainHeight: '500', lastIndexedHeight: '480', consecutiveErrors: 2 })
            .mockResolvedValueOnce([
                { status: 'pending', count: 1 },
                { status: 'running', count: 1 },
                { status: 'reconciliation_required', count: 1 }
            ])
            .mockResolvedValueOnce([{ oldest: new Date(Date.now() - 120_000).toISOString() }]);
        const text = await buildMetricsText(db);
        expect(text).toContain('odatano_nightgate_sync_lag 20');
        expect(text).toContain('odatano_nightgate_consecutive_errors 2');
        expect(text).toContain('odatano_nightgate_jobs_queued 1');
        expect(text).toContain('odatano_nightgate_jobs_running 1');
        expect(text).toContain('odatano_nightgate_jobs_reconciliation_required 1');
        expect(text).toMatch(/odatano_nightgate_jobs_oldest_queued_seconds 1\d\d/);
        expect(text.endsWith('\n')).toBe(true);
    });

    it('carries the wallet worker as gauges, so one scrape covers both pipelines', async () => {
        mockWorkerStatus.mockReturnValue({ ...WORKER, running: false, inFlightRpcs: 3, exitCount: 2 });
        const text = await buildMetricsText(db);
        expect(text).toContain('odatano_nightgate_wallet_worker_running 0');
        expect(text).toContain('odatano_nightgate_wallet_worker_inflight_rpcs 3');
        expect(text).toContain('odatano_nightgate_wallet_worker_exits 2');
        expect(text).toContain('odatano_nightgate_wallet_worker_rotations 0');
    });

    it('still answers when the jobs table is unreadable during a schema rollout', async () => {
        mockDbRun
            .mockResolvedValueOnce({ chainHeight: '10', lastIndexedHeight: '10' })
            .mockRejectedValueOnce(new Error('no such table: midnight_BackgroundJobs'));
        const text = await buildMetricsText(db);
        expect(text).toContain('odatano_nightgate_jobs_queued 0');
        expect(text).toContain('odatano_nightgate_chain_height 10');
    });
});

describe('buildRuntimeInfo', () => {
    it('reports the artifact digest per registered contract', () => {
        mockListContracts.mockReturnValue(['attestation-vault', 'attestation-vault-32']);
        mockGetRegistration.mockImplementation((name: string) =>
            name.endsWith('-32') ? { slotWidth: 32, privateStateId: 'ps' } : { privateStateId: 'ps' }
        );
        mockGetDigest.mockImplementation((name: string) => `digest-${name}`);
        mockGetCurrentDigest.mockImplementation((name: string) => `digest-${name}`);

        const info = buildRuntimeInfo();
        expect(info.network).toBe('preprod');
        expect(info.provingMode).toBe('wasm');
        expect(info.contracts).toEqual([
            {
                name: 'attestation-vault',
                artifactDigest: 'digest-attestation-vault',
                currentDigest: 'digest-attestation-vault',
                digestStale: false,
                digestError: null,
                slotWidth: 16,
                privateStateId: 'ps'
            },
            {
                name: 'attestation-vault-32',
                artifactDigest: 'digest-attestation-vault-32',
                currentDigest: 'digest-attestation-vault-32',
                digestStale: false,
                digestError: null,
                slotWidth: 32,
                privateStateId: 'ps'
            }
        ]);
    });

    it('flags a digest the process loaded but no longer matches on disk', () => {
        // The exact failure this endpoint exists to explain. The per-alias
        // digest cache keeps serving the LOADED generation, while
        // resolveContract recomputes uncached and refuses every job, so
        // reporting only the cached value would hide it completely.
        mockListContracts.mockReturnValue(['attestation-vault']);
        mockGetRegistration.mockReturnValue({ privateStateId: 'ps' });
        mockGetDigest.mockReturnValue('loaded-generation');
        mockGetCurrentDigest.mockReturnValue('recompiled-on-disk');

        const contract = (buildRuntimeInfo().contracts as any[])[0];
        expect(contract.artifactDigest).toBe('loaded-generation');
        expect(contract.currentDigest).toBe('recompiled-on-disk');
        expect(contract.digestStale).toBe(true);
    });

    it('reports a contract whose artifact does not load instead of hiding it', () => {
        // This is the case the function exists for: after a recompile under a
        // running server every write job dies on the generation guard, and
        // without this the cause is invisible from outside.
        mockListContracts.mockReturnValue(['broken']);
        mockGetRegistration.mockReturnValue({ privateStateId: 'ps' });
        mockGetDigest.mockImplementation(() => { throw new Error('Cannot find module ./managed/broken'); });

        const contracts = buildRuntimeInfo().contracts as any[];
        expect(contracts[0].artifactDigest).toBeNull();
        expect(contracts[0].digestError).toContain('Cannot find module');
    });

    it('survives a layout where the package version cannot be read', () => {
        mockListContracts.mockReturnValue([]);
        expect(typeof buildRuntimeInfo().version).toBe('string');
    });
});

describe('buildWorkerStatus', () => {
    const withFacade = {
        ...WORKER,
        running: false,
        exitCount: 3,
        lastExitCode: 137,
        lastExitAt: '2026-08-23T10:00:00.000Z',
        facades: [{ sessionId: 'acct-1', label: 'prewarm', caughtUp: false, updatedAt: 'now' }]
    };

    it('passes the worker client state through, exit history included', () => {
        mockWorkerStatus.mockReturnValue(withFacade);
        const status = buildWorkerStatus(true);
        expect(status).toMatchObject({ running: false, exitCount: 3, lastExitCode: 137 });
        expect((status.facades as any[])[0].label).toBe('prewarm');
    });

    it('withholds the per-facade wallet ids from a non-admin caller', () => {
        // facades[].sessionId is the wallet cacheKey, an accountId derived
        // from wallet material and stable across sessions. Handing it to every
        // authenticated caller would leak which wallets this process holds,
        // across tenants.
        mockWorkerStatus.mockReturnValue(withFacade);
        const status = buildWorkerStatus(false);
        expect(status.facades).toEqual([]);
        // The operational signal survives the redaction.
        expect(status.facadeCount).toBe(1);
        expect(status).toMatchObject({ running: false, exitCount: 3 });
    });

    it('gives an admin the full list and the same count', () => {
        mockWorkerStatus.mockReturnValue(withFacade);
        const status = buildWorkerStatus(true);
        expect(status.facadeCount).toBe(1);
        expect((status.facades as any[])[0].sessionId).toBe('acct-1');
    });

    it('counts a resident facade that never reported progress', () => {
        // The worker only pushes a progress snapshot while a sync WAIT runs, so
        // a facade restored from persisted state at the tip reports none at
        // all. Counting snapshots showed `facadeCount: 0` for a sponsor pool
        // that was warm and sponsoring (live on the hosted box).
        mockWorkerStatus.mockReturnValue({ ...WORKER, facades: [] });
        mockListFacades.mockReturnValue(['acct-restored']);
        try {
            const status = buildWorkerStatus(true);
            expect(status.facadeCount).toBe(1);
            expect((status.facades as any[])[0]).toMatchObject({ sessionId: 'acct-restored', caughtUp: null });
        } finally {
            mockListFacades.mockReturnValue([]);
        }
    });

    it('merges progress detail into the resident entry rather than duplicating it', () => {
        mockWorkerStatus.mockReturnValue(withFacade);
        mockListFacades.mockReturnValue(['acct-1']);
        try {
            const status = buildWorkerStatus(true);
            expect(status.facadeCount).toBe(1);
            expect((status.facades as any[])[0].label).toBe('prewarm');
        } finally {
            mockListFacades.mockReturnValue([]);
        }
    });
});

describe('buildLiveness', () => {
    it('answers without touching the database at all', () => {
        const liveness = buildLiveness();
        expect(liveness.status).toBe('alive');
        expect(typeof liveness.uptime).toBe('number');
        expect(mockDbRun).not.toHaveBeenCalled();
    });
});
