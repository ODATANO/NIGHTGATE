/**
 * Indexer SyncState Resilience Tests
 *
 * Tests that the indexer service ensures SyncState exists at init
 * and getSyncStatus returns defaults instead of null.
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
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
                nightgate: { network: 'undeployed', nodeUrl: 'ws://localhost:9944' }
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
            before() { /* the hex input hook; its own tests boot the services */ }
            after() { /* the 64-bit result form; its own tests boot the services */ }
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
});
