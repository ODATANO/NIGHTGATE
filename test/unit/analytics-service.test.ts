/**
 * NightgateAnalyticsService Tests
 *
 * Verify aggregation functions return correct counts and averages.
 */

const mockDbRun = jest.fn();
const mockDbConnect = jest.fn().mockResolvedValue({ run: mockDbRun });

const registeredHandlers: Record<string, Function> = {};

jest.mock('@sap/cds', () => {
    const cds: any = {
        connect: { to: mockDbConnect },
        ql: {
            SELECT: {
                one: {
                    from: jest.fn().mockReturnValue({
                        columns: jest.fn()
                    })
                }
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

import NightgateAnalyticsService from '../../srv/analytics-service';

describe('NightgateAnalyticsService', () => {
    let service: NightgateAnalyticsService;

    beforeEach(async () => {
        jest.clearAllMocks();
        Object.keys(registeredHandlers).forEach(k => delete registeredHandlers[k]);
        service = new NightgateAnalyticsService();
        await service.init();
    });

    describe('getBlockCount', () => {
        it('should return the total number of blocks', async () => {
            const handler = registeredHandlers['getBlockCount'];
            expect(handler).toBeDefined();

            mockDbRun.mockResolvedValueOnce({ count: 42 });
            const result = await handler();
            expect(result).toBe(42);
        });

        it('should return 0 when no blocks exist', async () => {
            const handler = registeredHandlers['getBlockCount'];
            mockDbRun.mockResolvedValueOnce(null);
            const result = await handler();
            expect(result).toBe(0);
        });
    });

    describe('getTransactionCount', () => {
        it('should return the total number of transactions', async () => {
            const handler = registeredHandlers['getTransactionCount'];
            expect(handler).toBeDefined();

            mockDbRun.mockResolvedValueOnce({ count: 150 });
            const result = await handler();
            expect(result).toBe(150);
        });

        it('should return 0 when no transactions exist', async () => {
            const handler = registeredHandlers['getTransactionCount'];
            mockDbRun.mockResolvedValueOnce(null);
            const result = await handler();
            expect(result).toBe(0);
        });
    });

    describe('getContractCount', () => {
        it('should return the distinct contract address count', async () => {
            const handler = registeredHandlers['getContractCount'];
            expect(handler).toBeDefined();

            mockDbRun.mockResolvedValueOnce({ count: 5 });
            const result = await handler();
            expect(result).toBe(5);
        });
    });

    describe('getAverageTransactionsPerBlock', () => {
        it('should return the average transactions per block', async () => {
            const handler = registeredHandlers['getAverageTransactionsPerBlock'];
            expect(handler).toBeDefined();

            // First call: block count
            mockDbRun.mockResolvedValueOnce({ count: 10 });
            // Second call: transaction count
            mockDbRun.mockResolvedValueOnce({ count: 35 });

            const result = await handler();
            expect(result).toBe(3.5);
        });

        it('should return 0 when no blocks exist', async () => {
            const handler = registeredHandlers['getAverageTransactionsPerBlock'];

            mockDbRun.mockResolvedValueOnce({ count: 0 });
            mockDbRun.mockResolvedValueOnce({ count: 0 });

            const result = await handler();
            expect(result).toBe(0);
        });

        it('should round to 2 decimal places', async () => {
            const handler = registeredHandlers['getAverageTransactionsPerBlock'];

            mockDbRun.mockResolvedValueOnce({ count: 3 });
            mockDbRun.mockResolvedValueOnce({ count: 10 });

            const result = await handler();
            expect(result).toBe(3.33);
        });
    });
});
