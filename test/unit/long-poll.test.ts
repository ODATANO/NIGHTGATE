// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import type { Request } from '@sap/cds';
import { holdUntil, waiterPool, clientGone } from '../../srv/utils/long-poll';

type Res = { closed?: boolean; destroyed?: boolean };
const withClient = (res: Res | undefined): Request => ({ http: res ? { res } : undefined } as unknown as Request);

describe('holdUntil', () => {
    it('returns the first value when it is done or the pool is full, without waiting', async () => {
        const pool = waiterPool(1);
        let reads = 0;
        const read = async () => { reads++; return 'later'; };
        expect(await holdUntil(withClient({}), 5000, pool, 'done', read, v => v === 'done')).toBe('done');
        pool.count = 1;
        const t0 = Date.now();
        expect(await holdUntil(withClient({}), 5000, pool, 'first', read, () => false)).toBe('first');
        expect(Date.now() - t0).toBeLessThan(100);
        expect(reads).toBe(0);
    });

    it('re-reads until done, then frees its slot', async () => {
        const pool = waiterPool(10);
        let reads = 0;
        const read = async () => (++reads >= 2 ? 'done' : 'not yet');
        const t0 = Date.now();
        const out = await holdUntil(withClient({}), 5000, pool, 'not yet', read, v => v === 'done');
        expect(out).toBe('done');
        expect(reads).toBe(2);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
        expect(Date.now() - t0).toBeLessThan(2500);
        expect(pool.count).toBe(0);
    });

    it('gives up when the time is up, and an internal call without a client waits the whole time', async () => {
        const pool = waiterPool(10);
        const t0 = Date.now();
        expect(await holdUntil(withClient(undefined), 700, pool, 'x', async () => 'x', () => false)).toBe('x');
        expect(Date.now() - t0).toBeGreaterThanOrEqual(650);
        expect(pool.count).toBe(0);
    });

    it('ends as soon as the client has gone, without another read', async () => {
        const pool = waiterPool(10);
        const res: Res = {};
        let reads = 0;
        const t0 = Date.now();
        const held = holdUntil(withClient(res), 10_000, pool, 'x', async () => { reads++; return 'x'; }, () => false);
        await new Promise(r => setTimeout(r, 50));
        expect(pool.count).toBe(1);
        res.closed = true;
        expect(await held).toBe('x');
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(reads).toBe(0);
        expect(pool.count).toBe(0);
        expect(clientGone(withClient({ destroyed: true }))).toBe(true);
        expect(clientGone(withClient(undefined))).toBe(false);
    });
});
