/**
 * The public board figures (`srv/submission/board-status.ts`): which sponsors count as ready, how the counts reach the
 * answer, and that a failed read is not kept. The booted service is covered in swap-offers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessions = vi.hoisted(() => new Map<string, { ok: true; accountId: string } | { ok: false; status: number }>());
const progress = vi.hoisted(() => new Map<string, unknown>());
const sponsorIds = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('../../srv/sessions/wallet-session-lifecycle', () => ({
    loadSigningSessionAccountId: async (_db: unknown, sessionId: string, userId: unknown, ignoreExpiry: boolean) => {
        if (userId !== undefined || ignoreExpiry !== true) throw new Error('a sponsor is read without a user and past its expiry');
        const s = sessions.get(sessionId);
        if (!s) throw new Error('database down');
        return s;
    }
}));
vi.mock('../../srv/midnight/wallet-worker-client', () => ({ walletGetSyncProgress: (accountId: string) => progress.get(accountId) ?? null }));
vi.mock('../../srv/submission/fee-sponsor', () => ({ getConfiguredFeeSponsorSessions: () => sponsorIds.list }));
vi.mock('../../srv/submission/background-jobs', () => ({ runWithoutAmbientTx: (fn: () => unknown) => fn() }));

import { countReadySponsors, buildBoardStatus, __resetBoardStatusForTests } from '../../srv/submission/board-status';

const fresh = () => new Date().toISOString();
const noDb = {} as never;

beforeEach(() => {
    sessions.clear();
    progress.clear();
    sponsorIds.list = [];
    __resetBoardStatusForTests();
});

describe('countReadySponsors', () => {
    it('counts a sponsor that is synced and has spendable dust, and no other', async () => {
        sessions.set('s-ready', { ok: true, accountId: 'a-ready' });
        sessions.set('s-nodust', { ok: true, accountId: 'a-nodust' });
        sessions.set('s-behind', { ok: true, accountId: 'a-behind' });
        sessions.set('s-old', { ok: true, accountId: 'a-old' });
        sessions.set('s-closed', { ok: false, status: 404 });
        progress.set('a-ready', { caughtUp: true, updatedAt: fresh(), dust: { availableNotes: 2 } });
        progress.set('a-nodust', { caughtUp: true, updatedAt: fresh(), dust: { availableNotes: 0 } });
        progress.set('a-behind', { caughtUp: false, updatedAt: fresh(), dust: { availableNotes: 5 } });
        progress.set('a-old', { caughtUp: true, updatedAt: new Date(Date.now() - 3_600_000).toISOString(), dust: { availableNotes: 5 } });
        expect(await countReadySponsors(noDb, ['s-ready', 's-nodust', 's-behind', 's-old', 's-closed'])).toBe(1);
    });

    it('a sponsor whose session cannot be read counts as not ready and does not stop the count', async () => {
        sessions.set('s-ready', { ok: true, accountId: 'a-ready' });
        progress.set('a-ready', { caughtUp: true, updatedAt: fresh(), dust: { availableNotes: 1 } });
        expect(await countReadySponsors(noDb, ['s-broken', 's-ready'])).toBe(1);
    });

    it('a sponsor that never reported is not ready', async () => {
        sessions.set('s-new', { ok: true, accountId: 'a-new' });
        expect(await countReadySponsors(noDb, ['s-new'])).toBe(0);
    });
});

describe('buildBoardStatus', () => {
    const countingDb = (counts: number[]) => {
        let i = 0;
        return { run: vi.fn(async () => ({ count: counts[i++] })) } as unknown as { run: ReturnType<typeof vi.fn> };
    };

    it('reports the three counts, the configured sponsors and the ready ones', async () => {
        sponsorIds.list = ['s-ready', 's-closed'];
        sessions.set('s-ready', { ok: true, accountId: 'a-ready' });
        sessions.set('s-closed', { ok: false, status: 404 });
        progress.set('a-ready', { caughtUp: true, updatedAt: fresh(), dust: { availableNotes: 3 } });
        const status = await buildBoardStatus(countingDb([4, '2' as unknown as number, 7]) as never, new Date('2026-11-24T10:00:00Z'));
        expect(status).toMatchObject({ openOffers: 4, offersFilledToday: 2, swapsToday: 7, sponsorsConfigured: 2, sponsorsReady: 1, asOf: '2026-11-24T10:00:00.000Z' });
    });

    it('a count the database does not give is 0', async () => {
        const db = { run: vi.fn(async () => null) };
        expect(await buildBoardStatus(db as never)).toMatchObject({ openOffers: 0, offersFilledToday: 0, swapsToday: 0, sponsorsReady: 0 });
    });

    it('a failed read is not kept: the next reader asks again', async () => {
        const failing = { run: vi.fn(async () => { throw new Error('database down'); }) };
        const now = new Date('2026-11-24T10:00:00Z');
        await expect(buildBoardStatus(failing as never, now)).rejects.toThrow('database down');
        const working = countingDb([1, 0, 0]);
        expect(await buildBoardStatus(working as never, new Date(now.getTime() + 1000))).toMatchObject({ openOffers: 1 });
    });

    it('a read within ten seconds shares the answer, a later one reads again', async () => {
        const first = countingDb([1, 0, 0]);
        const now = new Date('2026-11-24T10:00:00Z');
        await buildBoardStatus(first as never, now);
        const second = countingDb([9, 0, 0]);
        expect(await buildBoardStatus(second as never, new Date(now.getTime() + 9_000))).toMatchObject({ openOffers: 1 });
        expect(second.run).not.toHaveBeenCalled();
        expect(await buildBoardStatus(second as never, new Date(now.getTime() + 10_000))).toMatchObject({ openOffers: 9 });
    });
});
