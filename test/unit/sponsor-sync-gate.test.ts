/**
 * Sponsor sync gate (`srv/submission/sponsor-sync-gate.ts`): the verdict a
 * pool member is selected by comes from the progress the worker pushed for
 * that session's account.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const progress = vi.hoisted(() => new Map<string, any>());
vi.mock('../../srv/midnight/wallet-worker-client', () => ({
    walletGetSyncProgress: (accountId: string) => progress.get(accountId) ?? null
}));

import { syncGateReading, sponsorAtSyncGate, noteSponsorAccount, __resetSponsorAccountsForTests } from '../../srv/submission/sponsor-sync-gate';

beforeEach(() => {
    progress.clear();
    __resetSponsorAccountsForTests();
});

describe('sponsorAtSyncGate', () => {
    it('is false for a session never resolved in this process', () => {
        progress.set('acct-1', { caughtUp: true, updatedAt: new Date().toISOString() });
        expect(sponsorAtSyncGate('sess-1')).toBe(false);
    });

    it('follows the fresh reading of the resolved account', () => {
        noteSponsorAccount('sess-1', 'acct-1');
        expect(sponsorAtSyncGate('sess-1')).toBe(false); // nothing pushed yet
        progress.set('acct-1', { caughtUp: false, behindEvents: '1400000', updatedAt: new Date().toISOString() });
        expect(sponsorAtSyncGate('sess-1')).toBe(false);
        progress.set('acct-1', { caughtUp: true, updatedAt: new Date().toISOString() });
        expect(sponsorAtSyncGate('sess-1')).toBe(true);
    });

    it('does not trust a reading the progress watch stopped refreshing', () => {
        noteSponsorAccount('sess-1', 'acct-1');
        progress.set('acct-1', { caughtUp: true, updatedAt: new Date(Date.now() - 3_600_000).toISOString() });
        expect(sponsorAtSyncGate('sess-1')).toBe(false);
        expect(syncGateReading(progress.get('acct-1')).reason).toMatch(/sync reading is \d+s old/);
    });
});

describe('syncGateReading', () => {
    const at = { caughtUp: false, behindEvents: '0', appliedIndex: '5', streamTip: '5', indexerFresh: false };

    it('names an unreachable indexer', () => {
        const r = syncGateReading({ ...at, indexerError: 'HTTP 403', updatedAt: new Date().toISOString() });
        expect(r.reason).toMatch(/indexer unreachable \(HTTP 403\)/);
    });

    it('names the age of a lagging indexer', () => {
        const r = syncGateReading({ ...at, indexerTipAgeMs: 420_000, indexerError: null, updatedAt: new Date().toISOString() });
        expect(r.reason).toMatch(/indexer's newest block is 420s old/);
    });

    it('keeps the generic wording for a reading without either', () => {
        expect(syncGateReading({ ...at, updatedAt: new Date().toISOString() }).reason).toMatch(/indexer not fresh/);
    });
});
