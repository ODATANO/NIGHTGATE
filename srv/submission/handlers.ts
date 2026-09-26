/**
 * Submission action handlers: validation, rate limits, artifact/session/sponsor
 * resolution and job admission. The SDK call itself lives in TransactionSubmitter.
 */

import cds, { Request } from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
    TransactionSubmitter,
    type TransactionSubmitterDeps
} from './TransactionSubmitter';
import {
    resolveContract,
    ContractNotRegisteredError,
    getArtifactGenerationDigest,
    assertArtifactGeneration,
    getContractRegistration,
    slotWidthOf,
    type ResolvedContract
} from './contract-registry';
import {
    buildWalletMaterialForSession,
    attesterIdForSession,
    SessionNotFoundError,
    WalletMaterialUnavailable
} from './wallet-material-factory';
import {
    resolveFeeSponsor,
    ensureFeeSponsorFacade,
    FeeSponsorError,
    type ResolvedFeeSponsor
} from './fee-sponsor';
import {
    coerceCircuitArgs,
    loadCircuitArgTypes,
    CoercionError
} from './arg-coercion';
import { resolveNightgateRuntimeConfig, type NightgateNetwork, VALID_NIGHTGATE_NETWORKS, resolveOverrideIndexerEndpoints, getConfiguredPrivateStateBackend, getNightgatePluginConfig, mainnetSubmissionBlockReason } from '../utils/nightgate-config';
import { RateLimiter, principalRateKey } from '../utils/rate-limiter';
import { ensureNetworkId, type ContractProvidersConfig } from '../midnight/providers';
import {
    deriveRawTokenType, TokenTypeError,
    SHIELDED_TEST_TOKEN_REF, SHIELDED_TEST_TOKEN_CIRCUIT, SHIELDED_TEST_TOKEN_AMOUNT
} from './token-type';
import { startJob, JobAdmissionBusyError, IdempotencyConflictError, runChildCommand, registerBackgroundJobProcessor, registerBackgroundJobReconciliationFinalizer, withLockContentionRetry, SponsorAttemptBookkeepingPendingError, WorkflowReconciliationRequiredError, type BackgroundJobRow, type ReconciliationEvidence } from './background-jobs';
import { reportSubmissionRejectedOn, reportBroadcastOn } from './job-execution-context';
import { declaredJobKindTraits } from './job-kinds';
import { reindexDisclosuresForContract } from './disclosure-indexer';
import { readAttestationStateForContract } from './attestation-state';
import {
    registerVerifyStateHandlers,
    SHA256_HEX_RE,
    DEFAULT_ATTESTATION_VAULT_REF,
    UINT64_MAX,
    vaultDims,
    parsePredicate,
    coerceMask,
    liveProviderConfigured,
    contractProvidersConfigFromEnv,
    contractProvidersConfigForNetwork,
    type PredicateKind
} from './verify-state';
import { readPredicateStateForContract, expandAllowedMask, computeRecordKey } from './predicate-state';
import { blake2b256Hex, loadPureCircuitsFromRegistry, PureCircuitsUnavailableError, agentOutputProducedAt } from './document-proof';
import { membershipPathFor, SET_DEPTH } from './set-root';
import { deriveGranteeId } from './grantee-identity';
import { getConfiguredGranteeBinding, isSelfServiceGranteeRegistrationAllowed } from '../utils/nightgate-config';
import { Documents, Transactions, TransactionResults, PredicateAttestations, DisclosureGrants, GranteeIdentities, PendingSubmissions, BackgroundJobs } from '#cds-models/midnight';
import { walletSponsorFinalizedTx, walletSponsorUnboundTx } from '../midnight/wallet-worker-client';
import {
    PLATFORM_POOL_SENTINEL, acquireSponsor, releaseSponsor, benchSponsor,
    decideSponsorFailure,
    sponsorCandidatesNonExclusive, touchSponsor
 } from './sponsor-pool';
import { resolveSponsorPolicyForRequest, effectiveSponsorPolicy, getGlobalSponsorPolicy, SponsorPolicyEmptyError, SponsorPolicyUnavailableError, type SponsorPolicy } from './sponsor-policy';
import { recordDeployedContracts, reserveDeployBudget, releaseDeployBudget, currentGrantPolicy, currentGrantRow, grantJobScopeViolation } from '../sessions/agent-grants';

/**
 * The sponsor policy resolved when the job RUNS, so a revoke or narrowed floor
 * applies to queued jobs. Revoked grant: permanent failure; unreadable policy file: retryable.
 */
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

async function liveSponsorPolicyForJob(db: any, command: { grantId?: string | null }): Promise<SponsorPolicy> {
    try {
        const grant = command.grantId ? await currentGrantPolicy(db, command.grantId) : null;
        if (command.grantId && !grant) {
            const err: any = new Error(`agent grant ${command.grantId} is revoked; nothing was sponsored`);
            err.code = 'AGENT_GRANT_REVOKED'; err.retryable = false;
            throw err;
        }
        return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
    } catch (e: any) {
        if (e instanceof SponsorPolicyUnavailableError || e instanceof SponsorPolicyEmptyError) {
            const err: any = new Error(e.message);
            err.code = e instanceof SponsorPolicyUnavailableError ? 'SPONSOR_POLICY_UNAVAILABLE' : 'SPONSOR_POLICY_EMPTY';
            err.retryable = e instanceof SponsorPolicyUnavailableError;
            err.cause = e;
            throw err;
        }
        throw e;
    }
}
import { getConfiguredFeeSponsorSessions } from './fee-sponsor';
import { sponsorAtSyncGate } from './sponsor-sync-gate';
import { hexToBytes } from '../utils/hex';
import { configInt, configMs, configNumber } from '../utils/config';

const { INSERT, UPDATE, SELECT, DELETE } = cds.ql;

// Rate limits are keyed by principal plus a scope (session, or contract for reindex).
const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
const predicateRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
const disclosureRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
const registrarRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });
// Per caller, not per session: the sponsor pool pays the dust of every job.
const sponsorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 120 });
const buildRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });

