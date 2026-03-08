const mockDisconnect = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();

const mockNodeProviderConstructor = jest.fn().mockImplementation(() => ({
    disconnect: mockDisconnect
}));

const mockCrawlerConstructor = jest.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop
}));

jest.mock('../../srv/providers/MidnightNodeProvider', () => ({
    MidnightNodeProvider: mockNodeProviderConstructor
}));

jest.mock('../../srv/crawler/Crawler', () => ({
    MidnightCrawler: mockCrawlerConstructor
}));

import { startCrawler, stopCrawler } from '../../srv/crawler/index';

describe('crawler lifecycle wrapper', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await stopCrawler();
    });

    afterEach(async () => {
        await stopCrawler();
    });

    it('disconnects provider when crawler startup fails', async () => {
        mockStart.mockRejectedValueOnce(new Error('startup failed'));

        await expect(startCrawler({ enabled: true, nodeUrl: 'ws://localhost:9944' } as any)).rejects.toThrow('startup failed');

        expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it('retains existing success behavior for start/stop', async () => {
        mockStart.mockResolvedValueOnce(undefined);
        mockStop.mockResolvedValueOnce(undefined);

        await expect(startCrawler({ enabled: true, nodeUrl: 'ws://localhost:9944' } as any)).resolves.toBeUndefined();
        await expect(stopCrawler()).resolves.toBeUndefined();

        expect(mockStop).toHaveBeenCalledTimes(1);
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });
});
