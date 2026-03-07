const mockDbRun = jest.fn();
const mockConnectTo = jest.fn();
const mockStartCrawler = jest.fn();
const mockStopCrawler = jest.fn();
const mockEnsureNightgateModelLoaded = jest.fn();
const selectFromSpy = jest.fn();

jest.mock('@sap/cds', () => {
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
            }
        }
    };
    cds.default = cds;
    return cds;
});

jest.mock('../../srv/crawler/index', () => ({
    startCrawler: mockStartCrawler,
    stopCrawler: mockStopCrawler
}));

jest.mock('../../srv/utils/cds-model', () => ({
    ensureNightgateModelLoaded: mockEnsureNightgateModelLoaded
}));

import cds from '@sap/cds';
import { initialize, shutdown } from '../../src/index';

describe('runtime initialize', () => {
    beforeEach(async () => {
        jest.clearAllMocks();

        (cds.env as any).requires = {
            nightgate: {
                kind: 'nightgate',
                network: 'testnet',
                nodeUrl: 'ws://localhost:9944'
            }
        };

        mockDbRun.mockResolvedValue({});
        mockConnectTo.mockResolvedValue({ run: mockDbRun });
        mockStartCrawler.mockResolvedValue(undefined);
        mockStopCrawler.mockResolvedValue(undefined);
        mockEnsureNightgateModelLoaded.mockResolvedValue(undefined);

        await shutdown();
        jest.clearAllMocks();
    });

    it('loads the model before DB access, starts the crawler, and logs syncing startup state', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        try {
            const status = await initialize();

            expect(mockEnsureNightgateModelLoaded).toHaveBeenCalledTimes(1);
            expect(mockEnsureNightgateModelLoaded.mock.invocationCallOrder[0]).toBeLessThan(mockConnectTo.mock.invocationCallOrder[0]);
            expect(mockConnectTo).toHaveBeenCalledWith('db');
            expect(selectFromSpy).toHaveBeenCalledWith('midnight.Blocks');
            expect(mockDbRun).toHaveBeenCalledWith(expect.objectContaining({
                __kind: 'one',
                __table: 'midnight.Blocks'
            }));
            expect(mockStartCrawler).toHaveBeenCalledWith(expect.objectContaining({
                enabled: true,
                nodeUrl: 'ws://localhost:9944',
                requestTimeout: 30000
            }));
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Initializing crawler and starting catch-up...');
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: syncing (crawler started)');
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
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        (cds.env as any).requires.nightgate.crawler = { enabled: false };

        try {
            const status = await initialize();

            expect(mockStartCrawler).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: stopped (crawler disabled)');
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
        const logSpy = jest.spyOn(console, 'log').mockImplementation();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        mockStartCrawler.mockRejectedValue(new Error('ECONNREFUSED: connect'));

        try {
            const status = await initialize();

            expect(warnSpy).toHaveBeenCalledWith('[odatano-nightgate] Node not reachable at ws://localhost:9944: ECONNREFUSED: connect');
            expect(logSpy).toHaveBeenCalledWith('[odatano-nightgate] Startup state: offline (node unreachable)');
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
});