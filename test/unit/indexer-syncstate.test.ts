/**
 * Indexer SyncState Resilience Tests
 *
 * Tests that the indexer service ensures SyncState exists at init
 * and getSyncStatus returns defaults instead of null.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
const mockSuperInit = vi.fn().mockResolvedValue(undefined);
const mockDbConnect = vi.hoisted(() => (vi.fn().mockResolvedValue({ run: mockDbRun })));

// Track registered handlers
const registeredHandlers: Record<string, Function> = vi.hoisted(() => ({}));

vi.mock('@sap/cds', () => {
    const cds: any = {
        log: (() => {
            const _c: Record<string, any> = {};
            return (name: string) => (_c[name] ??= {
                info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn()
            });
        })(),
        connect: { to: mockDbConnect },
        env: {
            requires: {
                nightgate: { network: 'testnet', nodeUrl: 'ws://localhost:9944' }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: vi.fn().mockReturnValue({
                        where: vi.fn()
                    })
                },
                from: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn()
                    })
                })
            },
            INSERT: {
                into: vi.fn().mockReturnValue({
                    entries: vi.fn()
                })
            }
        },
        ApplicationService: class {
            on(event: string, handler: Function) {
                registeredHandlers[event] = handler;
            }
            async init() {}
        }
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import NightgateIndexerService from '../../srv/nightgate-indexer-service';

describe('IndexerService SyncState', () => {
    let service: NightgateIndexerService;

    beforeEach(async () => {
        vi.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
    });

    it('should create SyncState row at init when missing', async () => {
        // First call (SELECT): returns null (no existing row)
        // Second call (INSERT): succeeds
        mockDbRun
            .mockResolvedValueOnce(null)    // SELECT.one → null
            .mockResolvedValueOnce(undefined); // INSERT → ok

        service = new NightgateIndexerService();
        await service.init();

        // First DB call should be the SELECT check
        expect(mockDbRun).toHaveBeenCalledTimes(2);
    });

    it('should not overwrite existing SyncState at init', async () => {
        // SELECT returns existing row
        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'syncing',
            lastIndexedHeight: 500
        });

        service = new NightgateIndexerService();
        await service.init();

        // Only 1 DB call (the SELECT), no INSERT
        expect(mockDbRun).toHaveBeenCalledTimes(1);
    });

    it('should handle DB error during SyncState init gracefully', async () => {
        mockDbRun.mockRejectedValueOnce(new Error('table not found'));
        const warnSpy = vi.spyOn(cds.log('nightgate:indexer'), 'warn').mockImplementation(() => {});

        service = new NightgateIndexerService();
        await service.init();

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('SyncState init skipped'),
            expect.any(String)
        );
    });

    it('getSyncStatus should return defaults when SyncState is null', async () => {
        // Init with existing SyncState
        mockDbRun.mockResolvedValueOnce({ ID: 'SINGLETON' });

        service = new NightgateIndexerService();
        await service.init();

        // Now call getSyncStatus handler with null DB result
        const handler = registeredHandlers['getSyncStatus'];
        expect(handler).toBeDefined();

        mockDbRun.mockResolvedValueOnce(null); // getSyncStatus SELECT returns null
        const result = await handler();

        expect(result).toEqual(expect.objectContaining({
            ID: 'SINGLETON',
            syncStatus: 'stopped',
            lastIndexedHeight: 0,
            chainHeight: 0,
            consecutiveErrors: 0
        }));
    });
});
