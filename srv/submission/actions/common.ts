/**
 * Shared helpers, command types and rate limits for the submission handlers.
 * SPDX-License-Identifier: Apache-2.0
 */
import { getArtifactGenerationDigest } from '../contract-registry';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason } from '../../utils/nightgate-config';
import { RateLimiter, principalRateKey } from '../../utils/rate-limiter';
import { WorkflowReconciliationRequiredError } from '../background-jobs';
import { UINT64_MAX } from '../verify-state';
import { effectiveSponsorPolicy, getGlobalSponsorPolicy, type SponsorPolicy } from '../sponsor-policy';
import { currentGrantPolicy } from '../../sessions/agent-grants';
import { formatErr } from '../../utils/format-error';
import { configInt } from '../../utils/config';
import type { DbRunner, TxCapableDb } from '../../utils/db-types';
import type { ActionRequest } from '@sap/cds';
import { isNightgateError, NightgateError, errorMessage } from '../../utils/errors';
import { HEX64_ANY_CASE_RE } from '../../utils/hex-patterns';
import { withLockContentionRetry } from '../db-write-retry';

/**
 * Records a workflow step whose transaction is already on chain.
 * If the write keeps failing, the parent job is parked. Its re-run reuses the landed transaction and repeats only this write.
 */
export async function recordProven(parentJobId: string, txHash: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await withLockContentionRetry(`recordProven(${parentJobId})`, write);
    } catch (err) {
        throw new WorkflowReconciliationRequiredError(
            `Workflow step of job ${parentJobId} is on chain (${txHash}) but recording it failed: ${errorMessage(err)}`
        );
    }
}

/**
 * Reads the sponsor policy when the job runs, not when it was queued.
 * So a revoked grant or a tightened policy also applies to jobs already waiting.
 */
export async function liveSponsorPolicyForJob(db: DbRunner, command: { grantId?: string | null }): Promise<SponsorPolicy> {
    const grant = command.grantId ? await currentGrantPolicy(db, command.grantId) : null;
    if (command.grantId && !grant) {
        throw new NightgateError('AGENT_GRANT_REVOKED', `agent grant ${command.grantId} is revoked; nothing was sponsored`);
    }
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
}

// Each limit counts per caller and per scope. The scope is a session, or a contract for reindex.
export const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
export const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
export const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
export const predicateRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
export const disclosureRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
export const registrarRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
export const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });
// Counted per caller only, because the shared sponsor pool pays the dust for every job.
export const sponsorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });
export const swapOfferRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });
export const swapListRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 600 });
export const holderClaimRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });
export const buildRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });

/** The vault contract only accepts a `valid_until` after the block time and at most 5 years ahead. */
export const CLAIM_MAX_LIFETIME_S = 5 * 365 * 24 * 60 * 60;
export function claimDefaultLifetimeS(): number {
    const configured = configInt('NIGHTGATE_CLAIM_LIFETIME_S') ?? 365 * 24 * 60 * 60;
    return Math.min(configured, CLAIM_MAX_LIFETIME_S - 60);
}
export function claimValidUntil(requested?: number): bigint {
    return BigInt(requested ?? Math.floor(Date.now() / 1000) + claimDefaultLifetimeS());
}
/** Parses an optional caller `validUntil`. On bad input it returns the error text for a 400. */
export function parseValidUntil(raw: unknown): { validUntil?: number; error?: string } {
    if (raw === undefined || raw === null || raw === '') return {};
    const v = Number(raw);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(v)) return { error: 'validUntil must be an integer UNIX time in seconds' };
    if (v <= now + 60) return { error: 'validUntil must lie at least a minute in the future' };
    if (v > now + CLAIM_MAX_LIFETIME_S) return { error: `validUntil may lie at most ${CLAIM_MAX_LIFETIME_S} seconds (5 years) ahead; the vault refuses longer claims` };
    return { validUntil: v };
}

/**
 * Private proof inputs for one circuit call. Proofs that compare two documents
 * use `docPair` and need no Merkle path, so `siblings` and `dirs` may be missing.
 */
