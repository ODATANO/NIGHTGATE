/**
 * OData handlers for the NightgateService submission action families:
 * contract submit (deploy / call / callBatch), document anchor + verify,
 * predicate issue + verify (incl. field-bound), disclosure grant / revoke,
 * passport registration, grantee registration, and the crawler-free
 * state-verification reads.
 *
 * Responsibilities here (the submitter itself does NOT do any of these):
 *   1. Parse and validate the JSON-encoded payloads (`args`,
 *      `initialPrivateState`, ...).
 *   2. Rate-limit per sessionId (deploys are stricter than calls).
 *   3. Resolve `compiledArtifactRef` → compiled contract + zkConfigPath +
 *      privateStateId via the contract registry.
 *   4. Look up the wallet session (signing key required: 412 without one).
 *   5. Catch SubmissionError / SessionNotFoundError / ContractNotRegisteredError
 *      and translate to OData status codes.
 *
 * The submitter (`srv/submission/TransactionSubmitter.ts`) handles the actual
 * SDK call, error classification, and PendingSubmissions row lifecycle.
 */

import cds, { Request } from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
    TransactionSubmitter,
    SubmissionError,
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
import { RateLimiter } from '../utils/rate-limiter';
import { ensureNetworkId, type ContractProvidersConfig } from '../midnight/providers';
import {
    deriveRawTokenType, TokenTypeError,
    SHIELDED_TEST_TOKEN_REF, SHIELDED_TEST_TOKEN_CIRCUIT, SHIELDED_TEST_TOKEN_AMOUNT
} from './token-type';
import { startJob, JobAdmissionBusyError, runChildCommand, registerBackgroundJobProcessor, registerBackgroundJobReconciliationFinalizer, withLockContentionRetry, SponsorAttemptBookkeepingPendingError, type BackgroundJobRow, type ReconciliationEvidence } from './background-jobs';
import { reportSubmissionRejectedOn, reportBroadcastOn } from './job-execution-context';
import { reindexDisclosuresForContract } from './disclosure-indexer';
import { readAttestationStateForContract } from './attestation-state';
import { readPredicateStateForContract, expandAllowedMask, computeAttestCommitment } from './predicate-state';
import { randomBytes } from 'node:crypto';
import { blake2b256Hex, loadPureCircuitsFromRegistry, PureCircuitsUnavailableError } from './document-proof';
import { membershipPathFor, SET_DEPTH } from './set-root';
import { deriveGranteeId } from './grantee-identity';
import { getConfiguredGranteeBinding, isSelfServiceGranteeRegistrationAllowed } from '../utils/nightgate-config';
import { Documents, Transactions, TransactionResults, PredicateAttestations, DisclosureGrants, GranteeIdentities, PendingSubmissions } from '#cds-models/midnight';
import { walletSponsorFinalizedTx, walletSponsorUnboundTx } from '../midnight/wallet-worker-client';
import {
    PLATFORM_POOL_SENTINEL, acquireSponsor, releaseSponsor, benchSponsor,
    isRetryableSponsorFailure, isDustRaceFailure, isGenericInvalidFailure, isPreInclusionReject, isAmbiguousSubmitOutcome, isCallNotAppliedFailure, envMsSetting,
    sponsorCandidatesNonExclusive, touchSponsor
} from './sponsor-pool';
import { resolveSponsorPolicyForRequest, SponsorPolicyEmptyError, SponsorPolicyUnavailableError } from './sponsor-policy';
import { recordDeployedContracts, reserveDeployBudget, releaseDeployBudget } from '../sessions/agent-grants';
import { getConfiguredFeeSponsorSessions } from './fee-sponsor';

const { INSERT, UPDATE, SELECT, DELETE } = cds.ql;

// 5 deploys / hour / session, deploys are heavyweight; tight bound.
const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
// 30 calls / minute / session.
const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
// 10 doc anchors / hour / session, contract-call heavyweight + extra DB writes.
const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
// 10 predicate proofs / hour / session; heavyweight circuit calls (often an
// anchor + a proof per request), so bound it like anchors.
const predicateRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
// 30 disclosure grant/revoke ops / hour / session; single heavyweight circuit
// call each, attester-gated; looser than predicate but tighter than plain calls.
const disclosureRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
// 30 passport registrations / hour / session; registrar-gated single circuit
// call, same weight class as the disclosure ops.
const registrarRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
// 60 on-demand reindexes / hour / contract; an indexer round-trip + DB writes,
// keyed by contractAddress (no session). Loose enough for a wallet-flow poll,
// tight enough not to hammer the indexer.
const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

/**
 * Width-dependent limits of a vault artifact (registration `slotWidth`,
 * default 16): slot count, inclusion-path depth, and the packed-mask upper
 * bound. JS bitwise operators are exact for bits 0..31, so widths up to 32
 * work on a Number mask (the CDS `Integer` params carry them; validation
 * happens here, not in the OData type).
 */
function vaultDims(compiledRef: string | undefined): { width: number; depth: number; maxMask: number } {
    const width = slotWidthOf(getContractRegistration(compiledRef?.length ? compiledRef : DEFAULT_ATTESTATION_VAULT_REF));
    return { width, depth: Math.log2(width), maxMask: width === 32 ? 0xffffffff : (1 << width) - 1 };
}
// The circuits take Uint<64>; overflow would otherwise surface only as an
// opaque proving-time failure.
const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Per-call proof witness bundle. `fieldValue` feeds `field_value()` (numeric
 * proveFieldPredicate), `fieldDigest` feeds `field_digest()` (bytes-valued
 * proveFieldMembership; proveFieldEquality needs neither, only the path),
 * `siblings`/`dirs` feed the DEPTH=4 content-root path, `setProof` feeds the
 * DEPTH=6 membership-set path, `docPair` feeds the cross-root circuits'
 * doc_leaves witnesses (those need no inclusion path, so
 * `siblings`/`dirs` may be absent alongside it).
 */
type MerkleProofBundle = {
    fieldValue?: string;
    /** Per-slot salt, 64 hex (v4; required by every single-field proof). */
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

/** Cross-root witness bundle (v4): shared schema + both documents' openings. */
type DocPairBundle = {
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
};

/** One batch claim; `predicate` discriminates the kind. */
type BatchClaimCommand = {
    predicateAttestationId: string; predicate: string; unit?: string;
    /** Absent only for the cross-root document kinds. */
    fieldKey?: string;
    /** Per-slot salt (v4); required for the single-field kinds. */
    salt?: string;
    // numeric ('lessOrEqual' | 'greaterOrEqual')
    threshold?: string; opCode?: number; value?: string;
    // 'bytesEquality'
    expectedDigest?: string;
    // 'setMembership'
    setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
    // 'documentIntegrity' / 'documentDiff' (document A = the batch payloadHash)
    payloadHashB?: string; allowedMask?: number; k?: number;
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
    siblings?: string[]; dirs?: boolean[];
};

type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle }
    | { op: 'callBatch'; contractAddress: string; calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>; compiledArtifactRef: string; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle; independentCalls?: boolean; orderedPrefix?: number }
    | { op: 'fieldPredicateWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldEqualityWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; expectedDigest: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldMembershipWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; setRoot: string; valueDigest: string; salt: string; siblings: string[]; dirs: boolean[]; setSiblings: string[]; setDirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateBatchWorkflow'; payloadHash: string; contractAddress: string; compiledArtifactRef: string; contentRoot?: string; schemaId?: string; claims: BatchClaimCommand[]; sponsorSessionId?: string }
    | { op: 'documentIntegrityWorkflow'; predicateAttestationId: string; payloadHashA: string; payloadHashB: string; contractAddress: string; compiledArtifactRef: string; allowedMask: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'documentDiffWorkflow'; predicateAttestationId: string; payloadHashA: string; payloadHashB: string; contractAddress: string; compiledArtifactRef: string; k: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'anchorDocument'; documentId: string; payloadHash: string; metadataHash: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string; guardedNonce?: string }
    | { op: 'attestCommit'; commitment: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'grantDisclosure'; disclosureGrantId: string; payloadHash: string; grantee: string; level: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'revokeDisclosure'; payloadHash: string; grantee: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'registerPassport'; passportId: string; ownerId: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

/**
 * Stamped by startJob at persistence time (see background-jobs.ts): the
 * artifact GENERATION the command was created against. Verified fail-closed
 * before execution; the registry name alone is a mutable alias.
 */
type ContractCommandV1WithProvenance = ContractCommandV1 & { artifactDigest?: string };

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

type PredicateKind = 'numeric' | 'equality' | 'membership' | 'integrity' | 'diff';

/**
 * The ONE predicate-literal parser (every call site validates through this,
 * so an unknown literal can never mint a wrong opCode / claim key).
 * `opCode` is the circuit's Uint<8> for the numeric predicates and null for
 * every other kind, whose claim structs carry no op.
 */
function parsePredicate(literal: unknown): { kind: PredicateKind; opCode: number | null } | null {
    if (literal === 'lessOrEqual') return { kind: 'numeric', opCode: 0 };
    if (literal === 'greaterOrEqual') return { kind: 'numeric', opCode: 1 };
    if (literal === 'bytesEquality') return { kind: 'equality', opCode: null };
    if (literal === 'setMembership') return { kind: 'membership', opCode: null };
    if (literal === 'documentIntegrity') return { kind: 'integrity', opCode: null };
    if (literal === 'documentDiff') return { kind: 'diff', opCode: null };
    return null;
}

/**
 * Parse + validate a JSON-encoded Merkle inclusion path of fixed depth.
 * Rejects the request (400) and returns null on any shape violation.
 */
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
        // Strict booleans: map(Boolean) would turn "false" into true and
        // silently corrupt the Merkle path.
        if (typeof d !== 'boolean') { req.reject(400, `${names.dirs} entries must be booleans`); return null; }
    }
    return { siblings: (siblings as string[]).map(s => s.toLowerCase()), dirs: dirs as boolean[] };
}

/**
 * Validate a parsed 16-entry schema descriptor list (throws with a
 * user-facing message on any shape violation; callers map to 400).
 */
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

/**
 * Validate a parsed cross-root document opening ({ saltSeed, slots[16] });
 * throws with a user-facing message on any shape violation.
 */
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
 * Parse + validate a JSON-encoded schema/opening pair off a request; rejects
 * the request (400) and returns null on any violation.
 */
/**
 * True when `allowedMask` frees every REAL (non-padding) slot of `schema`.
 * Such an integrity claim says nothing; the circuit rejects it in-circuit
 * ("mask must constrain at least one schema slot"), this check gives API
 * callers a clean 400 before any proving. Subsumes the all-ones case for
 * schemas with fewer than 16 real fields.
 */
function isVacuousMask(allowedMask: number, schema: SchemaSlotWire[]): boolean {
    return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}

/**
 * CAP delivers Integer64 action parameters (and reads Integer64 columns) as
 * STRINGS (IEEE754-compatible OData serialization); the mask is Integer64
 * because bit 31 of a 32-slot mask overflows a signed Int32. Coerce to a
 * plain number (masks are <= 32 bits, far below MAX_SAFE_INTEGER); null when
 * not an integer.
 */
