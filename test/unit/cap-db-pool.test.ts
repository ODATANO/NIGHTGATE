// The CAP connection pool the plugin runs on. @cap-js/db-service's built-in
// Pool loses a resource when it dispenses one to a request that already timed
// out (generic-pool.js `#dispense`, non-pending branch: neither loaned nor
// returned to `_available`); under load the pool empties and every request
// fails with "Pool resource could not be acquired". The plugin therefore
// selects `generic-pool` (features.use_generic_pool) unless the host decided.
// The first test pins the upstream defect against the installed version: when
// it starts failing, the workaround can go.
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cds = require('@sap/cds');

type Conn = { id: number; open: boolean };
function makePool(useGenericPool: boolean) {
    cds.env.features.use_generic_pool = useGenericPool;
    // module-level flag: load a fresh copy of the pool module per case
    const modPath = require.resolve('@cap-js/db-service/lib/common/generic-pool.js');
    delete require.cache[modPath];
    const ConnectionPool = require(modPath);
    let n = 0;
    const factory = {
        create: async (): Promise<Conn> => ({ id: ++n, open: true }),
        destroy: async () => {},
        validate: (c: Conn) => c.open,
        options: { min: 0, max: 2, acquireTimeoutMillis: 50, testOnBorrow: true }
    };
    return new ConnectionPool(factory, 'tenant');
}
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

async function leakAfterTimedOutRequest(pool: any): Promise<{ size: number; available: number; borrowed: number }> {
    const a = await pool.acquire();
    const b = await pool.acquire();                       // pool full
    const late = pool.acquire().catch((e: Error) => e);   // times out after 50 ms
    await tick(80);
    expect(await late).toBeInstanceOf(Error);
    await pool.release(a);                                // dispensed to the DEAD request
    await tick(10);
    await pool.release(b);
    await tick(10);
    return { size: pool.size, available: pool.available, borrowed: pool.borrowed };
}

describe('CAP db connection pool under acquire timeouts', () => {
    it('built-in pool (@cap-js/db-service): a resource dispensed to a timed-out request is lost (upstream defect, pinned)', async () => {
        const s = await leakAfterTimedOutRequest(makePool(false));
        expect(s.borrowed).toBe(0);
        expect(s.size).toBe(2);
        expect(s.available).toBe(1);                      // 2 released, 1 usable: the leak
    });

    it('generic-pool (selected by the plugin): every released resource is available again', async () => {
        const s = await leakAfterTimedOutRequest(makePool(true));
        expect(s.borrowed).toBe(0);
        expect(s.available).toBe(2);
    });

    it('the plugin defaults features.use_generic_pool to true and leaves an explicit host choice alone', async () => {
        const { applyPoolDefault } = await import('../../src/cap-pool-default.js');
        const fresh: { features?: Record<string, unknown> } = {};
        expect(applyPoolDefault(fresh)).toBe(true);
        expect(fresh.features?.use_generic_pool).toBe(true);
        const undecided = { features: { other: 1 } as Record<string, unknown> };
        expect(applyPoolDefault(undecided)).toBe(true);
        expect(undecided.features).toEqual({ other: 1, use_generic_pool: true });
        const optedOut = { features: { use_generic_pool: false } as Record<string, unknown> };
        expect(applyPoolDefault(optedOut)).toBe(false);
        expect(optedOut.features.use_generic_pool).toBe(false);
    });
});
