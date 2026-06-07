/**
 * Grantee-identity binding (Phase 0 of expose-disclosure-grants).
 *
 * The AttestationVault circuit keys disclosure grants by a 32-byte `grantee`.
 * To gate reads on an on-chain grant, NIGHTGATE must turn the authenticated
 * principal (`req.user.id`) into that same 32 bytes. This module owns:
 *
 *   1. `deriveGranteeId(kind, input)` — the canonical derivation. THE SAME
 *      function (or its documented scheme) must be used by whoever issues the
 *      grant, or the write-side id and the read-side id won't match.
 *   2. `resolveGranteeId(req, db, opts)` — look up the principal's registered
 *      granteeId from the `GranteeIdentities` table (scope precedence mirrors
 *      the disclosure-role middleware: a scoped row wins over a global one).
 *
 * Binding kind is per-deployment (`cds.requires.nightgate.granteeBinding`,
 * default 'wallet'). The principal→grantee *policy* (proving DID/wallet
 * ownership before a row is written) is the consumer's to own — NIGHTGATE
 * provides the table, derivation, and resolver, not the proofing.
 */
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { GranteeIdentities } from '#cds-models/midnight';
import { type GranteeBinding } from '../utils/nightgate-config';

const { SELECT } = cds.ql;

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Canonical derivation of a 64-hex grantee id from a binding input.
 *   - 'custom': `input` IS the 64-hex id (validated, lower-cased) — passthrough.
 *   - 'wallet': `input` is the coin public key hex; id = sha256(pubkey bytes).
 *   - 'did':    `input` is the DID string; id = sha256(utf8(did)).
 * sha256 is used (already a dependency) purely as a stable 32-byte digest; the
 * grantee id is an identifier, not a circuit witness.
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
    /**
     * Restricts the lookup to rows whose `scope` matches this value AND
     * globally-scoped rows (null/empty). If omitted, only global rows apply.
     * Typically the contract address (and/or payload hash) of the gated read.
     */
    scope?: string;
}

interface GranteeIdentityRow {
    granteeId: string;
    scope?: string | null;
}

/**
 * Resolve the authenticated principal's granteeId, or null when the principal
 * is anonymous or has no matching binding. Scope precedence: a row whose scope
 * equals `opts.scope` wins over a globally-scoped row.
 */
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

    // Prefer an exactly-scoped row; fall back to a global one.
    const scoped = rows.find(r => norm(r.scope) === opts.scope);
    if (scoped) return scoped.granteeId;
    const global = rows.find(r => norm(r.scope) === null);
    return global ? global.granteeId : null;
}

// Local hex→bytes (avoids importing the handler's copy; same semantics).
function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