export type MerkleProofBundle = {
    fieldValue?: string;
    /** Salt of the field, 64 hex chars. Every single-field proof needs it. */
    fieldSalt?: string;
    fieldDigest?: string;
    siblings?: string[];
    dirs?: boolean[];
    setProof?: { siblings: string[]; dirs: boolean[] };
    docPair?: DocPairBundle;
};

/** Same shape as in document-proof.ts. */
export type SchemaSlotWire = { fieldKey: string; kind: number; scale: string };
/** The private field values of one document, used to prove a comparison of two documents. */
export type OpeningWire = { saltSeed: string; slots: Array<{ present: boolean; value?: string; valueDigest?: string }> };

export type DocPairBundle = {
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
};

export type BatchClaimCommand = {
    predicateAttestationId: string; predicate: string; unit?: string;
    validUntil?: number;
    /** Missing only for the claims that compare two documents. */
    fieldKey?: string;
    /** Salt of the field. Required for single-field claims. */
    salt?: string;
    // numeric ('lessOrEqual' | 'greaterOrEqual')
    threshold?: string; opCode?: number; value?: string;
    // 'bytesEquality'
    expectedDigest?: string;
    // 'setMembership'
    setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
    // 'documentIntegrity' and 'documentDiff'. Document A is the batch payloadHash.
    payloadHashB?: string; attesterIdB?: string; allowedMask?: number; k?: number;
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
    siblings?: string[]; dirs?: boolean[];
};

