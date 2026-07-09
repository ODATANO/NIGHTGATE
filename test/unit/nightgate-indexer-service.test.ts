/**
 * Tests for srv/nightgate-indexer-service.ts.
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/jest.setup.ts). Persistence (SyncState, ReorgLog, Blocks, …) is
 * exercised against the real SQLite DB; the external crawler collaborator stays
 * mocked so startCrawler/stopCrawler/isCrawlerRunning never touch a real node.
 *
 * The CAP framework boots the server during cds.test() and runs each service's
 * init() during the `served` event, so NightgateIndexerService is already
 * initialized and its handlers registered. We connect to the live service and
 * drive it via srv.send(), then assert on the returned payload and/or resulting
 * DB rows.
 */

const mockStartCrawler = jest.fn();
const mockStopCrawler = jest.fn();
const mockIsCrawlerRunning = jest.fn();

// External collaborator: keep mocked. jest.mock is hoisted and applies to the
// framework-loaded service too, so the booted service uses these mocks.
jest.mock('../../srv/crawler', () => ({
    startCrawler: (...args: any[]) => mockStartCrawler(...args),
    stopCrawler: (...args: any[]) => mockStopCrawler(...args),
    isCrawlerRunning: (...args: any[]) => mockIsCrawlerRunning(...args)
}));

import cds from '@sap/cds';

jest.setTimeout(60000);

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Jest's global test()).
cds.test(__dirname + '/../..');

const SYNC_STATE = 'midnight.SyncState';
const REORG_LOG = 'midnight.ReorgLog';
const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const CONTRACT_ACTIONS = 'midnight.ContractActions';

let db: any;
let srv: any;

/** Upsert the SINGLETON SyncState row to a known shape. */
async function setSyncState(fields: Record<string, any>): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', ...fields }));
}

beforeAll(async () => {
    db = await cds.connect.to('db');
    srv = await cds.connect.to('NightgateIndexerService');
});

beforeEach(async () => {
    mockStartCrawler.mockReset();
    mockStopCrawler.mockReset();
    mockIsCrawlerRunning.mockReset();
    mockIsCrawlerRunning.mockReturnValue(false);

    // Reset DB state used by these tests.
    await db.run(cds.ql.DELETE.from(REORG_LOG));
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    // SyncState is created by the service init(); reset it to a clean SINGLETON.
    await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, chainHeight: 0, consecutiveErrors: 0 });
});

// ----------------------------------------------------------------------------
// init / SyncState creation
//
// The framework already ran init() once at boot (creating the SINGLETON row
// from the configured nightgate settings). We assert that behavioral outcome:
// a SINGLETON SyncState row exists and is queryable. The old query-shape
// assertions (__type:'insert', exact networkId/nodeUrl from env/config) are
// reframed to "the row exists and getSyncStatus reflects persisted state",
// since the [test] profile's config (not the old mockEnv) governs the values.
// ----------------------------------------------------------------------------
describe('SyncState initialization', () => {
    it('has created the SINGLETON SyncState row at boot', async () => {
        // Re-create from scratch to prove the singleton key shape works end-to-end.
        await db.run(cds.ql.DELETE.from(SYNC_STATE));
        const { ensureSyncStateSingleton } = require('../../srv/utils/sync-state');
        await ensureSyncStateSingleton(db);

        const row = await db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
        expect(row).toBeTruthy();
        expect(row.ID).toBe('SINGLETON');
        expect(row.syncStatus).toBe('stopped');
        expect(row.consecutiveErrors).toBe(0);
    });
});

describe('getSyncStatus', () => {
    it('returns the persisted sync state', async () => {
        await setSyncState({
            syncStatus: 'synced',
            lastIndexedHeight: 42,
            chainHeight: 50,
            consecutiveErrors: 0
        });

        const result = await srv.send('getSyncStatus');
        expect(result).toEqual(expect.objectContaining({
            syncStatus: 'synced',
            lastIndexedHeight: 42,
            chainHeight: 50
        }));
    });

    it('returns stopped defaults when SyncState is absent', async () => {
        await db.run(cds.ql.DELETE.from(SYNC_STATE));

        const result = await srv.send('getSyncStatus');
        expect(result).toEqual(expect.objectContaining({
            ID: 'SINGLETON',
            syncStatus: 'stopped',
            lastIndexedHeight: 0,
            chainHeight: 0,
            consecutiveErrors: 0
        }));
    });
});

