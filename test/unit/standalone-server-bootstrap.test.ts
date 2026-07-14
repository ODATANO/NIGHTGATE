const pluginLoadSpy = vi.hoisted(() => (vi.fn()));

vi.mock('../../src/plugin', () => {
    pluginLoadSpy();
    return {
        __esModule: true,
        default: {}
    };
});

describe('standalone server bootstrap', () => {
    beforeEach(() => {
        vi.resetModules();
        pluginLoadSpy.mockClear();
    });

    it('loads the Nightgate plugin bootstrap through srv/server.ts', async () => {
        await import('../../srv/server.js');

        expect(pluginLoadSpy).toHaveBeenCalledTimes(1);
    });
});