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
import { randomBytes, bytesToHex } from '@noble/hashes/utils';
import {
    TransactionSubmitter,
    SubmissionError,
    type TransactionSubmitterDeps
} from './TransactionSubmitter';
import {
    resolveContract,
    ContractNotRegisteredError,
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
import { startJob, runChildCommand, registerBackgroundJobProcessor, registerBackgroundJobReconciliationFinalizer, type BackgroundJobRow, type ReconciliationEvidence } from './background-jobs';
import { reindexDisclosuresForContract } from './disclosure-indexer';
import { readAttestationStateForContract } from './attestation-state';
import { readPredicateStateForContract } from './predicate-state';
import { blake2b256Hex, loadPureCircuitsFromRegistry, PureCircuitsUnavailableError } from './document-proof';
import { membershipPathFor, SET_DEPTH } from './set-root';
import { deriveGranteeId } from './grantee-identity';
import { getConfiguredGranteeBinding, isSelfServiceGranteeRegistrationAllowed } from '../utils/nightgate-config';
import { Documents, Transactions, TransactionResults, PredicateAttestations, DisclosureGrants, GranteeIdentities } from '#cds-models/midnight';

const { INSERT, UPDATE, SELECT, DELETE } = cds.ql;

// 5 deploys / hour / session, deploys are heavyweight; tight bound.
const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
// 30 calls / minute / session.
const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
// 10 doc anchors / hour / session, contract-call heavyweight + extra DB writes.
const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
// 10 predicate proofs / hour / session; each is TWO heavyweight circuit calls
// (commitValue + provePredicate), so bound it like anchors.
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
 * Per-call proof witness bundle. `fieldValue` feeds `field_value()` (numeric
 * proveFieldPredicate), `fieldDigest` feeds `field_digest()` (bytes-valued
 * proveFieldMembership; proveFieldEquality needs neither, only the path),
 * `siblings`/`dirs` feed the DEPTH=4 content-root path, `setProof` feeds the
 * DEPTH=6 membership-set path.
 */
type MerkleProofBundle = {
    fieldValue?: string;
    fieldDigest?: string;
    siblings: string[];
    dirs: boolean[];
    setProof?: { siblings: string[]; dirs: boolean[] };
};

/** One batch claim; `predicate` discriminates the kind. */
type BatchClaimCommand = {
    predicateAttestationId: string; fieldKey: string; predicate: string; unit?: string;
    // numeric ('lessOrEqual' | 'greaterOrEqual')
    threshold?: string; opCode?: number; value?: string;
    // 'bytesEquality'
    expectedDigest?: string;
    // 'setMembership'
    setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
    siblings: string[]; dirs: boolean[];
};

type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; witnessValues?: { attestedValue: string; valueSalt: string }; merkleProof?: MerkleProofBundle }
    | { op: 'callBatch'; contractAddress: string; calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>; compiledArtifactRef: string; initialPrivateState?: unknown; sponsorSessionId?: string; witnessValues?: { attestedValue: string; valueSalt: string }; merkleProof?: MerkleProofBundle }
    | { op: 'predicateWorkflow'; predicateAttestationId: string; payloadHash: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; salt: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; sponsorSessionId?: string }
    | { op: 'fieldEqualityWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; expectedDigest: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; sponsorSessionId?: string }
    | { op: 'fieldMembershipWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; setRoot: string; valueDigest: string; siblings: string[]; dirs: boolean[]; setSiblings: string[]; setDirs: boolean[]; contentRoot?: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateBatchWorkflow'; payloadHash: string; contractAddress: string; compiledArtifactRef: string; contentRoot?: string; claims: BatchClaimCommand[]; sponsorSessionId?: string }
    | { op: 'anchorDocument'; documentId: string; payloadHash: string; metadataHash: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'grantDisclosure'; disclosureGrantId: string; payloadHash: string; grantee: string; level: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'revokeDisclosure'; payloadHash: string; grantee: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'registerPassport'; passportId: string; ownerId: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
}

type PredicateKind = 'numeric' | 'equality' | 'membership';

/**
 * The ONE predicate-literal parser (every call site validates through this,
 * so an unknown literal can never mint a wrong opCode / claim key).
 * `opCode` is the circuit's Uint<8> for the numeric predicates and null for
 * the bytes kinds, whose claim structs carry no op.
 */
function parsePredicate(literal: unknown): { kind: PredicateKind; opCode: number | null } | null {
    if (literal === 'lessOrEqual') return { kind: 'numeric', opCode: 0 };
    if (literal === 'greaterOrEqual') return { kind: 'numeric', opCode: 1 };
    if (literal === 'bytesEquality') return { kind: 'equality', opCode: null };
    if (literal === 'setMembership') return { kind: 'membership', opCode: null };
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
        const callKinds = new Set(['submitContractCall', 'predicateCommitValue', 'predicateProof', 'fieldAnchorRoot', 'fieldPredicateProof', 'fieldEqualityProof', 'fieldMembershipProof']);
        if ((job.kind === 'deployContract' && command.op !== 'deploy')
            || (callKinds.has(job.kind) && command.op !== 'call')
            || (job.kind === 'submitContractCallBatch' && command.op !== 'callBatch')
            || (job.kind === 'fieldPredicateBatchProof' && command.op !== 'callBatch')
            || (job.kind === 'issuePredicateAttestation' && command.op !== 'predicateWorkflow')
            || (job.kind === 'issueFieldPredicateAttestation' && command.op !== 'fieldPredicateWorkflow')
            || (job.kind === 'issueFieldEqualityAttestation' && command.op !== 'fieldEqualityWorkflow')
            || (job.kind === 'issueFieldMembershipAttestation' && command.op !== 'fieldMembershipWorkflow')
            || (job.kind === 'issueFieldPredicateAttestationBatch' && command.op !== 'fieldPredicateBatchWorkflow')
            || (job.kind === 'anchorDocument' && command.op !== 'anchorDocument')
            || (job.kind === 'grantDisclosure' && command.op !== 'grantDisclosure')
            || (job.kind === 'revokeDisclosure' && command.op !== 'revokeDisclosure')
            || (job.kind === 'registerPassport' && command.op !== 'registerPassport')) {
            throw new Error(`Persisted command operation '${command.op}' is incompatible with ${job.kind}`);
        }

        if (command.op === 'predicateWorkflow') {
            const witnessValues = { attestedValue: command.value, valueSalt: command.salt };
            await runChildCommand({
                parent: job, kind: 'predicateCommitValue', step: 'commitValue', commandVersion: 1,
                request: { circuit: 'commitValue', payloadHash: command.payloadHash },
                command: { op: 'call', contractAddress: command.contractAddress, circuit: 'commitValue', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash], witnessValues, sponsorSessionId: command.sponsorSessionId }
            });
            // Let it propagate: ambiguous child -> ChildReconciliationRequiredError (parent reconciles); definitive rejection -> plain error (parent fails cleanly).
            const proof: any = await runChildCommand<any>({
                parent: job, kind: 'predicateProof', step: 'provePredicate', commandVersion: 1,
                request: { circuit: 'provePredicate', payloadHash: command.payloadHash },
                command: { op: 'call', contractAddress: command.contractAddress, circuit: 'provePredicate', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.threshold, String(command.opCode)], witnessValues, sponsorSessionId: command.sponsorSessionId }
            });
            const provenAt = new Date().toISOString();
            await db.run(UPDATE.entity(PredicateAttestations).set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt }).where({ ID: command.predicateAttestationId }));
            return {
                predicateAttestationId: command.predicateAttestationId, payloadHash: command.payloadHash,
                claim: { predicate: command.predicate, threshold: command.threshold, unit: command.unit ?? null },
                proof: { system: 'midnight-compact', circuit: 'provePredicate', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }

        if (command.op === 'fieldPredicateWorkflow') {
            if (command.contentRoot) {
                await runChildCommand({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot], sponsorSessionId: command.sponsorSessionId }
                });
            }
            const proof: any = await runChildCommand<any>({
                parent: job, kind: 'fieldPredicateProof', step: 'proveFieldPredicate', commandVersion: 1,
                request: { circuit: 'proveFieldPredicate', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldPredicate', compiledArtifactRef: command.compiledArtifactRef,
                    args: [command.payloadHash, command.fieldKey, command.threshold, String(command.opCode)],
                    merkleProof: { fieldValue: command.value, siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
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
                await runChildCommand({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot], sponsorSessionId: command.sponsorSessionId }
                });
            }
            // The expected digest is the PUBLIC statement (also a circuit arg);
            // only the inclusion path travels as witness material.
            const proof: any = await runChildCommand<any>({
                parent: job, kind: 'fieldEqualityProof', step: 'proveFieldEquality', commandVersion: 1,
                request: { circuit: 'proveFieldEquality', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldEquality', compiledArtifactRef: command.compiledArtifactRef,
                    args: [command.payloadHash, command.fieldKey, command.expectedDigest],
                    merkleProof: { siblings: command.siblings, dirs: command.dirs }, sponsorSessionId: command.sponsorSessionId
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
                await runChildCommand({
                    parent: job, kind: 'fieldAnchorRoot', step: 'anchorContentRoot', commandVersion: 1,
                    request: { circuit: 'anchorContentRoot', payloadHash: command.payloadHash },
                    command: { op: 'call', contractAddress: command.contractAddress, circuit: 'anchorContentRoot', compiledArtifactRef: command.compiledArtifactRef, args: [command.payloadHash, command.contentRoot], sponsorSessionId: command.sponsorSessionId }
                });
            }
            const proof: any = await runChildCommand<any>({
                parent: job, kind: 'fieldMembershipProof', step: 'proveFieldMembership', commandVersion: 1,
                request: { circuit: 'proveFieldMembership', payloadHash: command.payloadHash, fieldKey: command.fieldKey },
                command: {
                    op: 'call', contractAddress: command.contractAddress, circuit: 'proveFieldMembership', compiledArtifactRef: command.compiledArtifactRef,
                    args: [command.payloadHash, command.fieldKey, command.setRoot],
                    merkleProof: {
                        fieldDigest: command.valueDigest, siblings: command.siblings, dirs: command.dirs,
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

        if (command.op === 'fieldPredicateBatchWorkflow') {
            // ONE transaction for the whole cart: optional anchorContentRoot
            // first (distinct entryPoint, so segment ordering pins it ahead of
            // the proofs), then N proof calls (any mix of proveFieldPredicate /
            // proveFieldEquality / proveFieldMembership), each carrying its
            // OWN proof bundle (per-call witness binding via the batch holder).
            // A false claim fails at local proving, before submission.
            const calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }> = [];
            if (command.contentRoot) {
                calls.push({ circuit: 'anchorContentRoot', args: [command.payloadHash, command.contentRoot] });
            }
            for (const claim of command.claims) {
                if (claim.predicate === 'bytesEquality') {
                    calls.push({
                        circuit: 'proveFieldEquality',
                        args: [command.payloadHash, claim.fieldKey, claim.expectedDigest],
                        merkleProof: { siblings: claim.siblings, dirs: claim.dirs }
                    });
                } else if (claim.predicate === 'setMembership') {
                    calls.push({
                        circuit: 'proveFieldMembership',
                        args: [command.payloadHash, claim.fieldKey, claim.setRoot],
                        merkleProof: {
                            fieldDigest: claim.valueDigest, siblings: claim.siblings, dirs: claim.dirs,
                            setProof: { siblings: claim.setSiblings!, dirs: claim.setDirs! }
                        }
                    });
                } else {
                    calls.push({
                        circuit: 'proveFieldPredicate',
                        args: [command.payloadHash, claim.fieldKey, claim.threshold, String(claim.opCode)],
                        merkleProof: { fieldValue: claim.value, siblings: claim.siblings, dirs: claim.dirs }
                    });
                }
            }
            // Let it propagate: ambiguous child -> ChildReconciliationRequiredError (parent reconciles); definitive rejection -> plain error (parent fails cleanly).
            const proof: any = await runChildCommand<any>({
                parent: job, kind: 'fieldPredicateBatchProof', step: 'proveFieldPredicateBatch', commandVersion: 1,
                request: { circuits: calls.map(c => c.circuit), payloadHash: command.payloadHash, claimCount: command.claims.length },
                command: { op: 'callBatch', contractAddress: command.contractAddress, calls, compiledArtifactRef: command.compiledArtifactRef, sponsorSessionId: command.sponsorSessionId }
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
                            : { threshold: c.threshold, unit: c.unit ?? null })
                    }
                })),
                proof: { system: 'midnight-compact', circuit: 'proveFieldPredicate', verificationMethod: command.contractAddress, proofValue: proof.txHash },
                ...(command.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
            };
        }
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);
        const resolved = await contractResolver(command.compiledArtifactRef);
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
                registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
                initialPrivateState: command.initialPrivateState,
                sessionId: job.sessionId
            });
            return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'anchorDocument') {
            const result = await submitter.call({
                contractAddress: command.contractAddress, circuit: 'attest',
                args: [hexToBytes(command.payloadHash), hexToBytes(command.metadataHash)],
                contractName: command.compiledArtifactRef,
                registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
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
                registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
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
                registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
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
                        ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1]))]
                        : (c.circuit === 'proveFieldEquality' || c.circuit === 'proveFieldMembership')
                            ? [hexToBytes(String(c.args[0])), hexToBytes(String(c.args[1])), hexToBytes(String(c.args[2]))]
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
                witnessValues: command.witnessValues,
                merkleProof: command.merkleProof,
                registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
                sessionId: job.sessionId
            });
            return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, circuits: result.circuits, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        let coercedArgs: unknown[];
        if (job.kind === 'predicateCommitValue') {
            coercedArgs = [hexToBytes(String(command.args[0]))];
        } else if (job.kind === 'predicateProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), BigInt(String(command.args[1])), BigInt(String(command.args[2]))];
        } else if (job.kind === 'fieldAnchorRoot') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1]))];
        } else if (job.kind === 'fieldPredicateProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), BigInt(String(command.args[2])), BigInt(String(command.args[3]))];
        } else if (job.kind === 'fieldEqualityProof' || job.kind === 'fieldMembershipProof') {
            coercedArgs = [hexToBytes(String(command.args[0])), hexToBytes(String(command.args[1])), hexToBytes(String(command.args[2]))];
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
            witnessValues: command.witnessValues,
            merkleProof: command.merkleProof,
            registration: { artifactPath: resolved.artifactPath, privateStateId: resolved.privateStateId, zkConfigPath: resolved.zkConfigPath },
            sessionId: job.sessionId
        });
        return { submissionId: result.submissionId, txHash: result.txHash, contractAddress: result.contractAddress, status: result.status, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
    };
    registerBackgroundJobProcessor('deployContract', 1, executeContractCommand);
    registerBackgroundJobProcessor('submitContractCall', 1, executeContractCommand);
    registerBackgroundJobProcessor('submitContractCallBatch', 1, executeContractCommand);
    registerBackgroundJobProcessor('issuePredicateAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldPredicateAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldEqualityAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldMembershipAttestation', 1, executeContractCommand);
    registerBackgroundJobProcessor('issueFieldPredicateAttestationBatch', 1, executeContractCommand);
    registerBackgroundJobProcessor('anchorDocument', 1, executeContractCommand);
    registerBackgroundJobProcessor('grantDisclosure', 1, executeContractCommand);
    registerBackgroundJobProcessor('revokeDisclosure', 1, executeContractCommand);
    registerBackgroundJobProcessor('registerPassport', 1, executeContractCommand);
    for (const childKind of ['predicateCommitValue', 'predicateProof', 'fieldAnchorRoot', 'fieldPredicateProof', 'fieldEqualityProof', 'fieldMembershipProof', 'fieldPredicateBatchProof']) {
        registerBackgroundJobProcessor(childKind, 1, executeContractCommand);
    }

    const finalizeContractProjection = async (
        raw: unknown,
        _job: BackgroundJobRow,
        evidence: ReconciliationEvidence
    ): Promise<unknown> => {
        const command = raw as ContractCommandV1;
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
            const resolved = await contractResolver(command.compiledArtifactRef);
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

    srv.on('submitContractCallBatch', async (req: Request) => {
        const { contractAddress, calls, compiledArtifactRef, sessionId, idempotencyKey, initialPrivateState, sponsorSessionId } = req.data as {
            contractAddress?: string;
            calls?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
            sponsorSessionId?: string;
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
                    if (!Array.isArray(mp.siblings) || mp.siblings.length !== 4) {
                        throw new Error(`calls[${i}].merkleProof.siblings must be a JSON array of 4 hashes`);
                    }
                    for (const s of mp.siblings) {
                        if (typeof s !== 'string' || !SHA256_HEX_RE.test(s)) throw new Error(`calls[${i}].merkleProof.siblings entries must be 64 hex chars (32 bytes)`);
                    }
                    if (!Array.isArray(mp.dirs) || mp.dirs.length !== 4) {
                        throw new Error(`calls[${i}].merkleProof.dirs must be a JSON array of 4 booleans`);
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
                command: { op: 'callBatch', contractAddress, calls: parsedCalls, compiledArtifactRef, initialPrivateState: parsedInitialPrivateState, sponsorSessionId: sponsor?.sponsorSessionId }
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

        // On-chain inputs: payload_hash (caller's sha256) + metadata_hash (of the
        // public metadata blob). Both 32-byte commitments; bytes live off-chain
        // at `storageRef`.
        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));

        // Insert the Documents row up-front so its ID is stable and queryable
        // while the on-chain anchoring is deferred to the background job. Gives
        // clients a stable handle without polling.
        const documentId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(Documents).entries({
            ID: documentId,
            sha256: data.sha256.toLowerCase(),
            contentType: data.contentType ?? null,
            size: data.size ?? null,
            storageRef: data.storageRef,
            anchoredTxHash: null,
            anchoredAt: null,
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
                    compiledRef, metadata: metadataStr, feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'anchorDocument', documentId, payloadHash: data.sha256!.toLowerCase(),
                    metadataHash: bytesToHex(metadataHashBytes), contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(Documents).where({ ID: documentId }));
            const stableDocumentId = (job.originalRequest as any)?.documentId ?? documentId;
            return { jobId: job.jobId, status: job.status, documentId: stableDocumentId };
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
            } else if (contractAddress && liveProviderConfigured()) {
                // Crawler-free fallback (anchoring tx not indexed locally): confirm
                // the effect against live state. The document's sha256 is its
                // on-chain payload_hash, so a present attestation IS the proof.
                chainSuccess = await verifyDocumentViaState(
                    contractAddress, doc.sha256, compiledArtifactRef);
            }
        }

        return {
            verified: hashMatches && anchoredOk && chainSuccess,
            anchoredTxHash: doc.anchoredTxHash ?? '',
            anchoredAt: doc.anchoredAt ?? null,
            originalSha256: doc.sha256 ?? ''
        };
    });

    srv.on('issuePredicateAttestation', async (req: Request) => {
        const data = req.data as {
            payloadHash?: string;
            value?: string;
            salt?: string;
            predicate?: string;
            threshold?: number | string;
            unit?: string;
            valueCommitment?: string;
            sessionId?: string;
            contractAddress?: string;
            compiledArtifactRef?: string;
            idempotencyKey?: string;
            sponsorSessionId?: string;
        };

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        if (data.value === undefined || data.value === null || data.value === '') {
            return req.reject(400, 'value is required');
        }
        let valueBig: bigint;
        try { valueBig = BigInt(data.value); } catch { return req.reject(400, 'value must be an integer (decimal string)'); }
        if (valueBig < 0n) return req.reject(400, 'value must be a non-negative integer');

        if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
        let thresholdBig: bigint;
        try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
        if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual'");
        }
        const op = parsedPredicate.opCode!;

        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        let saltHex: string;
        if (data.salt) {
            if (!SHA256_HEX_RE.test(data.salt)) return req.reject(400, 'salt must be 64 hex chars (32 bytes)');
            saltHex = data.salt.toLowerCase();
        } else {
            saltHex = bytesToHex(randomBytes(32));
        }
        if (data.valueCommitment && !SHA256_HEX_RE.test(data.valueCommitment)) {
            return req.reject(400, 'valueCommitment must be 64 hex chars (32 bytes)');
        }

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // Row up-front (mirrors anchorDocument): a stable pollable handle.
        // `value`/`salt` are intentionally NOT stored.
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate: data.predicate,
            op,
            // Integer64 column; caller may pass the scaled integer as a string to
            // preserve precision past Number.MAX_SAFE_INTEGER. cds-models types it
            // as `number`, but the DB layer accepts the string at runtime.
            threshold: data.threshold as any,
            unit: data.unit ?? null,
            valueCommitment: data.valueCommitment ? data.valueCommitment.toLowerCase() : null,
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
                kind: 'issuePredicateAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: data.predicate,
                    threshold: String(data.threshold),
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), contractAddress: data.contractAddress,
                    predicate: data.predicate, threshold: String(data.threshold),
                    value: data.value, salt: data.salt, valueCommitment: data.valueCommitment,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: (req as any).user?.id,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'predicateWorkflow', predicateAttestationId,
                    payloadHash: data.payloadHash!.toLowerCase(), contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef, predicate: data.predicate!, threshold: thresholdBig.toString(),
                    opCode: op, unit: data.unit, value: valueBig.toString(), salt: saltHex,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on('issueFieldPredicateAttestation', async (req: Request) => {
        const data = req.data as {
            payloadHash?: string;
            fieldKey?: string;
            value?: string;
            contentRoot?: string;
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

        if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
        let thresholdBig: bigint;
        try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
        if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual' (use issueFieldEqualityAttestation / issueFieldMembershipAttestation for the bytes kinds)");
        }
        const op = parsedPredicate.opCode!;

        // Parse + validate the inclusion path (DEPTH=4).
        let siblings: string[];
        let dirs: boolean[];
        try { siblings = JSON.parse(data.siblingsJson ?? '[]'); } catch { return req.reject(400, 'siblingsJson must be a JSON array'); }
        try { dirs = JSON.parse(data.dirsJson ?? '[]'); } catch { return req.reject(400, 'dirsJson must be a JSON array'); }
        if (!Array.isArray(siblings) || siblings.length !== 4) return req.reject(400, 'siblingsJson must be a JSON array of 4 hashes');
        if (!Array.isArray(dirs) || dirs.length !== 4) return req.reject(400, 'dirsJson must be a JSON array of 4 booleans');
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
            valueCommitment: null,
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
                    threshold: String(data.threshold), value: data.value,
                    contentRoot: data.contentRoot, siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
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
                    unit: data.unit, value: valueBig.toString(), siblings: siblings.map(s => s.toLowerCase()),
                    dirs: dirsBool, contentRoot: data.contentRoot?.toLowerCase(),
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
            expectedValue?: string; expectedDigest?: string;
            contentRoot?: string; siblingsJson?: string; dirsJson?: string;
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

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, 4, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
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
            valueCommitment: null,
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
                    expectedDigest, contentRoot: data.contentRoot,
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
                    expectedDigest, siblings: path.siblings, dirs: path.dirs,
                    contentRoot: data.contentRoot?.toLowerCase(),
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
            contentRoot?: string; siblingsJson?: string; dirsJson?: string;
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

        const hasList = typeof data.allowedValuesJson === 'string' && data.allowedValuesJson.length > 0;
        const hasSetPath = !!(data.setRoot || data.setSiblingsJson || data.setDirsJson);
        if (hasList && hasSetPath) {
            return req.reject(400, 'pass either allowedValuesJson or setRoot + setSiblingsJson + setDirsJson, not both');
        }
        if (!hasList && !(data.setRoot && data.setSiblingsJson && data.setDirsJson)) {
            return req.reject(400, 'allowedValuesJson or setRoot + setSiblingsJson + setDirsJson is required');
        }

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, 4, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
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
            valueCommitment: null,
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
                    setRoot, valueDigest, contentRoot: data.contentRoot,
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
                    setRoot, valueDigest, siblings: path.siblings, dirs: path.dirs,
                    setSiblings, setDirs,
                    contentRoot: data.contentRoot?.toLowerCase(),
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
            contentRoot?: string;
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
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.claimsJson) return req.reject(400, 'claimsJson is required');

        // 8 calls per transaction is the batch cap; an in-batch anchor
        // occupies one slot.
        const maxClaims = data.contentRoot ? 7 : 8;
        // Mixed-kind batch claim; `predicate` discriminates (numeric /
        // bytesEquality / setMembership). `allowedValues` is the raw list of a
        // membership claim before set resolution.
        interface BatchClaim {
            fieldKey: string; siblings: string[]; dirs: boolean[];
            predicate: string; unit?: string;
            value?: string; threshold?: string; opCode?: number;
            expectedDigest?: string;
            setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
            allowedValues?: string[];
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
        let claims: BatchClaim[];
        try {
            const v = JSON.parse(data.claimsJson);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'claimsJson must be a non-empty JSON array');
            if (v.length > maxClaims) {
                return req.reject(400, `claimsJson supports at most ${maxClaims} entries per batch` + (data.contentRoot ? ' (the contentRoot anchor occupies one of the 8 call slots)' : ''));
            }
            claims = v.map((entry: any, i: number): BatchClaim => {
                if (!entry || typeof entry !== 'object') throw new Error(`claims[${i}] must be an object`);
                if (typeof entry.fieldKey !== 'string' || !SHA256_HEX_RE.test(entry.fieldKey)) {
                    throw new Error(`claims[${i}].fieldKey must be 64 hex chars (32 bytes)`);
                }
                const parsed = parsePredicate(entry.predicate);
                if (!parsed) throw new Error(`claims[${i}].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality' or 'setMembership'`);
                const contentPath = parsePath(entry, i, 4, 'siblings', 'dirs');
                const base = {
                    fieldKey: entry.fieldKey.toLowerCase(),
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
                if (entry.threshold === undefined || entry.threshold === null) throw new Error(`claims[${i}].threshold is required`);
                let thresholdBig: bigint;
                try { thresholdBig = BigInt(entry.threshold); } catch { throw new Error(`claims[${i}].threshold must be an integer`); }
                if (thresholdBig < 0n) throw new Error(`claims[${i}].threshold must be a non-negative integer`);
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
            threshold: (c.threshold ?? null) as any,
            unit: c.unit ?? null,
            fieldKey: c.fieldKey,
            expectedDigest: c.expectedDigest ?? null,
            setRoot: c.setRoot ?? null,
            valueCommitment: null,
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
                        siblings: c.siblings, dirs: c.dirs
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
                    contentRoot: data.contentRoot?.toLowerCase(),
                    claims: rowedClaims.map(c => ({
                        predicateAttestationId: c.predicateAttestationId,
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        opCode: c.opCode, unit: c.unit, value: c.value,
                        expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        setSiblings: c.setSiblings, setDirs: c.setDirs,
                        siblings: c.siblings, dirs: c.dirs
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
        // claim key from the row and look it up in predicate_results against live
        // state. Verifies the effect, not the tx, so no crawler/txHash needed.
        if (!chainSuccess && liveProviderConfigured() && row.contractAddress && row.payloadHash) {
            chainSuccess = await verifyPredicateViaState(row);
        }

        return {
            verified: chainSuccess,
            predicate: row.predicate ?? '',
            threshold: row.threshold ?? 0,
            unit: row.unit ?? '',
            expectedDigest: row.expectedDigest ?? '',
            setRoot: row.setRoot ?? '',
            valueCommitment: row.valueCommitment ?? '',
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
        const netParsed = parseVerifyNetworkOverride(data.network, req);
        if (!netParsed.ok) return;

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, attested: false, contentRootOk: false, attesterId: '' };

        // No live provider configured → clean negative, not a 5xx (criterion 5).
        if (!liveProviderConfigured(netParsed.network)) return NEGATIVE;

        return runSubmission(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const state = await attestationStateReader({
                contractAddress: data.contractAddress!,
                payloadHash: data.payloadHash!,
                contentRoot: data.contentRoot,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigForNetwork(resolved.zkConfigPath, netParsed.network)
            });

            // Unknown contract / no on-chain state → clean negative.
            if (!state) return NEGATIVE;

            const verified = state.attested && (data.contentRoot ? state.contentRootOk : true);
            return {
                verified,
                attested: state.attested,
                contentRootOk: state.contentRootOk,
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
        if (!parsed) return req.reject(400, "predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality' or 'setMembership'");

        // Per-kind statement coordinates. The claim key is recomputed from
        // exactly what the circuit hashed, so the wrong coordinate silently
        // yields verified: false; validate shapes here.
        let thresholdBig: bigint | undefined;
        let op: number | undefined;
        let expectedDigest: string | undefined;
        let setRoot: string | undefined;
        if (parsed.kind === 'numeric') {
            if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
            try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
            if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');
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
                // Field-bound iff fieldKey supplied; '' means plain.
                fieldKey: data.fieldKey ? data.fieldKey.toLowerCase() : undefined,
                threshold: thresholdBig,
                op,
                expectedDigest,
                setRoot,
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
        compiledArtifactRef?: string
    ): Promise<boolean> {
        try {
            const compiledRef = compiledArtifactRef && compiledArtifactRef.length > 0
                ? compiledArtifactRef
                : DEFAULT_ATTESTATION_VAULT_REF;
            const resolved = await contractResolver(compiledRef);
            const state = await attestationStateReader({
                contractAddress,
                payloadHash,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
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
            const resolved = await contractResolver(DEFAULT_ATTESTATION_VAULT_REF);
            // The row's `predicate` literal discriminates the claim kind: the
            // bytes kinds carry expectedDigest/setRoot (no threshold/op); the
            // numeric kinds carry threshold/op. Field-bound rows carry a
            // fieldKey; plain rows check predicate_results.
            const bytesKind = row.predicate === 'bytesEquality' || row.predicate === 'setMembership';
            const proven = await predicateStateReader({
                contractAddress: row.contractAddress,
                payloadHash: row.payloadHash,
                threshold: bytesKind ? undefined : BigInt(row.threshold),
                op: bytesKind ? undefined : Number(row.op),
                fieldKey: row.fieldKey || undefined,
                expectedDigest: row.predicate === 'bytesEquality' ? (row.expectedDigest || undefined) : undefined,
                setRoot: row.predicate === 'setMembership' ? (row.setRoot || undefined) : undefined,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
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

/** Resolves the WalletFacade build config from cds.requires.nightgate + env vars. */
function facadeConfigFromEnv() {
    const nightgateConfig = getNightgatePluginConfig();
    const { network, nodeUrl, submissionEndpoints } = resolveNightgateRuntimeConfig(nightgateConfig);
    return {
        networkId: network as 'preprod' | 'testnet' | 'mainnet' | 'undeployed',
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        relayUrl: nodeUrl
    };
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
        if (err instanceof WalletMaterialUnavailable) {
            // 501 = the session lacks signing material (no seed). The caller must
            // run connectWalletForSigning before deploy/call/submit actions.
            return req.reject(501, err.message);
        }
        if (err instanceof SubmissionError) {
            const c = err.classification;
            return req.reject(c.retryable ? 503 : 400, JSON.stringify({
                code: c.code,
                retryable: c.retryable,
                knownIssueRef: c.knownIssueRef,
                message: c.message,
                submissionId: err.submissionId
            }));
        }
        const msg = err instanceof Error ? err.message : String(err);
        return req.reject(500, msg);
    }
}
