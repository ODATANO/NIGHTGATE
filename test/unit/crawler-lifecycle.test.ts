const mockDisconnect = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

// Regular `function` impls: the sources construct these with `new`, and only
// constructable (non-arrow) implementations survive that under vitest.
const mockNodeProviderConstructor = vi.hoisted(() => (vi.fn().mockImplementation(function () {
    return { disconnect: mockDisconnect };
} as any)));

const mockCrawlerConstructor = vi.hoisted(() => (vi.fn().mockImplementation(function () {
    return { start: mockStart, stop: mockStop };
} as any)));

vi.mock('../../srv/providers/MidnightNodeProvider', () => ({
    MidnightNodeProvider: mockNodeProviderConstructor
}));

vi.mock('../../srv/crawler/Crawler', () => ({
    MidnightCrawler: mockCrawlerConstructor
}));

import { startCrawler, stopCrawler } from '../../srv/crawler/index';

describe('crawler lifecycle wrapper', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
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
