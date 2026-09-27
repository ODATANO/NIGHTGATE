/**
 * Module-level helpers, command types and rate limits of the submission handlers.
 * SPDX-License-Identifier: Apache-2.0
 */
import { getArtifactGenerationDigest } from '../contract-registry';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason } from '../../utils/nightgate-config';
import { RateLimiter, principalRateKey } from '../../utils/rate-limiter';
import { withLockContentionRetry, WorkflowReconciliationRequiredError } from '../background-jobs';
import { SHA256_HEX_RE, UINT64_MAX } from '../verify-state';
import { effectiveSponsorPolicy, getGlobalSponsorPolicy, type SponsorPolicy } from '../sponsor-policy';
import { currentGrantPolicy } from '../../sessions/agent-grants';
import { formatErr } from '../../utils/format-error';
import { configInt } from '../../utils/config';
import type { DbRunner, TxCapableDb } from '../../utils/db-types';
import type { NightgateRequest } from '../../utils/request-types';
import { isNightgateError, NightgateError } from '../../utils/errors';

/**
 * Records a workflow step that is on chain. A write that still fails parks the parent for
 * reconciliation: the re-run reuses the landed child and repeats only this write.
 */
export async function recordProven(parentJobId: string, txHash: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await withLockContentionRetry(`recordProven(${parentJobId})`, write);
    } catch (err) {
        throw new WorkflowReconciliationRequiredError(
            `Workflow step of job ${parentJobId} is on chain (${txHash}) but recording it failed: ${(err as Error)?.message ?? err}`
        );
    }
}

/**
 * The sponsor policy resolved when the job RUNS, so a revoke or narrowed floor
 * applies to queued jobs. Revoked grant: permanent failure; unreadable policy file: retryable.
 */
export async function liveSponsorPolicyForJob(db: DbRunner, command: { grantId?: string | null }): Promise<SponsorPolicy> {
    const grant = command.grantId ? await currentGrantPolicy(db, command.grantId) : null;
    if (command.grantId && !grant) {
        throw new NightgateError('AGENT_GRANT_REVOKED', `agent grant ${command.grantId} is revoked; nothing was sponsored`);
    }
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
}

// Rate limits are keyed by principal plus a scope (session, or contract for reindex).
export const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
export const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
export const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
export const predicateRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
export const disclosureRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
export const registrarRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
export const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });
// Per caller, not per session: the sponsor pool pays the dust of every job.
export const sponsorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });
export const buildRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });

/** The vault asserts `valid_until` lies in (block time, block time + 5 years]. */
export const CLAIM_MAX_LIFETIME_S = 5 * 365 * 24 * 60 * 60;
export function claimDefaultLifetimeS(): number {
    const configured = configInt('NIGHTGATE_CLAIM_LIFETIME_S') ?? 365 * 24 * 60 * 60;
    return Math.min(configured, CLAIM_MAX_LIFETIME_S - 60);
}
export function claimValidUntil(requested?: number): bigint {
    return BigInt(requested ?? Math.floor(Date.now() / 1000) + claimDefaultLifetimeS());
}
/** Parses an optional caller `validUntil`; returns an error text for the 400. */
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
 * Per-call proof witness bundle. The cross-root circuits (`docPair`) need no
 * inclusion path, so `siblings`/`dirs` may be absent alongside it.
 */
export type MerkleProofBundle = {
    fieldValue?: string;
    /** Per-slot salt, 64 hex; required by every single-field proof. */
    fieldSalt?: string;
    fieldDigest?: string;
    siblings?: string[];
    dirs?: boolean[];
    setProof?: { siblings: string[]; dirs: boolean[] };
    docPair?: DocPairBundle;
};

/** One slot of the shared schema (wire form; matches document-proof.ts). */
export type SchemaSlotWire = { fieldKey: string; kind: number; scale: string };
/** One document's cross-root opening (wire form; witness material). */
export type OpeningWire = { saltSeed: string; slots: Array<{ present: boolean; value?: string; valueDigest?: string }> };

/** Cross-root witness bundle: shared schema + both documents' openings. */
export type DocPairBundle = {
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
};

/** One batch claim; `predicate` discriminates the kind. */
export type BatchClaimCommand = {
    predicateAttestationId: string; predicate: string; unit?: string;
    validUntil?: number;
    /** Absent only for the cross-root document kinds. */
    fieldKey?: string;
    /** Per-slot salt; required for the single-field kinds. */
    salt?: string;
    // numeric ('lessOrEqual' | 'greaterOrEqual')
    threshold?: string; opCode?: number; value?: string;
    // 'bytesEquality'
    expectedDigest?: string;
    // 'setMembership'
    setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
    // 'documentIntegrity' / 'documentDiff' (document A = the batch payloadHash)
    payloadHashB?: string; attesterIdB?: string; allowedMask?: number; k?: number;
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
    siblings?: string[]; dirs?: boolean[];
};

