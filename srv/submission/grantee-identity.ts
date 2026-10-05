/**
 * Maps a user to the 32-byte grantee id that disclosure grants use.
 * This module does not prove that the user owns the DID or wallet. The deployment must do that.
 */
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { GranteeIdentities, type GranteeIdentity } from '#cds-models/midnight';
import { type GranteeBinding } from '../utils/nightgate-config';
import { hexToBytes } from '../utils/hex';
import type { DbRunner } from '../utils/db-types';
import { HEX64_ANY_CASE_RE } from '../utils/hex-patterns';

const { SELECT } = cds.ql;


/**
 * custom uses the 64-hex id as is. wallet hashes the coin public key with sha256. did hashes the UTF-8 text.
 * Grant issuers must use the same rule, or the ids will not match.
 */
export function deriveGranteeId(kind: GranteeBinding, input: string): string {
    if (input == null || input === '') {
        throw new Error('grantee-identity: input is required');
    }
    if (kind === 'custom') {
        if (!HEX64_ANY_CASE_RE.test(input)) {
            throw new Error('grantee-identity: custom granteeId must be 64 hex chars (32 bytes)');
        }
        return input.toLowerCase();
    }
    if (kind === 'wallet') {
        if (!/^[0-9a-fA-F]+$/.test(input) || input.length % 2 !== 0) {
            throw new Error('grantee-identity: wallet coin public key must be hex');
        }
        return bytesToHex(sha256(hexToBytes(input)));
    }
    return bytesToHex(sha256(new TextEncoder().encode(input)));
}

export interface ResolveGranteeIdOptions {
    /** Rows of this scope and global rows apply. Without a scope, only global rows apply. */
    scope?: string;
}

/** A row for the exact scope wins over a global row. */
export async function resolveGranteeId(
    req: cds.Request,
    db: DbRunner,
    opts: ResolveGranteeIdOptions = {}
): Promise<string | null> {
    const userId = req.user?.id;
    if (!userId) return null;

    const rows: GranteeIdentity[] =
        (await db.run(SELECT.from(GranteeIdentities).where({ userId }))) || [];
    if (rows.length === 0) return null;

    const norm = (s: string | null | undefined) => (s == null || s === '' ? null : s);

    if (opts.scope === undefined) {
        const global = rows.find(r => norm(r.scope) === null);
        return global ? global.granteeId : null;
    }

    const scoped = rows.find(r => norm(r.scope) === opts.scope);
    if (scoped) return scoped.granteeId;
    const global = rows.find(r => norm(r.scope) === null);
    return global ? global.granteeId : null;
}