describe('getHealth', () => {
    it('returns unknown defaults when SyncState is absent', async () => {
        await db.run(cds.ql.DELETE.from(SYNC_STATE));

        const result = await srv.send('getHealth');
        expect(result).toEqual({
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

    it('reports healthy status and clamps negative lag to zero', async () => {
        await setSyncState({
            chainHeight: 8,
            lastIndexedHeight: 12,
            lastFinalizedHeight: 10,
            blocksPerSecond: 0
            // syncStatus left at default 'stopped'
        });

        const result = await srv.send('getHealth');
        expect(result).toEqual(expect.objectContaining({
            status: 'healthy',
            lag: 0,
            finalizedLag: 0,
            syncStatus: 'stopped'
        }));
    });

    it('reports degraded status when lag exceeds 10 blocks', async () => {
        await setSyncState({
            chainHeight: 25,
            lastIndexedHeight: 12,
            lastFinalizedHeight: 20,
            blocksPerSecond: 1.5,
            syncStatus: 'syncing'
        });

        const result = await srv.send('getHealth');
        expect(result).toEqual(expect.objectContaining({
            status: 'degraded',
            lag: 13,
            finalizedLag: 5,
            blocksPerSecond: 1.5
        }));
    });

    it('reports unhealthy status when lag exceeds 100 blocks', async () => {
        await setSyncState({
            chainHeight: 250,
            lastIndexedHeight: 100,
            lastFinalizedHeight: 150,
            blocksPerSecond: 0,
            syncStatus: 'error'
        });

        const result = await srv.send('getHealth');
        expect(result).toEqual(expect.objectContaining({
            status: 'unhealthy',
            lag: 150,
            finalizedLag: 100,
            syncStatus: 'error'
        }));
    });
});

describe('getReorgHistory', () => {
    async function seedReorgs(...entries: Array<{ detectedAt: string; forkHeight: number; oldTipHash: string; newTipHash: string }>): Promise<void> {
        await db.run(cds.ql.INSERT.into(REORG_LOG).entries(entries.map(e => ({
            ID: cds.utils.uuid(),
            ...e
        }))));
    }

    it('returns reorg history ordered by newest first and honors a custom limit', async () => {
        const older = new Date(Date.now() - 60_000).toISOString();
        const newer = new Date().toISOString();
        await seedReorgs(
            { detectedAt: older, forkHeight: 5, oldTipHash: '0xold1', newTipHash: '0xnew1' },
            { detectedAt: newer, forkHeight: 9, oldTipHash: '0xold2', newTipHash: '0xnew2' }
        );

        const result = await srv.send({ event: 'getReorgHistory', data: { limit: 25 } });
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(2);
        // Newest first.
        expect(result[0].forkHeight).toBe(9);
        expect(result[1].forkHeight).toBe(5);
    });

    it('caps the number of returned rows to the requested limit', async () => {
        const base = Date.now();
        await seedReorgs(
            ...Array.from({ length: 5 }, (_, i) => ({
                detectedAt: new Date(base - i * 1000).toISOString(),
                forkHeight: i,
                oldTipHash: `0xold${i}`,
                newTipHash: `0xnew${i}`
            }))
        );

        const result = await srv.send({ event: 'getReorgHistory', data: { limit: 2 } });
        expect(result.length).toBe(2);
    });

    it('uses the default reorg history limit when no limit is provided', async () => {
        // Seed more than the default (10) to prove the default cap applies.
        const base = Date.now();
        await seedReorgs(
            ...Array.from({ length: 12 }, (_, i) => ({
                detectedAt: new Date(base - i * 1000).toISOString(),
                forkHeight: i,
                oldTipHash: `0xold${i}`,
                newTipHash: `0xnew${i}`
            }))
        );

        const result = await srv.send({ event: 'getReorgHistory', data: {} });
        expect(result.length).toBe(10);
    });

    it('returns an empty array when there is no reorg history', async () => {
        const result = await srv.send({ event: 'getReorgHistory', data: {} });
        expect(result).toEqual([]);
    });
});

describe('getLiveness', () => {
    it('returns liveness with an ISO timestamp and non-negative uptime', async () => {
        const result = await srv.send('getLiveness');
        expect(result.status).toBe('alive');
        expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
        expect(result.uptime).toBeGreaterThanOrEqual(0);
    });
});

describe('getReadiness', () => {
    it('returns false when SyncState is missing after the database check', async () => {
        await db.run(cds.ql.DELETE.from(SYNC_STATE));

        const result = await srv.send('getReadiness');
        expect(result).toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: false,
                node: false
            }
        });
    });

    it('reports database:false (and all checks false) when the readiness DB read throws', async () => {
        // The service's this.db is the same memoized 'db' connection used here,
        // so spying its run() drives the catch{} branch in getReadiness
        // (srv/nightgate-indexer-service.ts). Restored immediately after.
        const runSpy = jest.spyOn(db, 'run').mockImplementation(() => Promise.reject(new Error('db down')));
        try {
            const result = await srv.send('getReadiness');
            expect(result).toEqual({
                ready: false,
                checks: {
                    database: false,
                    crawler: false,
                    node: false
                }
            });
        } finally {
            runSpy.mockRestore();
        }
    });

    it('returns ready when crawler is active and node activity is fresh', async () => {
        await setSyncState({
            syncStatus: 'synced',
            lastIndexedAt: new Date().toISOString()
        });

        const result = await srv.send('getReadiness');
        expect(result).toEqual({
            ready: true,
            checks: {
                database: true,
                crawler: true,
                node: true
            }
        });
    });

    it('reports stale node activity separately from crawler readiness', async () => {
        await setSyncState({
            syncStatus: 'syncing',
            lastIndexedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        });

        const result = await srv.send('getReadiness');
        expect(result).toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: true,
                node: false
            }
        });
    });

    it('keeps crawler false when syncStatus is stopped', async () => {
        await setSyncState({
            syncStatus: 'stopped',
            lastIndexedAt: new Date().toISOString()
        });

        const result = await srv.send('getReadiness');
        expect(result).toEqual({
            ready: false,
            checks: {
                database: true,
                crawler: false,
                node: true
            }
        });
    });
});

