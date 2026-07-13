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
    coerceCircuitArgs,
    loadCircuitArgTypes,
    CoercionError
} from './arg-coercion';
import { resolveNightgateRuntimeConfig, type NightgateNetwork, getConfiguredPrivateStateBackend, getNightgatePluginConfig, mainnetSubmissionBlockReason } from '../utils/nightgate-config';
import { RateLimiter } from '../utils/rate-limiter';
import { ensureNetworkId, type ContractProvidersConfig } from '../midnight/providers';
import { startJob } from './background-jobs';
import { reindexDisclosuresForContract } from './disclosure-indexer';
import { readAttestationStateForContract } from './attestation-state';
import { readPredicateStateForContract } from './predicate-state';
import { deriveGranteeId } from './grantee-identity';
import { getConfiguredGranteeBinding, isSelfServiceGranteeRegistrationAllowed } from '../utils/nightgate-config';
import { Documents, Transactions, TransactionResults, PredicateAttestations, DisclosureGrants, GranteeIdentities } from '#cds-models/midnight';

const { INSERT, UPDATE, SELECT } = cds.ql;

// 5 deploys / hour / session, deploys are heavyweight; tight bound.
const deployRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 5 });
// 30 calls / minute / session.
const callRateLimiter = new RateLimiter({ windowMs: 60 * 1000, maxRequests: 30 });
// 10 doc anchors / hour / session, contract-call heavyweight + extra DB writes.
const anchorRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
// 10 predicate proofs / hour / session — each is TWO heavyweight circuit calls
// (commitValue + provePredicate), so bound it like anchors.
const predicateRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 10 });
// 30 disclosure grant/revoke ops / hour / session — single heavyweight circuit
// call each, attester-gated; looser than predicate but tighter than plain calls.
const disclosureRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 30 });
// 60 on-demand reindexes / hour / contract — an indexer round-trip + DB writes,
// keyed by contractAddress (no session). Loose enough for a wallet-flow poll,
// tight enough not to hammer the indexer.
const reindexRateLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, maxRequests: 60 });

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_ATTESTATION_VAULT_REF = 'attestation-vault';

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

    srv.on('deployContract', async (req: Request) => {
        const { compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey } = req.data as {
            compiledArtifactRef?: string;
            sessionId?: string;
            initialPrivateState?: string;
            idempotencyKey?: string;
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

        // Sync setup phase (on req.tx, translates the well-known setup errors
        // 404/401/501 into status codes via runSubmission). The actual SDK
        // round-trip is deferred to startJob's `work` and surfaces failures
        // via BackgroundJobs.errorCode/errorMessage instead of OData status.
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);
            const wallet = await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            return startJob({
                kind: 'deployContract',
                sessionId,
                idempotencyKey,
                request: { compiledArtifactRef, sessionId, hasInitialState: !!initialPrivateState },
                work: async () => {
                    const result = await submitter.deploy({
                        contractName: compiledArtifactRef,
                        registration: {
                            artifactPath: resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath: resolved.zkConfigPath
                        },
                        initialPrivateState: parsedInitialState,
                        sessionId
                    });
                    return {
                        submissionId: result.submissionId,
                        txHash: result.txHash,
                        contractAddress: result.contractAddress,
                        status: result.status
                    };
                }
            });
        });
    });

    srv.on('submitContractCall', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey, initialPrivateState } = req.data as {
            contractAddress?: string;
            circuit?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            args?: string;
            idempotencyKey?: string;
            initialPrivateState?: string;
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

            // Coerce JSON-parsed args into the value shapes the compiled circuit
            // requires (Bytes<N> → Uint8Array, Uint<N> → BigInt) before the
            // worker spreads them into fn(...callArgs). CoercionError → 400 via
            // runSubmission. See srv/submission/arg-coercion.ts.
            const argTypes = argTypesLoader(resolved.zkConfigPath, circuit);
            const coercedArgs = coerceCircuitArgs(parsedArgs, argTypes);

            const wallet = await walletFactory({ sessionId, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            return startJob({
                kind: 'submitContractCall',
                sessionId,
                idempotencyKey,
                request: { contractAddress, circuit, compiledArtifactRef, sessionId, argCount: coercedArgs.length },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress,
                        circuit,
                        args: coercedArgs,
                        contractName: compiledArtifactRef,
                        registration: {
                            artifactPath: resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath: resolved.zkConfigPath
                        },
                        sessionId,
                        initialPrivateState: parsedInitialPrivateState
                    });
                    return {
                        submissionId: result.submissionId,
                        txHash: result.txHash,
                        contractAddress: result.contractAddress,
                        status: result.status
                    };
                }
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

        // Compute the on-chain inputs: payload_hash from the caller's sha256
        // and metadata_hash from the public metadata blob. Both are 32-byte
        // commitments — the actual bytes live off-chain at `storageRef`.
        const payloadHashBytes = hexToBytes(data.sha256);
        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));

        // Insert the Documents row up-front on req.tx so the row ID is stable
        // and immediately queryable, even though the on-chain anchoring is
        // deferred to the background job. Mirrors the PendingSubmissions
        // pattern: clients have a handle to retry against without polling.
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

        // Sync setup (errors here become 404/401/501 via runSubmission); the
        // SDK round-trip + Documents UPDATE move into the background job.
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            const job = await startJob({
                kind: 'anchorDocument',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    sha256: data.sha256!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    compiledRef,
                    documentId
                },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit: 'attest',
                        args: [payloadHashBytes, metadataHashBytes],
                        contractName: compiledRef,
                        registration: {
                            artifactPath: resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath: resolved.zkConfigPath
                        },
                        sessionId: data.sessionId!
                    });

                    const anchoredAt = new Date().toISOString();
                    await db.run(UPDATE.entity(Documents)
                        .set({ anchoredTxHash: result.txHash, anchoredAt, modifiedAt: anchoredAt })
                        .where({ ID: documentId }));

                    return {
                        documentId,
                        attestationId: data.sha256!.toLowerCase(),
                        txHash: result.txHash,
                        anchoredAt
                    };
                }
            });

            return { jobId: job.jobId, status: job.status, documentId };
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
                        .columns('status')
                        .where({ transaction_ID: txRow.ID })
                );
                chainSuccess = result?.status === 'SUCCESS';
            } else if (contractAddress && liveProviderConfigured()) {
                // Crawler-free fallback: the anchoring tx is not in the local
                // Transactions table (crawler off or lagging). Confirm the effect
                // directly against live contract state — the document's sha256 is
                // its on-chain payload_hash, so a present attestation IS the proof.
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

        const payloadHashBytes = hexToBytes(data.payloadHash);
        // The hidden value + salt travel ONLY as circuit witnesses — never as a
        // circuit arg, never persisted. This is what keeps the value private.
        const witnessValues = { attestedValue: valueBig.toString(), valueSalt: saltHex };

        // Insert the row up-front (mirrors anchorDocument): stable handle the
        // caller can poll independently of getJobStatus. Note: `value`/`salt`
        // are intentionally NOT stored.
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
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));
            const registration = {
                artifactPath: resolved.artifactPath,
                privateStateId: resolved.privateStateId,
                zkConfigPath: resolved.zkConfigPath
            };

            const job = await startJob({
                kind: 'issuePredicateAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: data.predicate,
                    threshold: String(data.threshold),
                    predicateAttestationId
                },
                work: async () => {
                    // 1. Bind the numeric commitment to the attestation. The
                    //    commitment is computed in-circuit from the witnesses.
                    await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit: 'commitValue',
                        args: [payloadHashBytes],
                        contractName: compiledRef,
                        registration,
                        sessionId: data.sessionId!,
                        witnessValues
                    });
                    // 2. Prove the predicate. The ledger only accepts this tx if
                    //    the in-circuit asserts (commitment match + predicate)
                    //    held — so a successful tx IS the verified proof.
                    const proof = await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit: 'provePredicate',
                        args: [payloadHashBytes, thresholdBig, BigInt(op)],
                        contractName: compiledRef,
                        registration,
                        sessionId: data.sessionId!,
                        witnessValues
                    });

                    const provenAt = new Date().toISOString();
                    await db.run(UPDATE.entity(PredicateAttestations)
                        .set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt })
                        .where({ ID: predicateAttestationId }));

                    return {
                        predicateAttestationId,
                        payloadHash: data.payloadHash!.toLowerCase(),
                        claim: {
                            predicate: data.predicate,
                            threshold: String(data.threshold),
                            unit: data.unit ?? null
                        },
                        proof: {
                            system: 'midnight-compact',
                            circuit: 'provePredicate',
                            verificationMethod: data.contractAddress,
                            proofValue: proof.txHash
                        }
                    };
                }
            });

            return { jobId: job.jobId, status: job.status, predicateAttestationId };
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

        const payloadHashBytes = hexToBytes(data.payloadHash);
        const fieldKeyBytes = hexToBytes(data.fieldKey);
        const contentRootBytes = data.contentRoot ? hexToBytes(data.contentRoot) : null;
        // The field value + inclusion path travel ONLY as circuit witnesses,
        // never as circuit args, never persisted. This keeps the value private
        // while binding it to the anchored content root.
        const merkleProof = { fieldValue: valueBig.toString(), siblings: siblings.map(s => s.toLowerCase()), dirs: dirsBool };

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
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));
            const registration = {
                artifactPath: resolved.artifactPath,
                privateStateId: resolved.privateStateId,
                zkConfigPath: resolved.zkConfigPath
            };

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
                    predicateAttestationId
                },
                work: async () => {
                    // 1. Anchor the content root (idempotent overwrite) if supplied,
                    //    so proveFieldPredicate has a root to bind against. Uses only
                    //    the attester-identity witness (no value/proof witnesses).
                    if (contentRootBytes) {
                        await submitter.call({
                            contractAddress: data.contractAddress!,
                            circuit: 'anchorContentRoot',
                            args: [payloadHashBytes, contentRootBytes],
                            contractName: compiledRef,
                            registration,
                            sessionId: data.sessionId!
                        });
                    }
                    // 2. Prove the field-bound predicate. The ledger only accepts
                    //    this tx if the in-circuit asserts (Merkle root match +
                    //    predicate) held — so a successful tx IS the verified proof
                    //    that THIS passport field satisfies the predicate.
                    const proof = await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit: 'proveFieldPredicate',
                        args: [payloadHashBytes, fieldKeyBytes, thresholdBig, BigInt(op)],
                        contractName: compiledRef,
                        registration,
                        sessionId: data.sessionId!,
                        merkleProof
                    });

                    const provenAt = new Date().toISOString();
                    await db.run(UPDATE.entity(PredicateAttestations)
                        .set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt })
                        .where({ ID: predicateAttestationId }));

                    return {
                        predicateAttestationId,
                        payloadHash: data.payloadHash!.toLowerCase(),
                        fieldKey: data.fieldKey!.toLowerCase(),
                        claim: {
                            predicate: data.predicate,
                            threshold: String(data.threshold),
                            unit: data.unit ?? null
                        },
                        proof: {
                            system: 'midnight-compact',
                            circuit: 'proveFieldPredicate',
                            verificationMethod: data.contractAddress,
                            proofValue: proof.txHash
                        }
                    };
                }
            });

            return { jobId: job.jobId, status: job.status, predicateAttestationId };
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
        // Same chain-success check as verifyDocument: the proof tx must resolve
        // to an indexed SUCCESS result. Only then is the on-chain predicate
        // verification trustworthy.
        let chainSuccess = false;
        if (provenOk) {
            const txRow: any = await db.run(
                SELECT.one.from(Transactions).columns('ID', 'hash').where({ hash: row.provenTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from(TransactionResults).columns('status').where({ transaction_ID: txRow.ID })
                );
                chainSuccess = result?.status === 'SUCCESS';
            }
        }

        // Crawler-free fallback: the proof tx is not indexed locally (crawler off
        // or lagging). Confirm the outcome directly against live contract state —
        // recompute the claim key from the row and look it up in predicate_results.
        // Verifies the effect, not the tx, so it needs no crawler and no txHash.
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

        const payloadHashBytes = hexToBytes(data.payloadHash);
        const granteeBytes = hexToBytes(data.grantee);
        const payloadHashLc = data.payloadHash.toLowerCase();
        const granteeLc = data.grantee.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        // Insert the row up-front (mirrors anchorDocument / issuePredicateAttestation):
        // a stable handle the caller can poll. active=false until the chain indexer
        // (Phase 2) confirms the grant is present in ledger state — the handler insert
        // is an optimistic placeholder, the chain is the source of truth.
        // Reuse an existing row for the same logical key (contract, payloadHash,
        // grantee) so retries / re-grants don't accumulate orphan placeholder rows.
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
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));
            const registration = {
                artifactPath: resolved.artifactPath,
                privateStateId: resolved.privateStateId,
                zkConfigPath: resolved.zkConfigPath
            };

            const job = await startJob({
                kind: 'grantDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    grantee: granteeLc,
                    level: levelNum,
                    contractAddress: contractAddressLc,
                    disclosureGrantId
                },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress: contractAddressLc,
                        circuit: 'grantDisclosure',
                        args: [payloadHashBytes, granteeBytes, BigInt(levelNum)],
                        contractName: compiledRef,
                        registration,
                        sessionId: data.sessionId!
                    });

                    const grantedAt = new Date().toISOString();
                    await db.run(UPDATE.entity(DisclosureGrants)
                        .set({ grantedTxHash: result.txHash, modifiedAt: grantedAt })
                        .where({ ID: disclosureGrantId }));

                    // Best-effort: pull the grant back out of on-chain state so the
                    // row's `active` flag becomes chain-confirmed. Never fail the
                    // submit on an indexing error — the row already records intent.
                    await reindexAfterSubmit(contractAddressLc, resolved);

                    return {
                        disclosureGrantId,
                        payloadHash: payloadHashLc,
                        grantee: granteeLc,
                        level: levelNum,
                        txHash: result.txHash
                    };
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

        const payloadHashBytes = hexToBytes(data.payloadHash);
        const granteeBytes = hexToBytes(data.grantee);
        const payloadHashLc = data.payloadHash.toLowerCase();
        const granteeLc = data.grantee.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: (req as any).user?.id });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));
            const registration = {
                artifactPath: resolved.artifactPath,
                privateStateId: resolved.privateStateId,
                zkConfigPath: resolved.zkConfigPath
            };

            const job = await startJob({
                kind: 'revokeDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    grantee: granteeLc,
                    contractAddress: contractAddressLc
                },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress: contractAddressLc,
                        circuit: 'revokeDisclosure',
                        args: [payloadHashBytes, granteeBytes],
                        contractName: compiledRef,
                        registration,
                        sessionId: data.sessionId!
                    });

                    // Mark any matching optimistic/active grant row as revoked. The
                    // chain indexer (Phase 2) is authoritative on `active`; this is a
                    // best-effort flip so the row reflects intent before reindex.
                    const revokedAt = new Date().toISOString();
                    await db.run(UPDATE.entity(DisclosureGrants)
                        .set({ revokedTxHash: result.txHash, active: false, modifiedAt: revokedAt })
                        .where({
                            contractAddress: contractAddressLc,
                            payloadHash: payloadHashLc,
                            grantee: granteeLc
                        }));

                    // Best-effort: reconcile against on-chain state (the chain is
                    // authoritative on `active`). Never fail the submit on error.
                    await reindexAfterSubmit(contractAddressLc, resolved);

                    return {
                        payloadHash: payloadHashLc,
                        grantee: granteeLc,
                        txHash: result.txHash
                    };
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    // ------------------------------------------------------------------
    // Crawler-free on-chain state verification (onchain-state-verification-
    // crawlerless FR). Both read LIVE contract state via queryContractState,
    // so they work with the block crawler disabled and without a local txHash.
    // ------------------------------------------------------------------

    srv.on('verifyAttestationState', async (req: Request) => {
        const data = req.data as {
            contractAddress?: string;
            payloadHash?: string;
            contentRoot?: string;
            compiledArtifactRef?: string;
        };

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!SHA256_HEX_RE.test(data.payloadHash)) {
            return req.reject(400, 'payloadHash must be 64 hex chars (32 bytes)');
        }
        if (data.contentRoot && !SHA256_HEX_RE.test(data.contentRoot)) {
            return req.reject(400, 'contentRoot must be 64 hex chars (32 bytes)');
        }

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, attested: false, contentRootOk: false, attesterId: '' };

        // No live provider configured → clean negative, not a 5xx (criterion 5).
        if (!liveProviderConfigured()) return NEGATIVE;

        return runSubmission(req, async () => {
            const resolved = await contractResolver(compiledRef);
            const state = await attestationStateReader({
                contractAddress: data.contractAddress!,
                payloadHash: data.payloadHash!,
                contentRoot: data.contentRoot,
                artifactPath: resolved.artifactPath,
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
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

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        const NEGATIVE = { verified: false, proven: false };

        // No live provider configured → clean negative, not a 5xx (criterion 4).
        if (!liveProviderConfigured()) return NEGATIVE;

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
                contractProvidersConfig: contractProvidersConfigFromEnv(resolved.zkConfigPath)
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
            // `indexed` is the count of grants present on-chain after reconcile —
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
     * map. Best-effort — any resolution/provider error yields `false` (a clean
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
     * Best-effort — any error yields `false`, never a 5xx. Defaults to the
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

    function buildSubmitterDeps(db: any, resolved: ResolvedContract, wallet: import('../midnight/providers').WalletMaterial): TransactionSubmitterDeps {
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
            network: network as NightgateNetwork
        };
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
 */
function liveProviderConfigured(): boolean {
    const { submissionEndpoints } = resolveNightgateRuntimeConfig(getNightgatePluginConfig());
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
            // Uint, …) — a clean 400, not a deep circuit type error.
            return req.reject(400, err.message);
        }
        if (err instanceof ContractNotRegisteredError) {
            return req.reject(404, err.message);
        }
        if (err instanceof SessionNotFoundError) {
            return req.reject(401, err.message);
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