/** The vault asserts `valid_until` lies in (block time, block time + 5 years]. */
const CLAIM_MAX_LIFETIME_S = 5 * 365 * 24 * 60 * 60;
function claimDefaultLifetimeS(): number {
    const configured = configInt('NIGHTGATE_CLAIM_LIFETIME_S') ?? 365 * 24 * 60 * 60;
    return Math.min(configured, CLAIM_MAX_LIFETIME_S - 60);
}
function claimValidUntil(requested?: number): bigint {
    return BigInt(requested ?? Math.floor(Date.now() / 1000) + claimDefaultLifetimeS());
}
/** Parses an optional caller `validUntil`; returns an error text for the 400. */
function parseValidUntil(raw: unknown): { validUntil?: number; error?: string } {
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
type MerkleProofBundle = {
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
type SchemaSlotWire = { fieldKey: string; kind: number; scale: string };
/** One document's cross-root opening (wire form; witness material). */
type OpeningWire = { saltSeed: string; slots: Array<{ present: boolean; value?: string; valueDigest?: string }> };

/** Cross-root witness bundle: shared schema + both documents' openings. */
type DocPairBundle = {
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
};

/** One batch claim; `predicate` discriminates the kind. */
type BatchClaimCommand = {
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

type ContractCommandV1 =
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
type ContractCommandV1WithProvenance = ContractCommandV1 & { artifactDigest?: string };

/** Parse a JSON Merkle inclusion path of fixed depth; rejects 400 and returns null on violation. */
function parseInclusionPath(
    req: Request,
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
function validateSchemaSlots(schema: unknown, name: string, width = 16): SchemaSlotWire[] {
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
function validateOpening(opening: unknown, name: string, width = 16): OpeningWire {
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
function isVacuousMask(allowedMask: number, schema: SchemaSlotWire[]): boolean {
    return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}

/** Parse a JSON schema/opening pair; rejects 400 and returns null on violation. */
/** `PredicateAttestations.threshold` is Integer64: a recorded claim's threshold stays below 2^63. */
const INT64_MAX = 9223372036854775807n;

function parseDocPairInputs(
    req: Request,
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
    } catch (e: any) {
        req.reject(400, e instanceof SyntaxError
            ? 'schemaJson / openingAJson / openingBJson must be valid JSON'
            : String(e?.message ?? e));
        return null;
    }
}

/** Dependency overrides for tests. */
export interface SubmissionHandlersOptions {
    walletMaterialFactory?: typeof buildWalletMaterialForSession;
    attesterIdResolver?: typeof attesterIdForSession;
    resolveContractImpl?: typeof resolveContract;
    submitterFactory?: (deps: TransactionSubmitterDeps) => TransactionSubmitter;
    circuitArgTypesLoader?: typeof loadCircuitArgTypes;
    disclosureReindexer?: typeof reindexDisclosuresForContract;
    attestationStateReader?: typeof readAttestationStateForContract;
    predicateStateReader?: typeof readPredicateStateForContract;
    pureCircuitsLoader?: typeof loadPureCircuitsFromRegistry;
}

export function registerSubmissionHandlers(
    srv: cds.ApplicationService,
    // `any`: tests inject a minimal `{ run }` mock.
    db: any,
    options: SubmissionHandlersOptions = {}
): void {
    const walletFactory = options.walletMaterialFactory ?? buildWalletMaterialForSession;
    const attesterIdResolver = options.attesterIdResolver ?? attesterIdForSession;
    const contractResolver = options.resolveContractImpl ?? resolveContract;
    const submitterFactory = options.submitterFactory ?? ((deps: TransactionSubmitterDeps) => new TransactionSubmitter(deps));
    const argTypesLoader = options.circuitArgTypesLoader ?? loadCircuitArgTypes;
    const disclosureReindexer = options.disclosureReindexer ?? reindexDisclosuresForContract;
    const attestationStateReader = options.attestationStateReader ?? readAttestationStateForContract;
    const predicateStateReader = options.predicateStateReader ?? readPredicateStateForContract;
    const pureCircuitsLoader = options.pureCircuitsLoader ?? loadPureCircuitsFromRegistry;

    const executeContractCommand = async (raw: unknown, job: BackgroundJobRow): Promise<unknown> => {
        const command = raw as ContractCommandV1;
        if (!command || job.commandVersion !== 1 || !job.sessionId || !job.requestedBy) {
            throw new Error(`Invalid persisted contract command for job ${job.ID}`);
        }
        const callKinds = new Set(['submitContractCall', 'mintShieldedTestToken', 'fieldAnchorRoot', 'fieldPredicateProof', 'fieldEqualityProof', 'fieldMembershipProof', 'documentIntegrityProof', 'documentDiffProof']);
        if ((job.kind === 'deployContract' && command.op !== 'deploy')
            || (callKinds.has(job.kind) && command.op !== 'call')
            || (job.kind === 'submitContractCallBatch' && command.op !== 'callBatch')
            || (job.kind === 'fieldPredicateBatchProof' && command.op !== 'callBatch')
            || (job.kind === 'issueFieldPredicateAttestation' && command.op !== 'fieldPredicateWorkflow')
            || (job.kind === 'issueFieldEqualityAttestation' && command.op !== 'fieldEqualityWorkflow')
            || (job.kind === 'issueFieldMembershipAttestation' && command.op !== 'fieldMembershipWorkflow')
            || (job.kind === 'issueFieldPredicateAttestationBatch' && command.op !== 'fieldPredicateBatchWorkflow')
            || (job.kind === 'issueDocumentIntegrityAttestation' && command.op !== 'documentIntegrityWorkflow')
            || (job.kind === 'issueDocumentDiffAttestation' && command.op !== 'documentDiffWorkflow')
            || (job.kind === 'anchorDocument' && command.op !== 'anchorDocument')
            || (job.kind === 'grantDisclosure' && command.op !== 'grantDisclosure')
            || (job.kind === 'revokeDisclosure' && command.op !== 'revokeDisclosure')
            || (job.kind === 'registerPassport' && command.op !== 'registerPassport')
            || (job.kind === 'retract' && command.op !== 'retract')) {
            throw new Error(`Persisted command operation '${command.op}' is incompatible with ${job.kind}`);
        }

        // The alias is mutable: refuse a different artifact generation than the
        // command was created for, and refuse digest-less commands.
        {
            const cmd = command as ContractCommandV1WithProvenance;
            if (typeof (cmd as any).compiledArtifactRef === 'string') {
                assertArtifactGeneration(
                    (cmd as any).compiledArtifactRef,
                    cmd.artifactDigest,
                    `Persisted '${command.op}' command of job ${job.ID}`);
            }
        }
        // A grant is re-read when the job RUNS (children carry the parent's), so a
        // revoke, an expiry or a narrowed scope after admission stops a queued job.
        if (job.grantId) {
            const grant = await currentGrantRow(db, String(job.grantId));
            if (!grant) {
                const err: any = new Error(`agent grant ${job.grantId} is revoked or expired; the job was not executed`);
                err.code = 'AGENT_GRANT_REVOKED'; err.retryable = false;
                throw err;
            }
            let parentKind: string | null = null;
            if (job.parentJobId) {
                const parent: any = await db.run(SELECT.one.from(BackgroundJobs).columns('kind').where({ ID: job.parentJobId }));
                parentKind = parent?.kind ?? null;
            }
            const scope = grantJobScopeViolation(grant, { kind: job.kind, parentJobId: job.parentJobId, parentKind }, command as unknown as Record<string, unknown>);
            if (scope) {
                const err: any = new Error(`agent grant ${job.grantId}: ${scope}; the job was not executed`);
                err.code = 'AGENT_GRANT_SCOPE'; err.retryable = false;
                throw err;
            }
        }
        // Children inherit the parent's digest, so an alias re-pointed between
        // steps fails the child instead of mixing generations in one workflow.
        const parentArtifactDigest = (command as ContractCommandV1WithProvenance).artifactDigest;
        const runChild = <T,>(args: Parameters<typeof runChildCommand>[0]): Promise<T> => runChildCommand<T>({
            ...args,
            command: (args.command && typeof args.command === 'object'
                && typeof (args.command as any).compiledArtifactRef === 'string'
                && (args.command as any).artifactDigest === undefined)
                ? { ...(args.command as object), artifactDigest: parentArtifactDigest }
                : args.command
        });

        if (command.op === 'fieldPredicateWorkflow') {
            if (command.contentRoot) {
                await runChild({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot, command.schemaId], sponsorSessionId: command.sponsorSessionId }
                });
            }
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldPredicateProof', step: 'proveFieldPredicate', commandVersion: 1,
                request: { circuit: 'proveFieldPredicate', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldPredicate', compiledArtifactRef: command.compiledArtifactRef,
                    args: [await computeRecordKey(command.attesterId, command.payloadHash), command.fieldKey, command.threshold, String(command.opCode), String(claimValidUntil(command.validUntil))],
                    merkleProof: { fieldValue: command.value, fieldSalt: command.salt, siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await recordProven(job.ID, proof.txHash, () => db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId })));
            return {
                predicateAttestationId: command.predicateAttestationId, payloadHash: command.payloadHash, fieldKey: command.fieldKey,
                claim: { predicate: command.predicate, threshold: command.threshold, unit: command.unit ?? null },
                proof: { system: 'midnight-compact', circuit: 'proveFieldPredicate', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'fieldEqualityWorkflow') {
            if (command.contentRoot) {
                await runChild({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot, command.schemaId], sponsorSessionId: command.sponsorSessionId }
                });
            }
            // The digest is public (a circuit arg); only the path is witness material.
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldEqualityProof', step: 'proveFieldEquality', commandVersion: 1,
                request: { circuit: 'proveFieldEquality', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldEquality', compiledArtifactRef: command.compiledArtifactRef,
                    args: [await computeRecordKey(command.attesterId, command.payloadHash), command.fieldKey, command.expectedDigest, String(claimValidUntil(command.validUntil))],
                    merkleProof: { fieldSalt: command.salt, siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await recordProven(job.ID, proof.txHash, () => db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId })));
            return {
                predicateAttestationId: command.predicateAttestationId, payloadHash: command.payloadHash, fieldKey: command.fieldKey,
                claim: { predicate: 'bytesEquality', expectedDigest: command.expectedDigest },
                proof: { system: 'midnight-compact', circuit: 'proveFieldEquality', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'fieldMembershipWorkflow') {
            if (command.contentRoot) {
                await runChild({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot, command.schemaId], sponsorSessionId: command.sponsorSessionId }
                });
            }
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldMembershipProof', step: 'proveFieldMembership', commandVersion: 1,
                request: { circuit: 'proveFieldMembership', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldMembership', compiledArtifactRef: command.compiledArtifactRef,
                    args: [await computeRecordKey(command.attesterId, command.payloadHash), command.fieldKey, command.setRoot, String(claimValidUntil(command.validUntil))],
                    merkleProof: {
                        fieldDigest: command.valueDigest, fieldSalt: command.salt,
                        siblings: command.siblings, dirs: command.dirs,
                        setProof: { siblings: command.setSiblings, dirs: command.setDirs }
                    },
                    sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await recordProven(job.ID, proof.txHash, () => db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId })));
            return {
                predicateAttestationId: command.predicateAttestationId, payloadHash: command.payloadHash, fieldKey: command.fieldKey,
                claim: { predicate: 'setMembership', setRoot: command.setRoot },
                proof: { system: 'midnight-compact', circuit: 'proveFieldMembership', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'documentIntegrityWorkflow' || command.op === 'documentDiffWorkflow') {
            // Each optional anchor is its own transaction; the batch action's
            // document kinds do it in one.
            if (command.contentRootA) {
                await runChild({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRootA', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHashA },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHashA, command.contentRootA, command.schemaId], sponsorSessionId: command.sponsorSessionId }
                });
            }
            if (command.contentRootB) {
                await runChild({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRootB', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHashB },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHashB, command.contentRootB, command.schemaId], sponsorSessionId: command.sponsorSessionId }
                });
            }
            const recordKeyA = await computeRecordKey(command.attesterIdA, command.payloadHashA);
            const recordKeyB = await computeRecordKey(command.attesterIdB, command.payloadHashB);
            const isIntegrity = command.op === 'documentIntegrityWorkflow';
            // One mode-switched circuit for both kinds (each verifier key costs
            // deploy bytes); the inactive statement gets a neutral dummy (mask 0 / k 1).
            const proof: any = isIntegrity
                ? await runChild<any>({
                    parent: job, kind: 'documentIntegrityProof', step: 'proveDocumentComparison-integrity', commandVersion: 1,
                    request: { circuit: 'proveDocumentComparison', mode: 'integrity', payloadHashA: command.payloadHashA, payloadHashB: command.payloadHashB },
                    command: {
                        op: 'call', contractAddress: command.contractAddress, circuit: 'proveDocumentComparison', compiledArtifactRef: command.compiledArtifactRef,
                        args: [recordKeyA, recordKeyB, '0', String(command.allowedMask), '1', String(claimValidUntil(command.validUntil))],
                        merkleProof: { docPair: { schema: command.schema, openingA: command.openingA, openingB: command.openingB } }, sponsorSessionId: command.sponsorSessionId
                    }
                })
                : await runChild<any>({
                    parent: job, kind: 'documentDiffProof', step: 'proveDocumentComparison-diff', commandVersion: 1,
                    request: { circuit: 'proveDocumentComparison', mode: 'diff', payloadHashA: command.payloadHashA, payloadHashB: command.payloadHashB },
                    command: {
                        op: 'call', contractAddress: command.contractAddress, circuit: 'proveDocumentComparison', compiledArtifactRef: command.compiledArtifactRef,
                        args: [recordKeyA, recordKeyB, '1', '0', String(command.k), String(claimValidUntil(command.validUntil))],
                        merkleProof: { docPair: { schema: command.schema, openingA: command.openingA, openingB: command.openingB } }, sponsorSessionId: command.sponsorSessionId
                    }
                });
            const provenAt = new Date().toISOString();
            await recordProven(job.ID, proof.txHash, () => db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId })));
            return {
                predicateAttestationId: command.predicateAttestationId,
                payloadHashA: command.payloadHashA, payloadHashB: command.payloadHashB,
                claim: isIntegrity
                    ? { predicate: 'documentIntegrity', allowedMask: command.allowedMask }
                    : { predicate: 'documentDiff', k: command.k },
                proof: { system: 'midnight-compact', circuit: 'proveDocumentComparison', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'fieldPredicateBatchWorkflow') {
            // One transaction: an optional anchor first, then one proof call per
            // claim with its own witness bundle. A false claim fails at local proving.
            const calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }> = [];
            const recordKey = await computeRecordKey(command.attesterId, command.payloadHash);
            if (command.contentRoot) {
                calls.push({ circuit: 'anchorContentRoot', args: [command.payloadHash, command.contentRoot, command.schemaId] });
            }
            for (const claim of command.claims) {
                if (claim.predicate === 'documentIntegrity') {
                    calls.push({
                        circuit: 'proveDocumentComparison',
                        args: [recordKey, await computeRecordKey(claim.attesterIdB ?? command.attesterId, claim.payloadHashB!), '0', String(claim.allowedMask), '1', String(claimValidUntil(claim.validUntil ?? command.validUntil))],
                        merkleProof: { docPair: { schema: claim.schema, openingA: claim.openingA, openingB: claim.openingB } }
                    });
                } else if (claim.predicate === 'documentDiff') {
                    calls.push({
                        circuit: 'proveDocumentComparison',
                        args: [recordKey, await computeRecordKey(claim.attesterIdB ?? command.attesterId, claim.payloadHashB!), '1', '0', String(claim.k), String(claimValidUntil(claim.validUntil ?? command.validUntil))],
                        merkleProof: { docPair: { schema: claim.schema, openingA: claim.openingA, openingB: claim.openingB } }
                    });
                } else if (claim.predicate === 'bytesEquality') {
                    calls.push({
                        circuit: 'proveFieldEquality',
                        args: [recordKey, claim.fieldKey, claim.expectedDigest, String(claimValidUntil(claim.validUntil ?? command.validUntil))],
                        merkleProof: { fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs }
                    });
                } else if (claim.predicate === 'setMembership') {
                    calls.push({
                        circuit: 'proveFieldMembership',
                        args: [recordKey, claim.fieldKey, claim.setRoot, String(claimValidUntil(claim.validUntil ?? command.validUntil))],
                        merkleProof: {
                            fieldDigest: claim.valueDigest, fieldSalt: claim.salt,
                            siblings: claim.siblings, dirs: claim.dirs,
                            setProof: { siblings: claim.setSiblings!, dirs: claim.setDirs! }
                        }
                    });
                } else {
                    calls.push({
                        circuit: 'proveFieldPredicate',
                        args: [recordKey, claim.fieldKey, claim.threshold, String(claim.opCode), String(claimValidUntil(claim.validUntil ?? command.validUntil))],
                        merkleProof: { fieldValue: claim.value, fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs }
                    });
                }
            }
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldPredicateBatchProof', step: 'proveFieldPredicateBatch', commandVersion: 1,
                request: { circuits: calls.map(c => c.circuit), payloadHash: command.payloadHash, claimCount: command.claims.length },
                // The claims are a set (distinct claim keys, no shared cell); only
                // an in-batch anchor is a dependency and stays first.
                command: { op: 'callBatch', contractAddress: command.contractAddress, calls, compiledArtifactRef: command.compiledArtifactRef, sponsorSessionId: command.sponsorSessionId, independentCalls: true, orderedPrefix: calls[0]?.circuit === 'anchorContentRoot' ? 1 : 0 }
            });
            // One statement: the tx is on chain, a partial projection must be impossible.
            const provenAtBatch = new Date().toISOString();
            await recordProven(job.ID, proof.txHash, () => db.run(UPDATE.entity(PredicateAttestations)
                .set({ provenTxHash: proof.txHash, provenAt: provenAtBatch, modifiedAt: provenAtBatch })
                .where({ ID: { in: command.claims.map(c => c.predicateAttestationId) } })));
            return {
                payloadHash: command.payloadHash,
                claims: command.claims.map(c => ({
                    predicateAttestationId: c.predicateAttestationId, fieldKey: c.fieldKey,
                    claim: {
                        predicate: c.predicate,
                        ...(c.predicate === 'bytesEquality' ? { expectedDigest: c.expectedDigest }
                            : c.predicate === 'setMembership' ? { setRoot: c.setRoot }
                            : c.predicate === 'documentIntegrity' ? { payloadHashB: c.payloadHashB, allowedMask: c.allowedMask }
                            : c.predicate === 'documentDiff' ? { payloadHashB: c.payloadHashB, k: c.k }
                            : { threshold: c.threshold, unit: c.unit ?? null })
                    }
                })),
                proof: { system: 'midnight-compact', circuit: 'proveFieldPredicate', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);
        // Atomic: the resolver checks the digest against the snapshot it imports,
        // closing the window against a concurrent registerContract or overwrite.
        const resolved = await contractResolver(
            command.compiledArtifactRef,
            (command as ContractCommandV1WithProvenance).artifactDigest);
        const wallet = await walletFactory({
            sessionId: job.sessionId, db, facadeConfig: facadeCfg, expectedUserId: job.requestedBy
        });
        const sponsor = command.sponsorSessionId
            ? await resolveFeeSponsor({ db, sponsorSessionId: command.sponsorSessionId, requestingUserId: job.requestedBy, config: getNightgatePluginConfig() })
            : null;
        await wallet.ensureFacade?.();
        if (sponsor) await ensureFeeSponsorFacade(sponsor, facadeCfg);
        const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet, sponsor?.accountId));

        if (command.op === 'deploy') {
            const result = await submitter.deploy({
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                initialPrivateState: command.initialPrivateState,
                sessionId: job.sessionId,
                ...(command.recoveryId ? { recoveryId: command.recoveryId } : {})
            });
            return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'anchorDocument') {
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: 'attest',
                args: [hexToBytes(command.payloadHash), hexToBytes(command.metadataHash)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            const anchoredAt = new Date().toISOString();
            await db.run(UPDATE.entity(Documents).set({ anchoredTxHash: result.txHash, anchoredAt, modifiedAt: anchoredAt }).where({ ID: command.documentId }));
            return { documentId: command.documentId, attestationId: command.payloadHash, attesterId: command.attesterId ?? null, txHash: result.txHash, anchoredAt, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'grantDisclosure' || command.op === 'revokeDisclosure') {
            const isGrant = command.op === 'grantDisclosure';
            let result: { txHash: string; blockHeight?: number | null };
            try {
                result = await submitter.call({
                    contractAddress: command.contractAddress,
                    circuit: isGrant ? 'grantDisclosure' : 'revokeDisclosure',
                    args: isGrant
                        ? [hexToBytes(command.payloadHash), hexToBytes(command.grantee), BigInt(command.level)]
                        : [hexToBytes(command.payloadHash), hexToBytes(command.grantee)],
                    contractName: command.compiledArtifactRef,
                    registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                    sessionId: job.sessionId
                });
            } catch (err) {
                // Not taken by the chain: the confirmed level stays.
                if (isGrant) await clearPendingDisclosureLevel(command.disclosureGrantId, command.level);
                throw err;
            }
            const changedAt = new Date().toISOString();
            const landed = result.blockHeight ?? null;
            if (isGrant) {
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants)
                    .set(confirmedDisclosureLevel(command.level, result.txHash, changedAt, landed))
                    .where({ ID: command.disclosureGrantId }), landed));
            } else {
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants).set({ revokedTxHash: result.txHash, active: false, modifiedAt: changedAt, ...heightStamp(landed) }).where({ contractAddress: command.contractAddress, attesterId: command.attesterId, payloadHash: command.payloadHash, grantee: command.grantee }), landed));
            }
            await reindexAfterSubmit(command.contractAddress, resolved, landed, job, command.compiledArtifactRef);
            return { ...(isGrant ? { disclosureGrantId: command.disclosureGrantId, level: command.level } : {}), payloadHash: command.payloadHash, grantee: command.grantee, txHash: result.txHash };
        }

        if (command.op === 'registerPassport') {
            // Mode 0 assigns the id, 1 unregisters it, 2 transfers the registrar role,
            // 3 and 4 are the recovery identity re-pointing registrar / recovery.
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: 'registerDocument',
                args: [BigInt(command.mode ?? 0), hexToBytes(command.passportId), hexToBytes(command.ownerId)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            return { passportId: command.passportId, documentId: command.passportId, ownerId: command.ownerId, mode: command.mode ?? 0, contractAddress: command.contractAddress, txHash: result.txHash, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'retract') {
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: 'retract',
                args: [BigInt(command.mode), hexToBytes(command.key)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            if (command.mode === 0) {
                // The payload's grants left the chain with the attestation.
                const changedAt = new Date().toISOString();
                const landed = result.blockHeight ?? null;
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants).set({ active: false, revokedTxHash: result.txHash, modifiedAt: changedAt, ...heightStamp(landed) }).where({ contractAddress: command.contractAddress, attesterId: command.attesterId, payloadHash: command.key, active: true }), landed));
                await reindexAfterSubmit(command.contractAddress, resolved, landed, job, command.compiledArtifactRef);
            }
            return { mode: command.mode, key: command.key, contractAddress: command.contractAddress, txHash: result.txHash, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'callBatch') {
            // Raw JSON args were persisted; coerce per entry like the single-call tail.
            const coercedCalls = command.calls.map(c => {
                if (job.kind === 'fieldPredicateBatchProof') {
                    const args = c.circuit === 'anchorContentRoot'
                        ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), hexToBytes(String(c.args[2]))]
                        : (c.circuit === 'proveFieldEquality' || c.circuit === 'proveFieldMembership')
                            ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), hexToBytes(String(c.args[2])), BigInt(String(c.args[3]))]
                            : c.circuit === 'proveDocumentComparison'
                                ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), BigInt(String(c.args[2])), expandAllowedMask(Number(c.args[3]), vaultDims(command.compiledArtifactRef).width), BigInt(String(c.args[4])), BigInt(String(c.args[5]))]
                            : [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), BigInt(String(c.args[2])), BigInt(String(c.args[3])), BigInt(String(c.args[4]))];
                    return { circuit: c.circuit, args, merkleProof: c.merkleProof };
                }
                const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
                return { circuit: c.circuit, args: coerceCircuitArgs(c.args, argTypes), merkleProof: c.merkleProof };
            });
            const result = await submitter.callBatch({
                contractAddress: command.contractAddress,
                calls: coercedCalls,
                contractName: command.compiledArtifactRef,
                initialPrivateState: command.initialPrivateState,
                merkleProof: command.merkleProof,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId,
                independentCalls: command.independentCalls,
                orderedPrefix: command.orderedPrefix
            });
            return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, circuits: result.circuits, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if ((command as { op: string }).op === 'buildSponsorable') {
            // Build, sign and finalize under the caller's identity; no sponsor, no submit.
            const c = command as unknown as { contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[] };
            const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
            const coerced = coerceCircuitArgs(c.args, argTypes);
            const out = await submitter.buildSponsorable({
                contractAddress: c.contractAddress, circuit: c.circuit, args: coerced,
                contractName: c.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            return { ...out, contractAddress: c.contractAddress, circuit: c.circuit };
        }

        let coercedArgs: unknown[];
        if (job.kind === 'fieldAnchorRoot') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), hexToBytes(String(command.args[2]))];
        } else if (job.kind === 'fieldPredicateProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), BigInt(String(command.args[2])), BigInt(String(command.args[3])), BigInt(String(command.args[4]))];
        } else if (job.kind === 'fieldEqualityProof' || job.kind === 'fieldMembershipProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), hexToBytes(String(command.args[2])), BigInt(String(command.args[3]))];
        } else if (job.kind === 'documentIntegrityProof' || job.kind === 'documentDiffProof') {
            // The Vector<width, Boolean> mask arg expands from the packed integer.
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), BigInt(String(command.args[2])), expandAllowedMask(Number(command.args[3]), vaultDims(command.compiledArtifactRef).width), BigInt(String(command.args[4])), BigInt(String(command.args[5]))];
        } else {
            const argTypes = argTypesLoader(resolved.zkConfigPath, command.circuit);
            coercedArgs = coerceCircuitArgs(command.args, argTypes);
        }
        const result = await submitter.call({
            contractAddress: command.contractAddress,
            circuit: command.circuit,
            args: coercedArgs,
            contractName: command.compiledArtifactRef,
            initialPrivateState: command.initialPrivateState,
            merkleProof: command.merkleProof,
            registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
            sessionId: job.sessionId
        });
        return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
    };
    registerBackgroundJobProcessor('deployContract', 1, declaredJobKindTraits('deployContract'), executeContractCommand);
    registerBackgroundJobProcessor('submitContractCall', 1, declaredJobKindTraits('submitContractCall'), executeContractCommand);
    registerBackgroundJobProcessor('submitContractCallBatch', 1, declaredJobKindTraits('submitContractCallBatch'), executeContractCommand);
    // The result adds the token type, without which the minted coin cannot be spent.
    registerBackgroundJobProcessor('mintShieldedTestToken', 1, declaredJobKindTraits('mintShieldedTestToken'), async (raw, job) => {
        const result = await executeContractCommand(raw, job) as Record<string, unknown> | undefined;
        // The executor already rejected any op but 'call' for this kind.
        const command = raw as Extract<ContractCommandV1, { op: 'call' }>;
        const token = await deriveRawTokenType(String(command?.contractAddress ?? ''));
        return { ...(result ?? {}), tokenTypeHex: token.tokenTypeHex, amount: SHIELDED_TEST_TOKEN_AMOUNT.toString() };
    });
    registerBackgroundJobProcessor('issueFieldPredicateAttestation', 1, declaredJobKindTraits('issueFieldPredicateAttestation'), executeContractCommand);
    registerBackgroundJobProcessor('issueFieldEqualityAttestation', 1, declaredJobKindTraits('issueFieldEqualityAttestation'), executeContractCommand);
    registerBackgroundJobProcessor('issueFieldMembershipAttestation', 1, declaredJobKindTraits('issueFieldMembershipAttestation'), executeContractCommand);
    registerBackgroundJobProcessor('issueFieldPredicateAttestationBatch', 1, declaredJobKindTraits('issueFieldPredicateAttestationBatch'), executeContractCommand);
    registerBackgroundJobProcessor('issueDocumentIntegrityAttestation', 1, declaredJobKindTraits('issueDocumentIntegrityAttestation'), executeContractCommand);
    registerBackgroundJobProcessor('issueDocumentDiffAttestation', 1, declaredJobKindTraits('issueDocumentDiffAttestation'), executeContractCommand);
    registerBackgroundJobProcessor('buildSponsorableTx', 1, declaredJobKindTraits('buildSponsorableTx'), executeContractCommand);

    /**
     * Bookkeeping across broadcast attempts of a sponsoring job: the boundary is
     * crossed once, each attempt gets its own PendingSubmissions row, and a later
     * attempt first closes the previous one (REJECTED or REBUILT).
     */
    const sponsorAttemptLedger = (db: any, job: BackgroundJobRow, command: any, feeSponsorSessionId: () => string) => {
        let boundaryCrossed = false;
        let currentSubmissionId: string | null = null;
        let currentTxHash: string | null = null;
        // Kept across rebuilds; refunded only when an attempt is provably not on chain.
        let reservedDeploys = 0;
        const failPreviousAttempt = async (why: string, rejectedPreInclusion: boolean) => {
            if (!currentSubmissionId) return;
            // Row close, refund and taking the hash off the job are one transaction;
            // if it still fails, never rebuild on an unclosed attempt.
            const refund = rejectedPreInclusion && reservedDeploys > 0 && command?.grantId ? reservedDeploys : 0;
            const rowId = currentSubmissionId;
            const rowHash = currentTxHash ?? undefined;
            try {
                await withLockContentionRetry(`failSponsorAttempt(${job.ID})`, () => runInOneTransaction(db, async (tx) => {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ status: 'failed', errorCode: rejectedPreInclusion ? 'REJECTED' : 'REBUILT', errorMessage: why.slice(0, 500) }).where({ ID: rowId }));
                    if (refund > 0) await releaseDeployBudget(tx, String(command.grantId), refund);
                    if (rejectedPreInclusion) await reportSubmissionRejectedOn(tx, { submissionId: rowId, txHash: rowHash });
                }));
            } catch (e) {
                cds.log('nightgate').error(`sponsor attempt ${rowId} of job ${job.ID} could not be closed as ${rejectedPreInclusion ? 'REJECTED' : 'REBUILT'}${refund > 0 ? ` (deploy reservation of ${refund} NOT refunded)` : ''}; not retrying: ${String((e as Error)?.message ?? e)}`);
                if (rejectedPreInclusion) {
                    // settleRejectedSponsorAttempts re-runs the bookkeeping from this error
                    // code; generic reconciliation cannot, the hash never reached a mempool.
                    throw new SponsorAttemptBookkeepingPendingError(
                        `sponsoring attempt ${rowId} was rejected before inclusion but its bookkeeping (close, refund, hash) could not be committed: ${String((e as Error)?.message ?? e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                        { submissionId: rowId, txHash: rowHash, grantId: refund > 0 ? String(command.grantId) : undefined, refund });
                }
                throw new Error(`sponsoring attempt could not be closed (${String((e as Error)?.message ?? e)}); the job stops here for reconciliation instead of rebuilding on an open attempt. Original failure: ${why.slice(0, 200)}`);
            }
            if (refund > 0) reservedDeploys = 0;
            currentSubmissionId = null; currentTxHash = null;
        };
        // The intent carries what the worker chose (contract, circuits, backing,
        // payer), so a reconciled result can be rebuilt from the attempt row.
        const onSubmitIntent = () => async (txHash: string, intent?: { contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string }) => {
            const submissionId = cds.utils.uuid();
            const deployed = (intent?.deployed ?? []).map(String).filter(Boolean);
            const grantId = command?.grantId ? String(command.grantId) : null;
            // A deploy reserves grant budget before the ack lets the worker broadcast
            // (fail-closed), in the same transaction as the attempt row.
            const need = grantId && deployed.length > reservedDeploys ? deployed.length - reservedDeploys : 0;
            const coordinates = {
                feeSponsor: feeSponsorSessionId(), sponsorAccountId: intent?.sponsorAccountId ?? null,
                circuits: intent?.circuits ?? [], contractAddress: intent?.contractAddress ?? null,
                ...(intent?.note ? { note: intent.note } : {}),
                ...(intent?.ttl ? { ttl: intent.ttl } : {}),
                ...(deployed.length ? { deployed } : {}),
                ...(grantId && deployed.length ? { deployReservation: { grantId, count: deployed.length } } : {})
            };
            const row = {
                ID: submissionId, txHash, contractAddress: intent?.contractAddress ?? null, circuitName: intent?.circuits?.[0] ?? null,
                actionType: (deployed.length ? 'DEPLOY' : 'CALL') as 'DEPLOY' | 'CALL', submittedAt: new Date().toISOString(), status: 'pending' as const, sessionId: job.sessionId,
                submitIntentData: JSON.stringify(coordinates)
            };
            // The job transition shares the transaction: after a crash the job is running
            // with nothing reserved, or submitted with hash, row and reservation.
            let budgetExhausted: Error | null = null;
            await withLockContentionRetry(`sponsorAttempt(${job.ID})`, () => runInOneTransaction(db, async (tx) => {
                await tx.run(INSERT.into(PendingSubmissions).entries(row));
                if (need > 0) {
                    const ok = await reserveDeployBudget(tx, grantId!, need);
                    if (!ok) {
                        budgetExhausted = new Error(`deploy budget of the grant is exhausted or the grant no longer allows deploys (${deployed.length} deploy(s) in this transaction); not broadcasting`);
                        throw budgetExhausted;
                    }
                }
                await reportBroadcastOn(tx, { submissionId, txHash, firstBoundary: !boundaryCrossed });
            })).catch((e) => { throw budgetExhausted ?? e; });
            boundaryCrossed = true;
            if (grantId && deployed.length) reservedDeploys = deployed.length;
            currentSubmissionId = submissionId; currentTxHash = txHash;
        };
        const markIncluded = async (out: { contractAddress?: string; circuits?: string[] }) => {
            if (!currentSubmissionId) return;
            try { await db.run(UPDATE.entity(PendingSubmissions).set({ status: 'included', contractAddress: out.contractAddress ?? null, circuitName: out.circuits?.[0] ?? null }).where({ ID: currentSubmissionId })); } catch { /* best effort */ }
        };
        return { failPreviousAttempt, onSubmitIntent, markIncluded };
    };

    // Bound sponsoring job: no contract call of our own, just deserialize the
    // caller's finalized tx, enforce policy, pay dust, submit.
    const executeSponsorFinalized = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        // An explicit sponsor stays exact (grant pinning is a security boundary).
        let candidates: string[];
        if (command.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
            candidates = [...pool];
        } else {
            candidates = [String(command.sponsorSessionId)];
        }
        cds.log('nightgate').info(`sponsorFinalizedTransaction job: ${command.finalizedTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        const waitMs = configMs('NIGHTGATE_SPONSOR_LEASE_WAIT_MS');
        const cooldownMs = configMs('NIGHTGATE_SPONSOR_COOLDOWN_MS');
        const dustRetries = configNumber('NIGHTGATE_SPONSOR_DUST_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS');
        // One shared deadline: a fully busy pool queues instead of failing at once.
        const deadline = Date.now() + waitMs;
        let lastErr: unknown;
        while (candidates.length > 0) {
            let sessionId: string;
            try {
                sessionId = await acquireSponsor(candidates, Math.max(0, deadline - Date.now()), sponsorAtSyncGate);
            } catch (e) {
                throw lastErr ?? e; // pool stayed busy/cooling until the deadline
            }
            // Same-sponsor rebuilds on a dust race, then the pool decision.
            let outcome: 'next' | undefined;
            for (let attempt = 0; attempt <= dustRetries && outcome === undefined; attempt++) {
                try {
                    const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: sessionId, requestingUserId: job.requestedBy ?? undefined, config: getNightgatePluginConfig() });
                    await ensureFeeSponsorFacade(sponsor, facadeCfg);
                    activeSponsorSessionId = sponsor.sponsorSessionId;
                    const policy = await liveSponsorPolicyForJob(db, command);
                    const out = await walletSponsorFinalizedTx({
                        sponsorSessionId: sponsor.accountId,
                        finalizedTxB64: command.finalizedTxB64,
                        networkId: facadeCfg.networkId,
                        allowedContracts: policy.allowedContracts,
                        allowedCircuits: policy.allowedCircuits,
                        allowDeploy: policy.allowDeploy === true,
                        ownContracts: policy.ownContracts,
                        allowedTokenTypes: policy.allowedTokenTypes
                    }, ledger.onSubmitIntent());
                    await ledger.markIncluded(out);
                    releaseSponsor(sessionId);
                    if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                    return { ...out, feeSponsor: sponsor.sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    // Ambiguous or on-chain: the job runner reconciles or fails it.
                    if (verdict.decision === 'ambiguous' || verdict.decision === 'landed-not-applied') { releaseSponsor(sessionId); throw e; }
                    // Everything else builds a NEW transaction: close this attempt's row.
                    try {
                        await ledger.failPreviousAttempt(String((e as Error)?.message ?? e), verdict.preInclusion);
                    } catch (closeErr) {
                        releaseSponsor(sessionId);
                        throw closeErr;
                    }
                    if (verdict.decision === 'dust-rebuild') {
                        const budget = verdict.generic ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} hit a dust race, rebuild-retry ${attempt + 1}/${budget} on the same sponsor: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue;
                        }
                        // Rebuilds exhausted: a coded race may clear on the next
                        // wallet, a pool Invalid is the caller's transaction.
                        if (verdict.generic) { releaseSponsor(sessionId); throw e; }
                    } else if (verdict.decision === 'fail') {
                        releaseSponsor(sessionId);
                        cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
                        throw e; // fails identically on every sponsor; do not burn the pool
                    }
                    // Bench on every failover so the next job skips this sponsor too.
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed over (${String((e as Error).message).slice(0, 120)})`);
                    candidates = candidates.filter(c => c !== sessionId);
                    outcome = 'next';
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };

    /**
     * Reconciliation finalizer for both sponsoring channels: records deployed
     * addresses from the attempt row once inclusion is proven. A reconciled chain
     * failure keeps its reservation; refunds only cover txs that never reached the chain.
     */
    const finalizeSponsoredSubmission = async (raw: unknown, _job: BackgroundJobRow, evidence: ReconciliationEvidence): Promise<unknown> => {
        const command = raw as { grantId?: string; sponsorSessionId?: string };
        const submission: any = evidence.submissionId
            ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: evidence.submissionId }))
            : await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: evidence.txHash }));
        let coordinates: any = {};
        try { coordinates = submission?.submitIntentData ? JSON.parse(submission.submitIntentData) : {}; } catch { coordinates = {}; }
        const deployed: string[] = Array.isArray(coordinates.deployed) ? coordinates.deployed.map(String) : [];
        const grantId = coordinates.deployReservation?.grantId ?? command?.grantId;
        if (deployed.length && grantId) await recordDeployedContracts(db, String(grantId), deployed);
        return {
            reconciled: true, ...evidence, status: 'finalized',
            circuits: Array.isArray(coordinates.circuits) ? coordinates.circuits : [],
            contractAddress: coordinates.contractAddress ?? evidence.contractAddress ?? '',
            ...(coordinates.note ? { note: coordinates.note } : {}),
            ...(deployed.length ? { deployed } : {}),
            feeSponsor: coordinates.feeSponsor ?? command?.sponsorSessionId ?? _job.sessionId
        };
    };
    registerBackgroundJobReconciliationFinalizer('sponsorFinalizedTransaction', 1, finalizeSponsoredSubmission);
    registerBackgroundJobReconciliationFinalizer('sponsorUnboundTransaction', 1, finalizeSponsoredSubmission);

    registerBackgroundJobProcessor('sponsorFinalizedTransaction', 1, declaredJobKindTraits('sponsorFinalizedTransaction'), executeSponsorFinalized);

    // No exclusive wallet lease: per-note locking in the worker lets many jobs
    // share one wallet; this loop only spreads load and fails over.
    const executeSponsorUnbound = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        let candidates: string[];
        if (command.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
            candidates = sponsorCandidatesNonExclusive(pool, Date.now(), sponsorAtSyncGate);
        } else {
            candidates = [String(command.sponsorSessionId)];
        }
        const cooldownMs = configMs('NIGHTGATE_SPONSOR_COOLDOWN_MS');
        // A dust race is not sponsor health: rebuild on the same sponsor after a
        // backoff (the rebuild succeeds only once the local dust wallet applied the
        // lost spend). Only a non-dust retryable failure benches and fails over.
        const dustRetries = configNumber('NIGHTGATE_SPONSOR_DUST_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS');
        cds.log('nightgate').info(`sponsorUnboundTransaction job: ${command.unboundTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        let lastErr: unknown;
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const { failPreviousAttempt, onSubmitIntent } = ledger;
        for (const sessionId of candidates) {
            // Touch before the first await: concurrent jobs order candidates in the
            // same tick and would otherwise all pick the same wallet.
            touchSponsor(sessionId);
            for (let attempt = 0; attempt <= dustRetries; attempt++) {
                try {
                    const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: sessionId, requestingUserId: job.requestedBy ?? undefined, config: getNightgatePluginConfig() });
                    await ensureFeeSponsorFacade(sponsor, facadeCfg);
                    activeSponsorSessionId = sponsor.sponsorSessionId;
                    const policy = await liveSponsorPolicyForJob(db, command);
                    const out = await walletSponsorUnboundTx({
                        sponsorSessionId: sponsor.accountId,
                        unboundTxB64: command.unboundTxB64,
                        networkId: facadeCfg.networkId,
                        allowedContracts: policy.allowedContracts,
                        allowedCircuits: policy.allowedCircuits,
                        allowDeploy: policy.allowDeploy === true,
                        ownContracts: policy.ownContracts,
                        allowedTokenTypes: policy.allowedTokenTypes
                    }, onSubmitIntent());
                    await ledger.markIncluded(out);
                    if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                    return { ...out, feeSponsor: sponsor.sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    if (verdict.decision === 'ambiguous') {
                        // May still be included: no rebuild (two fees could land);
                        // the indexer confirmer resolves the job by identifier.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: ambiguous submit outcome, leaving the job for reconciliation: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    if (verdict.decision === 'landed-not-applied') {
                        // Landed but not applied: the caller's transcript is stale,
                        // which no sponsor-side rebuild fixes. The job fails terminally.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: sponsored call landed but did not apply (caller transcript stale); not retrying: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    await failPreviousAttempt(String((e as Error)?.message ?? e), verdict.preInclusion);
                    if (verdict.decision === 'dust-rebuild') {
                        // Generic pool-Invalid: one rebuild only (it may be the caller's tx).
                        const budget = verdict.generic ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} hit a dust race (1010/170|171|196 or pool Invalid), rebuild-retry ${attempt + 1}/${budget}: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue; // rebuild the dust spend fresh on the SAME sponsor
                        }
                        // Exhausted: the caller's transaction is losing, not the sponsor; no bench.
                        throw e;
                    }
                    if (verdict.decision === 'fail') {
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
                        throw e;
                    }
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed over (${String((e as Error).message).slice(0, 120)})`);
                    break; // fail over to the next candidate
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };
    // Runs in parallel: the worker proves and submits unbound jobs outside the
    // per-facade submit lock, so N jobs overlap on N dust backings. The dust-wedge
    // snapshot/restore is for the bound paths only.
    registerBackgroundJobProcessor('sponsorUnboundTransaction', 1, declaredJobKindTraits('sponsorUnboundTransaction'), executeSponsorUnbound);

    registerBackgroundJobProcessor('anchorDocument', 1, declaredJobKindTraits('anchorDocument'), executeContractCommand);
    registerBackgroundJobProcessor('grantDisclosure', 1, declaredJobKindTraits('grantDisclosure'), executeContractCommand);
    registerBackgroundJobProcessor('revokeDisclosure', 1, declaredJobKindTraits('revokeDisclosure'), executeContractCommand);
    registerBackgroundJobProcessor('registerPassport', 1, declaredJobKindTraits('registerPassport'), executeContractCommand);
    registerBackgroundJobProcessor('retract', 1, declaredJobKindTraits('retract'), executeContractCommand);
    registerBackgroundJobProcessor('reindexDisclosures', 1, declaredJobKindTraits('reindexDisclosures'), executeReindexDisclosures);
    for (const childKind of ['fieldAnchorRoot', 'fieldPredicateProof', 'fieldEqualityProof', 'fieldMembershipProof', 'fieldPredicateBatchProof', 'documentIntegrityProof', 'documentDiffProof']) {
        registerBackgroundJobProcessor(childKind, 1, declaredJobKindTraits(childKind), executeContractCommand);
    }

    const finalizeContractProjection = async (
        raw: unknown,
        _job: BackgroundJobRow,
        evidence: ReconciliationEvidence
    ): Promise<unknown> => {
        const command = raw as ContractCommandV1;
        // Same provenance gate as the executor: reconciliation can run long after
        // submission, against a re-pointed alias.
        if (typeof (command as any).compiledArtifactRef === 'string') {
            assertArtifactGeneration(
                (command as any).compiledArtifactRef,
                (command as ContractCommandV1WithProvenance).artifactDigest,
                `Reconciled '${command.op}' command of job ${_job.ID}`);
        }
        const changedAt = evidence.finalizedAt ?? new Date().toISOString();
        if (command.op === 'anchorDocument') {
            await db.run(UPDATE.entity(Documents).set({
                anchoredTxHash: evidence.txHash, anchoredAt: changedAt, modifiedAt: changedAt
            }).where({ ID: command.documentId }));
            return {
                reconciled: true, documentId: command.documentId,
                attestationId: command.payloadHash, txHash: evidence.txHash, anchoredAt: changedAt,
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        if (command.op === 'grantDisclosure' || command.op === 'revokeDisclosure') {
            const isGrant = command.op === 'grantDisclosure';
            const landed = evidence.blockHeight ?? null;
            if (isGrant) {
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants)
                    .set(confirmedDisclosureLevel(command.level, evidence.txHash, changedAt, landed))
                    .where({ ID: command.disclosureGrantId }), landed));
            } else {
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants).set({
                    revokedTxHash: evidence.txHash, active: false, modifiedAt: changedAt, ...heightStamp(landed)
                }).where({
                    contractAddress: command.contractAddress,
                    attesterId: command.attesterId,
                    payloadHash: command.payloadHash,
                    grantee: command.grantee
                }), landed));
            }
            // Atomic generation binding, as in the executor.
            const resolved = await contractResolver(
                command.compiledArtifactRef,
                (command as ContractCommandV1WithProvenance).artifactDigest);
            await reindexAfterSubmit(command.contractAddress, resolved, evidence.blockHeight ?? null, _job, command.compiledArtifactRef);
            return {
                reconciled: true,
                ...(isGrant ? { disclosureGrantId: command.disclosureGrantId, level: command.level } : {}),
                payloadHash: command.payloadHash, grantee: command.grantee, txHash: evidence.txHash
            };
        }
        if (command.op === 'registerPassport') {
            return {
                reconciled: true, passportId: command.passportId, documentId: command.passportId, ownerId: command.ownerId, mode: command.mode ?? 0,
                contractAddress: command.contractAddress, txHash: evidence.txHash,
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        if (command.op === 'retract') {
            if (command.mode === 0) {
                // Same projection as the executor; idempotent.
                const changedAt = new Date().toISOString();
                const landed = evidence.blockHeight ?? null;
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants).set({ active: false, revokedTxHash: evidence.txHash, modifiedAt: changedAt, ...heightStamp(landed) }).where({ contractAddress: command.contractAddress, attesterId: command.attesterId, payloadHash: command.key, active: true }), landed));
                const resolved = await contractResolver(
                    command.compiledArtifactRef,
                    (command as ContractCommandV1WithProvenance).artifactDigest);
                await reindexAfterSubmit(command.contractAddress, resolved, landed, _job, command.compiledArtifactRef);
            }
            return {
                reconciled: true, mode: command.mode, key: command.key,
                contractAddress: command.contractAddress, txHash: evidence.txHash,
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        if (command.op === 'callBatch') {
            // The generic recovery result would miss `circuits`.
            return {
                reconciled: true,
                submissionId: evidence.submissionId,
                txHash: evidence.txHash,
                contractAddress: evidence.contractAddress ?? command.contractAddress,
                circuits: command.calls.map(c => c.circuit),
                status: 'finalized',
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        throw new Error(`Unsupported projection finalizer operation '${(command as any)?.op}'`);
    };
    registerBackgroundJobReconciliationFinalizer('anchorDocument', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('grantDisclosure', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('revokeDisclosure', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('registerPassport', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('retract', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('submitContractCallBatch', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('fieldPredicateBatchProof', 1, finalizeContractProjection);

    srv.on('deployContract', async (req: Request) => {
        const { compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey, sponsorSessionId } = req.data as {
            compiledArtifactRef?: string;
            sessionId?: string;
            initialPrivateState?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };
        const recoveryId = typeof (req.data as any).recoveryId === 'string' && (req.data as any).recoveryId.length > 0
            ? String((req.data as any).recoveryId).toLowerCase()
            : undefined;

        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (recoveryId !== undefined && !SHA256_HEX_RE.test(recoveryId)) return req.reject(400, 'recoveryId must be 64 hex chars (32 bytes)');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(deployRateLimiter, sessionId, req)) return;

        let parsedInitialState: unknown = {};
        if (initialPrivateState) {
            try { parsedInitialState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledArtifactRef);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'deployContract',
                sessionId,
                idempotencyKey,
                request: { compiledArtifactRef, sessionId, hasInitialState: !!initialPrivateState, feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {}) },
                idempotencyPayload: {
                    compiledArtifactRef, sessionId, initialPrivateState: parsedInitialState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null, ...(recoveryId ? { recoveryId } : {})
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'deploy', compiledArtifactRef, initialPrivateState: parsedInitialState, sponsorSessionId: sponsor?.sponsorSessionId, ...(recoveryId ? { recoveryId } : {}) }
            });
        });
    });

    srv.on('submitContractCall', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey, initialPrivateState, sponsorSessionId } = req.data as {
            contractAddress?: string;
            circuit?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            args?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
            sponsorSessionId?: string;
        };

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        let parsedArgs: unknown[] = [];
        if (args) {
            try {
                const v = JSON.parse(args);
                if (!Array.isArray(v)) return req.reject(400, 'args must be a JSON array');
                parsedArgs = v;
            } catch {
                return req.reject(400, 'args must be valid JSON');
            }
        }

        // Used only when the wallet has no private state for this contract yet.
        let parsedInitialPrivateState: unknown;
        if (initialPrivateState) {
            try { parsedInitialPrivateState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);

            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            const coercedArgs = coerceCircuitArgs(parsedArgs, argTypes);

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'submitContractCall',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId, argCount: coercedArgs.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuit, compiledArtifactRef, sessionId,
                    args: parsedArgs, initialPrivateState: parsedInitialPrivateState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'call', contractAddress, circuit, compiledArtifactRef, args: parsedArgs, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId }
            });
        });
    });

    // A generic call would leave the caller without the fixture's domain
    // separator, which the token type derives from.
    srv.on('mintShieldedTestToken', async (req: Request) => {
        const { contractAddress, sessionId, compiledArtifactRef, idempotencyKey, sponsorSessionId } = req.data as {
            contractAddress?: string; sessionId?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required (deploy shielded-token first)');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        // The result uses the fixture's separator and amount, so a foreign
        // contract would be reported with a wrong tokenTypeHex.
        if (compiledArtifactRef && compiledArtifactRef !== SHIELDED_TEST_TOKEN_REF) {
            return req.reject(400,
                `mintShieldedTestToken only mints the bundled '${SHIELDED_TEST_TOKEN_REF}' fixture; `
                + `for other contracts use submitContractCall and deriveTokenType with the contract's own domain separator`);
        }
        const artifactRef = SHIELDED_TEST_TOKEN_REF;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(artifactRef);
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            return startJob({
                kind: 'mintShieldedTestToken',
                sessionId,
                idempotencyKey,
                request: { contractAddress, compiledArtifactRef: artifactRef, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                // The contract's round counter feeds the nonce: repeat calls mint distinct coins.
                command: {
                    op: 'call', contractAddress, circuit: SHIELDED_TEST_TOKEN_CIRCUIT,
                    compiledArtifactRef: artifactRef, args: [],
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
        });
    });

    // Compute-only; not restricted to the bundled token.
    srv.on('deriveTokenType', async (req: Request) => {
        const { contractAddress, domainSeparator } = req.data as {
            contractAddress?: string; domainSeparator?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        try {
            return await deriveRawTokenType(contractAddress, domainSeparator);
        } catch (e) {
            if (e instanceof TokenTypeError) return req.reject(400, e.message);
            throw e;
        }
    });

    // Sponsoring phase 1, server-side: build, sign and finalize under the
    // caller's identity; the job result is the fee-unpaid tx.
    srv.on('buildSponsorable', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args } = req.data as {
            contractAddress?: string; circuit?: string; compiledArtifactRef?: string; sessionId?: string; args?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(buildRateLimiter, sessionId, req)) return;
        let parsedArgs: unknown[] = [];
        if (args) { try { const v = JSON.parse(args); if (!Array.isArray(v)) return req.reject(400, 'args must be a JSON array'); parsedArgs = v; } catch { return req.reject(400, 'args must be valid JSON'); } }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);
            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            coerceCircuitArgs(parsedArgs, argTypes); // validate now -> 400
            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            return startJob({
                kind: 'buildSponsorableTx', sessionId,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'buildSponsorable', contractAddress, circuit, compiledArtifactRef, args: parsedArgs }
            });
        });
    });

    // Sponsoring phase 2: policy check, dust from the sponsor, submit.
    srv.on('sponsorFinalizedTransaction', async (req: Request) => {
        const { finalizedTxB64, sponsorSessionId, idempotencyKey } = req.data as {
            finalizedTxB64?: string; sponsorSessionId?: string; idempotencyKey?: string;
        };
        if (!finalizedTxB64) return req.reject(400, 'finalizedTxB64 is required');
        // The pool sentinel defers the concrete sponsor to execution (failover).
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) {
                return req.reject(400, 'sponsorSessionId is required (the wallet that pays dust); no platform pool is configured');
            }
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(sponsorRateLimiter, 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            // Explicit sponsor: row-level check only (the slow facade restore is the
            // executor's). Pool jobs check nothing and key under the sentinel, so a
            // broken member cannot block admission and the idempotency key is stable.
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: (req as any).user?.id, config: getNightgatePluginConfig() });
            }
            // Floor narrowed by the grant; an empty intersection or unusable policy
            // file refuses before a job exists.
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes } = resolveSponsorPolicyForRequest(req);
            // A sponsored deploy's address is recorded onto this grant.
            const grantId: string | undefined = (req as any).agentGrant?.ID ? String((req as any).agentGrant.ID) : undefined;
            // Per-caller key: sponsors are shared, so a raw key would let one
            // caller's key dedupe or block another's.
            const caller = String((req as any).user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorFinalizedTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                // Fingerprint the content: equal-size txs under one key must not dedupe.
                request: {
                    feeSponsor: effectiveSponsor,
                    caller,
                    bytes: finalizedTxB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(finalizedTxB64, 'base64')))
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorFinalized', finalizedTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, grantId }
            });
            // Keyed by the sponsor session, which the caller needs to poll.
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    // As sponsorFinalizedTransaction, for an unbound caller tx.
    srv.on('sponsorUnboundTransaction', async (req: Request) => {
        const { unboundTxB64, sponsorSessionId, idempotencyKey } = req.data as {
            unboundTxB64?: string; sponsorSessionId?: string; idempotencyKey?: string;
        };
        if (!unboundTxB64) return req.reject(400, 'unboundTxB64 is required');
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) return req.reject(400, 'sponsorSessionId is required; no platform pool is configured');
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(sponsorRateLimiter, 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: (req as any).user?.id, config: getNightgatePluginConfig() });
            }
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes } = resolveSponsorPolicyForRequest(req);
            const grantId: string | undefined = (req as any).agentGrant?.ID ? String((req as any).agentGrant.ID) : undefined;
            const caller = String((req as any).user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorUnboundTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                request: {
                    feeSponsor: effectiveSponsor, caller,
                    bytes: unboundTxB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(unboundTxB64, 'base64')))
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorUnbound', unboundTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, grantId }
            });
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on('submitContractCallBatch', async (req: Request) => {
        const { contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey, initialPrivateState, sponsorSessionId, independentCalls } = req.data as {
            contractAddress?: string;
            calls?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
            sponsorSessionId?: string;
            independentCalls?: boolean;
        };

        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!calls) return req.reject(400, 'calls is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        // Bounded: each call carries a proof, and one rejected call discards the
        // whole scope before submission.
        const { depth: rawBatchDepth, width: rawBatchWidth } = vaultDims(compiledArtifactRef);
        let parsedCalls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
        try {
            const v = JSON.parse(calls);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'calls must be a non-empty JSON array');
            if (v.length > 8) return req.reject(400, 'calls supports at most 8 entries per batch');
            parsedCalls = v.map((entry: any, i: number) => {
                if (!entry || typeof entry.circuit !== 'string' || !entry.circuit) {
                    throw new Error(`calls[${i}].circuit is required`);
                }
                if (entry.args !== undefined && !Array.isArray(entry.args)) {
                    throw new Error(`calls[${i}].args must be an array`);
                }
                // Validated here so a malformed proof is a 400, not a failed job.
                let merkleProof: MerkleProofBundle | undefined;
                if (entry.merkleProof !== undefined && entry.merkleProof?.docPair !== undefined) {
                    // Cross-root witnesses: no inclusion path.
                    const dp = entry.merkleProof.docPair;
                    if (!dp || typeof dp !== 'object') throw new Error(`calls[${i}].merkleProof.docPair must be an object`);
                    merkleProof = {
                        docPair: {
                            schema: validateSchemaSlots(dp.schema, `calls[${i}].merkleProof.docPair.schema`, rawBatchWidth),
                            openingA: validateOpening(dp.openingA, `calls[${i}].merkleProof.docPair.openingA`, rawBatchWidth),
                            openingB: validateOpening(dp.openingB, `calls[${i}].merkleProof.docPair.openingB`, rawBatchWidth)
                        }
                    };
                } else if (entry.merkleProof !== undefined) {
                    const mp = entry.merkleProof;
                    if (!mp || typeof mp !== 'object') throw new Error(`calls[${i}].merkleProof must be an object`);
                    let fieldValueStr: string | undefined;
                    if (mp.fieldValue !== undefined) {
                        let fieldValueBig: bigint;
                        try { fieldValueBig = BigInt(mp.fieldValue); } catch { throw new Error(`calls[${i}].merkleProof.fieldValue must be an integer (decimal string)`); }
                        if (fieldValueBig < 0n) throw new Error(`calls[${i}].merkleProof.fieldValue must be a non-negative integer`);
                        fieldValueStr = fieldValueBig.toString();
                    }
                    let fieldDigest: string | undefined;
                    if (mp.fieldDigest !== undefined) {
                        if (typeof mp.fieldDigest !== 'string' || !SHA256_HEX_RE.test(mp.fieldDigest)) {
                            throw new Error(`calls[${i}].merkleProof.fieldDigest must be 64 hex chars (32 bytes)`);
                        }
                        fieldDigest = mp.fieldDigest.toLowerCase();
                    }
                    let fieldSalt: string | undefined;
                    if (mp.fieldSalt !== undefined) {
                        if (typeof mp.fieldSalt !== 'string' || !SHA256_HEX_RE.test(mp.fieldSalt)) {
                            throw new Error(`calls[${i}].merkleProof.fieldSalt must be 64 hex chars (32 bytes)`);
                        }
                        fieldSalt = mp.fieldSalt.toLowerCase();
                    }
                    if (!Array.isArray(mp.siblings) || mp.siblings.length !== rawBatchDepth) {
                        throw new Error(`calls[${i}].merkleProof.siblings must be a JSON array of ${rawBatchDepth} hashes`);
                    }
                    for (const s of mp.siblings) {
                        if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`calls[${i}].merkleProof.siblings entries must be 64 hex chars (32 bytes)`);
                    }
                    if (!Array.isArray(mp.dirs) || mp.dirs.length !== rawBatchDepth) {
                        throw new Error(`calls[${i}].merkleProof.dirs must be a JSON array of ${rawBatchDepth} booleans`);
                    }
                    for (const d of mp.dirs) {
                        if (typeof d !== 'boolean') throw new Error(`calls[${i}].merkleProof.dirs entries must be booleans`);
                    }
                    let setProof: { siblings: string[]; dirs: boolean[] } | undefined;
                    if (mp.setProof !== undefined) {
                        const sp = mp.setProof;
                        if (!sp || typeof sp !== 'object') throw new Error(`calls[${i}].merkleProof.setProof must be an object`);
                        if (!Array.isArray(sp.siblings) || sp.siblings.length !== SET_DEPTH) {
                            throw new Error(`calls[${i}].merkleProof.setProof.siblings must be a JSON array of ${SET_DEPTH} hashes`);
                        }
                        for (const s of sp.siblings) {
                            if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`calls[${i}].merkleProof.setProof.siblings entries must be 64 hex chars (32 bytes)`);
                        }
                        if (!Array.isArray(sp.dirs) || sp.dirs.length !== SET_DEPTH) {
                            throw new Error(`calls[${i}].merkleProof.setProof.dirs must be a JSON array of ${SET_DEPTH} booleans`);
                        }
                        for (const d of sp.dirs) {
                            if (typeof d !== 'boolean') throw new Error(`calls[${i}].merkleProof.setProof.dirs entries must be booleans`);
                        }
                        setProof = { siblings: sp.siblings.map((s: string) => s.toLowerCase()), dirs: sp.dirs as boolean[] };
                    }
                    merkleProof = {
                        ...(fieldValueStr !== undefined ? { fieldValue: fieldValueStr } : {}),
                        ...(fieldDigest !== undefined ? { fieldDigest } : {}),
                        ...(fieldSalt !== undefined ? { fieldSalt } : {}),
                        siblings: mp.siblings.map((s: string) => s.toLowerCase()),
                        dirs: mp.dirs as boolean[],
                        ...(setProof ? { setProof } : {})
                    };
                }
                return { circuit: entry.circuit, args: entry.args ?? [], ...(merkleProof ? { merkleProof } : {}) };
            });
        } catch (e: any) {
            return req.reject(400, /^calls\[/.test(String(e?.message)) ? String(e.message) : 'calls must be valid JSON');
        }

        let parsedInitialPrivateState: unknown;
        if (initialPrivateState) {
            try { parsedInitialPrivateState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);

            // Validate-coerce every call now so a bad arg is a 400 here, not a
            // failed job later. Raw args are persisted; the executor re-coerces.
            for (const c of parsedCalls) {
                const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
                coerceCircuitArgs(c.args, argTypes);
            }

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            const circuits = parsedCalls.map(c => c.circuit);
            return startJob({
                kind: 'submitContractCallBatch',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuits, compiledArtifactRef, sessionId, callCount: parsedCalls.length, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    contractAddress, circuits, compiledArtifactRef, sessionId,
                    calls: parsedCalls, initialPrivateState: parsedInitialPrivateState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'callBatch', contractAddress, calls: parsedCalls, compiledArtifactRef, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId, ...(independentCalls === true ? { independentCalls: true } : {}) }
            });
        });
    });

    srv.on('anchorDocument', async (req: Request) => {
        const data = req.data as {
            sha256?: string;
            contentType?: string;
            size?: number;
            storageRef?: string;
            metadata?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.sha256) return req.reject(400, 'sha256 is required');
        if (!data.storageRef) return req.reject(400, 'storageRef is required');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!SHA256_HEX_RE.test(data.sha256)) {
            return req.reject(400, 'sha256 must be 64 hex chars (32 bytes)');
        }

        const metadataStr = data.metadata ?? '';
        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(anchorRateLimiter, data.sessionId, req)) return;

        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));
        const producedAt = agentOutputProducedAt(data.contentType, metadataStr);

        // Row first, so the document id is stable before the job runs.
        const documentId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        // verifyDocument trusts only this recorded binding (owner, vault,
        // network, artifact), never caller-supplied coordinates.
        const networkId = recordedNetworkId();
        await db.run(INSERT.into(Documents).entries({
            ID: documentId,
            sha256: data.sha256.toLowerCase(),
            contentType: data.contentType ?? null,
            size: data.size ?? null,
            storageRef: data.storageRef,
            anchoredTxHash: null,
            anchoredAt: null,
            userId: (req as any).user?.id ?? null,
            contractAddress: data.contractAddress ?? null,
            network: networkId,
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            sessionId: data.sessionId ?? null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            // The record is keyed by the session's attester id and the hash, so a
            // plain attest cannot be pre-empted by another identity.
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: (req as any).user?.id });
            await db.run(UPDATE.entity(Documents).set({ attesterId }).where({ ID: documentId }));
            const job = await startJob({
                kind: 'anchorDocument',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    sha256: data.sha256!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    compiledRef,
                    documentId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null,
                    ...(producedAt ? { producedAt } : {})
                },
                idempotencyPayload: {
                    sha256: data.sha256!.toLowerCase(), contractAddress: data.contractAddress,
                    compiledRef, metadata: metadataStr, feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'anchorDocument', documentId, payloadHash: data.sha256!.toLowerCase(),
                    metadataHash: bytesToHex(metadataHashBytes), attesterId, contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(Documents).where({ ID: documentId }));
            const stableDocumentId = (job.originalRequest as any)?.documentId ?? documentId;
            return { jobId: job.jobId, status: job.status, documentId: stableDocumentId, attesterId };
        });
    });

    srv.on('verifyDocument', async (req: Request) => {
        const { documentId, providedSha256, contractAddress, compiledArtifactRef } = req.data as {
            documentId?: string;
            providedSha256?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
        };

        if (!documentId) return req.reject(400, 'documentId is required');
        if (!providedSha256) return req.reject(400, 'providedSha256 is required');
        if (!SHA256_HEX_RE.test(providedSha256)) {
            return req.reject(400, 'providedSha256 must be 64 hex chars (32 bytes)');
        }

        const doc: any = await db.run(
            SELECT.one.from(Documents).where({ ID: documentId })
        );
        if (!doc) return req.reject(404, `Document ${documentId} not found`);

        // Recorded coordinates are authoritative and caller values may only
        // confirm them: another vault attesting the same public hash must not
        // verify this document. Rows without them take the caller's values.
        const recordedContract: string | null = doc.contractAddress ?? null;
        if (recordedContract && contractAddress
            && contractAddress.toLowerCase() !== recordedContract.toLowerCase()) {
            return req.reject(400, 'contractAddress does not match the vault this document was anchored in');
        }
        const effectiveContract = recordedContract ?? contractAddress;
        const recordedArtifact: string | null = doc.compiledArtifactRef ?? null;
        if (recordedArtifact && compiledArtifactRef && compiledArtifactRef !== recordedArtifact) {
            return req.reject(400, 'compiledArtifactRef does not match the artifact this document was anchored with');
        }
        const effectiveArtifact = recordedArtifact ?? compiledArtifactRef;
        // Read the recorded network's indexer, never silently the configured one.
        const recordedNetwork = doc.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(doc.network)
            ? doc.network as NightgateNetwork
            : undefined;

        const hashMatches = doc.sha256?.toLowerCase() === providedSha256.toLowerCase();
        const anchoredOk = Boolean(doc.anchoredTxHash);

        // `included` = indexed inclusion of the anchoring tx; `current` = live
        // state, which a retract can have changed since. The verdict needs the
        // live read: an indexed inclusion alone never says the record still stands.
        let included = false;
        let stateChecked = false;
        let current = false;
        if (anchoredOk && hashMatches) {
            const txRow: any = await db.run(
                SELECT.one.from(Transactions)
                    .columns('ID', 'hash')
                    .where({ hash: doc.anchoredTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from(TransactionResults)
                        .columns('status', 'outcomeSource')
                        .where({ transaction_ID: txRow.ID })
                );
                included = result?.status === 'SUCCESS'
                    && result?.outcomeSource === 'substrate-system-events';
            }
            if (effectiveContract && doc.attesterId && liveProviderConfigured(recordedNetwork)) {
                stateChecked = true;
                current = await verifyDocumentViaState(
                    effectiveContract, doc.attesterId, doc.sha256, effectiveArtifact, recordedNetwork,
                    doc.artifactDigest ?? null);
            }
        }

        return {
            verified: hashMatches && anchoredOk && stateChecked && current,
            included,
            stateChecked,
            anchoredTxHash: doc.anchoredTxHash ?? '',
            anchoredAt: doc.anchoredAt ?? null,
            originalSha256: doc.sha256 ?? ''
        };
    });

    srv.on('issueFieldPredicateAttestation', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHash?: string; attesterId?: string;
            fieldKey?: string;
            value?: string;
            fieldSalt?: string;
            contentRoot?: string; schemaId?: string;
            siblingsJson?: string;
            dirsJson?: string;
            predicate?: string;
            threshold?: number | string;
            unit?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (data.attesterId && !SHA256_HEX_RE.test(data.attesterId)) return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        if (!SHA256_HEX_RE.test(data.fieldKey)) return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');
        if (data.value === undefined || data.value === null || data.value === '') {
            return req.reject(400, 'value is required');
        }
        let valueBig: bigint;
        try { valueBig = BigInt(data.value); } catch { return req.reject(400, 'value must be an integer (decimal string)'); }
        if (valueBig < 0n) return req.reject(400, 'value must be a non-negative integer');
        if (valueBig > UINT64_MAX) return req.reject(400, 'value exceeds Uint<64>');
        if (!data.fieldSalt || !SHA256_HEX_RE.test(data.fieldSalt)) {
            return req.reject(400, 'fieldSalt (64 hex chars) is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
        let thresholdBig: bigint;
        try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
        if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');
        if (thresholdBig > INT64_MAX) return req.reject(400, 'threshold exceeds the recorded range (at most 9223372036854775807)');

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual' (use issueFieldEqualityAttestation / issueFieldMembershipAttestation for the bytes kinds)");
        }
        const op = parsedPredicate.opCode!;

        const { depth } = vaultDims(data.compiledArtifactRef);
        let siblings: string[];
        let dirs: boolean[];
        try { siblings = JSON.parse(data.siblingsJson ?? '[]'); } catch { return req.reject(400, 'siblingsJson must be a JSON array'); }
        try { dirs = JSON.parse(data.dirsJson ?? '[]'); } catch { return req.reject(400, 'dirsJson must be a JSON array'); }
        if (!Array.isArray(siblings) || siblings.length !== depth) return req.reject(400, `siblingsJson must be a JSON array of ${depth} hashes`);
        if (!Array.isArray(dirs) || dirs.length !== depth) return req.reject(400, `dirsJson must be a JSON array of ${depth} booleans`);
        for (const s of siblings) {
            if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) return req.reject(400, 'each sibling must be 64 hex chars (32 bytes)');
        }
        for (const d of dirs) {
            // Strict: Boolean("false") is true and would corrupt the path.
            if (typeof d !== 'boolean') return req.reject(400, 'dirsJson entries must be booleans');
        }
        const dirsBool = dirs as boolean[];

        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // Row up-front, before the job exists.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: data.predicate,
            op,
            threshold: data.threshold as any,
            unit: data.unit ?? null,
            // Lets the crawler-free verify path recompute the claim key.
            fieldKey: data.fieldKey.toLowerCase(),
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldPredicateAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: data.predicate,
                    threshold: String(data.threshold),
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: data.predicate,
                    threshold: String(data.threshold), value: data.value, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId, siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    predicate: data.predicate!, threshold: thresholdBig.toString(), opCode: op,
                    unit: data.unit, value: valueBig.toString(), salt: data.fieldSalt!.toLowerCase(),
                    siblings: siblings.map(s => s.toLowerCase()),
                    dirs: dirsBool, contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueFieldEqualityAttestation', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHash?: string; attesterId?: string; fieldKey?: string;
            expectedValue?: string; expectedDigest?: string; fieldSalt?: string;
            contentRoot?: string; schemaId?: string; siblingsJson?: string; dirsJson?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (data.attesterId && !SHA256_HEX_RE.test(data.attesterId)) return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        if (!SHA256_HEX_RE.test(data.fieldKey)) return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');

        const hasValue = typeof data.expectedValue === 'string' && data.expectedValue.length > 0;
        const hasDigest = typeof data.expectedDigest === 'string' && data.expectedDigest.length > 0;
        if (hasValue === hasDigest) return req.reject(400, 'pass exactly one of expectedValue / expectedDigest');
        if (hasDigest && !SHA256_HEX_RE.test(data.expectedDigest!)) {
            return req.reject(400, 'expectedDigest must be 64 hex chars (32 bytes)');
        }
        // The exact string, untrimmed, as prepareDocumentProof encodes bytes leaves.
        const expectedDigest = hasDigest ? data.expectedDigest!.toLowerCase() : blake2b256Hex(data.expectedValue!);
        if (!data.fieldSalt || !SHA256_HEX_RE.test(data.fieldSalt)) {
            return req.reject(400, 'fieldSalt (64 hex chars) is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // No op/threshold: the expected digest is the statement.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: 'bytesEquality',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: data.fieldKey.toLowerCase(),
            expectedDigest,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldEqualityAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'bytesEquality',
                    expectedDigest,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'bytesEquality',
                    expectedDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldEqualityWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    expectedDigest, salt: data.fieldSalt!.toLowerCase(), siblings: path.siblings, dirs: path.dirs,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueFieldMembershipAttestation', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHash?: string; attesterId?: string; fieldKey?: string;
            value?: string; valueDigest?: string;
            allowedValuesJson?: string; setRoot?: string; setSiblingsJson?: string; setDirsJson?: string;
            fieldSalt?: string;
            contentRoot?: string; schemaId?: string; siblingsJson?: string; dirsJson?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (data.attesterId && !SHA256_HEX_RE.test(data.attesterId)) return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        if (!SHA256_HEX_RE.test(data.fieldKey)) return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');

        const hasValue = typeof data.value === 'string' && data.value.length > 0;
        const hasDigest = typeof data.valueDigest === 'string' && data.valueDigest.length > 0;
        if (hasValue === hasDigest) return req.reject(400, 'pass exactly one of value / valueDigest');
        if (hasDigest && !SHA256_HEX_RE.test(data.valueDigest!)) {
            return req.reject(400, 'valueDigest must be 64 hex chars (32 bytes)');
        }
        const valueDigest = hasDigest ? data.valueDigest!.toLowerCase() : blake2b256Hex(data.value!);
        if (!data.fieldSalt || !SHA256_HEX_RE.test(data.fieldSalt)) {
            return req.reject(400, 'fieldSalt (64 hex chars) is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        const hasList = typeof data.allowedValuesJson === 'string' && data.allowedValuesJson.length > 0;
        const hasSetPath = !!(data.setRoot || data.setSiblingsJson || data.setDirsJson);
        if (hasList && hasSetPath) {
            return req.reject(400, 'pass either allowedValuesJson or setRoot + setSiblingsJson + setDirsJson, not both');
        }
        if (!hasList && !(data.setRoot && data.setSiblingsJson && data.setDirsJson)) {
            return req.reject(400, 'allowedValuesJson or setRoot + setSiblingsJson + setDirsJson is required');
        }

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        // Resolve the set lane BEFORE the rate gate: a value-not-in-list 400
        // must not consume proving budget.
        let setRoot: string;
        let setSiblings: string[];
        let setDirs: boolean[];
        if (hasList) {
            let allowed: unknown;
            try { allowed = JSON.parse(data.allowedValuesJson!); } catch { return req.reject(400, 'allowedValuesJson must be valid JSON'); }
            if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some(v => typeof v !== 'string' || v.length === 0)) {
                return req.reject(400, 'allowedValuesJson must be a non-empty JSON array of non-empty strings');
            }
            // Every RAW entry is digested before dedupe; cap the raw list so an
            // oversized duplicate-heavy list cannot buy unbounded hashing.
            if (allowed.length > 1024) {
                return req.reject(400, 'allowedValuesJson supports at most 1024 raw entries (64 distinct values)');
            }
            let pure;
            try {
                pure = await pureCircuitsLoader(compiledRef);
            } catch (err) {
                if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
                throw err;
            }
            let member;
            try {
                member = membershipPathFor(allowed as string[], valueDigest, pure);
            } catch (err) {
                return req.reject(400, (err as Error).message);
            }
            if (!member) return req.reject(400, 'value is not in the allowed list');
            setRoot = member.setRoot;
            setSiblings = member.setSiblings;
            setDirs = member.setDirs;
        } else {
            if (!SHA256_HEX_RE.test(data.setRoot!)) return req.reject(400, 'setRoot must be 64 hex chars (32 bytes)');
            const setPath = parseInclusionPath(req, data.setSiblingsJson, data.setDirsJson, SET_DEPTH, { siblings: 'setSiblingsJson', dirs: 'setDirsJson' });
            if (!setPath) return;
            setRoot = data.setRoot!.toLowerCase();
            setSiblings = setPath.siblings;
            setDirs = setPath.dirs;
        }

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // The set root is public; value digest and paths stay witness material.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: 'setMembership',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: data.fieldKey.toLowerCase(),
            setRoot,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldMembershipAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'setMembership',
                    setRoot,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'setMembership',
                    setRoot, valueDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldMembershipWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    setRoot, valueDigest, salt: data.fieldSalt!.toLowerCase(),
                    siblings: path.siblings, dirs: path.dirs,
                    setSiblings, setDirs,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueDocumentIntegrityAttestation', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHashA?: string; payloadHashB?: string; attesterIdA?: string; attesterIdB?: string; allowedMask?: number | string;
            schemaJson?: string; openingAJson?: string; openingBJson?: string;
            contentRootA?: string; contentRootB?: string; schemaId?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!SHA256_HEX_RE.test(data.payloadHashA)) return req.reject(400, 'payloadHashA must be 64 hex chars (32 bytes)');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (!SHA256_HEX_RE.test(data.payloadHashB)) return req.reject(400, 'payloadHashB must be 64 hex chars (32 bytes)');
        if (data.attesterIdA && !SHA256_HEX_RE.test(data.attesterIdA)) return req.reject(400, 'attesterIdA must be 64 hex chars (32 bytes)');
        if (data.attesterIdB && !SHA256_HEX_RE.test(data.attesterIdB)) return req.reject(400, 'attesterIdB must be 64 hex chars (32 bytes)');
        if (data.payloadHashA.toLowerCase() === data.payloadHashB.toLowerCase()) {
            return req.reject(400, 'payloadHashA and payloadHashB must differ (a document is trivially unchanged against itself)');
        }
        const { width: intWidth, maxMask } = vaultDims(data.compiledArtifactRef);
        if (data.allowedMask === undefined || data.allowedMask === null) return req.reject(400, 'allowedMask is required');
        const allowedMask = coerceMask(data.allowedMask);
        if (allowedMask === null || allowedMask < 0 || allowedMask > maxMask) {
            return req.reject(400, `allowedMask must be an integer in 0..${maxMask} (packed ${intWidth}-bit slot mask)`);
        }
        if (allowedMask === maxMask) {
            return req.reject(400, `allowedMask ${maxMask} permits every slot to differ; the claim would be vacuous`);
        }
        const docPair = parseDocPairInputs(req, data.schemaJson, data.openingAJson, data.openingBJson, intWidth);
        if (!docPair) return;
        if (isVacuousMask(allowedMask, docPair.schema)) {
            return req.reject(400, 'allowedMask frees every real (non-padding) schema slot; the claim would be vacuous');
        }
        for (const [name, root] of [['contentRootA', data.contentRootA], ['contentRootB', data.contentRootB]] as const) {
            if (root && !SHA256_HEX_RE.test(root)) return req.reject(400, `${name} must be 64 hex chars (32 bytes)`);
        }
        if ((data.contentRootA || data.contentRootB) && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // Document A rides in the payloadHash column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            attesterId: attesterIdA,
            contractAddress: data.contractAddress,
            predicate: 'documentIntegrity',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
            attesterIdB,
            allowedMask,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueDocumentIntegrityAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHashA: data.payloadHashA!.toLowerCase(),
                    payloadHashB: data.payloadHashB!.toLowerCase(),
                    attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress,
                    predicate: 'documentIntegrity',
                    allowedMask,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress, predicate: 'documentIntegrity',
                    allowedMask,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentIntegrityWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    allowedMask,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase(),
                    contentRootB: data.contentRootB?.toLowerCase(),
                    schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueDocumentDiffAttestation', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHashA?: string; payloadHashB?: string; attesterIdA?: string; attesterIdB?: string; k?: number;
            schemaJson?: string; openingAJson?: string; openingBJson?: string;
            contentRootA?: string; contentRootB?: string; schemaId?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!SHA256_HEX_RE.test(data.payloadHashA)) return req.reject(400, 'payloadHashA must be 64 hex chars (32 bytes)');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (!SHA256_HEX_RE.test(data.payloadHashB)) return req.reject(400, 'payloadHashB must be 64 hex chars (32 bytes)');
        if (data.attesterIdA && !SHA256_HEX_RE.test(data.attesterIdA)) return req.reject(400, 'attesterIdA must be 64 hex chars (32 bytes)');
        if (data.attesterIdB && !SHA256_HEX_RE.test(data.attesterIdB)) return req.reject(400, 'attesterIdB must be 64 hex chars (32 bytes)');
        if (data.payloadHashA.toLowerCase() === data.payloadHashB.toLowerCase()) {
            return req.reject(400, 'payloadHashA and payloadHashB must differ (a document has no differences against itself)');
        }
        const { width: diffWidth } = vaultDims(data.compiledArtifactRef);
        if (data.k === undefined || data.k === null) return req.reject(400, 'k is required');
        if (!Number.isInteger(data.k) || data.k < 1 || data.k > diffWidth) {
            return req.reject(400, `k must be an integer in 1..${diffWidth} (minimum differing slots)`);
        }
        const docPair = parseDocPairInputs(req, data.schemaJson, data.openingAJson, data.openingBJson, diffWidth);
        if (!docPair) return;
        for (const [name, root] of [['contentRootA', data.contentRootA], ['contentRootB', data.contentRootB]] as const) {
            if (root && !SHA256_HEX_RE.test(root)) return req.reject(400, `${name} must be 64 hex chars (32 bytes)`);
        }
        if ((data.contentRootA || data.contentRootB) && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // k rides in the threshold column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            attesterId: attesterIdA,
            contractAddress: data.contractAddress,
            predicate: 'documentDiff',
            op: null,
            threshold: data.k as any,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
            attesterIdB,
            allowedMask: null,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueDocumentDiffAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHashA: data.payloadHashA!.toLowerCase(),
                    payloadHashB: data.payloadHashB!.toLowerCase(),
                    attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress,
                    predicate: 'documentDiff',
                    k: data.k,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress, predicate: 'documentDiff',
                    k: data.k,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentDiffWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    k: data.k!,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase(),
                    contentRootB: data.contentRootB?.toLowerCase(),
                    schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueFieldPredicateAttestationBatch', async (req: Request) => {
        const data = req.data as {
            validUntil?: number | string;
            payloadHash?: string; attesterId?: string;
            contentRoot?: string; schemaId?: string;
            claimsJson?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (data.attesterId && !SHA256_HEX_RE.test(data.attesterId)) return req.reject(400, 'attesterId must be 64 hex chars (32 bytes)');
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && (!data.schemaId || !SHA256_HEX_RE.test(data.schemaId))) {
            return req.reject(400, 'schemaId (64 hex chars) is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.claimsJson) return req.reject(400, 'claimsJson is required');

        // 8 calls per transaction; an in-batch anchor occupies one.
        const maxClaims = data.contentRoot ? 7 : 8;
        // `allowedValues` is a membership claim's raw list before set resolution.
        // Document kinds carry no fieldKey/path; document A is the batch payloadHash.
        interface BatchClaim {
            fieldKey?: string; siblings?: string[]; dirs?: boolean[];
            predicate: string; unit?: string;
            value?: string; threshold?: string; opCode?: number;
            expectedDigest?: string;
            setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
            allowedValues?: string[];
            salt?: string;
            payloadHashB?: string; attesterIdB?: string; allowedMask?: number; k?: number;
            schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
        }
        const parsePath = (entry: any, i: number, depth: number, sibName: string, dirName: string): { siblings: string[]; dirs: boolean[] } => {
            const sibs = entry[sibName];
            const ds = entry[dirName];
            if (!Array.isArray(sibs) || sibs.length !== depth) {
                throw new Error(`claims[${i}].${sibName} must be a JSON array of ${depth} hashes`);
            }
            for (const s of sibs) {
                if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`claims[${i}].${sibName} entries must be 64 hex chars (32 bytes)`);
            }
            if (!Array.isArray(ds) || ds.length !== depth) {
                throw new Error(`claims[${i}].${dirName} must be a JSON array of ${depth} booleans`);
            }
            for (const d of ds) {
                // Strict: Boolean("false") is true and would corrupt the path.
                if (typeof d !== 'boolean') throw new Error(`claims[${i}].${dirName} entries must be booleans`);
            }
            return { siblings: sibs.map((s: string) => s.toLowerCase()), dirs: ds as boolean[] };
        };
        const { width: batchWidth, depth: batchDepth, maxMask: batchMaxMask } = vaultDims(data.compiledArtifactRef);
        let claims: BatchClaim[];
        try {
            const v = JSON.parse(data.claimsJson);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'claimsJson must be a non-empty JSON array');
            if (v.length > maxClaims) {
                return req.reject(400, `claimsJson supports at most ${maxClaims} entries per batch` + (data.contentRoot ? ' (the contentRoot anchor occupies one of the 8 call slots)' : ''));
            }
            claims = v.map((entry: any, i: number): BatchClaim => {
                if (!entry || typeof entry !== 'object') throw new Error(`claims[${i}] must be an object`);
                const parsed = parsePredicate(entry.predicate);
                if (!parsed) throw new Error(`claims[${i}].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'`);

                if (parsed.kind === 'integrity' || parsed.kind === 'diff') {
                    // An in-batch contentRoot anchor is A's root; B's must already be anchored.
                    if (typeof entry.payloadHashB !== 'string' || !SHA256_HEX_RE.test(entry.payloadHashB)) {
                        throw new Error(`claims[${i}].payloadHashB must be 64 hex chars (32 bytes)`);
                    }
                    const payloadHashB = entry.payloadHashB.toLowerCase();
                    if (entry.attesterIdB !== undefined && (typeof entry.attesterIdB !== 'string' || !SHA256_HEX_RE.test(entry.attesterIdB))) {
                        throw new Error(`claims[${i}].attesterIdB must be 64 hex chars (32 bytes)`);
                    }
                    const attesterIdB = typeof entry.attesterIdB === 'string' ? entry.attesterIdB.toLowerCase() : undefined;
                    if (payloadHashB === data.payloadHash!.toLowerCase()) {
                        throw new Error(`claims[${i}].payloadHashB must differ from the batch payloadHash`);
                    }
                    const schema = validateSchemaSlots(entry.schema, `claims[${i}].schema`, batchWidth);
                    const openingA = validateOpening(entry.openingA, `claims[${i}].openingA`, batchWidth);
                    const openingB = validateOpening(entry.openingB, `claims[${i}].openingB`, batchWidth);
                    if (parsed.kind === 'integrity') {
                        if (!Number.isInteger(entry.allowedMask) || entry.allowedMask < 0 || entry.allowedMask > batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask must be an integer in 0..${batchMaxMask}`);
                        }
                        if (entry.allowedMask === batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask ${batchMaxMask} permits every slot to differ; the claim would be vacuous`);
                        }
                        if (isVacuousMask(entry.allowedMask, schema)) {
                            throw new Error(`claims[${i}].allowedMask frees every real (non-padding) schema slot; the claim would be vacuous`);
                        }
                        return {
                            predicate: 'documentIntegrity', payloadHashB, attesterIdB, allowedMask: entry.allowedMask,
                            schema, openingA, openingB
                        };
                    }
                    if (!Number.isInteger(entry.k) || entry.k < 1 || entry.k > batchWidth) {
                        throw new Error(`claims[${i}].k must be an integer in 1..${batchWidth}`);
                    }
                    return {
                        predicate: 'documentDiff', payloadHashB, attesterIdB, k: entry.k,
                        schema, openingA, openingB
                    };
                }

                if (typeof entry.fieldKey !== 'string' || !SHA256_HEX_RE.test(entry.fieldKey)) {
                    throw new Error(`claims[${i}].fieldKey must be 64 hex chars (32 bytes)`);
                }
                const contentPath = parsePath(entry, i, batchDepth, 'siblings', 'dirs');
                if (typeof entry.salt !== 'string' || !SHA256_HEX_RE.test(entry.salt)) {
                    throw new Error(`claims[${i}].salt must be 64 hex chars (32 bytes; v4 salted leaves)`);
                }
                const base = {
                    fieldKey: entry.fieldKey.toLowerCase(),
                    salt: entry.salt.toLowerCase(),
                    siblings: contentPath.siblings,
                    dirs: contentPath.dirs,
                    predicate: entry.predicate as string,
                    unit: typeof entry.unit === 'string' && entry.unit.length > 0 ? entry.unit : undefined
                };

                if (parsed.kind === 'equality') {
                    const hasVal = typeof entry.expectedValue === 'string' && entry.expectedValue.length > 0;
                    const hasDig = typeof entry.expectedDigest === 'string' && entry.expectedDigest.length > 0;
                    if (hasVal === hasDig) throw new Error(`claims[${i}]: pass exactly one of expectedValue / expectedDigest`);
                    if (hasDig && !SHA256_HEX_RE.test(entry.expectedDigest)) throw new Error(`claims[${i}].expectedDigest must be 64 hex chars (32 bytes)`);
                    return { ...base, expectedDigest: hasDig ? entry.expectedDigest.toLowerCase() : blake2b256Hex(entry.expectedValue) };
                }

                if (parsed.kind === 'membership') {
                    const hasVal = typeof entry.value === 'string' && entry.value.length > 0;
                    const hasDig = typeof entry.valueDigest === 'string' && entry.valueDigest.length > 0;
                    if (hasVal === hasDig) throw new Error(`claims[${i}]: pass exactly one of value / valueDigest`);
                    if (hasDig && !SHA256_HEX_RE.test(entry.valueDigest)) throw new Error(`claims[${i}].valueDigest must be 64 hex chars (32 bytes)`);
                    const valueDigest = hasDig ? entry.valueDigest.toLowerCase() : blake2b256Hex(entry.value);
                    const hasAllowed = Array.isArray(entry.allowedValues);
                    const hasSetPath = !!(entry.setRoot || entry.setSiblings || entry.setDirs);
                    if (hasAllowed && hasSetPath) throw new Error(`claims[${i}]: pass either allowedValues or setRoot + setSiblings + setDirs, not both`);
                    if (hasAllowed) {
                        if ((entry.allowedValues as unknown[]).length === 0 || (entry.allowedValues as unknown[]).some(x => typeof x !== 'string' || x.length === 0)) {
                            throw new Error(`claims[${i}].allowedValues must be a non-empty array of non-empty strings`);
                        }
                        if ((entry.allowedValues as unknown[]).length > 1024) {
                            throw new Error(`claims[${i}].allowedValues supports at most 1024 raw entries (64 distinct values)`);
                        }
                        return { ...base, valueDigest, allowedValues: entry.allowedValues as string[] };
                    }
                    if (!(entry.setRoot && entry.setSiblings && entry.setDirs)) {
                        throw new Error(`claims[${i}]: allowedValues or setRoot + setSiblings + setDirs is required`);
                    }
                    if (typeof entry.setRoot !== 'string' || !SHA256_HEX_RE.test(entry.setRoot)) throw new Error(`claims[${i}].setRoot must be 64 hex chars (32 bytes)`);
                    const setPath = parsePath(entry, i, SET_DEPTH, 'setSiblings', 'setDirs');
                    return { ...base, valueDigest, setRoot: entry.setRoot.toLowerCase(), setSiblings: setPath.siblings, setDirs: setPath.dirs };
                }

                // numeric
                if (entry.value === undefined || entry.value === null || entry.value === '') {
                    throw new Error(`claims[${i}].value is required`);
                }
                let valueBig: bigint;
                try { valueBig = BigInt(entry.value); } catch { throw new Error(`claims[${i}].value must be an integer (decimal string)`); }
                if (valueBig < 0n) throw new Error(`claims[${i}].value must be a non-negative integer`);
                if (valueBig > UINT64_MAX) throw new Error(`claims[${i}].value exceeds Uint<64>`);
                if (entry.threshold === undefined || entry.threshold === null) throw new Error(`claims[${i}].threshold is required`);
                let thresholdBig: bigint;
                try { thresholdBig = BigInt(entry.threshold); } catch { throw new Error(`claims[${i}].threshold must be an integer`); }
                if (thresholdBig < 0n) throw new Error(`claims[${i}].threshold must be a non-negative integer`);
                if (thresholdBig > INT64_MAX) throw new Error(`claims[${i}].threshold exceeds the recorded range (at most 9223372036854775807)`);
                return { ...base, value: valueBig.toString(), threshold: thresholdBig.toString(), opCode: parsed.opCode! };
            });
        } catch (e: any) {
            return req.reject(400, /^claims\[/.test(String(e?.message)) ? String(e.message) : 'claimsJson must be valid JSON');
        }

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        // Before dedup (its keys need the set root) and the rate gate (a
        // not-in-list 400 must not consume budget).
        if (claims.some(c => c.allowedValues)) {
            let pure;
            try {
                pure = await pureCircuitsLoader(compiledRef);
            } catch (err) {
                if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
                throw err;
            }
            for (let i = 0; i < claims.length; i++) {
                const c = claims[i];
                if (!c.allowedValues) continue;
                let member;
                try {
                    member = membershipPathFor(c.allowedValues, c.valueDigest!, pure);
                } catch (err) {
                    return req.reject(400, `claims[${i}]: ${(err as Error).message}`);
                }
                if (!member) return req.reject(400, `claims[${i}]: value is not in the allowed list`);
                c.setRoot = member.setRoot;
                c.setSiblings = member.setSiblings;
                c.setDirs = member.setDirs;
                delete c.allowedValues;
            }
        }

        // Duplicates only waste proving (claim keys are idempotent on-chain); the
        // tuple mirrors each kind's on-chain claim struct.
        const seenTuples = new Set<string>();
        const uniqueClaims: BatchClaim[] = [];
        for (const c of claims) {
            const tuple = c.predicate === 'bytesEquality' ? `${c.fieldKey}|eq|${c.expectedDigest}`
                : c.predicate === 'setMembership' ? `${c.fieldKey}|set|${c.setRoot}`
                : c.predicate === 'documentIntegrity' ? `${c.attesterIdB ?? ''}|${c.payloadHashB}|integ|${c.allowedMask}`
                : c.predicate === 'documentDiff' ? `${c.attesterIdB ?? ''}|${c.payloadHashB}|diff|${c.k}`
                : `${c.fieldKey}|${c.threshold}|${c.opCode}`;
            if (seenTuples.has(tuple)) continue;
            seenTuples.add(tuple);
            uniqueClaims.push(c);
        }
        const droppedDuplicates = claims.length - uniqueClaims.length;

        if (rejectIfMainnetBlocked(req)) return;
        // N claims count as N, so batching is no rate-limit bypass.
        if (!checkRate(predicateRateLimiter, data.sessionId, req, uniqueClaims.length)) return;

        // One row per claim; on success all share one provenTxHash.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const insertedAt = new Date().toISOString();
        const rowedClaims = uniqueClaims.map(c => ({ ...c, predicateAttestationId: cds.utils.uuid() }));
        await db.run(INSERT.into(PredicateAttestations).entries(rowedClaims.map(c => ({
            ID: c.predicateAttestationId,
            payloadHash: data.payloadHash!.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: c.predicate,
            op: c.opCode ?? null,
            threshold: (c.predicate === 'documentDiff' ? c.k : c.threshold ?? null) as any,
            unit: c.unit ?? null,
            fieldKey: c.fieldKey ?? null,
            expectedDigest: c.expectedDigest ?? null,
            setRoot: c.setRoot ?? null,
            payloadHashB: c.payloadHashB ?? null,
            attesterIdB: c.attesterIdB ?? null,
            allowedMask: c.allowedMask ?? null,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }))));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const publicClaims = rowedClaims.map(c => ({
                predicateAttestationId: c.predicateAttestationId, fieldKey: c.fieldKey,
                predicate: c.predicate,
                ...(c.predicate === 'bytesEquality' ? { expectedDigest: c.expectedDigest }
                    : c.predicate === 'setMembership' ? { setRoot: c.setRoot }
                    : c.predicate === 'documentIntegrity' ? { payloadHashB: c.payloadHashB, allowedMask: c.allowedMask }
                    : c.predicate === 'documentDiff' ? { payloadHashB: c.payloadHashB, k: c.k }
                    : { threshold: c.threshold, unit: c.unit ?? null })
            }));
            const job = await startJob({
                kind: 'issueFieldPredicateAttestationBatch',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    claimCount: rowedClaims.length,
                    claims: publicClaims,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    contentRoot: data.contentRoot?.toLowerCase() ?? null,
                    claims: uniqueClaims.map(c => ({
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        value: c.value, expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        salt: c.salt, siblings: c.siblings, dirs: c.dirs,
                        payloadHashB: c.payloadHashB, attesterIdB: c.attesterIdB, allowedMask: c.allowedMask, k: c.k,
                        schema: c.schema, openingA: c.openingA, openingB: c.openingB
                    })),
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateBatchWorkflow', validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    claims: rowedClaims.map(c => ({
                        predicateAttestationId: c.predicateAttestationId,
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        opCode: c.opCode, unit: c.unit, value: c.value,
                        expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        setSiblings: c.setSiblings, setDirs: c.setDirs,
                        salt: c.salt, siblings: c.siblings, dirs: c.dirs,
                        payloadHashB: c.payloadHashB, attesterIdB: c.attesterIdB, allowedMask: c.allowedMask, k: c.k,
                        schema: c.schema, openingA: c.openingA, openingB: c.openingB
                    })),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            // Idempotent retry: the rows created for THIS request are orphans;
            // the original request's rows (and IDs) are authoritative.
            if (job.deduplicated) {
                await db.run(DELETE.from(PredicateAttestations).where({ ID: { in: rowedClaims.map(c => c.predicateAttestationId) } }));
            }
            const stableClaims = job.deduplicated
                ? ((job.originalRequest as any)?.claims ?? publicClaims)
                : publicClaims;
            return {
                jobId: job.jobId, status: job.status,
                claims: JSON.stringify(stableClaims),
                droppedDuplicates
            };
        });
    });

    srv.on('verifyPredicateAttestation', async (req: Request) => {
        const { predicateAttestationId } = req.data as { predicateAttestationId?: string };
        if (!predicateAttestationId) return req.reject(400, 'predicateAttestationId is required');

        const row: any = await db.run(
            SELECT.one.from(PredicateAttestations).where({ ID: predicateAttestationId })
        );
        if (!row) return req.reject(404, `PredicateAttestation ${predicateAttestationId} not found`);

        const provenOk = Boolean(row.provenTxHash);
        // As in verifyDocument: the verdict needs the live read; an indexed
        // inclusion never shortcuts an expiry, purge or retract.
        let included = false;
        if (provenOk) {
            const txRow: any = await db.run(
                SELECT.one.from(Transactions).columns('ID', 'hash').where({ hash: row.provenTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: txRow.ID })
                );
                included = result?.status === 'SUCCESS'
                    && result?.outcomeSource === 'substrate-system-events';
            }
        }

        // Live state of the recorded network and artifact.
        const rowNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
            ? row.network as NightgateNetwork
            : undefined;
        let stateChecked = false;
        let current = false;
        if (liveProviderConfigured(rowNetwork) && row.contractAddress && row.payloadHash) {
            stateChecked = true;
            current = await verifyPredicateViaState(row);
        }

        return {
            verified: stateChecked && current,
            included,
            stateChecked,
            predicate: row.predicate ?? '',
            threshold: row.threshold ?? 0,
            unit: row.unit ?? '',
            expectedDigest: row.expectedDigest ?? '',
            setRoot: row.setRoot ?? '',
            payloadHashB: row.payloadHashB ?? '',
            // Integer64 column: some DB drivers hand the value back as a string
            allowedMask: row.allowedMask === null || row.allowedMask === undefined ? null : coerceMask(row.allowedMask),
            provenTxHash: row.provenTxHash ?? '',
            provenAt: row.provenAt ?? null
        };
    });

    srv.on('grantDisclosure', async (req: Request) => {
        const data = req.data as {
            payloadHash?: string;
            grantee?: string;
            level?: number | string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (!data.grantee) return req.reject(400, 'grantee is required');
        if (!SHA256_HEX_RE.test(data.grantee)) return req.reject(400, 'grantee must be 64 hex chars (32 bytes)');

        if (data.level === undefined || data.level === null) return req.reject(400, 'level is required');
        const levelNum = Number(data.level);
        if (!Number.isInteger(levelNum) || levelNum < 0 || levelNum > 2) {
            return req.reject(400, 'level must be 0 (public), 1 (legitimate-interest), or 2 (authority)');
        }

        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(disclosureRateLimiter, data.sessionId, req)) return;

        const payloadHashLc = data.payloadHash.toLowerCase();
        const granteeLc = data.grantee.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            // Ownership first: the grant row is the off-chain read ACL, so nothing
            // is written for a caller who does not hold the session.
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: (req as any).user?.id });

            // A new row stays inactive until the indexer confirms it; an existing one
            // keeps its confirmed level and carries the request as `pendingLevel`, so
            // a request the chain has not accepted never widens what the grantee reads.
            const insertedAt = new Date().toISOString();
            const existingGrant: any = await db.run(
                SELECT.one.from(DisclosureGrants).columns('ID').where({
                    contractAddress: contractAddressLc,
                    attesterId,
                    payloadHash: payloadHashLc,
                    grantee: granteeLc
                })
            );
            const disclosureGrantId = existingGrant?.ID ?? cds.utils.uuid();
            if (existingGrant) {
                await db.run(UPDATE.entity(DisclosureGrants)
                    .set({ pendingLevel: levelNum, modifiedAt: insertedAt })
                    .where({ ID: disclosureGrantId }));
            } else {
                await db.run(INSERT.into(DisclosureGrants).entries({
                    ID: disclosureGrantId,
                    payloadHash: payloadHashLc,
                    attesterId,
                    grantee: granteeLc,
                    level: levelNum,
                    pendingLevel: null,
                    contractAddress: contractAddressLc,
                    grantedTxHash: null,
                    revokedTxHash: null,
                    active: false,
                    createdAt: insertedAt,
                    modifiedAt: insertedAt
                }));
            }

            let job: Awaited<ReturnType<typeof startJob>>;
            try {
                job = await startJob({
                    kind: 'grantDisclosure',
                    sessionId: data.sessionId!,
                    idempotencyKey: data.idempotencyKey,
                    request: {
                        payloadHash: payloadHashLc,
                        attesterId,
                        grantee: granteeLc,
                        level: levelNum,
                        contractAddress: contractAddressLc,
                        disclosureGrantId,
                        feeSponsor: sponsor?.sponsorSessionId ?? null
                    },
                    requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                    commandVersion: 1,
                    encryptCommand: true,
                    command: {
                        op: 'grantDisclosure', disclosureGrantId, payloadHash: payloadHashLc, attesterId,
                        grantee: granteeLc, level: levelNum, contractAddress: contractAddressLc,
                        compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                    }
                });
            } catch (err) {
                // Nothing was admitted: leave no half-written handle behind.
                if (existingGrant) {
                    await db.run(UPDATE.entity(DisclosureGrants)
                        .set({ pendingLevel: null, modifiedAt: new Date().toISOString() })
                        .where({ ID: disclosureGrantId, pendingLevel: levelNum }));
                } else {
                    await db.run(DELETE.from(DisclosureGrants).where({ ID: disclosureGrantId }));
                }
                throw err;
            }

            return { jobId: job.jobId, status: job.status, disclosureGrantId };
        });
    });

    srv.on('revokeDisclosure', async (req: Request) => {
        const data = req.data as {
            payloadHash?: string;
            grantee?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (!data.grantee) return req.reject(400, 'grantee is required');
        if (!SHA256_HEX_RE.test(data.grantee)) return req.reject(400, 'grantee must be 64 hex chars (32 bytes)');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(disclosureRateLimiter, data.sessionId, req)) return;

        const payloadHashLc = data.payloadHash.toLowerCase();
        const granteeLc = data.grantee.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: (req as any).user?.id });

            const job = await startJob({
                kind: 'revokeDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    attesterId,
                    grantee: granteeLc,
                    contractAddress: contractAddressLc,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'revokeDisclosure', payloadHash: payloadHashLc, attesterId, grantee: granteeLc,
                    contractAddress: contractAddressLc, compiledArtifactRef: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    srv.on('registerPassport', async (req: Request) => {
        const data = req.data as {
            passportId?: string;
            documentId?: string;
            ownerId?: string;
            mode?: number | string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        const mode = data.mode === undefined || data.mode === null || data.mode === '' ? 0 : Number(data.mode);
        if (![0, 1, 2, 3, 4].includes(mode)) return req.reject(400, 'mode must be 0 (register), 1 (unregister), 2 (transfer registrar), 3 (recovery: set registrar) or 4 (recovery: set recovery)');
        const zeroId = '00'.repeat(32);
        // Mode 1 takes no owner, modes 2-4 no id: the unused argument rides as zero.
        if (mode === 1) data.ownerId = zeroId;
        if (mode >= 2) data.passportId = zeroId;
        if (!data.passportId && data.documentId) data.passportId = data.documentId;
        if (!data.passportId) return req.reject(400, 'documentId is required');
        if (!SHA256_HEX_RE.test(data.passportId)) return req.reject(400, 'documentId must be 64 hex chars (32 bytes)');
        if (!data.ownerId) return req.reject(400, 'ownerId is required');
        if (!SHA256_HEX_RE.test(data.ownerId)) return req.reject(400, 'ownerId must be 64 hex chars (32 bytes)');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(registrarRateLimiter, data.sessionId, req)) return;

        const passportIdLc = data.passportId.toLowerCase();
        const ownerIdLc = data.ownerId.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'registerPassport',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    passportId: passportIdLc,
                    documentId: passportIdLc,
                    ownerId: ownerIdLc,
                    mode,
                    contractAddress: contractAddressLc,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'registerPassport', passportId: passportIdLc, ownerId: ownerIdLc, mode,
                    contractAddress: contractAddressLc, compiledArtifactRef: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    /** Shared submit path of the retract circuit (mode 0 payload, 1 claim, 2 commitment). */
    async function submitRetract(req: Request, mode: number, key: string, data: { sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string }) {
        if (!SHA256_HEX_RE.test(key)) return req.reject(400, 'key must be 64 hex chars (32 bytes)');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(registrarRateLimiter, data.sessionId, req)) return;
        const keyLc = key.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = mode === 0 ? await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: (req as any).user?.id }) : undefined;
            const job = await startJob({
                kind: 'retract',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: { mode, key: keyLc, contractAddress: contractAddressLc, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: (req as any).user?.id,
                grantId: (req as any).agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'retract', mode, key: keyLc, attesterId, contractAddress: contractAddressLc, compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId }
            });
            return { jobId: job.jobId, status: job.status };
        });
    }

    // Owner-initiated removal of a payload: attestation, anchor, disclosures
    // and document binding leave the chain (retract mode 0).
    srv.on('retractAttestation', async (req: Request) => {
        const data = req.data as { payloadHash?: string; sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string };
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        return submitRetract(req, 0, data.payloadHash, data);
    });

    // Anyone removes an expired claim (`kind` claim, key = claim key).
    srv.on('purgeExpired', async (req: Request) => {
        const data = req.data as { kind?: string; key?: string; sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string };
        const mode = data.kind === 'claim' ? 1 : null;
        if (mode === null) return req.reject(400, "kind must be 'claim'");
        if (!data.key) return req.reject(400, 'key is required');
        return submitRetract(req, mode, data.key, data);
    });

    registerVerifyStateHandlers(srv, { contractResolver, attestationStateReader, predicateStateReader });

    srv.on('reindexDisclosures', async (req: Request) => {
        const data = req.data as { contractAddress?: string; compiledArtifactRef?: string };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;
        const contractAddressLc = data.contractAddress.toLowerCase();

        if (!checkRate(reindexRateLimiter, contractAddressLc, req)) return;

        // No live provider configured → clean zero, not a 5xx.
        if (!liveProviderConfigured()) {
            return {
                contractAddress: contractAddressLc,
                active: 0,
                deactivated: 0,
                reconciledAt: new Date().toISOString()
            };
        }

        return runSubmission(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const result = await disclosureReindexer({
                db,
                contractAddress: contractAddressLc,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
            });
            // `indexed` = grants present on-chain after reconcile.
            return {
                contractAddress: contractAddressLc,
                active: result.indexed,
                deactivated: result.deactivated,
                reconciledAt: new Date().toISOString()
            };
        });
    });

    srv.on('registerGranteeIdentity', async (req: Request) => {
        const userId = (req as any).user?.id;
        if (!userId) return req.reject(401, 'authentication required');

        // Ownership of the binding input is not verified; deployments gating reads
        // on grants should disable self-service and use their own proofing flow.
        if (!isSelfServiceGranteeRegistrationAllowed(getNightgatePluginConfig())) {
            return req.reject(403, 'Self-service grantee registration is disabled on this deployment. ' +
                'Identities are registered through the operator\'s proofing flow.');
        }

        const { bindingInput, scope } = req.data as { bindingInput?: string; scope?: string };
        if (!bindingInput) return req.reject(400, 'bindingInput is required');

        const bindingKind = getConfiguredGranteeBinding(getNightgatePluginConfig());
        let granteeId: string;
        try {
            granteeId = deriveGranteeId(bindingKind, bindingInput);
        } catch (err) {
            return req.reject(400, err instanceof Error ? err.message : String(err));
        }

        const scopeNorm = scope && scope.length > 0 ? scope : null;
        const now = new Date().toISOString();

        // Idempotent on (userId, scope): re-registering updates in place.
        const existing: any = await db.run(
            SELECT.one.from(GranteeIdentities).where({ userId, scope: scopeNorm })
        );
        if (existing) {
            await db.run(UPDATE.entity(GranteeIdentities)
                .set({ granteeId, bindingKind, modifiedAt: now })
                .where({ ID: existing.ID }));
            return { ID: existing.ID, granteeId, bindingKind };
        }

        const ID = cds.utils.uuid();
        await db.run(INSERT.into(GranteeIdentities).entries({
            ID, userId, granteeId, bindingKind, scope: scopeNorm,
            createdAt: now, modifiedAt: now
        }));
        return { ID, granteeId, bindingKind };
    });

    /**
     * Crawler-free evidence for verifyDocument: the attester's record of the
     * sha256 in live state. Any error is a clean false, never a 5xx.
     */
    async function verifyDocumentViaState(
        contractAddress: string,
        attesterId: string,
        payloadHash: string,
        compiledArtifactRef?: string,
        networkOverride?: NightgateNetwork,
        recordedArtifactDigest?: string | null
    ): Promise<boolean> {
        try {
            const compiledRef = compiledArtifactRef && compiledArtifactRef.length > 0
                ? compiledArtifactRef
                : DEFAULT_ATTESTATION_VAULT_REF;
            // Atomic digest check: a re-pointed alias or overwritten asset throws
            // and yields false, never a false "verified".
            const resolved = await contractResolver(compiledRef, recordedArtifactDigest ?? undefined);
            const state = await attestationStateReader({
                contractAddress,
                attesterId,
                payloadHash,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, networkOverride)
            });
            return Boolean(state?.attested);
        } catch {
            return false;
        }
    }

    /**
     * Crawler-free evidence for verifyPredicateAttestation: the row's recomputed
     * claim key holds true on-chain. Any error is a clean false, never a 5xx.
     */
    async function verifyPredicateViaState(row: any): Promise<boolean> {
        try {
            // The artifact, digest and network recorded at proving time, so a
            // redeploy or re-pointed alias cannot change what a stored claim verifies.
            const rowRef = row.compiledArtifactRef || DEFAULT_ATTESTATION_VAULT_REF;
            const resolved = await contractResolver(rowRef, row.artifactDigest ?? undefined);
            const recordedNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
                ? row.network as NightgateNetwork
                : undefined;
            const bytesKind = row.predicate === 'bytesEquality' || row.predicate === 'setMembership';
            const docKind = row.predicate === 'documentIntegrity' || row.predicate === 'documentDiff';
            if (!row.attesterId) return false;
            const proven = await predicateStateReader({
                contractAddress: row.contractAddress,
                attesterId: row.attesterId,
                payloadHash: row.payloadHash,
                threshold: (bytesKind || docKind) ? undefined : BigInt(row.threshold),
                op: (bytesKind || docKind) ? undefined : Number(row.op),
                fieldKey: row.fieldKey || undefined,
                expectedDigest: row.predicate === 'bytesEquality' ? (row.expectedDigest || undefined) : undefined,
                setRoot: row.predicate === 'setMembership' ? (row.setRoot || undefined) : undefined,
                payloadHashB: docKind ? (row.payloadHashB || undefined) : undefined,
                attesterIdB: docKind ? (row.attesterIdB || undefined) : undefined,
                allowedMask: row.predicate === 'documentIntegrity' ? Number(row.allowedMask) : undefined,
                k: row.predicate === 'documentDiff' ? Number(row.threshold) : undefined,
                slotWidth: vaultDims(rowRef).width,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, recordedNetwork)
            });
            return proven === true;
        } catch {
            return false;
        }
    }

    /**
     * Grant columns once the chain took the level. `active` is left to the
     * disclosure indexer, which re-materialises it from ledger state right after.
     */
    function confirmedDisclosureLevel(level: number, txHash: string, changedAt: string, landedHeight: number | null): Record<string, unknown> {
        return { level, pendingLevel: null, grantedTxHash: txHash, revokedTxHash: null, modifiedAt: changedAt, ...heightStamp(landedHeight) };
    }

    /** The row's `changedAtHeight` column value for a change that landed at `height` (nothing when unknown). */
    function heightStamp(height: number | null): Record<string, unknown> {
        return Number.isInteger(height) && (height as number) >= 0 ? { changedAtHeight: height } : {};
    }

    /**
     * A confirmation that landed at `height` only writes rows nothing ordered has
     * touched since: unstamped rows, or rows stamped strictly below it. Same-block
     * and unknown-height writes defer to the reindex, which reads the ledger.
     */
    function notNewerThan(query: any, height: number | null): any {
        return Number.isInteger(height) && (height as number) >= 0
            ? query.and('(changedAtHeight is null or changedAtHeight <', height, ')')
            : query.and('changedAtHeight is null');
    }

    /**
     * Drop the pending marker of a level request the chain did not take; matching
     * on `pendingLevel` leaves a newer request untouched.
     */
    async function clearPendingDisclosureLevel(disclosureGrantId: string, level: number): Promise<void> {
        try {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ pendingLevel: null, modifiedAt: new Date().toISOString() })
                .where({ ID: disclosureGrantId, pendingLevel: level }));
        } catch {
            /* best-effort; the marker is never read by the ACL */
        }
    }

    /**
     * The attester an issue action proves against: the session's own unless named.
     * A content root anchors only under the own record (the circuit keys by caller).
     */
    async function resolveAttester(req: Request, sessionId: string | undefined, requested: string | undefined, anchorsRoot: boolean): Promise<string | null> {
        let own: string;
        try {
            own = await attesterIdResolver({ sessionId: sessionId!, db, expectedUserId: (req as any).user?.id });
        } catch (err) {
            if (err instanceof SessionNotFoundError) { req.reject(401, err.message); return null; }
            throw err;
        }
        const attesterId = requested ? requested.toLowerCase() : own;
        if (anchorsRoot && attesterId !== own) {
            req.reject(400, "a content root can only be anchored under the session's own attester id; omit attesterId or drop contentRoot");
            return null;
        }
        return attesterId;
    }

    /**
     * Best-effort reindex as of the landed height (the snapshot cannot predate the
     * change); a failure never fails the submission, a later reindex reconciles.
     */
    function runDisclosureReindex(contractAddress: string, resolved: ResolvedContract, atHeight: number | null): Promise<unknown> {
        return disclosureReindexer({
            db,
            contractAddress,
            artifactPath: resolved.artifactPath,
            contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath),
            atHeight
        });
    }

    /**
     * Projection catch-up after a landed grant, revoke or retract. The
     * confirmation write is already in; a failed reindex is retried by a durable
     * `reindexDisclosures` job under the originating job's session.
     */
    async function reindexAfterSubmit(contractAddress: string, resolved: ResolvedContract, atHeight: number | null, origin: BackgroundJobRow, compiledArtifactRef: string): Promise<void> {
        try {
            await runDisclosureReindex(contractAddress, resolved, atHeight);
            return;
        } catch (err) {
            cds.log('nightgate').warn(`disclosure reindex of ${contractAddress.slice(0, 16)} after job ${origin.ID} failed, queuing a retry job: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        }
        try {
            await startJob({
                kind: 'reindexDisclosures',
                sessionId: origin.sessionId!,
                idempotencyKey: `reindex:${contractAddress.toLowerCase()}:${atHeight ?? 'tip'}:${origin.ID}`,
                request: { contractAddress, atHeight, afterJob: origin.ID },
                requestedBy: origin.requestedBy ?? undefined,
                commandVersion: 1,
                encryptCommand: false,
                command: { op: 'reindexDisclosures', contractAddress, compiledArtifactRef, atHeight }
            });
        } catch (err) {
            cds.log('nightgate').error(`could not queue the reindexDisclosures retry for ${contractAddress.slice(0, 16)}; run reindexDisclosures by hand: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
        }
    }

    /** Retries the reindex with backoff until it lands or the retry window closes. */
    async function executeReindexDisclosures(raw: unknown, job: BackgroundJobRow): Promise<unknown> {
        const command = raw as { op: string; contractAddress: string; compiledArtifactRef: string; atHeight: number | null; artifactDigest?: string };
        if (!command || command.op !== 'reindexDisclosures') throw new Error(`Persisted command operation '${(command as any)?.op}' is incompatible with ${job.kind}`);
        const resolved = await contractResolver(command.compiledArtifactRef, command.artifactDigest);
        const windowMs = configMs('NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS');
        const startedAt = Date.now();
        let lastError: unknown;
        for (let attempt = 1; ; attempt++) {
            try {
                const result: any = await runDisclosureReindex(command.contractAddress, resolved, command.atHeight);
                return { reindexed: true, attempts: attempt, indexed: result?.indexed ?? 0, deactivated: result?.deactivated ?? 0, snapshotHeight: result?.snapshotHeight ?? null };
            } catch (err) {
                lastError = err;
            }
            const elapsed = Date.now() - startedAt;
            const backoff = Math.min(15_000 * 2 ** (attempt - 1), 300_000, Math.max(1, windowMs / 4));
            if (elapsed + backoff > windowMs) break;
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
        const err: any = new Error(`disclosure reindex of ${command.contractAddress.slice(0, 16)} still failing after ${Math.round((Date.now() - startedAt) / 1000)} s; run reindexDisclosures once the indexer answers: ${String((lastError as Error)?.message ?? lastError).slice(0, 200)}`);
        err.code = 'DISCLOSURE_REINDEX_FAILED'; err.retryable = false;
        throw err;
    }

    function buildSubmitterDeps(
        db: any,
        resolved: ResolvedContract,
        wallet: import('../midnight/providers').WalletMaterial,
        sponsorAccountId?: string
    ): TransactionSubmitterDeps {
        const nightgateConfig = getNightgatePluginConfig();
        const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(nightgateConfig);
        const privateStateBackend = getConfiguredPrivateStateBackend(nightgateConfig);

        const contractProvidersConfig: ContractProvidersConfig = {
            indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
            indexerWsUrl: submissionEndpoints.indexerWsUrl,
            proofServerUrl: submissionEndpoints.proofServerUrl,
            zkConfigPath: resolved.zkConfigPath
        };

        return {
            contractProvidersConfig,
            walletMaterial: { ...wallet, privateStateBackend: wallet.privateStateBackend ?? privateStateBackend },
            db,
            network: network as NightgateNetwork,
            sponsorAccountId
        };
    }

    /** The optional per-tx fee sponsor; null when none was requested. */
    async function resolveSponsorForRequest(
        req: Request,
        sponsorSessionId: string | undefined
    ): Promise<ResolvedFeeSponsor | null> {
        if (!sponsorSessionId) return null;
        return resolveFeeSponsor({
            db,
            sponsorSessionId,
            requestingUserId: (req as any).user?.id,
            config: getNightgatePluginConfig()
        });
    }
}

/**
 * WalletFacade config. Fail-closed on an invalid network: the CAP host stays
 * online after a rejected init, so this must refuse the fallback network itself.
 */
function facadeConfigFromEnv() {
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
function recordedNetworkId(): string | null {
    try { return facadeConfigFromEnv().networkId ?? null; } catch { return null; }
}

/** Artifact-generation digest recorded on evidence rows; null for an unregistered alias. */
function artifactDigestOrNull(compiledRef: string): string | null {
    try { return getArtifactGenerationDigest(compiledRef); } catch { return null; }
}

/** Mainnet gate: rejects 403 and returns true when submission is not allowed. Call before any work. */
function rejectIfMainnetBlocked(req: Request): boolean {
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
function rateKey(req: Request, scope: string): string {
    return principalRateKey(req, scope);
}

function checkRate(limiter: RateLimiter, scope: string, req: Request, count = 1): boolean {
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
async function runInOneTransaction<T>(db: any, fn: (tx: { run: (q: unknown) => Promise<unknown> }) => Promise<T>): Promise<T> {
    if (typeof db?.tx === 'function') return db.tx(fn);
    return fn(db);
}

/** `Retry-After` on a retryable 503. `req.http` is absent outside an HTTP request (tests, programmatic calls). */
function setRetryAfter(req: Request, seconds: number): void {
    try { (req as any).http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
}

/** Catch the known error classes and translate to OData status codes. */
async function runSubmission(req: Request, op: () => Promise<unknown>): Promise<unknown> {
    try {
        return await op();
    } catch (err) {
        if (err instanceof CoercionError) {
            return req.reject(400, err.message);
        }
        if (err instanceof ContractNotRegisteredError) {
            return req.reject(404, err.message);
        }
        if (err instanceof SessionNotFoundError) {
            return req.reject(401, err.message);
        }
        if (err instanceof FeeSponsorError) {
            return req.reject(err.httpStatus, err.message);
        }
        if (err instanceof SponsorPolicyEmptyError) {
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message } as any);
        }
        if (err instanceof SponsorPolicyUnavailableError) {
            // `$sanitize: false` keeps the message readable in production.
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        if (err instanceof WalletMaterialUnavailable) {
            // No signing material: the caller must run connectWalletForSigning first.
            return req.reject(501, err.message);
        }
        if (err instanceof IdempotencyConflictError) {
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message } as any);
        }
        if (err instanceof JobAdmissionBusyError) {
            // Busy, nothing written. An object keeps code and `$sanitize: false`; a
            // bare (status, message) pair is sanitised by CAP in production.
            setRetryAfter(req, err.retryAfterSeconds);
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return req.reject(500, msg);
    }
}
