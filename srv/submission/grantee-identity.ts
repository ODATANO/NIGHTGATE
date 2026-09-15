/**
 * Maps a principal to the 32-byte `grantee` disclosure grants are keyed by.
 * Proving ownership of the DID/wallet before a row is written is the consumer's job.
 */
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { GranteeIdentities } from '#cds-models/midnight';
import { type GranteeBinding } from '../utils/nightgate-config';
import { hexToBytes } from '../utils/hex';

const { SELECT } = cds.ql;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * custom: the 64-hex id; wallet: sha256(coin pubkey bytes); did: sha256(utf8).
 * Grant issuers must use the same scheme or the ids will not match.
 */
export function deriveGranteeId(kind: GranteeBinding, input: string): string {
    if (input == null || input === '') {
        throw new Error('grantee-identity: input is required');
    }
    if (kind === 'custom') {
        if (!HEX64_RE.test(input)) {
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
    // 'did'
    return bytesToHex(sha256(new TextEncoder().encode(input)));
}

export interface ResolveGranteeIdOptions {
    /** Matching and global rows apply; omitted = global rows only. */
    scope?: string;
}

interface GranteeIdentityRow {
    granteeId: string;
    scope?: string | null;
}

/** The principal's granteeId or null; an exactly scoped row wins over a global one. */
export async function resolveGranteeId(
    req: cds.Request,
    db: any,
    opts: ResolveGranteeIdOptions = {}
): Promise<string | null> {
    const userId = (req as any).user?.id;
    if (!userId) return null;

    const rows: GranteeIdentityRow[] =
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