describe('getMetrics', () => {
    it('renders Prometheus metrics for sync state and error status', async () => {
        await setSyncState({
            chainHeight: 120,
            lastIndexedHeight: 100,
            blocksPerSecond: 3.5,
            consecutiveErrors: 2,
            syncStatus: 'error'
        });

        const result: string = await srv.send('getMetrics');
        expect(result).toContain('odatano_nightgate_chain_height 120');
        expect(result).toContain('odatano_nightgate_indexed_height 100');
        expect(result).toContain('odatano_nightgate_sync_lag 20');
        expect(result).toContain('odatano_nightgate_blocks_per_second 3.5');
        expect(result).toContain('odatano_nightgate_consecutive_errors 2');
        expect(result).toContain('odatano_nightgate_sync_status 3');
        expect(result.endsWith('\n')).toBe(true);
    });

    it('falls back to zero values when sync state is absent or unknown', async () => {
        await db.run(cds.ql.DELETE.from(SYNC_STATE));

        const result: string = await srv.send('getMetrics');
        expect(result).toContain('odatano_nightgate_chain_height 0');
        expect(result).toContain('odatano_nightgate_indexed_height 0');
        expect(result).toContain('odatano_nightgate_sync_lag 0');
        expect(result).toContain('odatano_nightgate_sync_status 0');
    });

    it('maps unknown sync statuses to zero', async () => {
        await setSyncState({
            chainHeight: 5,
            lastIndexedHeight: 7,
            blocksPerSecond: 0,
            consecutiveErrors: 0,
            syncStatus: 'mystery'
        });

        const result: string = await srv.send('getMetrics');
        expect(result).toContain('odatano_nightgate_sync_lag -2');
        expect(result).toContain('odatano_nightgate_sync_status 0');
    });
});

describe('pauseCrawler', () => {
    it('returns no-op status when crawler is already paused', async () => {
        mockIsCrawlerRunning.mockReturnValue(false);

        const result = await srv.send('pauseCrawler');
        expect(result).toEqual({
            status: 'ok',
            running: false,
            message: 'Crawler is already paused'
        });
        expect(mockStopCrawler).not.toHaveBeenCalled();
    });

    it('stops the crawler and marks sync state as stopped', async () => {
        await setSyncState({ syncStatus: 'syncing', lastIndexedHeight: 5, chainHeight: 5 });
        mockIsCrawlerRunning.mockReturnValue(true);
        mockStopCrawler.mockResolvedValueOnce(undefined);

        const result = await srv.send('pauseCrawler');
        expect(result).toEqual({
            status: 'ok',
            running: false,
            message: 'Crawler paused'
        });
        expect(mockStopCrawler).toHaveBeenCalledTimes(1);

        // Behavioral: the SINGLETON row was actually flipped to 'stopped'.
        const row = await db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
        expect(row.syncStatus).toBe('stopped');
    });
});

