/**
 * OData handlers for NightgateService submission actions.
 *
 * - `deployContract`        → TransactionSubmitter.deploy()
 * - `submitContractCall`    → TransactionSubmitter.call()
 *
 * Responsibilities here (the submitter itself does NOT do any of these):
 *   1. Parse the JSON-encoded `args` / `initialPrivateState` payloads.
 *   2. Rate-limit per sessionId (deploys are stricter than calls).
 *   3. Resolve `compiledArtifactRef` → compiled contract + zkConfigPath +
 *      privateStateId via the contract registry.
 *   4. Look up the wallet session and build WalletMaterial (real signing-capable
 *      material when the session has a seed; `WalletMaterialUnavailable` otherwise).
 *   5. Catch SubmissionError / SessionNotFoundError / ContractNotRegisteredError /
 *      WalletMaterialUnavailable and translate to OData status codes.
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
// 60 on-demand reindexes / hour / contract; an indexer round-trip + DB writes,
// keyed by contractAddress (no session). Loose enough for a wallet-flow poll,
// tight enough not to hammer the indexer.
const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; witnessValues?: { attestedValue: string; valueSalt: string }; merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] } }
    | { op: 'callBatch'; contractAddress: string; calls: Array<{ circuit: string; args: unknown[] }>; compiledArtifactRef: string; initialPrivateState?: unknown; sponsorSessionId?: string; witnessValues?: { attestedValue: string; valueSalt: string }; merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] } }
    | { op: 'predicateWorkflow'; predicateAttestationId: string; payloadHash: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; salt: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateWorkflow'; predicateAttestationId: string; payloadHash: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; sponsorSessionId?: string }
    | { op: 'anchorDocument'; documentId: string; payloadHash: string; metadataHash: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'grantDisclosure'; disclosureGrantId: string; payloadHash: string; grantee: string; level: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'revokeDisclosure'; payloadHash: string; grantee: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
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

    const executeContractCommand = async (raw: unknown, job: BackgroundJobRow): Promise<unknown> => {
        const command = raw as ContractCommandV1;
        if (!command || job.commandVersion !== 1 || !job.sessionId || !job.requestedBy) {
            throw new Error(`Invalid persisted contract command for job ${job.ID}`);
        }
        const callKinds = new Set(['submitContractCall', 'predicateCommitValue', 'predicateProof', 'fieldAnchorRoot', 'fieldPredicateProof']);
        if ((job.kind === 'deployContract' && command.op !== 'deploy')
            || (callKinds.has(job.kind) && command.op !== 'call')
            || (job.kind === 'submitContractCallBatch' && command.op !== 'callBatch')
            || (job.kind === 'issuePredicateAttestation' && command.op !== 'predicateWorkflow')
            || (job.kind === 'issueFieldPredicateAttestation' && command.op !== 'fieldPredicateWorkflow')
            || (job.kind === 'anchorDocument' && command.op !== 'anchorDocument')
            || (job.kind === 'grantDisclosure' && command.op !== 'grantDisclosure')
            || (job.kind === 'revokeDisclosure' && command.op !== 'revokeDisclosure')) {
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

        if (command.op === 'callBatch') {
            // Same per-circuit coercion as the single-call tail below, applied
            // to each entry of the batch (raw JSON args were persisted).
            const coercedCalls = command.calls.map(c => {
                const argTypes = argTypesLoader(resolved.zkConfigPath, c.circuit);
                return { circuit: c.circuit, args: coerceCircuitArgs(c.args, argTypes) };
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
    registerBackgroundJobProcessor('anchorDocument', 1, executeContractCommand);
    registerBackgroundJobProcessor('grantDisclosure', 1, executeContractCommand);
    registerBackgroundJobProcessor('revokeDisclosure', 1, executeContractCommand);
    for (const childKind of ['predicateCommitValue', 'predicateProof', 'fieldAnchorRoot', 'fieldPredicateProof']) {
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
    registerBackgroundJobReconciliationFinalizer('submitContractCallBatch', 1, finalizeContractProjection);

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
        let parsedCalls: Array<{ circuit: string; args: unknown[] }>;
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
                return { circuit: entry.circuit, args: entry.args ?? [] };
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

        let op: number;
        if (data.predicate === 'lessOrEqual') op = 0;
        else if (data.predicate === 'greaterOrEqual') op = 1;
        else return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual'");

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

        let op: number;
        if (data.predicate === 'lessOrEqual') op = 0;
        else if (data.predicate === 'greaterOrEqual') op = 1;
        else return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual'");

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
        const dirsBool = dirs.map(Boolean);

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

        let op: number;
        if (data.predicate === 'lessOrEqual') op = 0;
        else if (data.predicate === 'greaterOrEqual') op = 1;
        else return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual'");

        if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
        let thresholdBig: bigint;
        try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
        if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');

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
            const proven = await predicateStateReader({
                contractAddress: row.contractAddress,
                payloadHash: row.payloadHash,
                threshold: BigInt(row.threshold),
                op: Number(row.op),
                // Field-bound rows carry a fieldKey → verify against
                // field_predicate_results; plain rows check predicate_results.
                fieldKey: row.fieldKey || undefined,
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

function checkRate(limiter: RateLimiter, sessionId: string, req: Request): boolean {
    const r = limiter.check(sessionId);
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
