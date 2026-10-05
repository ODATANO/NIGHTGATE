/**
 * Finds out how much the caller may see: 0 public, 1 legitimate interest, 2 authority.
 * This decides which fields a response contains. `@requires` decides service access.
 */
import cds from '@sap/cds';
import { DisclosureRoles, DisclosureGrants, type DisclosureRole } from '#cds-models/midnight';
import { resolveGranteeId } from '../submission/grantee-identity';
import type { Request } from '@sap/cds';

export type DisclosureRoleValue = DisclosureRole['role'];

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

const LEVEL_TO_ROLE: Record<number, DisclosureRoleValue> = {
    0: 'public_only',
    1: 'legitimate_interest',
    2: 'authority'
};

export interface AttachDisclosureRoleOptions {

    scope?: string;
    contractAddress?: string;
    payloadHash?: string; // Optional hash of one attested payload. Needs attesterId.
    attesterId?: string;
}

/**
 * Sets and returns `req.disclosureRole`. With `contractAddress` it reads the on-chain
 * grants in `DisclosureGrants`. Otherwise it reads the operator's `DisclosureRoles` table.
 */
export async function attachDisclosureRole(
    req: Request,
    db: cds.DatabaseService,
    options: AttachDisclosureRoleOptions = {}
): Promise<DisclosureRoleValue> {
    const userId = req.user?.id;

    if (!userId) {
        req.disclosureRole = DEFAULT_DISCLOSURE_ROLE;
        return DEFAULT_DISCLOSURE_ROLE;
    }

    if (options.contractAddress) {
        const role = await resolveOnChainRole(req, db, options.contractAddress, options.payloadHash, options.attesterId);
        req.disclosureRole = role;
        return role;
    }

    const { SELECT } = cds.ql;
    const rows: DisclosureRole[] =
        (await db.run(SELECT.from(DisclosureRoles).where({ userId })) as DisclosureRole[]) || [];

    const now = new Date().toISOString();
    const valid = rows.filter(r => isCurrentlyValidGrant(r, now, options.scope));
    if (valid.length === 0) {
        req.disclosureRole = DEFAULT_DISCLOSURE_ROLE;
        return DEFAULT_DISCLOSURE_ROLE;
    }

    const highest = valid.reduce((best, current) =>
        RANK[current.role] > RANK[best.role] ? current : best
    );

    req.disclosureRole = highest.role;
    return highest.role;
}

/**
 * Returns the highest active grant for the caller. A payload hash without an attester
 * gives public_only, so a grant from another attester on the same hash cannot unlock it.
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
    // Values are stored lowercase. Only the confirmed `level` counts, never `pendingLevel`.
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
    row: DisclosureRole,
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

export function meetsDisclosure(
    actual: DisclosureRoleValue | undefined,
    required: DisclosureRoleValue
): boolean {
    const a = actual ? RANK[actual] : RANK[DEFAULT_DISCLOSURE_ROLE];
    return a >= RANK[required];
}
