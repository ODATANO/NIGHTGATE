/**
 * Sponsor pool leases (`srv/submission/sponsor-pool.ts`): one in-flight dust
 * spend per wallet, rotation over the pool, cooldown after failures.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    pickFreeSponsor, acquireSponsor, releaseSponsor, benchSponsor,
    isRetryableSponsorFailure, __resetSponsorPoolForTests, PLATFORM_POOL_SENTINEL
} from '../../srv/submission/sponsor-pool';

const POOL = ['sp-a', 'sp-b', 'sp-c'];

beforeEach(() => __resetSponsorPoolForTests());

describe('sponsor pool', () => {
    it('rotates least-recently-used and never double-leases a wallet', async () => {
        const first = await acquireSponsor(POOL, 0);
        const second = await acquireSponsor(POOL, 0);
        const third = await acquireSponsor(POOL, 0);
        expect(new Set([first, second, third]).size).toBe(3); // all distinct
        await expect(acquireSponsor(POOL, 0)).rejects.toThrow(/busy or cooling/);

        releaseSponsor(second);
        expect(await acquireSponsor(POOL, 0)).toBe(second);
    });

    it('waits for a lease to free up, bounded', async () => {
        for (const id of POOL) { await acquireSponsor([id], 0); }
        const t0 = Date.now();
        setTimeout(() => releaseSponsor('sp-b'), 600);
        const got = await acquireSponsor(POOL, 5_000);
        expect(got).toBe('sp-b');
        expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    });

    it('a benched sponsor sits out its cooldown', async () => {
        benchSponsor('sp-a', 60_000);
        expect(pickFreeSponsor(['sp-a'])).toBeNull();
        expect(pickFreeSponsor(POOL)).not.toBe('sp-a');
        // and comes back after
        expect(pickFreeSponsor(['sp-a'], Date.now() + 61_000)).toBe('sp-a');
    });

    it('classifies sponsor-state failures as retryable, caller failures as not', () => {
        for (const msg of [
            'wallet not genuinely synced within 180000ms',
            'No facade for sponsorSessionId=abc',
            '1010: Invalid Transaction: Custom error: 170',
            'dust note stale (validity window)',
            '503 WALLET_SYNCING'
        ]) expect(isRetryableSponsorFailure(new Error(msg)), msg).toBe(true);

        for (const msg of [
            'refusing to sponsor: circuit \'sendAllMyMoney\' is not sponsorable',
            'refusing to sponsor: transaction carries a guaranteedUnshieldedOffer alongside its contract calls',
            'finalized-tx round-trip FAILED at deserialize'
        ]) expect(isRetryableSponsorFailure(new Error(msg)), msg).toBe(false);
    });

    it('the sentinel is a RESERVED UUID (every carrying surface is Edm.Guid)', () => {
        expect(PLATFORM_POOL_SENTINEL).toBe('00000000-0000-0000-0000-706f6f6c0000');
        expect(PLATFORM_POOL_SENTINEL).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
});
