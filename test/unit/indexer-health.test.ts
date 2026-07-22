/**
 * Indexer health and readiness tests
 */

const mockDbRun = vi.hoisted(() => (vi.fn()));
const mockDbConnect = vi.hoisted(() => (vi.fn().mockResolvedValue({ run: mockDbRun })));

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
                }
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
            async init() { }
        }
    };
    cds.default = cds;
    return cds;
});

import NightgateIndexerService from '../../srv/nightgate-indexer-service';

describe('NightgateIndexerService health', () => {
    let service: NightgateIndexerService;

    beforeEach(async () => {
        vi.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        mockDbRun.mockResolvedValueOnce({ ID: 'SINGLETON' });

        service = new NightgateIndexerService();
        await service.init();
    });

    it('getHealth returns finalized height and finalized lag', async () => {
        const handler = registeredHandlers['getHealth'];

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 120,
            lastIndexedHeight: 100,
            lastFinalizedHeight: 115,
            blocksPerSecond: 3.5,
            syncStatus: 'syncing'
        });

        const result = await handler();

        expect(result).toEqual(expect.objectContaining({
            chainHeight: 120,
            indexedHeight: 100,
            finalizedHeight: 115,
            lag: 20,
            finalizedLag: 5,
            syncStatus: 'syncing'
        }));
    });

    it('getReadiness requires fresh node activity', async () => {
        const handler = registeredHandlers['getReadiness'];

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'synced',
            lastIndexedAt: new Date().toISOString()
        });

        const result = await handler();

        expect(result).toEqual(expect.objectContaining({
            ready: true,
            checks: {
                database: true,
                crawler: true,
                node: true,
                runtime: true
            }
        }));
    });

    it('getReadiness is false when node activity is stale', async () => {
        const handler = registeredHandlers['getReadiness'];

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            syncStatus: 'synced',
            lastIndexedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        });

        const result = await handler();

        expect(result).toEqual(expect.objectContaining({
            ready: false,
            checks: {
                database: true,
                crawler: true,
                node: false,
                runtime: true
            }
        }));
    });
});