describe('resumeCrawler', () => {
    it('starts crawler with configured runtime values', async () => {
        mockIsCrawlerRunning.mockReturnValue(false);
        mockStartCrawler.mockResolvedValueOnce(undefined);

        const result = await srv.send('resumeCrawler');
        expect(result).toEqual({
            status: 'ok',
            running: true,
            message: 'Crawler resumed'
        });
        // Crawler stays mocked: assert it was invoked with a resolved runtime config.
        expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            nodeUrl: expect.any(String),
            requestTimeout: 30000
        }));
    });

    it('reports already-running without starting the crawler again', async () => {
        mockIsCrawlerRunning.mockReturnValue(true);

        const result = await srv.send('resumeCrawler');
        expect(result).toEqual({
            status: 'ok',
            running: true,
            message: 'Crawler already running'
        });
        expect(mockStartCrawler).not.toHaveBeenCalled();
    });

    it('rejects when startup fails', async () => {
        mockIsCrawlerRunning.mockReturnValue(false);
        mockStartCrawler.mockRejectedValueOnce(new Error('node offline'));

        await expect(srv.send('resumeCrawler')).rejects.toMatchObject({
            message: expect.stringContaining('Failed to resume crawler: node offline')
        });
    });
});

describe('reindexFromHeight', () => {
    it('rejects invalid heights', async () => {
        await expect(
            srv.send({ event: 'reindexFromHeight', data: { height: -1 } })
        ).rejects.toMatchObject({
            message: expect.stringContaining('height must be a non-negative integer')
        });
    });

    it('reports effective start height when no rollback is required', async () => {
        // Seed a block below the requested height so the fork-block lookup finds it.
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: cds.utils.uuid(),
            hash: '0x9',
            height: 9,
            protocolVersion: 1,
            timestamp: 1700000000,
            ledgerParameters: '0xabcd'
        }));
        mockIsCrawlerRunning.mockReturnValue(false);

        const result = await srv.send({ event: 'reindexFromHeight', data: { height: 10 } });
        expect(result).toEqual({
            status: 'ok',
            message: 'Reindex prepared',
            requestedHeight: 10,
            effectiveStartHeight: 10,
            blocksRolledBack: 0,
            transactionsRolledBack: 0,
            crawlerResumed: false
        });
        expect(mockStopCrawler).not.toHaveBeenCalled();
    });

    it('rolls back blocks at or above the requested height and updates SyncState', async () => {
        // Behavioral coverage of the rollback path: seed blocks 8,9,10,11 and a tx
        // on block 10, then reindex from height 10.
        const blockIds: Record<number, string> = {};
        for (const h of [8, 9, 10, 11]) {
            const id = cds.utils.uuid();
            blockIds[h] = id;
            await db.run(cds.ql.INSERT.into(BLOCKS).entries({
                ID: id,
                hash: `0x${h}`,
                height: h,
                protocolVersion: 1,
                timestamp: 1700000000 + h,
                ledgerParameters: '0xabcd'
            }));
        }
        const txId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
            ID: txId,
            transactionId: 0,
            hash: '0xtx10',
            protocolVersion: 1,
            transactionType: 'Regular',
            block_ID: blockIds[10]
        }));

        await setSyncState({ syncStatus: 'syncing', lastIndexedHeight: 11, chainHeight: 11 });
        mockIsCrawlerRunning.mockReturnValue(false);

        const result = await srv.send({ event: 'reindexFromHeight', data: { height: 10 } });
        expect(result).toMatchObject({
            status: 'ok',
            requestedHeight: 10,
            effectiveStartHeight: 10, // fork block height 9 + 1
            blocksRolledBack: 2,      // heights 10 and 11
            transactionsRolledBack: 1,
            crawlerResumed: false
        });

        // Behavioral: blocks 10/11 and their tx are gone; 8/9 remain.
        const remaining = await db.run(cds.ql.SELECT.from(BLOCKS).columns('height'));
        const heights = remaining.map((b: any) => Number(b.height)).sort((a: number, b: number) => a - b);
        expect(heights).toEqual([8, 9]);

        const txs = await db.run(cds.ql.SELECT.from(TRANSACTIONS));
        expect(txs.length).toBe(0);

        // SyncState reset to the fork block.
        const sync = await db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
        expect(Number(sync.lastIndexedHeight)).toBe(9);
        expect(sync.syncStatus).toBe('stopped');
    });

    it('stops and resumes the crawler when it was running during reindex', async () => {
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: cds.utils.uuid(),
            hash: '0x9',
            height: 9,
            protocolVersion: 1,
            timestamp: 1700000000,
            ledgerParameters: '0xabcd'
        }));
        mockIsCrawlerRunning.mockReturnValue(true);
        mockStopCrawler.mockResolvedValueOnce(undefined);
        mockStartCrawler.mockResolvedValueOnce(undefined);

        const result = await srv.send({ event: 'reindexFromHeight', data: { height: 10 } });
        expect(result).toMatchObject({
            status: 'ok',
            crawlerResumed: true
        });
        expect(mockStopCrawler).toHaveBeenCalledTimes(1);
        expect(mockStartCrawler).toHaveBeenCalledTimes(1);
    });

    it('repairs NightBalances during the rollback (no double-count on re-index)', async () => {
        const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
        const NIGHT_BALANCES = 'midnight.NightBalances';
        await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
        await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));

        // Block 9 (survives) and 10 (rolled back), each with a transfer to addr_b.
        const blockIds: Record<number, string> = {};
        for (const h of [9, 10]) {
            const id = cds.utils.uuid();
            blockIds[h] = id;
            await db.run(cds.ql.INSERT.into(BLOCKS).entries({
                ID: id,
                hash: `0x${h}`,
                height: h,
                protocolVersion: 1,
                timestamp: 1700000000 + h,
                ledgerParameters: '0xabcd'
            }));
        }
        const txIds: Record<number, string> = {};
        for (const [h, fields] of [
            [9, { receiverAddress: 'addr_b', nightAmount: '50' }],
            [10, { senderAddress: 'addr_a', receiverAddress: 'addr_b', nightAmount: '100' }]
        ] as const) {
            const id = cds.utils.uuid();
            txIds[h] = id;
            await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
                ID: id,
                transactionId: 0,
                hash: `0xtx${h}`,
                protocolVersion: 1,
                transactionType: 'Regular',
                block_ID: blockIds[h],
                ...fields
            }));
            await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
                ID: cds.utils.uuid(),
                owner: 'addr_b',
                tokenType: '0xtoken',
                value: (fields as any).nightAmount,
                intentHash: '0xintent',
                outputIndex: 0,
                initialNonce: `0xn${h}`,
                createdAtTransaction_ID: id
            }));
        }
        // Balances exactly as the delta-based ingest left them.
        await db.run(cds.ql.INSERT.into(NIGHT_BALANCES).entries([
            {
                address: 'addr_b', balance: '150', utxoCount: 2,
                txSentCount: 0, txReceivedCount: 2, totalSent: '0', totalReceived: '150',
                firstSeenHeight: 9, lastActivityHeight: 10
            },
            {
                address: 'addr_a', balance: '0', utxoCount: 0,
                txSentCount: 1, txReceivedCount: 0, totalSent: '100', totalReceived: '0',
                firstSeenHeight: 10, lastActivityHeight: 10
            }
        ]));
        mockIsCrawlerRunning.mockReturnValue(false);

        await srv.send({ event: 'reindexFromHeight', data: { height: 10 } });

        // addr_b restored to its pre-block-10 state.
        const b = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: 'addr_b' }));
        expect(Number(b.balance)).toBe(50);
        expect(b.utxoCount).toBe(1);
        expect(b.txReceivedCount).toBe(1);
        expect(Number(b.totalReceived)).toBe(50);
        // addr_a had no surviving activity → projection row deleted.
        const a = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: 'addr_a' }));
        expect(a).toBeFalsy();

        await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
        await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    });
});

// ----------------------------------------------------------------------------
// Authorization: the mutating operational actions are admin-gated in the
// model. Enforcement is CAP-generic (@requires); the [test] profile runs with
// dummy auth (privileged user), so the annotation itself is asserted here.
// ----------------------------------------------------------------------------
describe('authorization', () => {
    function actionDef(name: string): any {
        const model: any = cds.model;
        return model.definitions[`NightgateIndexerService.${name}`]
            ?? model.definitions['NightgateIndexerService']?.actions?.[name];
    }

    it.each(['pauseCrawler', 'resumeCrawler', 'reindexFromHeight'])(
        'requires the admin role on %s',
        (action) => {
            const def = actionDef(action);
            expect(def).toBeTruthy();
            expect(def['@requires']).toBe('admin');
        }
    );

    it('leaves read-only probes (liveness/readiness/metrics) unrestricted for K8s and Prometheus', () => {
        for (const fn of ['getLiveness', 'getReadiness', 'getMetrics', 'getSyncStatus', 'getHealth']) {
            const def = actionDef(fn);
            expect(def).toBeTruthy();
            expect(def['@requires']).toBeUndefined();
        }
    });
});