export type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string; recoveryId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle }
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
    // retract mode 0 = payload (owner; attesterId = the session's, for the local projection), 1 = expired claim
    | { op: 'retract'; mode: number; key: string; attesterId?: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

/**
 * The artifact generation stamped by startJob, verified fail-closed before
 * execution: the registry name alone is a mutable alias.
 */
export type ContractCommandV1WithProvenance = ContractCommandV1 & { artifactDigest?: string };

/** Parse a JSON Merkle inclusion path of fixed depth; rejects 400 and returns null on violation. */
export function parseInclusionPath(
    req: NightgateRequest,
    siblingsJson: string | undefined,
    dirsJson: string | undefined,
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
        if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) {
            req.reject(400, `each ${names.siblings} entry must be 64 hex chars (32 bytes)`); return null;
        }
    }
    for (const d of dirs) {
        // Strict: Boolean("false") is true and would corrupt the path.
        if (typeof d !== 'boolean') { req.reject(400, `${names.dirs} entries must be booleans`); return null; }
    }
    return { siblings: (siblings as string[]).map(s => s.toLowerCase()), dirs: dirs as boolean[] };
}

/** Validate a schema descriptor list; throws a user-facing message. */
export function validateSchemaSlots(schema: unknown, name: string, width = 16): SchemaSlotWire[] {
    if (!Array.isArray(schema) || schema.length !== width) {
        throw new Error(`${name} must be a JSON array of exactly ${width} slot descriptors`);
    }
    return schema.map((d: any, i: number) => {
        if (!d || typeof d !== 'object') throw new Error(`${name}[${i}] must be an object`);
        if (typeof d.fieldKey !== 'string' || !SHA256_HEX_RE.test(d.fieldKey)) {
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

/** Validate a cross-root document opening; throws a user-facing message. */
export function validateOpening(opening: unknown, name: string, width = 16): OpeningWire {
    const o = opening as any;
    if (!o || typeof o !== 'object') throw new Error(`${name} must be an object`);
    if (typeof o.saltSeed !== 'string' || !SHA256_HEX_RE.test(o.saltSeed)) {
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
            if (typeof s.valueDigest !== 'string' || !SHA256_HEX_RE.test(s.valueDigest)) {
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
 * True when the mask frees every real (non-padding) slot. The circuit rejects
 * such a claim; this gives a 400 before proving.
 */
export function isVacuousMask(allowedMask: number, schema: SchemaSlotWire[]): boolean {
    return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}

/** Parse a JSON schema/opening pair; rejects 400 and returns null on violation. */
/** `PredicateAttestations.threshold` is Integer64: a recorded claim's threshold stays below 2^63. */
export const INT64_MAX = 9223372036854775807n;

export function parseDocPairInputs(
    req: NightgateRequest,
    schemaJson: string | undefined,
    openingAJson: string | undefined,
    openingBJson: string | undefined,
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
 * WalletFacade config. Fail-closed on an invalid network: the CAP host stays
 * online after a rejected init, so this must refuse the fallback network itself.
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

/** Network id recorded on evidence rows; null when config is unresolvable. */
export function recordedNetworkId(): string | null {
    try { return facadeConfigFromEnv().networkId ?? null; } catch { return null; }
}

/** Artifact-generation digest recorded on evidence rows; null for an unregistered alias. */
export function artifactDigestOrNull(compiledRef: string): string | null {
    try { return getArtifactGenerationDigest(compiledRef); } catch { return null; }
}

/** Mainnet gate: rejects 403 and returns true when submission is not allowed. Call before any work. */
export function rejectIfMainnetBlocked(req: NightgateRequest): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

/**
 * Principal first, then the scope: the scope is caller input checked before
 * ownership, so alone it would let any user spend another's budget.
 */
export function rateKey(req: NightgateRequest, scope: string): string {
    return principalRateKey(req, scope);
}

export function checkRate(limiter: RateLimiter, scope: string, req: NightgateRequest, count = 1): boolean {
    // checkMany is all-or-nothing: a rejected batch consumes NO budget.
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

/** `Retry-After` on a retryable 503. `req.http` is absent outside an HTTP request (tests, programmatic calls). */
export function setRetryAfter(req: NightgateRequest, seconds: number): void {
    try { req.http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
}

/** Coded errors answer with their own status and code; anything else is a 500. */
export async function runSubmission(req: NightgateRequest, op: () => Promise<unknown>): Promise<unknown> {
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