export type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string; recoveryId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle; mintedTokenType?: string }
    | { op: 'callBatch'; contractAddress: string; calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>; compiledArtifactRef: string; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle; independentCalls?: boolean; orderedPrefix?: number }
    | { op: 'fieldPredicateWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldEqualityWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; expectedDigest: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldMembershipWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; setRoot: string; valueDigest: string; salt: string; siblings: string[]; dirs: boolean[]; setSiblings: string[]; setDirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateBatchWorkflow'; payloadHash: string; attesterId: string; validUntil?: number; contractAddress: string; compiledArtifactRef: string; contentRoot?: string; schemaId?: string; claims: BatchClaimCommand[]; sponsorSessionId?: string }
    | { op: 'documentIntegrityWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHashA: string; payloadHashB: string; attesterIdA: string; attesterIdB: string; contractAddress: string; compiledArtifactRef: string; allowedMask: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'documentDiffWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHashA: string; payloadHashB: string; attesterIdA: string; attesterIdB: string; contractAddress: string; compiledArtifactRef: string; k: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'anchorDocument'; documentId: string; payloadHash: string; metadataHash: string; attesterId?: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'grantDisclosure'; disclosureGrantId: string; payloadHash: string; attesterId: string; grantee: string; level: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'revokeDisclosure'; payloadHash: string; attesterId: string; grantee: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'registerPassport'; passportId: string; ownerId: string; mode?: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    // Retract mode 0 removes the owner's own attestation. attesterId is the session's and is used for the local database update.
    // Mode 1 removes an expired claim.
    | { op: 'retract'; mode: number; key: string; attesterId?: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

/**
 * A command plus the digest of the exact contract build it was created for.
 * The registered name can later point to a different build, so the digest is checked before running.
 */
export type ContractCommandV1WithProvenance = ContractCommandV1 & { artifactDigest?: string };

/** Parses a JSON Merkle path of fixed depth. On bad input it rejects with 400 and returns null. */
export function parseInclusionPath(
    req: ActionRequest<unknown, unknown>,
    siblingsJson: string | null | undefined,
    dirsJson: string | null | undefined,
    depth: number,
    names: { siblings: string; dirs: string }
): { siblings: string[]; dirs: boolean[] } | null {
    let siblings: unknown;
    let dirs: unknown;
    try { siblings = JSON.parse(siblingsJson ?? '[]'); } catch { req.reject(400, `${names.siblings} must be a JSON array`); return null; }
    try { dirs = JSON.parse(dirsJson ?? '[]'); } catch { req.reject(400, `${names.dirs} must be a JSON array`); return null; }
    if (!Array.isArray(siblings) || siblings.length !== depth) {
        req.reject(400, `${names.siblings} must be a JSON array of ${depth} hashes`); return null;
    }
    if (!Array.isArray(dirs) || dirs.length !== depth) {
        req.reject(400, `${names.dirs} must be a JSON array of ${depth} booleans`); return null;
    }
    for (const s of siblings) {
        if (typeof s !== 'string' || !HEX64_ANY_CASE_RE.test(s)) {
            req.reject(400, `each ${names.siblings} entry must be 64 hex chars (32 bytes)`); return null;
        }
    }
    for (const d of dirs) {
        // Strict: Boolean("false") is true and would corrupt the path.
        if (typeof d !== 'boolean') { req.reject(400, `${names.dirs} entries must be booleans`); return null; }
    }
    return { siblings: (siblings as string[]).map(s => s.toLowerCase()), dirs: dirs as boolean[] };
}

export function validateSchemaSlots(schema: unknown, name: string, width = 16): SchemaSlotWire[] {
    if (!Array.isArray(schema) || schema.length !== width) {
        throw new Error(`${name} must be a JSON array of exactly ${width} slot descriptors`);
    }
    return schema.map((d: any, i: number) => {
        if (!d || typeof d !== 'object') throw new Error(`${name}[${i}] must be an object`);
        if (typeof d.fieldKey !== 'string' || !HEX64_ANY_CASE_RE.test(d.fieldKey)) {
            throw new Error(`${name}[${i}].fieldKey must be 64 hex chars (32 bytes)`);
        }
        if (d.kind !== 0 && d.kind !== 1 && d.kind !== 2) {
            throw new Error(`${name}[${i}].kind must be 0 (uint), 1 (bytes) or 2 (padding)`);
        }
        let scaleBig: bigint;
        try { scaleBig = BigInt(d.scale ?? '0'); } catch { throw new Error(`${name}[${i}].scale must be an integer (decimal string)`); }
        if (scaleBig < 0n || scaleBig > UINT64_MAX) throw new Error(`${name}[${i}].scale must fit Uint<64>`);
        return { fieldKey: d.fieldKey.toLowerCase(), kind: d.kind, scale: scaleBig.toString() };
    });
}

export function validateOpening(opening: unknown, name: string, width = 16): OpeningWire {
    const o = opening as any;
    if (!o || typeof o !== 'object') throw new Error(`${name} must be an object`);
    if (typeof o.saltSeed !== 'string' || !HEX64_ANY_CASE_RE.test(o.saltSeed)) {
        throw new Error(`${name}.saltSeed must be 64 hex chars (32 bytes)`);
    }
    if (!Array.isArray(o.slots) || o.slots.length !== width) {
        throw new Error(`${name}.slots must be a JSON array of exactly ${width} slot openings`);
    }
    const slots = o.slots.map((s: any, i: number) => {
        if (!s || typeof s !== 'object') throw new Error(`${name}.slots[${i}] must be an object`);
        if (typeof s.present !== 'boolean') throw new Error(`${name}.slots[${i}].present must be a boolean`);
        const out: { present: boolean; value?: string; valueDigest?: string } = { present: s.present };
        if (s.value !== undefined) {
            let v: bigint;
            try { v = BigInt(s.value); } catch { throw new Error(`${name}.slots[${i}].value must be an integer (decimal string)`); }
            if (v < 0n || v > UINT64_MAX) throw new Error(`${name}.slots[${i}].value must fit Uint<64>`);
            out.value = v.toString();
        }
        if (s.valueDigest !== undefined) {
            if (typeof s.valueDigest !== 'string' || !HEX64_ANY_CASE_RE.test(s.valueDigest)) {
                throw new Error(`${name}.slots[${i}].valueDigest must be 64 hex chars (32 bytes)`);
            }
            out.valueDigest = s.valueDigest.toLowerCase();
        }
        if (s.present && out.value === undefined && out.valueDigest === undefined) {
            throw new Error(`${name}.slots[${i}]: a present slot needs value or valueDigest`);
        }
        return out;
    });
    return { saltSeed: o.saltSeed.toLowerCase(), slots };
}

/**
 * True when the mask allows every real field to change, which makes the claim empty.
 * The circuit rejects such a claim, so this answers with a 400 before proving.
 */
export function isVacuousMask(allowedMask: number, schema: SchemaSlotWire[]): boolean {
    return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}

/** `PredicateAttestations.threshold` is an Integer64 column, so a stored threshold must stay below 2^63. */
export const INT64_MAX = 9223372036854775807n;

/** Parses the schema and both document inputs. On bad input it rejects with 400 and returns null. */
export function parseDocPairInputs(
    req: ActionRequest<unknown, unknown>,
    schemaJson: string | null | undefined,
    openingAJson: string | null | undefined,
    openingBJson: string | null | undefined,
    width = 16
): { schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire } | null {
    try {
        const schema = validateSchemaSlots(JSON.parse(schemaJson ?? ''), 'schemaJson', width);
        const openingA = validateOpening(JSON.parse(openingAJson ?? ''), 'openingAJson', width);
        const openingB = validateOpening(JSON.parse(openingBJson ?? ''), 'openingBJson', width);
        return { schema, openingA, openingB };
    } catch (e: unknown) {
        req.reject(400, e instanceof SyntaxError
            ? 'schemaJson / openingAJson / openingBJson must be valid JSON'
            : formatErr(e));
        return null;
    }
}

/**
 * WalletFacade config. Throws on an invalid network name.
 * The server keeps running after a failed init, so this must not fall back to a default network.
 */
export function facadeConfigFromEnv() {
    const nightgateConfig = getNightgatePluginConfig();
    const { network, nodeUrl, submissionEndpoints, invalidNetwork } = resolveNightgateRuntimeConfig(nightgateConfig);
    if (invalidNetwork) {
        throw new Error(
            `Invalid network "${invalidNetwork}"; refusing to submit against the "${network}" fallback. ` +
            `Fix NIGHTGATE_NETWORK / cds.requires.nightgate.network.`);
    }
    return {
        networkId: network as 'preprod' | 'testnet' | 'mainnet' | 'undeployed',
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        relayUrl: nodeUrl
    };
}

export function recordedNetworkId(): string | null {
    try { return facadeConfigFromEnv().networkId ?? null; } catch { return null; }
}

export function artifactDigestOrNull(compiledRef: string): string | null {
    try { return getArtifactGenerationDigest(compiledRef); } catch { return null; }
}

/** Rejects with 403 and returns true when mainnet submission is not allowed. Call it before any work. */
export function rejectIfMainnetBlocked(req: ActionRequest<unknown, unknown>): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

/**
 * The key starts with the caller's identity. The scope comes from the request and is not yet
 * checked for ownership, so a scope-only key would let one user use up another user's budget.
 */
export function rateKey(req: ActionRequest<unknown, unknown>, scope: string): string {
    return principalRateKey(req, scope);
}

export function checkRate(limiter: RateLimiter, scope: string, req: ActionRequest<unknown, unknown>, count = 1): boolean {
    // checkMany counts all or nothing. A rejected batch uses up no budget.
    const r = limiter.checkMany(rateKey(req, scope), count);
    if (!r.allowed) {
        req.reject?.(429, `Rate limited. Retry after ${Math.ceil(r.retryAfterMs / 1000)}s`);
        return false;
    }
    return true;
}

/**
 * Run `fn` in one transaction of `db` (commit on return, rollback on throw).
 * A test double without `tx` runs it directly, without atomicity.
 */
export async function runInOneTransaction<T>(db: TxCapableDb, fn: (tx: DbRunner) => Promise<T>): Promise<T> {
    if (typeof db?.tx === 'function') return db.tx(fn);
    return fn(db);
}

export function setRetryAfter(req: ActionRequest<unknown, unknown>, seconds: number): void {
    try { req.http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
}

export async function runSubmission<T>(req: ActionRequest<unknown, unknown>, op: () => Promise<T>): Promise<T> {
    try {
        return await op();
    } catch (err) {
        if (isNightgateError(err)) {
            if (err.code === 'JOB_ADMISSION_BUSY') setRetryAfter(req, (err as { retryAfterSeconds?: number }).retryAfterSeconds ?? 2);
            return req.reject(err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return req.reject(500, msg);
    }
}
