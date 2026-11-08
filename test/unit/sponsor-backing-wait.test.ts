// How long a sponsor waits for a dust backing: only while one of its own is reserved and may come free.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { acquireBacking, noteLocks } from '../../srv/midnight/worker/sponsor';
import { isRetryableSponsorFailure } from '../../srv/submission/sponsor-pool';

const SESSION = 'session-a';
const note = (backingNight: string, generatedNow: bigint) => ({ token: { backingNight, nonce: `n-${backingNight}` }, generatedNow }) as any;

afterEach(() => noteLocks.clear());

describe('acquireBacking', () => {
    it('refuses at once when the notes cannot cover the fee and nothing is reserved, and the job may fail over', async () => {
        const refresh = vi.fn(async () => [note('b1', 5n)]);
        const started = Date.now();
        const err: Error = await acquireBacking(SESSION, refresh, 100n, 60_000, 60_000).catch(e => e);
        expect(err.message).toMatch(/do not cover 100 specks/);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(isRetryableSponsorFailure(err)).toBe(true);
    });

    it('refuses an empty wallet the same way', async () => {
        await expect(acquireBacking(SESSION, async () => [], 100n, 60_000, 60_000)).rejects.toThrow(/do not cover/);
    });

    it('a reservation of another sponsor does not count', async () => {
        noteLocks.set('session-b|b1', { exp: Date.now() + 60_000, token: 1 });
        await expect(acquireBacking(SESSION, async () => [], 100n, 60_000, 60_000)).rejects.toThrow(/do not cover/);
    });

    it('waits while its own backing is reserved, and that failure may fail over too', async () => {
        noteLocks.set(`${SESSION}|b1`, { exp: Date.now() + 60_000, token: 1 });
        const err: Error = await acquireBacking(SESSION, async () => [note('b1', 500n)], 100n, 60_000, 0).catch(e => e);
        expect(err.message).toMatch(/all backings busy/);
        expect(isRetryableSponsorFailure(err)).toBe(true);
    });

    it('takes a note that covers the fee', async () => {
        const lease = await acquireBacking(SESSION, async () => [note('b1', 500n)], 100n, 60_000, 0);
        expect(lease.parts[0].key).toBe(`${SESSION}|b1`);
    });
});
