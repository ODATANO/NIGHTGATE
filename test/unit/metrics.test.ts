/**
 * Metrics Endpoint Tests
 *
 * Verify that getMetrics returns Prometheus-compatible text format.
 */

const mockDbRun = jest.fn();
const mockSuperInit = jest.fn().mockResolvedValue(undefined);
const mockDbConnect = jest.fn().mockResolvedValue({ run: mockDbRun });

// Track registered handlers
const registeredHandlers: Record<string, Function> = {};

jest.mock('@sap/cds', () => {
    const cds: any = {
        connect: { to: mockDbConnect },
        env: {
            requires: {
                nightgate: { network: 'testnet', nodeUrl: 'ws://localhost:9944' }
            }
        },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        where: jest.fn()
                    })
                },
                from: jest.fn().mockReturnValue({
                    orderBy: jest.fn().mockReturnValue({
                        limit: jest.fn()
                    })
                })
            },
            INSERT: {
                into: jest.fn().mockReturnValue({
                    entries: jest.fn()
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

import NightgateIndexerService from '../../srv/nightgate-indexer-service';

describe('Metrics Endpoint', () => {
    let service: NightgateIndexerService;

    beforeEach(async () => {
        jest.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);

        // Init returns existing SyncState
        mockDbRun.mockResolvedValueOnce({ ID: 'SINGLETON' });

        service = new NightgateIndexerService();
        await service.init();
    });

    it('should return Prometheus-formatted metrics with sync data', async () => {
        const handler = registeredHandlers['getMetrics'];
        expect(handler).toBeDefined();

        mockDbRun.mockResolvedValueOnce({
            ID: 'SINGLETON',
            chainHeight: 1000,
            lastIndexedHeight: 950,
            blocksPerSecond: 2.5,
            consecutiveErrors: 0,
            syncStatus: 'syncing'
        });

        const result = await handler();

        expect(result).toContain('odatano_nightgate_chain_height 1000');
        expect(result).toContain('odatano_nightgate_indexed_height 950');
        expect(result).toContain('odatano_nightgate_sync_lag 50');
        expect(result).toContain('odatano_nightgate_blocks_per_second 2.5');
        expect(result).toContain('odatano_nightgate_consecutive_errors 0');
        expect(result).toContain('odatano_nightgate_sync_status 1'); // syncing = 1
        expect(result).toContain('# TYPE odatano_nightgate_chain_height gauge');
        expect(result).toContain('odatano_nightgate_uptime_seconds');
    });

    it('should return defaults when SyncState is null', async () => {
        const handler = registeredHandlers['getMetrics'];

        mockDbRun.mockResolvedValueOnce(null);

        const result = await handler();

        expect(result).toContain('odatano_nightgate_chain_height 0');
        expect(result).toContain('odatano_nightgate_indexed_height 0');
        expect(result).toContain('odatano_nightgate_sync_lag 0');
        expect(result).toContain('odatano_nightgate_sync_status 0'); // stopped = 0
    });

    it('should include HELP and TYPE annotations', async () => {
        const handler = registeredHandlers['getMetrics'];

        mockDbRun.mockResolvedValueOnce({ ID: 'SINGLETON', syncStatus: 'synced', chainHeight: 100, lastIndexedHeight: 100 });

        const result = await handler();

        expect(result).toContain('# HELP odatano_nightgate_chain_height');
        expect(result).toContain('# TYPE odatano_nightgate_chain_height gauge');
        expect(result).toContain('# HELP odatano_nightgate_uptime_seconds');
        expect(result).toContain('odatano_nightgate_sync_status 2'); // synced = 2
    });

    it('should map error status correctly', async () => {
        const handler = registeredHandlers['getMetrics'];

        mockDbRun.mockResolvedValueOnce({ ID: 'SINGLETON', syncStatus: 'error', consecutiveErrors: 5 });

        const result = await handler();

        expect(result).toContain('odatano_nightgate_sync_status 3'); // error = 3
        expect(result).toContain('odatano_nightgate_consecutive_errors 5');
    });
});
