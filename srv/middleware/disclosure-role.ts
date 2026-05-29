/**
 * Disclosure-role middleware (T14).
 *
 * Resolves the highest currently-valid `DisclosureRole` grant for the
 * authenticated user and attaches it to the request so downstream handlers
 * and CDS projections (T11 — AttestationService) can gate response width by
 * tier. When no grant applies, the default is `public_only`.
 *
 * The disclosure-role tiers map 1:1 to the EU Battery Regulation Annex XIII /
 * Art. 77 access tiers (general public / legitimate-interest / authority).
 * The middleware is intentionally orthogonal to CAP's `@requires` auth roles
 * — that gates access to *services*, this gates the *shape* of responses
 * within a service the caller already reached.
 */
import cds from '@sap/cds';

export type DisclosureRoleValue = 'public_only' | 'legitimate_interest' | 'authority';

export const DEFAULT_DISCLOSURE_ROLE: DisclosureRoleValue = 'public_only';

export const DISCLOSURE_ROLE_VALUES: readonly DisclosureRoleValue[] = [
    'public_only',
    'legitimate_interest',
    'authority'
];

const RANK: Record<DisclosureRoleValue, number> = {
    public_only: 0,
    legitimate_interest: 1,
    authority: 2
};

interface DisclosureRoleRow {
    userId: string;
    role: DisclosureRoleValue;
    scope?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
}

export interface AttachDisclosureRoleOptions {
    /**
     * If supplied, restricts the lookup to grants whose `scope` matches this
     * value AND globally-scoped grants (NULL/empty scope). If omitted, only
     * globally-scoped grants apply.
     */
    scope?: string;
}

/**
 * Looks up the authenticated user's highest disclosure tier and attaches it
 * to `req.disclosureRole`. Returns the resolved role for direct use inside a
 * handler.
 *
 * The lookup is small (one SELECT keyed on `userId`); we rank in JS to keep
 * the SQL portable across SQLite/HANA without a DB-specific CASE WHEN.
 */
export async function attachDisclosureRole(
    req: cds.Request,
    db: cds.DatabaseService,
    options: AttachDisclosureRoleOptions = {}
): Promise<DisclosureRoleValue> {
    const userId = (req as any).user?.id;
    const target = req as unknown as { disclosureRole?: DisclosureRoleValue };

    if (!userId) {
        target.disclosureRole = DEFAULT_DISCLOSURE_ROLE;
        return DEFAULT_DISCLOSURE_ROLE;
    }

    const { SELECT } = cds.ql as any;
    const rows: DisclosureRoleRow[] =
        (await db.run(SELECT.from('midnight.DisclosureRoles').where({ userId }))) || [];

    const now = new Date().toISOString();
    const valid = rows.filter(r => isCurrentlyValidGrant(r, now, options.scope));
    if (valid.length === 0) {
        target.disclosureRole = DEFAULT_DISCLOSURE_ROLE;
        return DEFAULT_DISCLOSURE_ROLE;
    }

    const highest = valid.reduce((best, current) =>
        RANK[current.role] > RANK[best.role] ? current : best
    );

    target.disclosureRole = highest.role;
    return highest.role;
}

function isCurrentlyValidGrant(
    row: DisclosureRoleRow,
    now: string,
    requestedScope: string | undefined
): boolean {
    if (row.validFrom && row.validFrom > now) return false;
    if (row.validUntil && row.validUntil <= now) return false;

    const rowScope = row.scope == null || row.scope === '' ? null : row.scope;

    if (requestedScope === undefined) {
        // No scope requested → only global (null/empty) grants apply.
        return rowScope === null;
    }
    // Scoped request → either global grant or grant matching the scope.
    return rowScope === null || rowScope === requestedScope;
}

export function isAuthority(role: DisclosureRoleValue | undefined): boolean {
    return role === 'authority';
}

export function isValidDisclosureRoleValue(value: unknown): value is DisclosureRoleValue {
    return typeof value === 'string'
        && (DISCLOSURE_ROLE_VALUES as readonly string[]).includes(value);
}

/**
 * Tier comparison helper for handler-side gating. Higher tiers always satisfy
 * lower-tier requirements (`authority` meets `legitimate_interest` and below).
 */
export function meetsDisclosure(
    actual: DisclosureRoleValue | undefined,
    required: DisclosureRoleValue
): boolean {
    const a = actual ? RANK[actual] : RANK[DEFAULT_DISCLOSURE_ROLE];
    return a >= RANK[required];
}
