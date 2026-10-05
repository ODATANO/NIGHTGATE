/**
 * Disclosure to token holders. The issuer links a document's text to a token type.
 * A holder registered a claim key on chain and gets the text by showing the secret behind that key.
 * SPDX-License-Identifier: Apache-2.0
 */
import { holderDisclosureContentBinding } from '../../utils/envelope-bindings';
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { HolderDisclosureGrants, type HolderDisclosureGrant } from '#cds-models/midnight';
import { NightgateError } from '../../utils/errors';
import { encrypt, decrypt, getEncryptionKey } from '../../utils/crypto';
import { blake2b256Hex } from '../hashing';
import { HOLDER_REGISTRY_REF, holderClaimKey, readHolderRegistration } from '../holder-registry';
import { liveProviderConfigured, contractProvidersConfigFromEnv } from '../verify-state';
import { disclosureRateLimiter, holderClaimRateLimiter, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';
import { HEX64_ANY_CASE_RE } from '../../utils/hex-patterns';
import { claimDisclosure, grantDisclosureToHolders, revokeHolderDisclosure } from '#cds-models/NightgateService';

const { SELECT, INSERT, UPDATE } = cds.ql;

const MAX_CONTENT_CHARS = 1_048_576;
const MAX_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000;

const contentBinding = holderDisclosureContentBinding;

type ClaimAnswer = NonNullable<Awaited<ReturnType<typeof claimDisclosure>>>;

/** A claimDisclosure answer. Fields that do not apply to it are null. */
function claimAnswer(fields: Partial<ClaimAnswer> & Pick<ClaimAnswer, 'entitled'>): ClaimAnswer {
    return {
        reason: null, payloadHash: null, tokenType: null, registryAddress: null, holderGrantId: null,
        contentType: null, contentHashKind: null, content: null, expiresAt: null, registries: [], ...fields
    };
}

/** With one grant per grantor, prefer a grant with content, then the one that expires last. */
function preferredGrant(grants: HolderDisclosureGrant[]): HolderDisclosureGrant {
    const lifetime = (g: HolderDisclosureGrant) => (g.expiresAt ? Date.parse(g.expiresAt) : Number.POSITIVE_INFINITY);
    return [...grants].sort((a, b) => Number(Boolean(b.content)) - Number(Boolean(a.content)) || lifetime(b) - lifetime(a))[0];
}

function hex64(value: unknown): string | null {
    const v = String(value ?? '').trim().toLowerCase();
    return HEX64_ANY_CASE_RE.test(v) ? v : null;
}

function contentHashKind(content: string, payloadHash: string): 'blake2b-256' | 'sha256' | null {
    if (blake2b256Hex(content) === payloadHash) return 'blake2b-256';
    if (bytesToHex(sha256(new TextEncoder().encode(content))) === payloadHash) return 'sha256';
    return null;
}

export function registerHolderDisclosureActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'contractResolver'>): void {
    const { srv, db, contractResolver } = ctx;

    srv.on(grantDisclosureToHolders, async (req) => {
        const data = req.data;
        const payloadHash = hex64(data.payloadHash);
        if (!payloadHash) return req.reject(400, 'payloadHash is required');
        const tokenType = hex64(data.tokenType);
        if (!tokenType) return req.reject(400, 'tokenType is required');
        const registryAddress = String(data.registryAddress ?? '').trim().toLowerCase();
        if (!registryAddress) return req.reject(400, 'registryAddress is required (the holder-registry deployment)');
        const content = data.content === undefined || data.content === null ? '' : String(data.content);
        if (content.length > MAX_CONTENT_CHARS) return req.reject(400, `content: at most ${MAX_CONTENT_CHARS} characters`);
        const hashKind = content ? contentHashKind(content, payloadHash) : null;
        if (content && !hashKind) return req.reject(400, 'content does not hash to payloadHash (blake2b-256 or sha256 of the UTF-8 text)');
        let expiry: string | null = null;
        if (data.expiresAt) {
            const ms = Date.parse(String(data.expiresAt));
            if (!Number.isFinite(ms) || ms <= Date.now()) return req.reject(400, 'expiresAt must be an ISO timestamp in the future');
            if (ms - Date.now() > MAX_EXPIRY_MS) return req.reject(400, 'expiresAt: at most one year ahead');
            expiry = new Date(ms).toISOString();
        }
        if (!checkRate(disclosureRateLimiter, 'disclosure', req)) return;

        return runSubmission(req, async () => {
            const grantorUserId = String(req.user?.id ?? 'anonymous');
            const grantorGrantId = req.agentGrant?.ID ?? null;
            // One row per grantor. An agent of the same user can never overwrite the user's row or another agent's.
            const existing: HolderDisclosureGrant | null = await db.run(SELECT.one.from(HolderDisclosureGrants).where({ payloadHash, tokenType, registryAddress, grantorUserId, grantorGrantId, active: true }));
            const ID = existing?.ID ?? cds.utils.uuid();
            const now = new Date().toISOString();
            const stored = content ? encrypt(content, getEncryptionKey(), contentBinding(ID)) : null;
            const fields = {
                payloadHash, tokenType, registryAddress, grantorUserId, grantorGrantId,
                contentType: data.contentType ? String(data.contentType).slice(0, 100) : (existing?.contentType ?? (content ? 'text/plain' : null)),
                // An update without content keeps the stored content. Only expiry or type change.
                ...(content || !existing ? { contentHashKind: hashKind, content: stored } : {}),
                expiresAt: expiry, active: true, revokedAt: null, modifiedAt: now
            };
            if (existing) await db.run(UPDATE.entity(HolderDisclosureGrants).set(fields).where({ ID }));
            else await db.run(INSERT.into(HolderDisclosureGrants).entries({ ID, ...fields, createdAt: now }));
            return { holderGrantId: ID, payloadHash, tokenType, registryAddress, hasContent: !!(content || existing?.content), expiresAt: expiry, status: existing ? 'updated' : 'granted' };
        });
    });

    srv.on(revokeHolderDisclosure, async (req) => {
        const { holderGrantId } = req.data;
        if (!holderGrantId) return req.reject(400, 'holderGrantId is required');
        return runSubmission(req, async () => {
            const row: HolderDisclosureGrant | null = await db.run(SELECT.one.from(HolderDisclosureGrants).where({ ID: String(holderGrantId) }));
            if (!row) throw new NightgateError('NOT_FOUND', 'holder disclosure grant not found');
            const mine = req.agentGrant ? row.grantorGrantId === req.agentGrant.ID : row.grantorUserId === String(req.user?.id ?? '') && !row.grantorGrantId;
            if (!mine) throw new NightgateError('FORBIDDEN', 'only the grantor revokes a holder disclosure');
            if (row.active) await db.run(UPDATE.entity(HolderDisclosureGrants).set({ active: false, revokedAt: new Date().toISOString() }).where({ ID: row.ID }));
            return { holderGrantId: row.ID, status: 'revoked' };
        });
    });

    srv.on(claimDisclosure, async (req) => {
        const data = req.data;
        const payloadHash = hex64(data.payloadHash);
        if (!payloadHash) return req.reject(400, 'payloadHash is required');
        const tokenType = hex64(data.tokenType);
        if (!tokenType) return req.reject(400, 'tokenType is required');
        const claimSecret = hex64(data.claimSecret);
        if (!claimSecret) return req.reject(400, 'claimSecret is required');
        if (!liveProviderConfigured()) return req.reject(503, 'no live indexer configured to read the holder registry');
        if (!checkRate(holderClaimRateLimiter, 'holder-claim', req)) return;

        return runSubmission(req, async () => {
            const grants: HolderDisclosureGrant[] = await db.run(SELECT.from(HolderDisclosureGrants).where({ payloadHash, tokenType, active: true })) ?? [];
            const now = Date.now();
            const live = grants.filter(g => !g.expiresAt || Date.parse(g.expiresAt) > now);
            if (live.length === 0) {
                return claimAnswer({ entitled: false, reason: grants.length ? 'every holder disclosure of this payload and token type has expired' : 'no holder disclosure for this payload and token type', payloadHash, tokenType });
            }
            const claimKey = holderClaimKey(claimSecret);
            const resolved = await contractResolver(HOLDER_REGISTRY_REF);
            const registries = [...new Set(live.map(g => String(g.registryAddress)))];
            for (const registryAddress of registries) {
                const reading = await readHolderRegistration({
                    contractAddress: registryAddress, tokenType, claimKey,
                    artifactPath: resolved.artifactPath, contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
                });
                if (!reading?.registered) continue;
                const grant = preferredGrant(live.filter(g => String(g.registryAddress) === registryAddress));
                const content = grant.content ? decrypt(String(grant.content), getEncryptionKey(), contentBinding(String(grant.ID))) : null;
                return claimAnswer({
                    entitled: true, payloadHash, tokenType, registryAddress, holderGrantId: grant.ID,
                    contentType: grant.contentType ?? null, contentHashKind: grant.contentHashKind ?? null, content,
                    expiresAt: grant.expiresAt ?? null
                });
            }
            return claimAnswer({ entitled: false, reason: 'the claim key is not registered as a holder of this token type', payloadHash, tokenType, registries });
        });
    });
}
