/**
 * Tests for srv/middleware/disclosure-role.ts.
 *
 * Covers: tier resolution from DB rows, default when no user/no grants,
 * scope handling (global vs. matching vs. non-matching), validity windows,
 * and the meetsDisclosure / isAuthority / isValidDisclosureRoleValue helpers.
 *
 * Runs against a real in-memory CAP DB via cds.test() (see test/vitest.setup.ts):
 * each test seeds midnight.DisclosureRoles and calls the middleware with the
 * real db connection, so the actual CQL query + JS filtering are exercised.
 */
import cds from '@sap/cds';
import {
    attachDisclosureRole,
    isAuthority,
    isValidDisclosureRoleValue,
    meetsDisclosure,
    DEFAULT_DISCLOSURE_ROLE,
    DISCLOSURE_ROLE_VALUES,
    DisclosureRoleValue
} from '../../srv/middleware/disclosure-role';

// Boot the in-memory CAP server for this file. Not assigned to a `test` const
// on purpose: that would shadow the global test(). We only need the DB here.
cds.test(__dirname + '/../..');

const ROLES = 'midnight.DisclosureRoles';
const GRANTS = 'midnight.DisclosureGrants';
const IDENTITIES = 'midnight.GranteeIdentities';

interface GrantSeed {
    userId: string;
    role: string;
    scope?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
}

let db: any;

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    await db.run(cds.ql.DELETE.from(ROLES));
    await db.run(cds.ql.DELETE.from(GRANTS));
    await db.run(cds.ql.DELETE.from(IDENTITIES));
});

async function seed(...grants: GrantSeed[]): Promise<void> {
    await db.run(cds.ql.INSERT.into(ROLES).entries(grants.map(g => ({
        ID: cds.utils.uuid(),
        userId: g.userId,
        role: g.role,
        scope: g.scope ?? null,
        validFrom: g.validFrom ?? null,
        validUntil: g.validUntil ?? null
    }))));
}

async function seedIdentity(userId: string, granteeId: string, scope: string | null = null): Promise<void> {
    await db.run(cds.ql.INSERT.into(IDENTITIES).entries({
        ID: cds.utils.uuid(), userId, granteeId, bindingKind: 'custom', scope
    }));
}

interface GrantRowSeed {
    payloadHash: string;
    grantee: string;
    level: number;
    contractAddress: string;
    active?: boolean;
}

async function seedGrant(g: GrantRowSeed): Promise<void> {
    await db.run(cds.ql.INSERT.into(GRANTS).entries({
        ID: cds.utils.uuid(),
        payloadHash: g.payloadHash,
        grantee: g.grantee,
        level: g.level,
        contractAddress: g.contractAddress,
        grantedTxHash: null,
        revokedTxHash: null,
        active: g.active ?? true
    }));
}

function makeReq(userId?: string): any {
    return { user: userId ? { id: userId } : undefined };
}

