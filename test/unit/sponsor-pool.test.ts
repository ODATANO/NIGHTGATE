/**
 * Sponsor pool leases (`srv/submission/sponsor-pool.ts`): one in-flight dust
 * spend per wallet, rotation over the pool, cooldown after failures.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    pickFreeSponsor, acquireSponsor, releaseSponsor, benchSponsor,
    isRetryableSponsorFailure, isDustRaceFailure, isGenericInvalidFailure, __resetSponsorPoolForTests, PLATFORM_POOL_SENTINEL,
    sponsorCandidatesNonExclusive, isPreInclusionReject, isAmbiguousSubmitOutcome, isCallNotAppliedFailure
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

    it('classifies a 1010/170 as a dust race (rebuild-retry), not a sponsor-health failure', () => {
        // A dust race is retryable AND dust-race: the unbound path rebuilds on the
        // SAME sponsor instead of benching it.
        for (const msg of [
            '1010: Invalid Transaction: Custom error: 170',
            'submit failed: 1010/170',
            'InvalidDustSpendProof',
            // 196 = the spent note's nullifier is already known to the node
            // (live: two sponsorings forced onto one note); same rebuild fix.
            '1010: Invalid Transaction: Custom error: 196',
            // The shape the worker RPC boundary now delivers (cause chain appended).
            'Transaction submission error <- Transaction submission failed <- 1010: Invalid Transaction: Custom error: 196',
            // Pool status Invalid: the loser reached the pool, the winner consumed the note first.
            'Transaction submission error <- SubmissionError: Transaction submission failed <- TransactionInvalidError: Transaction is invalid and was rejected by the node',
        ]) {
            expect(isDustRaceFailure(new Error(msg)), msg).toBe(true);
            // Only the coded rejects are ALSO sponsor-health retryable (fail over
            // once the dust retries are exhausted); a pool 'Invalid' status is not
            // a sponsor problem and must not bench a healthy sponsor.
            expect(isRetryableSponsorFailure(new Error(msg)), msg).toBe(!/TransactionInvalidError/.test(msg));
        }
        // Digit-boundary: 1700 / 1960 are not our codes.
        expect(isDustRaceFailure(new Error('Custom error: 1700'))).toBe(false);
        // The bare top-level SDK message (what crossed the boundary BEFORE
        // formatErrWithCauses) is NOT a dust race: the code must be visible.
        expect(isDustRaceFailure(new Error('Transaction submission error'))).toBe(false);
        // Sponsor-health failures are retryable but NOT dust races (they fail over).
        for (const msg of [
            'wallet not genuinely synced within 180000ms',
            'No facade for sponsorSessionId=abc',
            '503 WALLET_SYNCING'
        ]) {
            expect(isDustRaceFailure(new Error(msg)), msg).toBe(false);
            expect(isRetryableSponsorFailure(new Error(msg)), msg).toBe(true);
        }
        // A non-retryable shape failure is neither.
        expect(isDustRaceFailure(new Error('circuit \'x\' is not sponsorable'))).toBe(false);
    });

    it('the sentinel is a RESERVED UUID (every carrying surface is Edm.Guid)', () => {
        expect(PLATFORM_POOL_SENTINEL).toBe('00000000-0000-0000-0000-706f6f6c0000');
        expect(PLATFORM_POOL_SENTINEL).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
});

describe('non-exclusive candidates (unbound path)', () => {
    beforeEach(() => __resetSponsorPoolForTests());

    it('EXCLUDES benched sponsors for the cooldown instead of merely sorting them last', () => {
        benchSponsor('sp-a', 60_000);
        expect(sponsorCandidatesNonExclusive(['sp-a', 'sp-b', 'sp-c'])).toEqual(['sp-b', 'sp-c']);
        // a single-member pool whose only sponsor is benched yields NO candidate
        expect(sponsorCandidatesNonExclusive(['sp-a'])).toEqual([]);
        // once the cooldown is over it is back
        expect(sponsorCandidatesNonExclusive(['sp-a'], Date.now() + 61_000)).toEqual(['sp-a']);
    });

    it('isGenericInvalidFailure: a bare pool Invalid is generic; coded rejects and our own markers are not', () => {
        expect(isGenericInvalidFailure(new Error('Transaction submission error <- SubmissionError: Transaction submission failed <- TransactionInvalidError: Transaction is invalid and was rejected by the node'))).toBe(true);
        expect(isGenericInvalidFailure(new Error('1010: Invalid Transaction: Custom error: 196'))).toBe(false);
        expect(isGenericInvalidFailure(new Error('sponsored transaction 00ab is in block 1 but its contract call did NOT apply (ledger result PARTIAL_SUCCESS, failed segment 1); ...'))).toBe(false);
        expect(isGenericInvalidFailure(new Error('submit watch timed out after 60000ms without a Finalized status'))).toBe(false);
    });
});

describe('submit outcome classification', () => {
    it('pre-inclusion rejects are rebuildable and clear the hash; not-applied is rebuildable but on-chain; a watch timeout is ambiguous', () => {
        const rejects = [
            '1010: Invalid Transaction: Custom error: 196',
            'Transaction submission error <- SubmissionError: Transaction submission failed <- TransactionInvalidError: Transaction is invalid and was rejected by the node',
            "submit request died on the client's own closing socket (SDK disconnect lag)",
            'submit-intent rejected by the main thread: db down',
            'submit-intent was not acknowledged by the main thread within 30s; not broadcasting'
        ];
        for (const m of rejects) {
            expect(isPreInclusionReject(new Error(m)), m).toBe(true);
            expect(isAmbiguousSubmitOutcome(new Error(m)), m).toBe(false);
        }
        const notApplied = 'sponsored transaction 00ab is in block 1 but its contract call did NOT apply (ledger result PARTIAL_SUCCESS, failed segment 1); ...';
        expect(isDustRaceFailure(new Error(notApplied))).toBe(false);  // NOT a dust race: the caller's transcript is stale, terminal for the sponsor job
        expect(isCallNotAppliedFailure(new Error(notApplied))).toBe(true);
        expect(isPreInclusionReject(new Error(notApplied))).toBe(false); // it IS on-chain
        const timeout = 'submit watch timed out after 60000ms without a Finalized status';
        expect(isAmbiguousSubmitOutcome(new Error(timeout))).toBe(true);
        expect(isDustRaceFailure(new Error(timeout))).toBe(false);  // never rebuild on it
        expect(isPreInclusionReject(new Error(timeout))).toBe(false);
    });
});
