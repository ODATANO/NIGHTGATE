/**
 * Tests for srv/middleware/disclosure-role.ts (T14).
 *
 * Covers: tier resolution from DB rows, default when no user/no grants,
 * scope handling (global vs. matching vs. non-matching), validity windows,
 * and the meetsDisclosure / isAuthority / isValidDisclosureRoleValue helpers.
 */

const selectFromSpy = jest.fn();
const selectWhereSpy = jest.fn();

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        ql: {
            SELECT: {
                from: (entity: string) => {
                    selectFromSpy(entity);
                    return { where: selectWhereSpy };
                }
            }
        }
    };
    cds.default = cds;
    return cds;
});

import {
    attachDisclosureRole,
    isAuthority,
    isValidDisclosureRoleValue,
    meetsDisclosure,
    DEFAULT_DISCLOSURE_ROLE,
    DISCLOSURE_ROLE_VALUES,
    DisclosureRoleValue
} from '../../srv/middleware/disclosure-role';

const dbRun = jest.fn();
const fakeDb: any = { run: dbRun };

function makeReq(userId?: string): any {
    const req: any = { user: userId ? { id: userId } : undefined };
    return req;
}

beforeEach(() => {
    selectFromSpy.mockClear();
    selectWhereSpy.mockReset();
    dbRun.mockReset();
});

describe('attachDisclosureRole', () => {
    test('returns public_only and skips DB when no user.id', async () => {
        const req = makeReq();
        const role = await attachDisclosureRole(req, fakeDb);
        expect(role).toBe('public_only');
        expect(req.disclosureRole).toBe('public_only');
        expect(dbRun).not.toHaveBeenCalled();
    });

    test('returns public_only when DB returns no rows', async () => {
        dbRun.mockResolvedValueOnce([]);
        const req = makeReq('alice');
        const role = await attachDisclosureRole(req, fakeDb);
        expect(role).toBe('public_only');
        expect(req.disclosureRole).toBe('public_only');
        expect(selectFromSpy).toHaveBeenCalledWith('midnight.DisclosureRoles');
        expect(selectWhereSpy).toHaveBeenCalledWith({ userId: 'alice' });
    });

    test('returns public_only when DB returns null/undefined', async () => {
        dbRun.mockResolvedValueOnce(null);
        const req = makeReq('alice');
        const role = await attachDisclosureRole(req, fakeDb);
        expect(role).toBe('public_only');
    });

    test('picks the highest-tier currently-valid grant', async () => {
        dbRun.mockResolvedValueOnce([
            { userId: 'bob', role: 'public_only', scope: null, validFrom: null, validUntil: null },
            { userId: 'bob', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null },
            { userId: 'bob', role: 'authority', scope: null, validFrom: null, validUntil: null }
        ]);
        const req = makeReq('bob');
        const role = await attachDisclosureRole(req, fakeDb);
        expect(role).toBe('authority');
        expect(req.disclosureRole).toBe('authority');
    });

    test('ignores expired grants (validUntil in the past)', async () => {
        const yesterday = new Date(Date.now() - 86400_000).toISOString();
        dbRun.mockResolvedValueOnce([
            { userId: 'carol', role: 'authority', scope: null, validFrom: null, validUntil: yesterday },
            { userId: 'carol', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
        ]);
        const role = await attachDisclosureRole(makeReq('carol'), fakeDb);
        expect(role).toBe('legitimate_interest');
    });

    test('ignores not-yet-valid grants (validFrom in the future)', async () => {
        const tomorrow = new Date(Date.now() + 86400_000).toISOString();
        dbRun.mockResolvedValueOnce([
            { userId: 'dan', role: 'authority', scope: null, validFrom: tomorrow, validUntil: null },
            { userId: 'dan', role: 'public_only', scope: null, validFrom: null, validUntil: null }
        ]);
        const role = await attachDisclosureRole(makeReq('dan'), fakeDb);
        expect(role).toBe('public_only');
    });

    test('returns public_only when only expired grants exist', async () => {
        const yesterday = new Date(Date.now() - 86400_000).toISOString();
        dbRun.mockResolvedValueOnce([
            { userId: 'eve', role: 'authority', scope: null, validFrom: null, validUntil: yesterday }
        ]);
        const role = await attachDisclosureRole(makeReq('eve'), fakeDb);
        expect(role).toBe('public_only');
    });

    describe('scope handling', () => {
        test('default lookup ignores scoped grants', async () => {
            dbRun.mockResolvedValueOnce([
                { userId: 'fay', role: 'authority', scope: 'contract-A', validFrom: null, validUntil: null },
                { userId: 'fay', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
            ]);
            const role = await attachDisclosureRole(makeReq('fay'), fakeDb);
            expect(role).toBe('legitimate_interest');
        });

        test('scoped lookup matches the requested scope', async () => {
            dbRun.mockResolvedValueOnce([
                { userId: 'fay', role: 'authority', scope: 'contract-A', validFrom: null, validUntil: null },
                { userId: 'fay', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
            ]);
            const role = await attachDisclosureRole(makeReq('fay'), fakeDb, { scope: 'contract-A' });
            expect(role).toBe('authority');
        });

        test('scoped lookup ignores grants for a different scope', async () => {
            dbRun.mockResolvedValueOnce([
                { userId: 'gail', role: 'authority', scope: 'contract-B', validFrom: null, validUntil: null }
            ]);
            const role = await attachDisclosureRole(makeReq('gail'), fakeDb, { scope: 'contract-A' });
            expect(role).toBe('public_only');
        });

        test('scoped lookup still accepts global grants', async () => {
            dbRun.mockResolvedValueOnce([
                { userId: 'gail', role: 'legitimate_interest', scope: null, validFrom: null, validUntil: null }
            ]);
            const role = await attachDisclosureRole(makeReq('gail'), fakeDb, { scope: 'contract-A' });
            expect(role).toBe('legitimate_interest');
        });

        test('empty-string scope is treated as global', async () => {
            dbRun.mockResolvedValueOnce([
                { userId: 'gail', role: 'legitimate_interest', scope: '', validFrom: null, validUntil: null }
            ]);
            const role = await attachDisclosureRole(makeReq('gail'), fakeDb);
            expect(role).toBe('legitimate_interest');
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
            ['authority',          'public_only',         true],
            ['authority',          'legitimate_interest', true],
            ['authority',          'authority',           true],
            ['legitimate_interest','public_only',         true],
            ['legitimate_interest','legitimate_interest', true],
            ['legitimate_interest','authority',           false],
            ['public_only',        'public_only',         true],
            ['public_only',        'legitimate_interest', false],
            ['public_only',        'authority',           false],
            [undefined,            'public_only',         true],
            [undefined,            'legitimate_interest', false]
        ];
        for (const [actual, required, expected] of checks) {
            expect(meetsDisclosure(actual, required)).toBe(expected);
        }
    });

    test('DEFAULT_DISCLOSURE_ROLE is public_only', () => {
        expect(DEFAULT_DISCLOSURE_ROLE).toBe('public_only');
    });
});