describe('attachDisclosureRole', () => {
    test('returns public_only and skips DB when no user.id', async () => {
        const req = makeReq();
        const role = await attachDisclosureRole(req, db);
        expect(role).toBe('public_only');
        expect(req.disclosureRole).toBe('public_only');
    });

    test('returns public_only when DB returns no rows', async () => {
        const req = makeReq('alice');
        const role = await attachDisclosureRole(req, db);
        expect(role).toBe('public_only');
        expect(req.disclosureRole).toBe('public_only');
    });

    test('picks the highest-tier currently-valid grant', async () => {
        await seed(
            { userId: 'bob', role: 'public_only' },
            { userId: 'bob', role: 'legitimate_interest' },
            { userId: 'bob', role: 'authority' }
        );
        const req = makeReq('bob');
        const role = await attachDisclosureRole(req, db);
        expect(role).toBe('authority');
        expect(req.disclosureRole).toBe('authority');
    });

    test('ignores expired grants (validUntil in the past)', async () => {
        const yesterday = new Date(Date.now() - 86400_000).toISOString();
        await seed(
            { userId: 'carol', role: 'authority', validUntil: yesterday },
            { userId: 'carol', role: 'legitimate_interest' }
        );
        const role = await attachDisclosureRole(makeReq('carol'), db);
        expect(role).toBe('legitimate_interest');
    });

    test('ignores not-yet-valid grants (validFrom in the future)', async () => {
        const tomorrow = new Date(Date.now() + 86400_000).toISOString();
        await seed(
            { userId: 'dan', role: 'authority', validFrom: tomorrow },
            { userId: 'dan', role: 'public_only' }
        );
        const role = await attachDisclosureRole(makeReq('dan'), db);
        expect(role).toBe('public_only');
    });

    test('returns public_only when only expired grants exist', async () => {
        const yesterday = new Date(Date.now() - 86400_000).toISOString();
        await seed({ userId: 'eve', role: 'authority', validUntil: yesterday });
        const role = await attachDisclosureRole(makeReq('eve'), db);
        expect(role).toBe('public_only');
    });

    describe('scope handling', () => {
        test('default lookup ignores scoped grants', async () => {
            await seed(
                { userId: 'fay', role: 'authority', scope: 'contract-A' },
                { userId: 'fay', role: 'legitimate_interest' }
            );
            const role = await attachDisclosureRole(makeReq('fay'), db);
            expect(role).toBe('legitimate_interest');
        });

        test('scoped lookup matches the requested scope', async () => {
            await seed(
                { userId: 'fay', role: 'authority', scope: 'contract-A' },
                { userId: 'fay', role: 'legitimate_interest' }
            );
            const role = await attachDisclosureRole(makeReq('fay'), db, { scope: 'contract-A' });
            expect(role).toBe('authority');
        });

        test('scoped lookup ignores grants for a different scope', async () => {
            await seed({ userId: 'gail', role: 'authority', scope: 'contract-B' });
            const role = await attachDisclosureRole(makeReq('gail'), db, { scope: 'contract-A' });
            expect(role).toBe('public_only');
        });

        test('scoped lookup still accepts global grants', async () => {
            await seed({ userId: 'gail', role: 'legitimate_interest' });
            const role = await attachDisclosureRole(makeReq('gail'), db, { scope: 'contract-A' });
            expect(role).toBe('legitimate_interest');
        });

        test('empty-string scope is treated as global', async () => {
            await seed({ userId: 'gail', role: 'legitimate_interest', scope: '' });
            const role = await attachDisclosureRole(makeReq('gail'), db);
            expect(role).toBe('legitimate_interest');
        });
    });

    describe('on-chain ACL (contractAddress set)', () => {
        // Rows are stored lowercase (handlers + indexer normalize on write).
        const VAULT = '0xvault';
        const PH = 'a'.repeat(64);
        const GID = 'c'.repeat(64);

        test('active level-1 grant → legitimate_interest', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 1, contractAddress: VAULT });
            const role = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT });
            expect(role).toBe('legitimate_interest');
        });

        test('active level-2 grant → authority; level-0 → public_only', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 2, contractAddress: VAULT });
            expect(await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT })).toBe('authority');

            await db.run(cds.ql.DELETE.from(GRANTS));
            await seedGrant({ payloadHash: PH, grantee: GID, level: 0, contractAddress: VAULT });
            expect(await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT })).toBe('public_only');
        });

        test('highest active grant wins across multiple', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 1, contractAddress: VAULT });
            await seedGrant({ payloadHash: 'b'.repeat(64), grantee: GID, level: 2, contractAddress: VAULT });
            expect(await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT })).toBe('authority');
        });

        test('no registered granteeId → public_only (off-chain table NOT consulted)', async () => {
            // An off-chain authority grant exists, but with contractAddress set the
            // on-chain ACL is authoritative and the caller has no granteeId.
            await seed({ userId: 'han', role: 'authority' });
            const role = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT });
            expect(role).toBe('public_only');
        });

        test('registered granteeId but no active grant → public_only', async () => {
            await seedIdentity('han', GID);
            const role = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT });
            expect(role).toBe('public_only');
        });

        test('inactive (revoked) grant is ignored → public_only', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 2, contractAddress: VAULT, active: false });
            const role = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT });
            expect(role).toBe('public_only');
        });

        test('grant for a different contract is ignored', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 2, contractAddress: '0xOTHER' });
            const role = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT });
            expect(role).toBe('public_only');
        });

        test('payloadHash narrows the match', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 2, contractAddress: VAULT });
            // Asking about a different attestation → no match.
            const other = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT, payloadHash: 'd'.repeat(64) });
            expect(other).toBe('public_only');
            // Asking about the granted attestation → match.
            const match = await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT, payloadHash: PH });
            expect(match).toBe('authority');
        });

        test('anonymous caller → public_only', async () => {
            const role = await attachDisclosureRole(makeReq(), db, { contractAddress: VAULT });
            expect(role).toBe('public_only');
        });

        test('scoped granteeId (per-contract) resolves and matches', async () => {
            // identity bound specifically to this contract scope
            await seedIdentity('han', GID, VAULT);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 1, contractAddress: VAULT });
            expect(await attachDisclosureRole(makeReq('han'), db, { contractAddress: VAULT })).toBe('legitimate_interest');
        });

        test('mixed-case contractAddress and payloadHash are normalized for the lookup', async () => {
            await seedIdentity('han', GID);
            await seedGrant({ payloadHash: PH, grantee: GID, level: 2, contractAddress: VAULT });
            const role = await attachDisclosureRole(makeReq('han'), db, {
                contractAddress: '0xVaUlT', payloadHash: PH.toUpperCase()
            });
            expect(role).toBe('authority');
        });
    });
});

describe('helpers', () => {
    test('isAuthority is true only for authority', () => {
        expect(isAuthority('authority')).toBe(true);
        expect(isAuthority('legitimate_interest')).toBe(false);
        expect(isAuthority('public_only')).toBe(false);
        expect(isAuthority(undefined)).toBe(false);
    });

    test('isValidDisclosureRoleValue accepts the three known tiers', () => {
        for (const v of DISCLOSURE_ROLE_VALUES) {
            expect(isValidDisclosureRoleValue(v)).toBe(true);
        }
        expect(isValidDisclosureRoleValue('public')).toBe(false);
        expect(isValidDisclosureRoleValue('')).toBe(false);
        expect(isValidDisclosureRoleValue(null)).toBe(false);
        expect(isValidDisclosureRoleValue(42)).toBe(false);
    });

    test('meetsDisclosure obeys the rank hierarchy', () => {
        const checks: Array<[DisclosureRoleValue | undefined, DisclosureRoleValue, boolean]> = [
            ['authority', 'public_only', true],
            ['authority', 'legitimate_interest', true],
            ['authority', 'authority', true],
            ['legitimate_interest', 'public_only', true],
            ['legitimate_interest', 'legitimate_interest', true],
            ['legitimate_interest', 'authority', false],
            ['public_only', 'public_only', true],
            ['public_only', 'legitimate_interest', false],
            ['public_only', 'authority', false],
            [undefined, 'public_only', true],
            [undefined, 'legitimate_interest', false]
        ];
        for (const [actual, required, expected] of checks) {
            expect(meetsDisclosure(actual, required)).toBe(expected);
        }
    });

    test('DEFAULT_DISCLOSURE_ROLE is public_only', () => {
        expect(DEFAULT_DISCLOSURE_ROLE).toBe('public_only');
    });
});
