/**
 * Tests for srv/submission/fee-sponsor.ts, the guard and resolution layer of
 * per-transaction fee sponsoring.
 *
 * Verifies:
 *   - platform-sponsor list parsing (env wins over config, comma separated)
 *   - same-user scoping: a non-platform sponsor lookup is scoped to the
 *     requesting user (foreign session ids read back as not-found)
 *   - platform sponsors skip the user scope (cross-user sponsoring)
 *   - signing-capability and expiry guards with distinct statuses
 *   - facade ensure passes the sponsor's seed and passphrase through
 */

import crypto from 'crypto';

const getOrBuildWalletFacadeMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../srv/submission/wallet-facade-builder', () => ({
    getOrBuildWalletFacade: getOrBuildWalletFacadeMock
}));

import {
    resolveFeeSponsor,
    ensureFeeSponsorFacade,
    getConfiguredFeeSponsorSessions,
    FeeSponsorError
} from '../../srv/submission/fee-sponsor';
import { deriveAccountId, deriveStoragePassword } from '../../srv/submission/wallet-material-factory';
import { encrypt } from '../../srv/utils/crypto';

const TEST_KEY = crypto.createHash('sha256').update('fee-sponsor-test-key').digest();
const VIEWING_KEY = 'ab'.repeat(32);
const SEED_HEX = 'cd'.repeat(64);

function sponsorRow(overrides: Record<string, any> = {}) {
    return {
        ID: 'row-uuid',
        sessionId: 'sponsor-session-1',
        userId: 'platform-operator',
        isActive: true,
        encryptedViewingKey: encrypt(VIEWING_KEY, TEST_KEY),
        encryptedSeedKey: encrypt(SEED_HEX, TEST_KEY),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...overrides
    };
}

/** Fake db capturing the query so the WHERE scope is assertable. */
function makeDb(row: Record<string, any> | null) {
    const queries: any[] = [];
    return {
        queries,
        run: vi.fn(async (q: any) => { queries.push(q); return row; })
    };
}

function whereOf(db: ReturnType<typeof makeDb>): string {
    return JSON.stringify(db.queries[0] ?? {});
}

afterEach(() => {
    delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
    getOrBuildWalletFacadeMock.mockClear();
});

describe('getConfiguredFeeSponsorSessions', () => {
    it('returns [] without env or config', () => {
        expect(getConfiguredFeeSponsorSessions()).toEqual([]);
        expect(getConfiguredFeeSponsorSessions({})).toEqual([]);
    });

    it('parses the env var, comma separated, trimmed', () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = ' s1 , s2,s3 ';
        expect(getConfiguredFeeSponsorSessions()).toEqual(['s1', 's2', 's3']);
    });

    it('falls back to config feeSponsorSessions (string or array)', () => {
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: 'a,b' })).toEqual(['a', 'b']);
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: ['a', 'b'] })).toEqual(['a', 'b']);
    });

    it('env wins over config', () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'env-sponsor';
        expect(getConfiguredFeeSponsorSessions({ feeSponsorSessions: 'cfg-sponsor' })).toEqual(['env-sponsor']);
    });
});

describe('resolveFeeSponsor', () => {
    it('resolves a same-user sponsor session with derived account material', async () => {
        const db = makeDb(sponsorRow({ userId: 'alice' }));
        const sponsor = await resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'alice',
            encryptionKey: TEST_KEY
        });
        expect(sponsor.sponsorSessionId).toBe('sponsor-session-1');
        expect(sponsor.accountId).toBe(deriveAccountId(VIEWING_KEY));
        expect(sponsor.seedHex).toBe(SEED_HEX);
        expect(sponsor.syncStatePassphrase).toBe(deriveStoragePassword(VIEWING_KEY));
        // Non-platform lookup is scoped to the requesting user.
        expect(whereOf(db)).toContain('userId');
    });

    it('rejects an unauthenticated caller for a non-platform sponsor with 403', async () => {
        const db = makeDb(sponsorRow());
        await expect(resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            encryptionKey: TEST_KEY
        })).rejects.toMatchObject({ name: 'FeeSponsorError', httpStatus: 403 });
        expect(db.run).not.toHaveBeenCalled();
    });

    it('reads a foreign non-platform session back as 404 (scoped lookup finds nothing)', async () => {
        const db = makeDb(null); // userId scope excludes the foreign row
        await expect(resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'mallory',
            encryptionKey: TEST_KEY
        })).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('allows a platform-listed sponsor across users (no user scope in the lookup)', async () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = 'sponsor-session-1';
        const db = makeDb(sponsorRow({ userId: 'platform-operator' }));
        const sponsor = await resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'some-producer',
            encryptionKey: TEST_KEY
        });
        expect(sponsor.accountId).toBe(deriveAccountId(VIEWING_KEY));
        expect(whereOf(db)).not.toContain('userId');
    });

    it('rejects an expired sponsor session with 410', async () => {
        const db = makeDb(sponsorRow({ userId: 'alice', expiresAt: new Date(Date.now() - 1000).toISOString() }));
        await expect(resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'alice',
            encryptionKey: TEST_KEY
        })).rejects.toMatchObject({ httpStatus: 410 });
    });

    it('rejects a viewing-key-only sponsor session with 412 (cannot pay dust without the seed)', async () => {
        const db = makeDb(sponsorRow({ userId: 'alice', encryptedSeedKey: null }));
        await expect(resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'alice',
            encryptionKey: TEST_KEY
        })).rejects.toMatchObject({ httpStatus: 412 });
    });

    it('maps an undecryptable session to 500 without leaking material', async () => {
        const otherKey = crypto.createHash('sha256').update('other').digest();
        const db = makeDb(sponsorRow({
            userId: 'alice',
            encryptedViewingKey: encrypt(VIEWING_KEY, otherKey),
            encryptedSeedKey: encrypt(SEED_HEX, otherKey)
        }));
        await expect(resolveFeeSponsor({
            db,
            sponsorSessionId: 'sponsor-session-1',
            requestingUserId: 'alice',
            encryptionKey: TEST_KEY
        })).rejects.toMatchObject({ httpStatus: 500 });
    });

    it('errors are FeeSponsorError instances (handlers map httpStatus)', async () => {
        const db = makeDb(null);
        const err = await resolveFeeSponsor({
            db, sponsorSessionId: 'x', requestingUserId: 'u', encryptionKey: TEST_KEY
        }).catch(e => e);
        expect(err).toBeInstanceOf(FeeSponsorError);
    });
});

describe('ensureFeeSponsorFacade', () => {
    it('initialises the sponsor facade with the sponsor seed and passphrase', async () => {
        const sponsor = {
            sponsorSessionId: 's-1',
            accountId: 'acct-1',
            seedHex: SEED_HEX,
            syncStatePassphrase: 'pass-1',
            accountIndex: 3
        };
        const cfg = {
            networkId: 'preview' as const,
            indexerHttpUrl: 'http://i',
            indexerWsUrl: 'ws://i',
            proofServerUrl: 'http://p',
            relayUrl: 'ws://r',
            // The calling session's account; the sponsor's own must win.
            accountIndex: 1
        };
        await ensureFeeSponsorFacade(sponsor, cfg);
        expect(getOrBuildWalletFacadeMock).toHaveBeenCalledWith('acct-1', {
            ...cfg,
            seedHex: SEED_HEX,
            syncStatePassphrase: 'pass-1',
            accountIndex: 3
        });
    });
});
