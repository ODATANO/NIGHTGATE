/**
 * srv/utils/session-expiry.ts: the ONE expiry decision.
 *
 * The exception it encodes was learned twice. First on 2026-08-19, when the
 * fee-sponsor pool silently died 24 h after setup and the cleanup sweep wiped
 * its key material. Then again on 2026-08-23, when the rule lived only inside
 * resolveFeeSponsor while eight other sites carried a bare `expiresAt < now`:
 * sponsoring worked, every ordinary read of the same session answered 410, and
 * a new status endpoint reported the entire live pool as expired.
 */

vi.mock('@sap/cds', () => {
    const cds: any = { env: { requires: { nightgate: {} } } };
    cds.default = cds;
    return cds;
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    getConfiguredFeeSponsorSessions,
    isConfiguredPlatformSponsor,
    isSessionExpired
} from '../../srv/utils/session-expiry';

const SPONSOR = 'sponsor-session-1';
const PLAIN = 'plain-session-1';
const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 60_000).toISOString();

const previous = process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
beforeEach(() => { process.env.NIGHTGATE_FEE_SPONSOR_SESSION = SPONSOR; });
afterEach(() => {
    if (previous === undefined) delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
    else process.env.NIGHTGATE_FEE_SPONSOR_SESSION = previous;
});

describe('getConfiguredFeeSponsorSessions', () => {
    it('reads a comma separated env list and trims it', () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = ' a , b ,, c ';
        expect(getConfiguredFeeSponsorSessions()).toEqual(['a', 'b', 'c']);
    });

    it('falls back to the cds config, array or string', () => {
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: ['x', 'y'] })).toEqual(['x', 'y']);
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: 'x,y' })).toEqual(['x', 'y']);
    });

    it('is empty when nothing is configured', () => {
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        expect(getConfiguredFeeSponsorSessions({})).toEqual([]);
    });

    it('lets the env win over the config', () => {
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: 'from-config' })).toEqual([SPONSOR]);
    });
});

describe('isConfiguredPlatformSponsor', () => {
    it('recognises a configured session', () => {
        expect(isConfiguredPlatformSponsor(SPONSOR)).toBe(true);
        expect(isConfiguredPlatformSponsor(PLAIN)).toBe(false);
    });

    it('says no for a missing id instead of throwing', () => {
        expect(isConfiguredPlatformSponsor(undefined)).toBe(false);
        expect(isConfiguredPlatformSponsor(null)).toBe(false);
        expect(isConfiguredPlatformSponsor('')).toBe(false);
    });
});

describe('isSessionExpired', () => {
    it('expires an ordinary session whose timestamp has passed', () => {
        expect(isSessionExpired(PLAIN, past)).toBe(true);
    });

    it('does NOT expire an ordinary session with time left', () => {
        expect(isSessionExpired(PLAIN, future)).toBe(false);
    });

    it('never expires a CONFIGURED platform sponsor', () => {
        // The whole point: this session's timestamp has long passed, and it is
        // the pool that pays for everyone's transactions.
        expect(isSessionExpired(SPONSOR, past)).toBe(false);
    });

    it('expires a sponsor again once it is removed from the configuration', () => {
        // The exemption follows the CONFIG, not the row: an unconfigured
        // session is an ordinary one and ages out normally.
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'someone-else';
        expect(isSessionExpired(SPONSOR, past)).toBe(true);
    });

    it('treats a session without a timestamp as not expiring', () => {
        expect(isSessionExpired(PLAIN, null)).toBe(false);
        expect(isSessionExpired(PLAIN, undefined)).toBe(false);
        expect(isSessionExpired(PLAIN, '')).toBe(false);
    });

    it('does not expire on an unparseable timestamp', () => {
        // Fail OPEN here on purpose: refusing every request because a column
        // holds junk would take the deployment down over a data defect, and
        // the session is still owner-scoped and active-checked.
        expect(isSessionExpired(PLAIN, 'not-a-date')).toBe(false);
    });

    it('honours an explicitly passed config instead of the ambient one', () => {
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        expect(isSessionExpired(PLAIN, past, { feeSponsorSessions: [PLAIN] })).toBe(false);
    });
});
