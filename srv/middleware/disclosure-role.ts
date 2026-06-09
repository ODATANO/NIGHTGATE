/**
 * Disclosure-role middleware.
 *
 * Resolves the highest currently-valid `DisclosureRole` grant for the
 * authenticated user and attaches it to the request so downstream handlers
 * and CDS projections can gate response width by tier.
 * When no grant applies, the default is `public_only`.
 *
 * The disclosure-role tiers map 1:1 to the EU Battery Regulation Annex XIII /
 * Art. 77 access tiers (general public / legitimate-interest / authority).
 * The middleware is intentionally orthogonal to CAP's `@requires` auth roles
 * — that gates access to *services*, this gates the *shape* of responses
 * within a service the caller already reached.
 */
import cds from '@sap/cds';
import { DisclosureRoles, DisclosureGrants } from '#cds-models/midnight';
import { resolveGranteeId } from '../submission/grantee-identity';

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

/**
 * On-chain disclosure level (0/1/2) → disclosure-role tier. Inverse of the
 * RANK above; the AttestationVault `level` maps 1:1 onto the EU Battery
 * Regulation Annex XIII access tiers.
 */
const LEVEL_TO_ROLE: Record<number, DisclosureRoleValue> = {
    0: 'public_only',
    1: 'legitimate_interest',
    2: 'authority'
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
    /**
     * AttestationVault deployment address. When supplied, the tier is resolved
     * from the ON-CHAIN `DisclosureGrants` (the tamper-evident ACL) — the
     * caller's granteeId is matched against active grants for this contract,
     * and that result is AUTHORITATIVE (no fall-back to the off-chain
     * `DisclosureRoles` table). Omit to use the off-chain table (the original
     * behavior). See docs/feature-requests/expose-disclosure-grants.md §3.
     */
    contractAddress?: string;
    /**
     * Optional attestation payload hash. When supplied alongside
     * `contractAddress`, the on-chain match is narrowed to grants for this
     * specific attestation; otherwise any active grant on the contract counts.
     */
    payloadHash?: string;
}

/**
 * Looks up the authenticated user's highest disclosure tier and attaches it
 * to `req.disclosureRole`. Returns the resolved role for direct use inside a
 * handler.
 *
 * Two sources, selected by `options.contractAddress`:
 *   - on-chain (contractAddress set): the indexed `DisclosureGrants` ACL is
 *     authoritative — the caller's granteeId is matched against active grants.
 *   - off-chain (no contractAddress): the operator-configured `DisclosureRoles`
 *     table (original behavior).
 *
 * The lookup is small (one or two SELECTs keyed on `userId`/contract); we rank
 * in JS to keep the SQL portable across SQLite/HANA without a DB-specific
 * CASE WHEN.
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

    // On-chain ACL path: authoritative when a contract scope is configured.
    if (options.contractAddress) {
        const role = await resolveOnChainRole(req, db, options.contractAddress, options.payloadHash);
        target.disclosureRole = role;
        return role;
    }

    const { SELECT } = cds.ql;
    const rows: DisclosureRoleRow[] =
        (await db.run(SELECT.from(DisclosureRoles).where({ userId })) as DisclosureRoleRow[]) || [];

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

/**
 * Resolve the caller's tier from the on-chain `DisclosureGrants` ACL. Returns
 * the highest active grant's tier for the caller's granteeId on this contract
 * (optionally narrowed to one attestation), or `public_only` when the caller
 * has no registered granteeId or no active grant.
 */
async function resolveOnChainRole(
    req: cds.Request,
    db: cds.DatabaseService,
    contractAddress: string,
    payloadHash?: string
): Promise<DisclosureRoleValue> {
    const granteeId = await resolveGranteeId(req, db, { scope: contractAddress });
    if (!granteeId) return DEFAULT_DISCLOSURE_ROLE;

    const { SELECT } = cds.ql;
    // Grants are stored lowercase (handlers + indexer normalize on write).
    const where: Record<string, unknown> = {
        contractAddress: contractAddress.toLowerCase(),
        grantee: granteeId,
        active: true
    };
    if (payloadHash) where.payloadHash = payloadHash.toLowerCase();

    const grants: Array<{ level: number }> =
        (await db.run(SELECT.from(DisclosureGrants).where(where)) as Array<{ level: number }>) || [];
    if (grants.length === 0) return DEFAULT_DISCLOSURE_ROLE;

    const highestLevel = grants.reduce((max, g) => (g.level > max ? g.level : max), 0);
    return LEVEL_TO_ROLE[highestLevel] ?? DEFAULT_DISCLOSURE_ROLE;
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
