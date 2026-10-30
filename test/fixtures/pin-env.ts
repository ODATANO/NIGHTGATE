/** Sets env values for every test of the calling describe block and restores them after each. Keeps a test independent of a local `.env`. */
export function pinEnv(values: Record<string, string>): void {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        for (const [key, value] of Object.entries(values)) { saved[key] = process.env[key]; process.env[key] = value; }
    });
    afterEach(() => {
        for (const key of Object.keys(values)) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
    });
}