function coerceMask(raw: unknown): number | null {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

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

/**
 * Optional dependency overrides, primarily for tests.
 */
export interface SubmissionHandlersOptions {
    /** Override the wallet-material factory. Defaults to buildWalletMaterialForSession. */
    walletMaterialFactory?: typeof buildWalletMaterialForSession;
    /** Override contract resolution. Defaults to the static registry. */
    resolveContractImpl?: typeof resolveContract;
    /** Override the submitter constructor. Defaults to the real class. */
    submitterFactory?: (deps: TransactionSubmitterDeps) => TransactionSubmitter;
    /** Override circuit-arg-type introspection. Defaults to reading contract-info.json. */
    circuitArgTypesLoader?: typeof loadCircuitArgTypes;
    /** Override the post-submit disclosure reindexer. Defaults to the real wrapper. */
    disclosureReindexer?: typeof reindexDisclosuresForContract;
    /** Override the crawler-free attestation-state reader. Defaults to the real wrapper. */
    attestationStateReader?: typeof readAttestationStateForContract;
    /** Override the crawler-free predicate-state reader. Defaults to the real wrapper. */
    predicateStateReader?: typeof readPredicateStateForContract;
    /** Override the pure-circuit artifact loader (membership set building). */
    pureCircuitsLoader?: typeof loadPureCircuitsFromRegistry;
}

export function registerSubmissionHandlers(
    srv: cds.ApplicationService,
    // `any` (not cds.DatabaseService) on purpose: tests inject a minimal
    // `{ run }` mock; the handlers only use db.run.
    db: any,
    options: SubmissionHandlersOptions = {}
): void {
    const walletFactory = options.walletMaterialFactory ?? buildWalletMaterialForSession;
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
            || (job.kind === 'commitDocumentAnchor' && command.op !== 'attestCommit')
            || (job.kind === 'grantDisclosure' && command.op !== 'grantDisclosure')
            || (job.kind === 'revokeDisclosure' && command.op !== 'revokeDisclosure')
            || (job.kind === 'registerPassport' && command.op !== 'registerPassport')) {
            throw new Error(`Persisted command operation '${command.op}' is incompatible with ${job.kind}`);
        }

        // Provenance gate: the command's compiledArtifactRef is a MUTABLE
        // registry alias; refuse to execute against a different artifact
        // GENERATION than the one the command was created for (and refuse
        // digest-less commands from older releases outright, instead of
        // silently running them against today's registration).
        {
            const cmd = command as ContractCommandV1WithProvenance;
            if (typeof (cmd as any).compiledArtifactRef === 'string') {
                assertArtifactGeneration(
                    (cmd as any).compiledArtifactRef,
                    cmd.artifactDigest,
                    `Persisted '${command.op}' command of job ${job.ID}`);
            }
        }
        // Child commands INHERIT the parent's generation digest (instead of
        // letting startJob stamp whatever the alias resolves to at
        // child-creation time): a workflow whose alias is re-pointed between
        // steps must fail the child's own gate, never mix generations within
        // one workflow (e.g. anchor from one artifact, proof from another).
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
                    args: [command.payloadHash, command.fieldKey, command.threshold, String(command.opCode)],
                    merkleProof: { fieldValue: command.value, fieldSalt: command.salt, siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId }));
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
            // The expected digest is the PUBLIC statement (also a circuit arg);
            // only the inclusion path travels as witness material.
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldEqualityProof', step: 'proveFieldEquality', commandVersion: 1,
                request: { circuit: 'proveFieldEquality', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldEquality', compiledArtifactRef: command.compiledArtifactRef,
                    args: [command.payloadHash, command.fieldKey, command.expectedDigest],
                    merkleProof: { fieldSalt: command.salt, siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId }));
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
                    args: [command.payloadHash, command.fieldKey, command.setRoot],
                    merkleProof: {
                        fieldDigest: command.valueDigest, fieldSalt: command.salt,
                        siblings: command.siblings, dirs: command.dirs,
                        setProof: { siblings: command.setSiblings, dirs: command.setDirs }
                    },
                    sponsorSessionId: command.sponsorSessionId
                }
            });
            const provenAt = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId }));
            return {
                predicateAttestationId: command.predicateAttestationId, payloadHash: command.payloadHash, fieldKey: command.fieldKey,
                claim: { predicate: 'setMembership', setRoot: command.setRoot },
                proof: { system: 'midnight-compact', circuit: 'proveFieldMembership', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'documentIntegrityWorkflow' || command.op === 'documentDiffWorkflow') {
            // Both content roots must be anchored before the proof; each
            // optional anchor is its own child command (own tx), the same
            // pattern as the single-field workflows. One-transaction flows go
            // through the batch action's document claim kinds instead.
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
            const isIntegrity = command.op === 'documentIntegrityWorkflow';
            // ONE mode-switched circuit serves both kinds (a per-circuit
            // verifier key costs 2119 deploy bytes against the node's 32 KiB
            // per-tx write cap). Args: (a, b, mode, allowedMask, k); the
            // inactive statement rides as a neutral dummy (mask 0 / k 1).
            // Let it propagate: ambiguous child -> ChildReconciliationRequiredError (parent reconciles); definitive rejection -> plain error (parent fails cleanly).
            const proof: any = isIntegrity
                ? await runChild<any>({
                    parent: job, kind: 'documentIntegrityProof', step: 'proveDocumentComparison-integrity', commandVersion: 1,
                    request: { circuit: 'proveDocumentComparison', mode: 'integrity', payloadHashA: command.payloadHashA, payloadHashB: command.payloadHashB },
                    command: {
                        op: 'call', contractAddress: command.contractAddress, circuit: 'proveDocumentComparison', compiledArtifactRef: command.compiledArtifactRef,
                        args: [command.payloadHashA, command.payloadHashB, '0', String(command.allowedMask), '1'],
                        merkleProof: { docPair: { schema: command.schema, openingA: command.openingA, openingB: command.openingB } }, sponsorSessionId: command.sponsorSessionId
                    }
                })
                : await runChild<any>({
                    parent: job, kind: 'documentDiffProof', step: 'proveDocumentComparison-diff', commandVersion: 1,
                    request: { circuit: 'proveDocumentComparison', mode: 'diff', payloadHashA: command.payloadHashA, payloadHashB: command.payloadHashB },
                    command: {
                        op: 'call', contractAddress: command.contractAddress, circuit: 'proveDocumentComparison', compiledArtifactRef: command.compiledArtifactRef,
                        args: [command.payloadHashA, command.payloadHashB, '1', '0', String(command.k)],
                        merkleProof: { docPair: { schema: command.schema, openingA: command.openingA, openingB: command.openingB } }, sponsorSessionId: command.sponsorSessionId
                    }
                });
            const provenAt = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId }));
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
            // ONE transaction for the whole cart: optional anchorContentRoot
            // first (distinct entryPoint, so segment ordering pins it ahead of
            // the proofs), then N proof calls (any mix of proveFieldPredicate /
            // proveFieldEquality / proveFieldMembership), each carrying its
            // OWN proof bundle (per-call witness binding via the batch holder).
            // A false claim fails at local proving, before submission.
            const calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }> = [];
            if (command.contentRoot) {
                calls.push({ circuit: 'anchorContentRoot', args: [command.payloadHash, command.contentRoot, command.schemaId] });
            }
            for (const claim of command.claims) {
                if (claim.predicate === 'documentIntegrity') {
                    calls.push({
                        circuit: 'proveDocumentComparison',
                        args: [command.payloadHash, claim.payloadHashB, '0', String(claim.allowedMask), '1'],
                        merkleProof: { docPair: { schema: claim.schema, openingA: claim.openingA, openingB: claim.openingB } }
                    });
                } else if (claim.predicate === 'documentDiff') {
                    calls.push({
                        circuit: 'proveDocumentComparison',
                        args: [command.payloadHash, claim.payloadHashB, '1', '0', String(claim.k)],
                        merkleProof: { docPair: { schema: claim.schema, openingA: claim.openingA, openingB: claim.openingB } }
                    });
                } else if (claim.predicate === 'bytesEquality') {
                    calls.push({
                        circuit: 'proveFieldEquality',
                        args: [command.payloadHash, claim.fieldKey, claim.expectedDigest],
                        merkleProof: { fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs }
                    });
                } else if (claim.predicate === 'setMembership') {
                    calls.push({
                        circuit: 'proveFieldMembership',
                        args: [command.payloadHash, claim.fieldKey, claim.setRoot],
                        merkleProof: {
                            fieldDigest: claim.valueDigest, fieldSalt: claim.salt,
                            siblings: claim.siblings, dirs: claim.dirs,
                            setProof: { siblings: claim.setSiblings!, dirs: claim.setDirs! }
                        }
                    });
                } else {
                    calls.push({
                        circuit: 'proveFieldPredicate',
                        args: [command.payloadHash, claim.fieldKey, claim.threshold, String(claim.opCode)],
                        merkleProof: { fieldValue: claim.value, fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs }
                    });
                }
            }
            // Let it propagate: ambiguous child -> ChildReconciliationRequiredError (parent reconciles); definitive rejection -> plain error (parent fails cleanly).
            const proof: any = await runChild<any>({
                parent: job, kind: 'fieldPredicateBatchProof', step: 'proveFieldPredicateBatch', commandVersion: 1,
                request: { circuits: calls.map(c => c.circuit), payloadHash: command.payloadHash, claimCount: command.claims.length },
                // The claims are a set (distinct claim keys, no shared cell); only
                // an in-batch anchor is a dependency and stays first.
                command: { op: 'callBatch', contractAddress: command.contractAddress, calls, compiledArtifactRef: command.compiledArtifactRef, sponsorSessionId: command.sponsorSessionId, independentCalls: true, orderedPrefix: calls[0]?.circuit === 'anchorContentRoot' ? 1 : 0 }
            });
            // ONE statement for all rows: the tx is already on chain here, so a
            // partial projection (some rows proven, some not) must be impossible.
            const provenAtBatch = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations)
                .set({ provenTxHash: proof.txHash, provenAt: provenAtBatch, modifiedAt: provenAtBatch })
                .where({ ID: { in: command.claims.map(c => c.predicateAttestationId) } }));
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
        // ATOMIC generation binding: the resolver verifies the stamped digest
        // against the exact registration snapshot it then imports (the gate
        // at the top of this function fast-fails digest-less commands; this
        // closes the check-then-resolve window against a concurrent
        // registerContract and against assets overwritten in place).
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
                sessionId: job.sessionId
            });
            return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'attestCommit') {
            // Guarded-attest phase 1: record the opaque commitment
            // (attestGuarded mode 0; metadata/nonce args ride as zero dummies).
            const result = await submitter.call({
                contractAddress: command.contractAddress, circuit: 'attestGuarded',
                args: [0n, hexToBytes(command.commitment), new Uint8Array(32), new Uint8Array(32)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            return { commitment: command.commitment, contractAddress: command.contractAddress, txHash: result.txHash, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'anchorDocument') {
            // Guarded reveal (attestGuarded mode 1) when the commit-reveal
            // nonce rides with the command; plain attest otherwise.
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: command.guardedNonce ? 'attestGuarded' : 'attest',
                args: command.guardedNonce
                    ? [1n, hexToBytes(command.payloadHash), hexToBytes(command.metadataHash), hexToBytes(command.guardedNonce)]
                    : [hexToBytes(command.payloadHash), hexToBytes(command.metadataHash)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            const anchoredAt = new Date().toISOString();
            await db.run(UPDATE.entity(Documents).set({ anchoredTxHash: result.txHash, anchoredAt, modifiedAt: anchoredAt }).where({ ID: command.documentId }));
            return { documentId: command.documentId, attestationId: command.payloadHash, txHash: result.txHash, anchoredAt, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'grantDisclosure' || command.op === 'revokeDisclosure') {
            const isGrant = command.op === 'grantDisclosure';
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: isGrant ? 'grantDisclosure' : 'revokeDisclosure',
                args: isGrant
                    ? [hexToBytes(command.payloadHash), hexToBytes(command.grantee), BigInt(command.level)]
                    : [hexToBytes(command.payloadHash), hexToBytes(command.grantee)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            const changedAt = new Date().toISOString();
            if (isGrant) {
                await db.run(UPDATE.entity(DisclosureGrants).set({ grantedTxHash: result.txHash, modifiedAt: changedAt }).where({ ID: command.disclosureGrantId }));
            } else {
                await db.run(UPDATE.entity(DisclosureGrants).set({ revokedTxHash: result.txHash, active: false, modifiedAt: changedAt }).where({ contractAddress: command.contractAddress, payloadHash: command.payloadHash, grantee: command.grantee }));
            }
            await reindexAfterSubmit(command.contractAddress, resolved);
            return { ...(isGrant ? { disclosureGrantId: command.disclosureGrantId, level: command.level } : {}), payloadHash: command.payloadHash, grantee: command.grantee, txHash: result.txHash };
        }

        if (command.op === 'registerPassport') {
            const result = await submitter.call({
                contractAddress: command.contractAddress,
                circuit: 'registerPassport',
                args: [hexToBytes(command.passportId), hexToBytes(command.ownerId)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            return { passportId: command.passportId, ownerId: command.ownerId, contractAddress: command.contractAddress, txHash: result.txHash, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'callBatch') {
            // Same per-circuit coercion as the single-call tail below, applied
            // to each entry of the batch (raw JSON args were persisted). The
            // field-predicate batch child coerces like its single-call kinds
            // (fieldAnchorRoot / fieldPredicateProof): hex Bytes<32> + Uint<64>.
            const coercedCalls = command.calls.map(c => {
                if (job.kind === 'fieldPredicateBatchProof') {
                    const args = c.circuit === 'anchorContentRoot'
                        ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), hexToBytes(String(c.args[2]))]
                        : (c.circuit === 'proveFieldEquality' || c.circuit === 'proveFieldMembership')
                            ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), hexToBytes(String(c.args[2]))]
                            : c.circuit === 'proveDocumentComparison'
                                ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), BigInt(String(c.args[2])), expandAllowedMask(Number(c.args[3]), vaultDims(command.compiledArtifactRef).width), BigInt(String(c.args[4]))]
                            : [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), BigInt(String(c.args[2])), BigInt(String(c.args[3]))];
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

        if ((command as { op: string }).op === 'probeCrossServer') {
            // EXPERIMENTAL PROTOTYPE (cross-server-fee-sponsoring FR). Runs in
            // the background-job context (fully detached from any request tx),
            // which is what lets the worker's private-state read acquire a DB
            // connection instead of deadlocking against a pinned request tx.
            const c = command as unknown as { contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[] };
            const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
            const coerced = coerceCircuitArgs(c.args, argTypes);
            const out = await submitter.probeCrossServerSponsor({
                contractAddress: c.contractAddress, circuit: c.circuit, args: coerced,
                contractName: c.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, artifactDigest: resolved.artifactDigest, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath, ...(resolved.slotWidth !== undefined ? { slotWidth: resolved.slotWidth } : {}) },
                sessionId: job.sessionId
            });
            return { ...out, contractAddress: c.contractAddress, circuit: c.circuit, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if ((command as { op: string }).op === 'buildSponsorable') {
            // Cross-server sponsoring PHASE 1: build + sign + finalize under the
            // caller's identity, return the fee-unpaid tx as base64. No sponsor,
            // no submit here.
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
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), BigInt(String(command.args[2])), BigInt(String(command.args[3]))];
        } else if (job.kind === 'fieldEqualityProof' || job.kind === 'fieldMembershipProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), hexToBytes(String(command.args[2]))];
        } else if (job.kind === 'documentIntegrityProof' || job.kind === 'documentDiffProof') {
            // proveDocumentComparison(a, b, mode, allowed_mask, k); the
            // Vector<width, Boolean> mask arg expands from the packed integer.
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), BigInt(String(command.args[2])), expandAllowedMask(Number(command.args[3]), vaultDims(command.compiledArtifactRef).width), BigInt(String(command.args[4]))];
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
    registerBackgroundJobProcessor('deployContract', 1, executeContractCommand);
    registerBackgroundJobProcessor('submitContractCall', 1, executeContractCommand);
    registerBackgroundJobProcessor('submitContractCallBatch', 1, executeContractCommand);
    // Same execution as any contract call; the result additionally carries the
    // token type, without which the caller cannot spend what it just minted.
    registerBackgroundJobProcessor('mintShieldedTestToken', 1, async (raw, job) => {
        const result = await executeContractCommand(raw, job) as Record<string, unknown> | undefined;
        // Narrow to the call shape: this processor only ever runs commands the
        // mint handler wrote, and the executor already rejected any other op.
        const command = raw as Extract<ContractCommandV1, { op: 'call' }>;
        const token = await deriveRawTokenType(String(command?.contractAddress ?? ''));
        return { ...(result ?? {}), tokenTypeHex: token.tokenTypeHex, amount: SHIELDED_TEST_TOKEN_AMOUNT.toString() };
    });
    registerBackgroundJobProcessor('issueFieldPredicateAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldEqualityAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldMembershipAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldPredicateAttestationBatch', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueDocumentIntegrityAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueDocumentDiffAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('probeCrossServerSponsor', 1, executeContractCommand);
    registerBackgroundJobProcessor('buildSponsorableTx', 1, executeContractCommand);

    // Cross-server sponsoring PHASE 2 job: no contract call of our own, just
    // deserialize the caller's finalized tx, enforce policy, pay dust, submit.
    /**
     * EXTERNAL-EFFECT BOOKKEEPING across broadcast attempts of a sponsoring
     * job (both channels). A job crosses the external_execution boundary ONCE
     * (markJobExternalExecution is not re-entrant); every broadcast ATTEMPT
     * gets its own PendingSubmissions row and is reported as submitted with its
     * identifier (markJobSubmitted accepts external_execution|submitted, so it
     * may repeat). A later attempt closes the previous row first: `REJECTED`
     * (provably never on-chain; the job's hash is taken off via
     * reportSubmissionRejected so an exhausted run fails plainly) or `REBUILT`.
     * The job row's txHash is the LATEST attempt's identifier; reconciliation
     * and chain-outcome confirmation resolve it against the indexer.
     */
    const sponsorAttemptLedger = (db: any, job: BackgroundJobRow, command: any, feeSponsorSessionId: () => string) => {
        let boundaryCrossed = false;
        let currentSubmissionId: string | null = null;
        let currentTxHash: string | null = null;
        // Deploys reserved from the grant's lifetime budget for this job: taken at
        // the first submit-intent naming deploys, kept across rebuild attempts,
        // refunded only when the attempt is provably not on chain.
        let reservedDeploys = 0;
        const failPreviousAttempt = async (why: string, rejectedPreInclusion: boolean) => {
            if (!currentSubmissionId) return;
            // Row close, deploy refund (only for an attempt provably not on chain) and
            // taking the rejected hash off the job (CAS on lease + hash) are one transaction.
            // A write that still fails after the contention retry throws: no rebuild on an unclosed attempt.
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
                    // The runner persists this error's code as the job's errorCode;
                    // settleRejectedSponsorAttempts re-runs the bookkeeping from it.
                    // Generic reconciliation cannot resolve it: the hash never reached a mempool.
                    throw new SponsorAttemptBookkeepingPendingError(
                        `sponsoring attempt ${rowId} was rejected before inclusion but its bookkeeping (close, refund, hash) could not be committed: ${String((e as Error)?.message ?? e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                        { submissionId: rowId, txHash: rowHash, grantId: refund > 0 ? String(command.grantId) : undefined, refund });
                }
                throw new Error(`sponsoring attempt could not be closed (${String((e as Error)?.message ?? e)}); the job stops here for reconciliation instead of rebuilding on an open attempt. Original failure: ${why.slice(0, 200)}`);
            }
            if (refund > 0) reservedDeploys = 0;
            currentSubmissionId = null; currentTxHash = null;
        };
        // The intent carries what the WORKER inspected and chose (contract and
        // circuits from the caller transaction, the dust backing, the paying
        // account), so a reconciled result can be rebuilt canonically; stored
        // as JSON on the attempt row (submitIntentData, internal; finalizedTxData
        // keeps its public meaning: the indexed-transaction snapshot).
        const onSubmitIntent = () => async (txHash: string, intent?: { contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[] }) => {
            const submissionId = cds.utils.uuid();
            const deployed = (intent?.deployed ?? []).map(String).filter(Boolean);
            const grantId = command?.grantId ? String(command.grantId) : null;
            // A sponsored deploy consumes the grant's lifetime budget here, before the
            // ack that lets the worker broadcast: one conditional UPDATE, fail-closed (nack, no broadcast).
            // Reservation and attempt row are one transaction; the row carries grant + deployed addresses for the reconciliation finalizer.
            const need = grantId && deployed.length > reservedDeploys ? deployed.length - reservedDeploys : 0;
            const coordinates = {
                feeSponsor: feeSponsorSessionId(), sponsorAccountId: intent?.sponsorAccountId ?? null,
                circuits: intent?.circuits ?? [], contractAddress: intent?.contractAddress ?? null,
                ...(intent?.note ? { note: intent.note } : {}),
                ...(deployed.length ? { deployed } : {}),
                ...(grantId && deployed.length ? { deployReservation: { grantId, count: deployed.length } } : {})
            };
            const row = {
                ID: submissionId, txHash, contractAddress: intent?.contractAddress ?? null, circuitName: intent?.circuits?.[0] ?? null,
                actionType: (deployed.length ? 'DEPLOY' : 'CALL') as 'DEPLOY' | 'CALL', submittedAt: new Date().toISOString(), status: 'pending' as const, sessionId: job.sessionId,
                submitIntentData: JSON.stringify(coordinates)
            };
            // The job transition (running -> submitted, or the rebuild's new hash) rides
            // the same transaction: after a crash the job is either still running with
            // nothing reserved, or submitted with hash, row and reservation all present.
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

    const executeSponsorFinalized = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        // Candidate list: an explicit sponsor stays EXACT (grant pinning is a
        // security boundary); the platform-pool sentinel fans out over the
        // configured pool.
        let candidates: string[];
        if (command.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
            candidates = [...pool];
        } else {
            candidates = [String(command.sponsorSessionId)];
        }
        cds.log('nightgate').info(`sponsorFinalizedTransaction job: ${command.finalizedTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        const waitMs = envMsSetting('NIGHTGATE_SPONSOR_LEASE_WAIT_MS', 120_000);
        const cooldownMs = envMsSetting('NIGHTGATE_SPONSOR_COOLDOWN_MS', 120_000);
        // ONE shared deadline: a fully busy pool QUEUES here (acquireSponsor
        // polls the whole remaining candidate set) instead of skipping every
        // busy member and failing instantly.
        const deadline = Date.now() + waitMs;
        let lastErr: unknown;
        while (candidates.length > 0) {
            let sessionId: string;
            try {
                sessionId = await acquireSponsor(candidates, Math.max(0, deadline - Date.now()));
            } catch (e) {
                throw lastErr ?? e; // pool stayed busy/cooling until the deadline
            }
            try {
                const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: sessionId, requestingUserId: job.requestedBy ?? undefined, config: getNightgatePluginConfig() });
                await ensureFeeSponsorFacade(sponsor, facadeCfg);
                activeSponsorSessionId = sponsor.sponsorSessionId;
                // Same durable external-effect boundary as the unbound path: the
                // worker announces the identifier before it broadcasts, the job
                // row carries it (and a PendingSubmissions row) from then on.
                const out = await walletSponsorFinalizedTx({
                    sponsorSessionId: sponsor.accountId,
                    finalizedTxB64: command.finalizedTxB64,
                    networkId: facadeCfg.networkId,
                    allowedContracts: command.allowedContracts,
                    allowedCircuits: command.allowedCircuits,
                    allowDeploy: command.allowDeploy === true,
                    ownContracts: command.ownContracts
                }, ledger.onSubmitIntent());
                await ledger.markIncluded(out);
                releaseSponsor(sessionId);
                if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                return { ...out, feeSponsor: sponsor.sponsorSessionId };
            } catch (e) {
                lastErr = e;
                // A failover to the next sponsor builds a NEW transaction: close
                // this attempt's row. Whether the hash may stay on the job
                // follows the same rule as the unbound path.
                if (isAmbiguousSubmitOutcome(e)) { releaseSponsor(sessionId); throw e; }
                try {
                    await ledger.failPreviousAttempt(String((e as Error)?.message ?? e), isPreInclusionReject(e));
                } catch (closeErr) {
                    releaseSponsor(sessionId);
                    throw closeErr;
                }
                if (!isRetryableSponsorFailure(e)) {
                    releaseSponsor(sessionId);
                    throw e; // fails identically on every sponsor; do not burn the pool
                }
                // Bench EVERY retryable failure, so the NEXT job skips this
                // sponsor too; whether WE continue depends on candidates left.
                benchSponsor(sessionId, cooldownMs);
                cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed retryably (${String((e as Error).message).slice(0, 120)})`);
                candidates = candidates.filter(c => c !== sessionId);
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };

    /**
     * Reconciliation finalizer for both sponsoring channels: a broadcast whose
     * outcome was ambiguous in-process and is later proven included by the
     * indexer still records the deployed address on the grant. Reads only the
     * attempt row (`deployed`, `deployReservation`). Idempotent (recording is
     * a merge). A reconciled chain failure keeps the reservation consumed:
     * refunds are only for transactions that provably never reached the chain.
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

    registerBackgroundJobProcessor('sponsorFinalizedTransaction', 1, executeSponsorFinalized);

    // 0.18 PARALLEL channel: same policy + pool + failover, but NO exclusive
    // wallet lease. Concurrency comes from per-NOTE locking inside the worker,
    // so many unbound jobs run on ONE wallet at once (distinct notes). The
    // pool loop here only spreads load across wallets and fails over on error.
    const executeSponsorUnbound = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        let candidates: string[];
        if (command.sponsorSessionId === PLATFORM_POOL_SENTINEL) {
            const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
            if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
            candidates = sponsorCandidatesNonExclusive(pool);
        } else {
            candidates = [String(command.sponsorSessionId)];
        }
        const cooldownMs = envMsSetting('NIGHTGATE_SPONSOR_COOLDOWN_MS', 120_000);
        // A 1010/170 or /196 is a transient dust race, not a sponsor-health problem:
        // rebuild the dust spend fresh on the SAME sponsor and resubmit, up to
        // dustRetries times with a short backoff (letting the dust state catch
        // up). This is what makes concurrent sponsoring deterministic instead of
        // "lands sometimes": a lost dust race self-heals rather than failing the
        // job. Only a NON-dust retryable failure benches the sponsor + fails over.
        // 4 x 5 s spans ~2 blocks: the rebuilt spend can only succeed once the
        // sponsor's local dust wallet has applied the spend it lost against.
        const dustRetries = envMsSetting('NIGHTGATE_SPONSOR_DUST_RETRIES', 4);
        const dustBackoffMs = envMsSetting('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS', 5_000);
        cds.log('nightgate').info(`sponsorUnboundTransaction job: ${command.unboundTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        let lastErr: unknown;
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const { failPreviousAttempt, onSubmitIntent } = ledger;
        for (const sessionId of candidates) {
            // LRU-touch BEFORE the first await: concurrent jobs compute their
            // candidate order in the same tick, so a touch after the resolve
            // would send them all to the same wallet instead of round-robin
            // across the pool (one backing per wallet = one lane per wallet).
            touchSponsor(sessionId);
            for (let attempt = 0; attempt <= dustRetries; attempt++) {
                try {
                    const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: sessionId, requestingUserId: job.requestedBy ?? undefined, config: getNightgatePluginConfig() });
                    await ensureFeeSponsorFacade(sponsor, facadeCfg);
                    activeSponsorSessionId = sponsor.sponsorSessionId;
                    const out = await walletSponsorUnboundTx({
                        sponsorSessionId: sponsor.accountId,
                        unboundTxB64: command.unboundTxB64,
                        networkId: facadeCfg.networkId,
                        allowedContracts: command.allowedContracts,
                        allowedCircuits: command.allowedCircuits,
                        allowDeploy: command.allowDeploy === true,
                        ownContracts: command.ownContracts
                    }, onSubmitIntent());
                    await ledger.markIncluded(out);
                    if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                    return { ...out, feeSponsor: sponsor.sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    if (isAmbiguousSubmitOutcome(e)) {
                        // The broadcast may still be included: NO rebuild (two
                        // identifiers / two fees could land). Leave the attempt
                        // row pending and the job's hash in place; the job ends
                        // reconciliation_required and the indexer confirmer
                        // resolves it by identifier.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: ambiguous submit outcome, leaving the job for reconciliation: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    if (isCallNotAppliedFailure(e)) {
                        // On-chain, call not applied (PROVEN via the indexer):
                        // the CALLER's transcript is stale (same-contract
                        // conflict). No sponsor-side rebuild can fix that (the
                        // same caller bytes are rejected at admission); the job
                        // runner fails the job TERMINALLY with the identifier
                        // (job + attempt row in one write, no detour through
                        // reconciliation_required), the caller rebuilds against
                        // the current contract state.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: sponsored call landed but did not apply (caller transcript stale); not retrying: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    await failPreviousAttempt(String((e as Error)?.message ?? e), isPreInclusionReject(e));
                    if (isDustRaceFailure(e)) {
                        // Generic pool-Invalid: one rebuild only (each costs a
                        // full dust proof and it may be a caller-side invalid tx).
                        const budget = isGenericInvalidFailure(e) ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} hit a dust race (1010/170|196 or pool Invalid), rebuild-retry ${attempt + 1}/${budget}: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue; // rebuild the dust spend fresh on the SAME sponsor
                        }
                        // Dust retries exhausted: this is the CALLER's transaction
                        // losing (same-contract conflict, invalid tx), not a
                        // sponsor-health problem. Do NOT bench the wallet; fail.
                        throw e;
                    }
                    if (!isRetryableSponsorFailure(e)) throw e;
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed retryably (${String((e as Error).message).slice(0, 120)})`);
                    break; // fail over to the next candidate
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };
    // Parallel: the kind is HEAVY in background-jobs (4 concurrent by default,
    // `jobs.concurrency.heavy`), and the worker's sponsorUnboundTx never books
    // a spend in the sponsor's dust wallet and runs its proving + submit
    // OUTSIDE the per-facade submit lock (only the fast dust build takes it),
    // so N jobs overlap and land in parallel on N distinct dust backings.
    // Same-backing jobs serialize on the worker's backing lock; a lost dust
    // race (1010/170) self-heals via the rebuild-retry above. The whole-wallet
    // dust-wedge snapshot/restore stays exclusive to the BOUND paths (which
    // hold the whole-call lock); the unbound path never arms it.
    registerBackgroundJobProcessor('sponsorUnboundTransaction', 1, executeSponsorUnbound);

    registerBackgroundJobProcessor('anchorDocument', 1, executeContractCommand);
    registerBackgroundJobProcessor('commitDocumentAnchor', 1, executeContractCommand);
    registerBackgroundJobProcessor('grantDisclosure', 1, executeContractCommand);
    registerBackgroundJobProcessor('revokeDisclosure', 1, executeContractCommand);
    registerBackgroundJobProcessor('registerPassport', 1, executeContractCommand);
    for (const childKind of ['predicateCommitValue', 'predicateProof', 'fieldAnchorRoot', 'fieldPredicateProof', 'fieldEqualityProof', 'fieldMembershipProof', 'fieldPredicateBatchProof', 'documentIntegrityProof', 'documentDiffProof']) {
        registerBackgroundJobProcessor(childKind, 1, executeContractCommand);
    }

    const finalizeContractProjection = async (
        raw: unknown,
        _job: BackgroundJobRow,
        evidence: ReconciliationEvidence
    ): Promise<unknown> => {
        const command = raw as ContractCommandV1;
        // Same fail-closed provenance gate as the executor: reconciliation
        // may run long after submission (restart, upgrade), and its
        // projection/reindex work resolves the alias too; a re-pointed alias
        // must not finalize against a different registration.
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
            if (isGrant) {
                await db.run(UPDATE.entity(DisclosureGrants).set({
                    grantedTxHash: evidence.txHash, modifiedAt: changedAt
                }).where({ ID: command.disclosureGrantId }));
            } else {
                await db.run(UPDATE.entity(DisclosureGrants).set({
                    revokedTxHash: evidence.txHash, active: false, modifiedAt: changedAt
                }).where({
                    contractAddress: command.contractAddress,
                    payloadHash: command.payloadHash,
                    grantee: command.grantee
                }));
            }
            // Same atomic generation binding as the executor (the gate at the
            // top of the finalizer fast-fails digest-less commands).
            const resolved = await contractResolver(
                command.compiledArtifactRef,
                (command as ContractCommandV1WithProvenance).artifactDigest);
            await reindexAfterSubmit(command.contractAddress, resolved);
            return {
                reconciled: true,
                ...(isGrant ? { disclosureGrantId: command.disclosureGrantId, level: command.level } : {}),
                payloadHash: command.payloadHash, grantee: command.grantee, txHash: evidence.txHash
            };
        }
        if (command.op === 'registerPassport') {
            return {
                reconciled: true, passportId: command.passportId, ownerId: command.ownerId,
                contractAddress: command.contractAddress, txHash: evidence.txHash,
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        if (command.op === 'attestCommit') {
            return {
                reconciled: true, commitment: command.commitment,
                contractAddress: command.contractAddress, txHash: evidence.txHash,
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        if (command.op === 'callBatch') {
            // Rebuild the documented batch result from the encrypted command
            // (the ordered circuits) + the durable evidence. Without this the
            // generic recovery result would miss `circuits`.
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
    registerBackgroundJobReconciliationFinalizer('commitDocumentAnchor', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('grantDisclosure', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('revokeDisclosure', 1, finalizeContractProjection);
    registerBackgroundJobReconciliationFinalizer('registerPassport', 1, finalizeContractProjection);
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

        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(deployRateLimiter, sessionId, req)) return;

        let parsedInitialState: unknown = {};
        if (initialPrivateState) {
            try { parsedInitialState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        // Sync setup phase: setup errors become 404/401/501 via runSubmission.
        // The SDK round-trip is deferred to the background job and surfaces
        // failures via BackgroundJobs.errorCode/errorMessage, not OData status.
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
                request: { compiledArtifactRef, sessionId, hasInitialState: !!initialPrivateState, feeSponsor: sponsor?.sponsorSessionId ?? null },
                idempotencyPayload: {
                    compiledArtifactRef, sessionId, initialPrivateState: parsedInitialState,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'deploy', compiledArtifactRef, initialPrivateState: parsedInitialState, sponsorSessionId: sponsor?.sponsorSessionId }
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

        // Seeded only when the calling wallet has NO private state for this
        // contract yet (it did not deploy it). Defaults to `{}` downstream.
        let parsedInitialPrivateState: unknown;
        if (initialPrivateState) {
            try { parsedInitialPrivateState = JSON.parse(initialPrivateState); }
            catch { return req.reject(400, 'initialPrivateState must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);

            // Coerce args into the shapes the circuit requires (Bytes<N> →
            // Uint8Array, Uint<N> → BigInt) before the worker spreads them.
            // CoercionError → 400 via runSubmission. See arg-coercion.ts.
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
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'call', contractAddress, circuit, compiledArtifactRef, args: parsedArgs, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId }
            });
        });
    });

    // The bundled shielded-token fixture, as a first-class surface. It shipped
    // compiled artifacts from 0.11.0 on, but using it meant a generic
    // submitContractCall PLUS knowing the contract's domain separator to derive
    // the token type by hand, which is the one piece a caller cannot guess.
    srv.on('mintShieldedTestToken', async (req: Request) => {
        const { contractAddress, sessionId, compiledArtifactRef, idempotencyKey, sponsorSessionId } = req.data as {
            contractAddress?: string; sessionId?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required (deploy shielded-token first)');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(callRateLimiter, sessionId, req)) return;

        // The processor enriches the result with the FIXTURE's domain separator
        // and mint amount, so a foreign minting contract would execute fine and
        // then be reported with a WRONG tokenTypeHex. Only the bundled fixture
        // (or an explicit repeat of its name) is accepted; other contracts go
        // through submitContractCall + deriveTokenType with their own separator.
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
                commandVersion: 1,
                encryptCommand: true,
                // mint() takes no arguments; the contract's own round counter
                // feeds the coin nonce, so repeat calls mint distinct coins.
                command: {
                    op: 'call', contractAddress, circuit: SHIELDED_TEST_TOKEN_CIRCUIT,
                    compiledArtifactRef: artifactRef, args: [],
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
        });
    });

    // Compute-only: no wallet, no chain, no proving. Deliberately NOT
    // restricted to the bundled token; any minting contract's token type is
    // derived the same way.
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

    // EXPERIMENTAL PROTOTYPE (cross-server-fee-sponsoring FR). Synchronous
    // diagnostic: runs a contract call as the caller's phase 1, round-trips the
    // finalized tx through serialize/deserialize, and has the sponsor session
    // balance dust + submit (phase 2). Proves the finalized-tx round-trip that
    // a cross-machine sponsor endpoint would rely on. Not a shipping path; no
    // job, no idempotency, no PendingSubmissions.
    srv.on('probeCrossServerSponsor', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args, sponsorSessionId } = req.data as {
            contractAddress?: string; circuit?: string; compiledArtifactRef?: string;
            sessionId?: string; args?: string; sponsorSessionId?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (!sponsorSessionId) return req.reject(400, 'sponsorSessionId is required (the second session that pays dust)');
        if (rejectIfMainnetBlocked(req)) return;

        let parsedArgs: unknown[] = [];
        if (args) {
            try { const v = JSON.parse(args); if (!Array.isArray(v)) return req.reject(400, 'args must be a JSON array'); parsedArgs = v; }
            catch { return req.reject(400, 'args must be valid JSON'); }
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);
            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            const coercedArgs = coerceCircuitArgs(parsedArgs, argTypes);

            await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, sponsorSessionId);

            // Runs as a background job (fully detached): the synchronous request
            // path deadlocks the worker's private-state read against the pinned
            // request tx connection. Poll getJobStatus for { txHash, roundTrip,
            // serializedBytes }.
            return startJob({
                kind: 'probeCrossServerSponsor',
                sessionId,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'probeCrossServer', contractAddress, circuit, compiledArtifactRef, args: parsedArgs, sponsorSessionId: sponsor?.sponsorSessionId }
            });
        });
    });

    // Cross-server sponsoring PHASE 1 (0.17.0). Build + sign + finalize a call
    // under the caller's identity; returns the fee-unpaid tx as base64 (poll
    // getJobStatus). The caller then ships those bytes to a sponsor endpoint.
    // (Server-side variant; the txbuilder SDK runs this on the caller's own
    // machine so its key never leaves it.)
    srv.on('buildSponsorable', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args } = req.data as {
            contractAddress?: string; circuit?: string; compiledArtifactRef?: string; sessionId?: string; args?: string;
        };
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!circuit) return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId) return req.reject(400, 'sessionId is required');
        if (rejectIfMainnetBlocked(req)) return;
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
                requestedBy: (req as any).user?.id, commandVersion: 1, encryptCommand: true,
                command: { op: 'buildSponsorable', contractAddress, circuit, compiledArtifactRef, args: parsedArgs }
            });
        });
    });

    // Cross-server sponsoring PHASE 2 (0.17.0). Take a caller-finalized,
    // fee-unpaid tx (base64), enforce policy (allowed vault + circuits), pay
    // dust with the sponsor session and submit. This is the half a public /
    // x402-metered endpoint exposes.
    srv.on('sponsorFinalizedTransaction', async (req: Request) => {
        const { finalizedTxB64, sponsorSessionId, idempotencyKey } = req.data as {
            finalizedTxB64?: string; sponsorSessionId?: string; idempotencyKey?: string;
        };
        if (!finalizedTxB64) return req.reject(400, 'finalizedTxB64 is required');
        // The platform-pool sentinel (or an omitted sponsor with a configured
        // pool) defers the concrete choice to execution time, which is what
        // enables failover; an explicit session id stays exact.
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) {
                return req.reject(400, 'sponsorSessionId is required (the wallet that pays dust); no platform pool is configured');
            }
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            // Explicit sponsor: validate at admission, fail fast. POOL jobs
            // validate NOTHING here: the pool is operator config, a broken
            // first entry must not block admission (the processor resolves per
            // candidate with failover), and the job key must be STABLE for
            // idempotency, so pool jobs are keyed under the sentinel itself
            // rather than under whichever member happened to be free.
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: (req as any).user?.id, config: getNightgatePluginConfig() });
                await ensureFeeSponsorFacade(sponsor, facadeCfg);
            }
            // Allow-list: platform floor (env or NIGHTGATE_SPONSOR_POLICY_FILE) narrowed by
            // the agent grant's lists when the request carries a token; empty floor = allow any (dev).
            // Refused at admission, before a job exists: empty intersection or unusable policy file.
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts } = resolveSponsorPolicyForRequest(req);
            // Grant behind a token request; a sponsored deploy's address is recorded onto it.
            const grantId: string | undefined = (req as any).agentGrant?.ID ? String((req as any).agentGrant.ID) : undefined;
            // Idempotency scope: pool jobs share ONE sessionId (the sentinel)
            // and platform sponsors are shared across callers, so a raw key
            // would put every caller into one global namespace (user A's key
            // could dedupe or block user B's). Scope the key per caller.
            const caller = String((req as any).user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorFinalizedTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                // Fingerprint the tx CONTENT, not its length: two different
                // transactions of equal size under one idempotencyKey would
                // otherwise dedupe onto each other and the second caller would
                // be handed the first one's job.
                request: {
                    feeSponsor: effectiveSponsor,
                    caller,
                    bytes: finalizedTxB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(finalizedTxB64, 'base64')))
                },
                requestedBy: (req as any).user?.id, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorFinalized', finalizedTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, grantId }
            });
            // The job is keyed by the SPONSOR session (or the pool sentinel),
            // which an agent-grant caller may not know. Return it so the
            // caller can poll getJobStatus without guessing.
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    // 0.18 PARALLEL channel. Mirrors sponsorFinalizedTransaction but takes an
    // UNBOUND caller tx; the processor uses per-note locking for parallelism.
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

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: (req as any).user?.id, config: getNightgatePluginConfig() });
                await ensureFeeSponsorFacade(sponsor, facadeCfg);
            }
            // Floor narrowed by the agent grant; see sponsorFinalizedTransaction above.
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts } = resolveSponsorPolicyForRequest(req);
            // Grant behind a token request; a sponsored deploy's address is recorded onto it.
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
                requestedBy: (req as any).user?.id, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorUnbound', unboundTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, grantId }
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

        // `calls` is a JSON array of { circuit, args } executed IN ORDER inside
        // one transaction. Bounded: each call carries a ZK proof, so a huge
        // scope is slow to prove, and a single rejected call discards the
        // whole scope pre-submission (post-submission the fallible phase can
        // still finalize PARTIAL_SUCCESS; see the action doc).
        const { depth: rawBatchDepth } = vaultDims(compiledArtifactRef);
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
                // Optional per-call witness proof bundle (field-bound proof
                // circuits). Validated here so a malformed proof is a 400,
                // not a failed job at witness-invocation time. `fieldValue`
                // feeds proveFieldPredicate, `fieldDigest`/`setProof` feed
                // proveFieldMembership; proveFieldEquality needs the path only.
                let merkleProof: MerkleProofBundle | undefined;
                if (entry.merkleProof !== undefined) {
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
            nonce?: string;
        };

        if (!data.sha256) return req.reject(400, 'sha256 is required');
        if (!data.storageRef) return req.reject(400, 'storageRef is required');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!SHA256_HEX_RE.test(data.sha256)) {
            return req.reject(400, 'sha256 must be 64 hex chars (32 bytes)');
        }
        // Guarded reveal: with a nonce the anchor runs attestGuarded mode 1
        // against the previously committed
        // persistentHash(payload, metadataHash, nonce) (see
        // prepareAnchorCommitment / commitDocumentAnchor). Front-run recovery:
        // a plain attest that landed AFTER the commit is taken over.
        if (data.nonce !== undefined && !SHA256_HEX_RE.test(data.nonce)) {
            return req.reject(400, 'nonce must be 64 hex chars (32 bytes; from prepareAnchorCommitment)');
        }

        const metadataStr = data.metadata ?? '';
        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(anchorRateLimiter, data.sessionId, req)) return;

        // On-chain inputs: payload_hash (caller's sha256) + metadata_hash (of the
        // public metadata blob). Both 32-byte commitments; bytes live off-chain
        // at `storageRef`.
        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));

        // Insert the Documents row up-front so its ID is stable and queryable
        // while the on-chain anchoring is deferred to the background job. Gives
        // clients a stable handle without polling.
        const documentId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        // Anchoring context is persisted WITH the row (owner, vault, network,
        // artifact): verifyDocument only trusts this recorded binding, never
        // caller-supplied coordinates, and reads are owner-scoped.
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
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        // Sync setup (errors → 404/401/501 via runSubmission); SDK round-trip +
        // Documents UPDATE run in the background job.
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'anchorDocument',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    sha256: data.sha256!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    compiledRef,
                    documentId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    sha256: data.sha256!.toLowerCase(), contractAddress: data.contractAddress,
                    compiledRef, metadata: metadataStr, feeSponsor: sponsor?.sponsorSessionId ?? null,
                    guardedNonce: data.nonce?.toLowerCase() ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'anchorDocument', documentId, payloadHash: data.sha256!.toLowerCase(),
                    metadataHash: bytesToHex(metadataHashBytes), contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId,
                    guardedNonce: data.nonce?.toLowerCase()
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(Documents).where({ ID: documentId }));
            const stableDocumentId = (job.originalRequest as any)?.documentId ?? documentId;
            return { jobId: job.jobId, status: job.status, documentId: stableDocumentId };
        });
    });

    // Guarded attest, phase 0 (compute-only): the commitment + nonce for a
    // commit-reveal anchor. The commitment is
    // persistentHash(AttestCommitPreimage{sha256, metadataHash, nonce}),
    // byte-identical to attestGuarded's in-circuit recompute. STORE the
    // nonce: it is required at reveal time (anchorDocument with `nonce`) and
    // must stay secret until then (it is what a front-runner cannot forge).
    srv.on('prepareAnchorCommitment', async (req: Request) => {
        const data = req.data as { sha256?: string; metadata?: string; nonce?: string };
        if (!data.sha256) return req.reject(400, 'sha256 is required');
        if (!SHA256_HEX_RE.test(data.sha256)) return req.reject(400, 'sha256 must be 64 hex chars (32 bytes)');
        if (data.nonce !== undefined && !SHA256_HEX_RE.test(data.nonce)) {
            return req.reject(400, 'nonce must be 64 hex chars (32 bytes)');
        }
        const metadataStr = data.metadata ?? '';
        const metadataHash = bytesToHex(sha256(new TextEncoder().encode(metadataStr)));
        const nonce = data.nonce?.toLowerCase() ?? randomBytes(32).toString('hex');
        const commitment = await computeAttestCommitment(data.sha256.toLowerCase(), metadataHash, nonce);
        return { commitment, nonce, metadataHash };
    });

    // Guarded attest, phase 1 (async submit): record the opaque commitment
    // on-chain (attestGuarded mode 0). Nothing about the payload leaks; a
    // mempool observer sees only the hash. After the commit finalizes, run
    // `anchorDocument` WITH the nonce (phase 2, reveal): a plain attest that
    // front-ran the reveal is taken over because its sequence number is
    // newer than the commitment's.
    srv.on('commitDocumentAnchor', async (req: Request) => {
        const data = req.data as {
            commitment?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };
        if (!data.commitment) return req.reject(400, 'commitment is required (from prepareAnchorCommitment)');
        if (!SHA256_HEX_RE.test(data.commitment)) return req.reject(400, 'commitment must be 64 hex chars (32 bytes)');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(anchorRateLimiter, data.sessionId, req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'commitDocumentAnchor',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    commitment: data.commitment!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    compiledRef,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    commitment: data.commitment!.toLowerCase(), contractAddress: data.contractAddress,
                    compiledRef, feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'attestCommit', commitment: data.commitment!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });
            return { jobId: job.jobId, status: job.status };
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

        // Evidence binding: the row records its anchoring context (vault,
        // artifact, network) and those recorded coordinates are
        // authoritative. Caller-supplied values may only CONFIRM them; a
        // different one is rejected, otherwise any other vault (or another
        // artifact generation) attesting the same public hash could make
        // this document appear verified. Rows from pre-0.16.0 releases carry
        // nulls; only for those do the caller's values apply.
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
        // Recorded network: the state fallback reads THAT chain's indexer,
        // never silently the currently configured one.
        const recordedNetwork = doc.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(doc.network)
            ? doc.network as NightgateNetwork
            : undefined;

        const hashMatches = doc.sha256?.toLowerCase() === providedSha256.toLowerCase();
        const anchoredOk = Boolean(doc.anchoredTxHash);

        // Only resolve the on-chain status if we have a txHash and the hash
        // matched. Skipping the SELECT in the mismatch path saves one DB
        // round-trip on what is the "tampered" answer most of the time.
        let chainSuccess = false;
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
                chainSuccess = result?.status === 'SUCCESS'
                    && result?.outcomeSource === 'substrate-system-events';
            } else if (effectiveContract && liveProviderConfigured(recordedNetwork)) {
                // Crawler-free fallback (anchoring tx not indexed locally): confirm
                // the effect against live state. The document's sha256 is its
                // on-chain payload_hash, so a present attestation IS the proof.
                // Runs against the RECORDED anchoring vault, artifact and
                // network whenever the row carries them (evidence binding).
                chainSuccess = await verifyDocumentViaState(
                    effectiveContract, doc.sha256, effectiveArtifact, recordedNetwork,
                    doc.artifactDigest ?? null);
            }
        }

        return {
            verified: hashMatches && anchoredOk && chainSuccess,
            anchoredTxHash: doc.anchoredTxHash ?? '',
            anchoredAt: doc.anchoredAt ?? null,
            originalSha256: doc.sha256 ?? ''
        };
    });

    srv.on('issueFieldPredicateAttestation', async (req: Request) => {
        const data = req.data as {
            payloadHash?: string;
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

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
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
        if (thresholdBig > UINT64_MAX) return req.reject(400, 'threshold exceeds Uint<64>');

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual' (use issueFieldEqualityAttestation / issueFieldMembershipAttestation for the bytes kinds)");
        }
        const op = parsedPredicate.opCode!;

        // Parse + validate the inclusion path (depth = log2 of the artifact's
        // slot width: 4 for the classic vault, 5 for attestation-vault-32).
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
            // Strict booleans: map(Boolean) would turn "false" into true and
            // silently corrupt the Merkle path.
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

        // Row up-front (same shape as issuePredicateAttestation; field-agnostic).
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate: data.predicate,
            op,
            threshold: data.threshold as any,
            unit: data.unit ?? null,
            // Field-bound proof: record the field key so verifyPredicateAttestation's
            // crawler-free fallback can recompute the FieldPredicateClaim key.
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
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: data.predicate,
                    threshold: String(data.threshold),
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: data.predicate,
                    threshold: String(data.threshold), value: data.value, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId, siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateWorkflow', predicateAttestationId,
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
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
            payloadHash?: string; fieldKey?: string;
            expectedValue?: string; expectedDigest?: string; fieldSalt?: string;
            contentRoot?: string; schemaId?: string; siblingsJson?: string; dirsJson?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        if (!SHA256_HEX_RE.test(data.fieldKey)) return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');

        const hasValue = typeof data.expectedValue === 'string' && data.expectedValue.length > 0;
        const hasDigest = typeof data.expectedDigest === 'string' && data.expectedDigest.length > 0;
        if (hasValue === hasDigest) return req.reject(400, 'pass exactly one of expectedValue / expectedDigest');
        if (hasDigest && !SHA256_HEX_RE.test(data.expectedDigest!)) {
            return req.reject(400, 'expectedDigest must be 64 hex chars (32 bytes)');
        }
        // The digest covers the EXACT string (no trimming), matching the
        // bytes-leaf encoding of prepareDocumentProof.
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

        // Row up-front, same lifecycle as the numeric field action. The bytes
        // kinds have no op/threshold; the expected digest IS the statement.
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
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
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'bytesEquality',
                    expectedDigest,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'bytesEquality',
                    expectedDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldEqualityWorkflow', predicateAttestationId,
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
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
            payloadHash?: string; fieldKey?: string;
            value?: string; valueDigest?: string;
            allowedValuesJson?: string; setRoot?: string; setSiblingsJson?: string; setDirsJson?: string;
            fieldSalt?: string;
            contentRoot?: string; schemaId?: string; siblingsJson?: string; dirsJson?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
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

        // Row up-front. The set root is the public statement; the value digest
        // and both inclusion paths stay witness material (encrypted command).
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
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
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'setMembership',
                    setRoot,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'setMembership',
                    setRoot, valueDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldMembershipWorkflow', predicateAttestationId,
                    payloadHash: data.payloadHash!.toLowerCase(), fieldKey: data.fieldKey!.toLowerCase(),
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
            payloadHashA?: string; payloadHashB?: string; allowedMask?: number | string;
            schemaJson?: string; openingAJson?: string; openingBJson?: string;
            contentRootA?: string; contentRootB?: string; schemaId?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!SHA256_HEX_RE.test(data.payloadHashA)) return req.reject(400, 'payloadHashA must be 64 hex chars (32 bytes)');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (!SHA256_HEX_RE.test(data.payloadHashB)) return req.reject(400, 'payloadHashB must be 64 hex chars (32 bytes)');
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

        // Row up-front, same lifecycle as the field actions. Document A rides
        // in the shared payloadHash column; the mask is its own column so the
        // two cross-root statements stay unmistakable.
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate: 'documentIntegrity',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
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
                    contractAddress: data.contractAddress,
                    predicate: 'documentIntegrity',
                    allowedMask,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'documentIntegrity',
                    allowedMask,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentIntegrityWorkflow', predicateAttestationId,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(),
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
            payloadHashA?: string; payloadHashB?: string; k?: number;
            schemaJson?: string; openingAJson?: string; openingBJson?: string;
            contentRootA?: string; contentRootB?: string; schemaId?: string;
            sessionId?: string; contractAddress?: string; compiledArtifactRef?: string;
            idempotencyKey?: string; sponsorSessionId?: string;
        };

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!SHA256_HEX_RE.test(data.payloadHashA)) return req.reject(400, 'payloadHashA must be 64 hex chars (32 bytes)');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (!SHA256_HEX_RE.test(data.payloadHashB)) return req.reject(400, 'payloadHashB must be 64 hex chars (32 bytes)');
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

        // k rides in the threshold column (an integer bound, like the numeric
        // predicates' threshold).
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate: 'documentDiff',
            op: null,
            threshold: data.k as any,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
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
                    contractAddress: data.contractAddress,
                    predicate: 'documentDiff',
                    k: data.k,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'documentDiff',
                    k: data.k,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentDiffWorkflow', predicateAttestationId,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(),
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
            payloadHash?: string;
            contentRoot?: string; schemaId?: string;
            claimsJson?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
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

        // 8 calls per transaction is the batch cap; an in-batch anchor
        // occupies one slot.
        const maxClaims = data.contentRoot ? 7 : 8;
        // Mixed-kind batch claim; `predicate` discriminates (numeric /
        // bytesEquality / setMembership / documentIntegrity / documentDiff).
        // `allowedValues` is the raw list of a membership claim before set
        // resolution. The document kinds carry no fieldKey/inclusion path;
        // document A is the batch-level payloadHash.
        interface BatchClaim {
            fieldKey?: string; siblings?: string[]; dirs?: boolean[];
            predicate: string; unit?: string;
            value?: string; threshold?: string; opCode?: number;
            expectedDigest?: string;
            setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
            allowedValues?: string[];
            salt?: string;
            payloadHashB?: string; allowedMask?: number; k?: number;
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
                // Strict booleans: map(Boolean) would turn "false" into
                // true and silently corrupt the Merkle path.
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
                    // Cross-root document claims: document A is the batch
                    // payloadHash, so an in-batch contentRoot anchor is A's
                    // root and B's must already be anchored.
                    if (typeof entry.payloadHashB !== 'string' || !SHA256_HEX_RE.test(entry.payloadHashB)) {
                        throw new Error(`claims[${i}].payloadHashB must be 64 hex chars (32 bytes)`);
                    }
                    const payloadHashB = entry.payloadHashB.toLowerCase();
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
                            predicate: 'documentIntegrity', payloadHashB, allowedMask: entry.allowedMask,
                            schema, openingA, openingB
                        };
                    }
                    if (!Number.isInteger(entry.k) || entry.k < 1 || entry.k > batchWidth) {
                        throw new Error(`claims[${i}].k must be an integer in 1..${batchWidth}`);
                    }
                    return {
                        predicate: 'documentDiff', payloadHashB, k: entry.k,
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
                if (thresholdBig > UINT64_MAX) throw new Error(`claims[${i}].threshold exceeds Uint<64>`);
                return { ...base, value: valueBig.toString(), threshold: thresholdBig.toString(), opCode: parsed.opCode! };
            });
        } catch (e: any) {
            return req.reject(400, /^claims\[/.test(String(e?.message)) ? String(e.message) : 'claimsJson must be valid JSON');
        }

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        // Resolve allowedValues lanes to set roots + paths BEFORE dedup and the
        // rate gate: dedup keys need the set root, and a value-not-in-list 400
        // must not consume proving budget.
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

        // Drop exact duplicate claim tuples: claim keys are idempotent on-chain
        // (insert overwrites true with true), so duplicates only waste proving
        // time. First occurrence wins; the response reports the drop count.
        // The tuple mirrors each kind's on-chain claim struct.
        const seenTuples = new Set<string>();
        const uniqueClaims: BatchClaim[] = [];
        for (const c of claims) {
            const tuple = c.predicate === 'bytesEquality' ? `${c.fieldKey}|eq|${c.expectedDigest}`
                : c.predicate === 'setMembership' ? `${c.fieldKey}|set|${c.setRoot}`
                : c.predicate === 'documentIntegrity' ? `${c.payloadHashB}|integ|${c.allowedMask}`
                : c.predicate === 'documentDiff' ? `${c.payloadHashB}|diff|${c.k}`
                : `${c.fieldKey}|${c.threshold}|${c.opCode}`;
            if (seenTuples.has(tuple)) continue;
            seenTuples.add(tuple);
            uniqueClaims.push(c);
        }
        const droppedDuplicates = claims.length - uniqueClaims.length;

        if (rejectIfMainnetBlocked(req)) return;
        // The batch counts as N claims against the limiter, not one action
        // call, so batching is not a rate-limit bypass. All-or-nothing: a
        // rejected batch consumes no budget.
        if (!checkRate(predicateRateLimiter, data.sessionId, req, uniqueClaims.length)) return;

        // One row per claim up-front, same shape as the single action; on
        // success every row gets the SAME provenTxHash.
        const insertedAt = new Date().toISOString();
        const rowedClaims = uniqueClaims.map(c => ({ ...c, predicateAttestationId: cds.utils.uuid() }));
        await db.run(INSERT.into(PredicateAttestations).entries(rowedClaims.map(c => ({
            ID: c.predicateAttestationId,
            payloadHash: data.payloadHash!.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate: c.predicate,
            op: c.opCode ?? null,
            // documentDiff stores its k bound in the threshold column, like
            // the numeric predicates store theirs.
            threshold: (c.predicate === 'documentDiff' ? c.k : c.threshold ?? null) as any,
            unit: c.unit ?? null,
            fieldKey: c.fieldKey ?? null,
            expectedDigest: c.expectedDigest ?? null,
            setRoot: c.setRoot ?? null,
            payloadHashB: c.payloadHashB ?? null,
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
                    contractAddress: data.contractAddress,
                    claimCount: rowedClaims.length,
                    claims: publicClaims,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    contentRoot: data.contentRoot?.toLowerCase() ?? null,
                    claims: uniqueClaims.map(c => ({
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        value: c.value, expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        salt: c.salt, siblings: c.siblings, dirs: c.dirs,
                        payloadHashB: c.payloadHashB, allowedMask: c.allowedMask, k: c.k,
                        schema: c.schema, openingA: c.openingA, openingB: c.openingB
                    })),
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateBatchWorkflow',
                    payloadHash: data.payloadHash!.toLowerCase(),
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
                        payloadHashB: c.payloadHashB, allowedMask: c.allowedMask, k: c.k,
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
        // Same check as verifyDocument: the proof tx must resolve to an indexed
        // SUCCESS result before the predicate verification is trustworthy.
        let chainSuccess = false;
        if (provenOk) {
            const txRow: any = await db.run(
                SELECT.one.from(Transactions).columns('ID', 'hash').where({ hash: row.provenTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: txRow.ID })
                );
                chainSuccess = result?.status === 'SUCCESS'
                    && result?.outcomeSource === 'substrate-system-events';
            }
        }

        // Crawler-free fallback (proof tx not indexed locally): recompute the
        // claim key from the row and look it up in predicate_results against
        // live state OF THE RECORDED NETWORK/ARTIFACT (evidence provenance).
        // Verifies the effect, not the tx, so no crawler/txHash needed.
        const rowNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
            ? row.network as NightgateNetwork
            : undefined;
        if (!chainSuccess && liveProviderConfigured(rowNetwork) && row.contractAddress && row.payloadHash) {
            chainSuccess = await verifyPredicateViaState(row);
        }

        return {
            verified: chainSuccess,
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

        // Row up-front: a stable pollable handle. active=false (optimistic
        // placeholder) until the chain indexer confirms the grant in ledger
        // state; the chain is the source of truth. Reuse an existing row for the
        // same (contract, payloadHash, grantee) so retries don't orphan rows.
        const insertedAt = new Date().toISOString();
        const existingGrant: any = await db.run(
            SELECT.one.from(DisclosureGrants).columns('ID').where({
                contractAddress: contractAddressLc,
                payloadHash: payloadHashLc,
                grantee: granteeLc
            })
        );
        const disclosureGrantId = existingGrant?.ID ?? cds.utils.uuid();
        if (existingGrant) {
            await db.run(UPDATE.entity(DisclosureGrants)
                .set({ level: levelNum, revokedTxHash: null, modifiedAt: insertedAt })
                .where({ ID: disclosureGrantId }));
        } else {
            await db.run(INSERT.into(DisclosureGrants).entries({
                ID: disclosureGrantId,
                payloadHash: payloadHashLc,
                grantee: granteeLc,
                level: levelNum,
                contractAddress: contractAddressLc,
                grantedTxHash: null,
                revokedTxHash: null,
                active: false,
                createdAt: insertedAt,
                modifiedAt: insertedAt
            }));
        }

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'grantDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    grantee: granteeLc,
                    level: levelNum,
                    contractAddress: contractAddressLc,
                    disclosureGrantId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'grantDisclosure', disclosureGrantId, payloadHash: payloadHashLc,
                    grantee: granteeLc, level: levelNum, contractAddress: contractAddressLc,
                    compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

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

            const job = await startJob({
                kind: 'revokeDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    grantee: granteeLc,
                    contractAddress: contractAddressLc,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'revokeDisclosure', payloadHash: payloadHashLc, grantee: granteeLc,
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
            ownerId?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.passportId) return req.reject(400, 'passportId is required');
        if (!SHA256_HEX_RE.test(data.passportId)) return req.reject(400, 'passportId must be 64 hex chars (32 bytes)');
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
                    ownerId: ownerIdLc,
                    contractAddress: contractAddressLc,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'registerPassport', passportId: passportIdLc, ownerId: ownerIdLc,
                    contractAddress: contractAddressLc, compiledArtifactRef: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    // ------------------------------------------------------------------
    // Crawler-free on-chain state verification.
    // Both read LIVE contract state via queryContractState,
    // so they work with the block crawler disabled and without a local txHash.
    // ------------------------------------------------------------------

    srv.on('verifyAttestationState', async (req: Request) => {
        const data = req.data as {
            contractAddress?: string;
            payloadHash?: string;
            contentRoot?: string;
            schemaId?: string;
            compiledArtifactRef?: string;
            network?: string;
        };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) {
            return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }
        if (data.schemaId && !SHA256_HEX_RE.test(data.schemaId)) {
            return req.reject(400, 'schemaId must be 64 hex chars (32 bytes)');
        }
        const netParsed = parseVerifyNetworkOverride(data.network, req);
        if (!netParsed.ok) return;

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, attested: false, contentRootOk: false, schemaOk: false, attesterId: '' };

        // No live provider configured → clean negative, not a 5xx (criterion 5).
        if (!liveProviderConfigured(netParsed.network)) return NEGATIVE;

        return runSubmission(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const state = await attestationStateReader({
                contractAddress: data.contractAddress!,
                payloadHash: data.payloadHash!,
                contentRoot: data.contentRoot,
                schemaId: data.schemaId,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, netParsed.network)
            });

            // Unknown contract / no on-chain state → clean negative.
            if (!state) return NEGATIVE;

            const verified = state.attested
                && (data.contentRoot ? state.contentRootOk : true)
                && (data.schemaId ? state.schemaOk : true);
            return {
                verified,
                attested: state.attested,
                contentRootOk: state.contentRootOk,
                schemaOk: state.schemaOk,
                attesterId: state.attesterId
            };
        });
    });

    srv.on('verifyPredicateState', async (req: Request) => {
        const data = req.data as {
            contractAddress?: string;
            payloadHash?: string;
            fieldKey?: string;
            predicate?: string;
            threshold?: number | string;
            expectedDigest?: string;
            setRoot?: string;
            payloadHashB?: string;
            allowedMask?: number | string;
            k?: number;
            compiledArtifactRef?: string;
            network?: string;
        };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) {
            return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        }
        if (data.fieldKey && !SHA256_HEX_RE.test(data.fieldKey)) {
            return req.reject(400, 'fieldKey must be 64 hex chars (32 bytes)');
        }

        const parsed = parsePredicate(data.predicate);
        if (!parsed) return req.reject(400, "predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'");

        // Per-kind statement coordinates. The claim key is recomputed from
        // exactly what the circuit hashed, so the wrong coordinate silently
        // yields verified: false; validate shapes here.
        let thresholdBig: bigint | undefined;
        let op: number | undefined;
        let expectedDigest: string | undefined;
        let setRoot: string | undefined;
        let payloadHashB: string | undefined;
        let allowedMask: number | undefined;
        let k: number | undefined;
        if (parsed.kind === 'integrity' || parsed.kind === 'diff') {
            const { width: verifyWidth, maxMask: verifyMaxMask } = vaultDims(data.compiledArtifactRef);
            if (!data.payloadHashB || !SHA256_HEX_RE.test(data.payloadHashB)) {
                return req.reject(400, `payloadHashB (64 hex chars) is required for predicate '${data.predicate}'`);
            }
            payloadHashB = data.payloadHashB.toLowerCase();
            if (parsed.kind === 'integrity') {
                const coerced = data.allowedMask === undefined || data.allowedMask === null
                    ? null
                    : coerceMask(data.allowedMask);
                if (coerced === null || coerced < 0 || coerced > verifyMaxMask) {
                    return req.reject(400, `allowedMask (integer 0..${verifyMaxMask}) is required for predicate 'documentIntegrity'`);
                }
                allowedMask = coerced;
            } else {
                if (data.k === undefined || data.k === null || !Number.isInteger(data.k) || data.k < 1 || data.k > verifyWidth) {
                    return req.reject(400, `k (integer 1..${verifyWidth}) is required for predicate 'documentDiff'`);
                }
                k = data.k;
            }
        } else if (parsed.kind === 'numeric') {
            // Numeric claims are field-bound only (the commitment-only plain
            // kind was removed in 0.16.0 with commitValue/provePredicate).
            if (!data.fieldKey) return req.reject(400, `fieldKey is required for predicate '${data.predicate}'`);
            if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
            try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
            if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');
            if (thresholdBig > UINT64_MAX) return req.reject(400, 'threshold exceeds Uint<64>');
            op = parsed.opCode!;
        } else if (parsed.kind === 'equality') {
            if (!data.fieldKey) return req.reject(400, "fieldKey is required for predicate 'bytesEquality'");
            if (!data.expectedDigest || !SHA256_HEX_RE.test(data.expectedDigest)) {
                return req.reject(400, "expectedDigest (64 hex chars) is required for predicate 'bytesEquality'");
            }
            expectedDigest = data.expectedDigest.toLowerCase();
        } else {
            if (!data.fieldKey) return req.reject(400, "fieldKey is required for predicate 'setMembership'");
            if (!data.setRoot || !SHA256_HEX_RE.test(data.setRoot)) {
                return req.reject(400, "setRoot (64 hex chars) is required for predicate 'setMembership'");
            }
            setRoot = data.setRoot.toLowerCase();
        }

        const netParsed = parseVerifyNetworkOverride(data.network, req);
        if (!netParsed.ok) return;

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, proven: false };

        // No live provider configured → clean negative, not a 5xx (criterion 4).
        if (!liveProviderConfigured(netParsed.network)) return NEGATIVE;

        return runSubmission(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const proven = await predicateStateReader({
                contractAddress: data.contractAddress!,
                payloadHash: data.payloadHash!.toLowerCase(),
                fieldKey: data.fieldKey ? data.fieldKey.toLowerCase() : undefined,
                threshold: thresholdBig,
                op,
                expectedDigest,
                setRoot,
                payloadHashB,
                allowedMask,
                k,
                slotWidth: vaultDims(compiledRef).width,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, netParsed.network)
            });

            // `null` (unknown contract / no on-chain state) and `false` (no true
            // result for the recomputed claim key) both read as not proven.
            return { verified: proven === true, proven: proven === true };
        });
    });

    srv.on('reindexDisclosures', async (req: Request) => {
        const data = req.data as { contractAddress?: string; compiledArtifactRef?: string };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;
        const contractAddressLc = data.contractAddress.toLowerCase();

        if (!checkRate(reindexRateLimiter, contractAddressLc, req)) return;

        // No live provider configured → clean zero, not a 5xx (criterion 5).
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
            // `indexed` is the count of grants present on-chain after reconcile,
            // i.e. the active grants for this contract.
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

        // NIGHTGATE does not verify ownership of the binding input. Deployments
        // that gate reads on on-chain grants should disable self-service and
        // register identities via their own proofing flow.
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
     * Crawler-free evidence for verifyDocument: confirm the document's on-chain
     * payload_hash (== its sha256) is present in the AttestationVault attestation
     * map. Best-effort: any resolution/provider error yields `false` (a clean
     * negative), never a 5xx.
     */
    async function verifyDocumentViaState(
        contractAddress: string,
        payloadHash: string,
        compiledArtifactRef?: string,
        networkOverride?: NightgateNetwork,
        recordedArtifactDigest?: string | null
    ): Promise<boolean> {
        try {
            const compiledRef = compiledArtifactRef && compiledArtifactRef.length > 0
                ? compiledArtifactRef
                : DEFAULT_ATTESTATION_VAULT_REF;
            // Generation binding, ATOMIC: the resolver verifies the recorded
            // digest against the very snapshot it imports; a re-pointed alias
            // or an in-place asset overwrite throws and yields the clean
            // negative below, never a false "verified".
            const resolved = await contractResolver(compiledRef, recordedArtifactDigest ?? undefined);
            const state = await attestationStateReader({
                contractAddress,
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
     * Crawler-free evidence for verifyPredicateAttestation: recompute the claim
     * key from the row and confirm a (true) result is recorded on-chain.
     * Best-effort: any error yields `false`, never a 5xx. Defaults to the
     * canonical attestation-vault artifact (the row does not carry a ref).
     */
    async function verifyPredicateViaState(row: any): Promise<boolean> {
        try {
            // Evidence provenance (0.16.0): the state read runs against the
            // artifact and network RECORDED at proving time, not the current
            // defaults (a redeploy or network switch must not silently change
            // what a stored attestation verifies against). Pre-0.16.0 rows
            // carry nulls and keep the previous default behavior. The alias
            // is additionally pinned to its recorded GENERATION digest: a
            // re-pointed alias yields a clean negative.
            const rowRef = row.compiledArtifactRef || DEFAULT_ATTESTATION_VAULT_REF;
            // Atomic: the resolver checks the recorded digest against the very
            // snapshot it imports; a mismatch throws and lands in the clean
            // negative below.
            const resolved = await contractResolver(rowRef, row.artifactDigest ?? undefined);
            const recordedNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
                ? row.network as NightgateNetwork
                : undefined;
            // The row's `predicate` literal discriminates the claim kind: the
            // bytes kinds carry expectedDigest/setRoot (no threshold/op); the
            // numeric kinds carry threshold/op + fieldKey (field-bound only
            // since the commitment lane's removal in 0.16.0); the cross-root
            // kinds carry payloadHashB plus allowedMask (integrity) or
            // k-in-threshold (diff).
            const bytesKind = row.predicate === 'bytesEquality' || row.predicate === 'setMembership';
            const docKind = row.predicate === 'documentIntegrity' || row.predicate === 'documentDiff';
            const proven = await predicateStateReader({
                contractAddress: row.contractAddress,
                payloadHash: row.payloadHash,
                threshold: (bytesKind || docKind) ? undefined : BigInt(row.threshold),
                op: (bytesKind || docKind) ? undefined : Number(row.op),
                fieldKey: row.fieldKey || undefined,
                expectedDigest: row.predicate === 'bytesEquality' ? (row.expectedDigest || undefined) : undefined,
                setRoot: row.predicate === 'setMembership' ? (row.setRoot || undefined) : undefined,
                payloadHashB: docKind ? (row.payloadHashB || undefined) : undefined,
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
     * Best-effort chain reindex after a disclosure grant/revoke submit. Swallows
     * all errors: an indexing failure must never fail the submission (the row
     * already records intent; a later reindex reconciles).
     */
    async function reindexAfterSubmit(contractAddress: string, resolved: ResolvedContract): Promise<void> {
        try {
            await disclosureReindexer({
                db,
                contractAddress,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
            });
        } catch {
            /* best-effort; intentionally ignored */
        }
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

    /**
     * Resolves the optional per-tx fee sponsor of a submission action.
     * Returns null when the caller did not request sponsoring. Throws
     * FeeSponsorError (mapped by runSubmission) when the sponsor session is
     * unusable or not authorised for this caller.
     */
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
 * Resolves the WalletFacade build config from cds.requires.nightgate + env
 * vars. FAIL-CLOSED on an invalid configured network: initialize() already
 * refuses the boot, but the CAP host deliberately stays online after a
 * rejected init, so every submission/job/provider entry point that resolves
 * its config HERE must refuse the silent preprod fallback too (not rely on
 * the wallet worker never having started).
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

/**
 * Artifact-generation digest recorded on evidence rows; null when the alias
 * is not registered yet (the submission itself then fails later anyway).
 */
function artifactDigestOrNull(compiledRef: string): string | null {
    try { return getArtifactGenerationDigest(compiledRef); } catch { return null; }
}

/**
 * True when a live indexer provider is configured, i.e. crawler-free state
 * verification can attempt a `queryContractState` round-trip. When false, the
 * state-verification surfaces return a clean negative instead of a 5xx.
 *
 * With a `network` override to a DIFFERENT network than the configured one, the
 * override endpoints are what matter (they resolve from `config.networks` or
 * the built-in public defaults, so they always exist for a valid network).
 */
function liveProviderConfigured(networkOverride?: NightgateNetwork): boolean {
    const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    if (networkOverride && networkOverride !== network) {
        const eps = resolveOverrideIndexerEndpoints(networkOverride, getNightgatePluginConfig());
        return Boolean(eps.indexerHttpUrl && eps.indexerWsUrl);
    }
    return Boolean(submissionEndpoints.indexerHttpUrl && submissionEndpoints.indexerWsUrl);
}

/** Contract-only provider config (no wallet) for read-side reindexing. */
function contractProvidersConfigFromEnv(zkConfigPath: string): ContractProvidersConfig {
    const { submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    return {
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        zkConfigPath
    };
}

/**
 * Contract-only provider config honouring the optional per-call `network`
 * override on the crawler-free verify surface.
 * Omitted or equal to the configured network → EXACTLY
 * `contractProvidersConfigFromEnv` (env / top-level config keep winning). A
 * different valid network swaps only the indexer endpoints; proof server and
 * zkConfig stay as configured, since compiled artifacts are network-agnostic
 * and the read path never proves.
 */
function contractProvidersConfigForNetwork(
    zkConfigPath: string,
    networkOverride?: NightgateNetwork
): ContractProvidersConfig {
    const base = contractProvidersConfigFromEnv(zkConfigPath);
    if (!networkOverride) return base;
    const { network } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
    if (networkOverride === network) return base;
    const eps = resolveOverrideIndexerEndpoints(networkOverride, getNightgatePluginConfig());
    return { ...base, indexerHttpUrl: eps.indexerHttpUrl, indexerWsUrl: eps.indexerWsUrl };
}

/**
 * Validates the optional `network` param of the state-verify functions.
 * Returns `{ ok: false }` after rejecting with 400 for an unknown value
 * (criterion 3: explicit 400, never a silent fallback).
 */
function parseVerifyNetworkOverride(
    raw: string | undefined,
    req: Request
): { ok: boolean; network?: NightgateNetwork } {
    if (!raw) return { ok: true };
    if (!(VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(raw)) {
        req.reject(400, `network must be one of: ${VALID_NIGHTGATE_NETWORKS.join(', ')}`);
        return { ok: false };
    }
    return { ok: true, network: raw as NightgateNetwork };
}

/**
 * Mainnet submission gate. Returns true (and rejects with 403) when the resolved
 * network is mainnet and allowMainnetSubmission is not enabled. Call at the top
 * of every on-chain submission handler before doing any work.
 */
function rejectIfMainnetBlocked(req: Request): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

function checkRate(limiter: RateLimiter, sessionId: string, req: Request, count = 1): boolean {
    // checkMany is all-or-nothing: a rejected batch consumes NO budget.
    const r = limiter.checkMany(sessionId, count);
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
            // Bad arg encoding (invalid hex, wrong byte length, non-integer
            // Uint, …): a clean 400, not a deep circuit type error.
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
            // Grant ∩ platform floor is empty: 403 at admission, nothing written.
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message } as any);
        }
        if (err instanceof SponsorPolicyUnavailableError) {
            // Policy file configured but unusable, nothing good loaded yet: fail closed,
            // message kept readable in production.
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        if (err instanceof WalletMaterialUnavailable) {
            // 501 = the session lacks signing material (no seed). The caller must
            // run connectWalletForSigning before deploy/call/submit actions.
            return req.reject(501, err.message);
        }
        if (err instanceof JobAdmissionBusyError) {
            // Busy, not broken: nothing written, nothing submitted, the caller can resend.
            // Rejected as an object so code and `$sanitize: false` ride along; a bare
            // (status, message) pair is re-wrapped by CAP and sanitised in production.
            setRetryAfter(req, err.retryAfterSeconds);
            return req.reject({ status: err.httpStatus, code: err.code, message: err.message, $sanitize: false } as any);
        }
        if (err instanceof SubmissionError) {
            const c = err.classification;
            const body = JSON.stringify({
                code: c.code,
                retryable: c.retryable,
                knownIssueRef: c.knownIssueRef,
                message: c.message,
                submissionId: err.submissionId
            });
            // A retryable classification stays readable in production (same as above).
            if (c.retryable) return req.reject({ status: 503, code: c.code, message: body, $sanitize: false } as any);
            return req.reject(400, body);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return req.reject(500, msg);
    }
}
