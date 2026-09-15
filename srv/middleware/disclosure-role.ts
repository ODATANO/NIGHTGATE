/**
 * Resolves the caller's disclosure tier (0 public, 1 legitimate interest, 2 authority)
 * to gate response shape; orthogonal to `@requires`, which gates service access.
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

/** On-chain vault `level` -> tier; inverse of RANK. */
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

    scope?: string;
    contractAddress?: string; // AttestationVault deployment address
    payloadHash?: string; // Optional attestation payload hash; needs attesterId
    attesterId?: string; // The attester whose record of payloadHash the grant belongs to
}

/**
 * Sets and returns `req.disclosureRole`: from on-chain `DisclosureGrants` when
 * `contractAddress` is given, else from the operator's `DisclosureRoles` table.
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

    if (options.contractAddress) {
        const role = await resolveOnChainRole(req, db, options.contractAddress, options.payloadHash, options.attesterId);
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
 * Highest active grant for the caller's granteeId. A payload without an attester
 * resolves to public_only: another attester's grant on the same hash must not open it.
 */
async function resolveOnChainRole(
    req: cds.Request,
    db: cds.DatabaseService,
    contractAddress: string,
    payloadHash?: string,
    attesterId?: string
): Promise<DisclosureRoleValue> {
    if (payloadHash && !attesterId) return DEFAULT_DISCLOSURE_ROLE;
    const granteeId = await resolveGranteeId(req, db, { scope: contractAddress });
    if (!granteeId) return DEFAULT_DISCLOSURE_ROLE;

    const { SELECT } = cds.ql;
    // Stored lowercase. Only the confirmed `level` counts, never `pendingLevel`.
    const where: Record<string, unknown> = {
        contractAddress: contractAddress.toLowerCase(),
        grantee: granteeId,
        active: true
    };
    if (payloadHash) {
        where.payloadHash = payloadHash.toLowerCase();
        where.attesterId = attesterId!.toLowerCase();
    }

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
        return rowScope === null;
    }
    return rowScope === null || rowScope === requestedScope;
}

export function isAuthority(role: DisclosureRoleValue | undefined): boolean {
    return role === 'authority';
}

export function isValidDisclosureRoleValue(value: unknown): value is DisclosureRoleValue {
    return typeof value === 'string'
        && (DISCLOSURE_ROLE_VALUES as readonly string[]).includes(value);
}

/** Higher tiers satisfy lower requirements. */
export function meetsDisclosure(
    actual: DisclosureRoleValue | undefined,
    required: DisclosureRoleValue
): boolean {
    const a = actual ? RANK[actual] : RANK[DEFAULT_DISCLOSURE_ROLE];
    return a >= RANK[required];
}
