/**
 * Boot guard of srv/midnight/wallet-worker.ts: the module must refuse to load
 * outside a worker_threads worker (no parentPort). Lives in its own file
 * because the guard throws during module evaluation, and the dispatch suite
 * (wallet-worker-dispatch.test.ts) needs the module to LOAD.
 */

vi.mock('node:worker_threads', async () => {
    const actual = await vi.importActual<any>('node:worker_threads');
    return { ...actual, parentPort: null };
});

describe('wallet-worker boot guard', () => {
    it('refuses to load without a parentPort', async () => {
        await expect(import('../../srv/midnight/wallet-worker.js'))
            .rejects.toThrow(/must be loaded as a worker_threads worker/);
    });
});
