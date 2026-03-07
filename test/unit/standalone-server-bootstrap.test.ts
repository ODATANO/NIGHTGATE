const pluginLoadSpy = jest.fn();

jest.mock('../../src/plugin', () => {
    pluginLoadSpy();
    return {
        __esModule: true,
        default: {}
    };
});

describe('standalone server bootstrap', () => {
    beforeEach(() => {
        jest.resetModules();
        pluginLoadSpy.mockClear();
    });

    it('loads the Nightgate plugin bootstrap through srv/server.ts', async () => {
        await import('../../srv/server');

        expect(pluginLoadSpy).toHaveBeenCalledTimes(1);
    });
});