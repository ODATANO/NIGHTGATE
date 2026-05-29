/**
 * OData handlers for NightgateService submission actions (T6).
 *
 * - `deployContract`        → TransactionSubmitter.deploy()
 * - `submitContractCall`    → TransactionSubmitter.call()
 *
 * Responsibilities here (the submitter itself does NOT do any of these):
 *   1. Parse the JSON-encoded `args` / `initialPrivateState` payloads.
 *   2. Rate-limit per sessionId (deploys are stricter than calls).
 *   3. Resolve `compiledArtifactRef` → compiled contract + zkConfigPath +
 *      privateStateId via the contract registry.
 *   4. Look up the wallet session and build WalletMaterial (T7 stub today ,
 *      surfaces a clear `WalletMaterialUnavailable` until T7 lands).
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
import { resolveNightgateRuntimeConfig, type NightgateNetwork, getConfiguredPrivateStateBackend, getNightgatePluginConfig } from '../utils/nightgate-config';
import { RateLimiter } from '../utils/rate-limiter';
import { ensureNetworkId, type ContractProvidersConfig } from '../midnight/providers';
import { startJob } from './background-jobs';

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
    /** Override the wallet-material factory. Defaults to the T7-pending stub. */
    walletMaterialFactory?: typeof buildWalletMaterialForSession;
    /** Override contract resolution. Defaults to the static registry. */
    resolveContractImpl?: typeof resolveContract;
    /** Override the submitter constructor. Defaults to the real class. */
    submitterFactory?: (deps: TransactionSubmitterDeps) => TransactionSubmitter;
}

export function registerSubmissionHandlers(
    srv: cds.ApplicationService,
    db: any,
    options: SubmissionHandlersOptions = {}
): void {
    const walletFactory = options.walletMaterialFactory ?? buildWalletMaterialForSession;
    const contractResolver = options.resolveContractImpl ?? resolveContract;
    const submitterFactory = options.submitterFactory ?? ((deps: TransactionSubmitterDeps) => new TransactionSubmitter(deps));

    srv.on('deployContract', async (req: Request) => {
        const { compiledArtifactRef, sessionId, initialPrivateState, idempotencyKey } = req.data as {
            compiledArtifactRef?: string;
            sessionId?: string;
            initialPrivateState?: string;
            idempotencyKey?: string;
        };

        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId)          return req.reject(400, 'sessionId is required');

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
            const wallet = await walletFactory({ sessionId, db, facadeConfig: facadeCfg });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            return startJob({
                kind:           'deployContract',
                sessionId,
                idempotencyKey,
                request:        { compiledArtifactRef, sessionId, hasInitialState: !!initialPrivateState },
                work: async () => {
                    const result = await submitter.deploy({
                        contractName: compiledArtifactRef,
                        registration: {
                            artifactPath:   resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath:   resolved.zkConfigPath
                        },
                        initialPrivateState: parsedInitialState,
                        sessionId
                    });
                    return {
                        submissionId:    result.submissionId,
                        txHash:          result.txHash,
                        contractAddress: result.contractAddress,
                        status:          result.status
                    };
                }
            });
        });
    });

    srv.on('submitContractCall', async (req: Request) => {
        const { contractAddress, circuit, compiledArtifactRef, sessionId, args, idempotencyKey } = req.data as {
            contractAddress?: string;
            circuit?: string;
            compiledArtifactRef?: string;
            sessionId?: string;
            args?: string;
            idempotencyKey?: string;
        };

        if (!contractAddress)     return req.reject(400, 'contractAddress is required');
        if (!circuit)             return req.reject(400, 'circuit is required');
        if (!compiledArtifactRef) return req.reject(400, 'compiledArtifactRef is required');
        if (!sessionId)           return req.reject(400, 'sessionId is required');

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

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledArtifactRef);
            const wallet = await walletFactory({ sessionId, db, facadeConfig: facadeCfg });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            return startJob({
                kind:           'submitContractCall',
                sessionId,
                idempotencyKey,
                request:        { contractAddress, circuit, compiledArtifactRef, sessionId, argCount: parsedArgs.length },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress,
                        circuit,
                        args:         parsedArgs,
                        contractName: compiledArtifactRef,
                        registration: {
                            artifactPath:   resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath:   resolved.zkConfigPath
                        },
                        sessionId
                    });
                    return {
                        submissionId:    result.submissionId,
                        txHash:          result.txHash,
                        contractAddress: result.contractAddress,
                        status:          result.status
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

        if (!data.sha256)          return req.reject(400, 'sha256 is required');
        if (!data.storageRef)      return req.reject(400, 'storageRef is required');
        if (!data.sessionId)       return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        if (!SHA256_HEX_RE.test(data.sha256)) {
            return req.reject(400, 'sha256 must be 64 hex chars (32 bytes)');
        }

        const metadataStr  = data.metadata ?? '';
        const compiledRef  = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (!checkRate(anchorRateLimiter, data.sessionId, req)) return;

        // Compute the on-chain inputs: payload_hash from the caller's sha256
        // and metadata_hash from the public metadata blob. Both are 32-byte
        // commitments — the actual bytes live off-chain at `storageRef`.
        const payloadHashBytes  = hexToBytes(data.sha256);
        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));

        // Insert the Documents row up-front on req.tx so the row ID is stable
        // and immediately queryable, even though the on-chain anchoring is
        // deferred to the background job. Mirrors the PendingSubmissions
        // pattern: clients have a handle to retry against without polling.
        const documentId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into('midnight.Documents').entries({
            ID:          documentId,
            sha256:      data.sha256.toLowerCase(),
            contentType: data.contentType ?? null,
            size:        data.size ?? null,
            storageRef:  data.storageRef,
            anchoredTxHash: null,
            anchoredAt:     null,
            createdAt:   insertedAt,
            modifiedAt:  insertedAt
        }));

        // Sync setup (errors here become 404/401/501 via runSubmission); the
        // SDK round-trip + Documents UPDATE move into the background job.
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));

            const job = await startJob({
                kind:           'anchorDocument',
                sessionId:      data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    sha256:           data.sha256!.toLowerCase(),
                    contractAddress:  data.contractAddress,
                    compiledRef,
                    documentId
                },
                work: async () => {
                    const result = await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit:         'attest',
                        args:            [payloadHashBytes, metadataHashBytes],
                        contractName:    compiledRef,
                        registration: {
                            artifactPath:   resolved.artifactPath,
                            privateStateId: resolved.privateStateId,
                            zkConfigPath:   resolved.zkConfigPath
                        },
                        sessionId: data.sessionId!
                    });

                    const anchoredAt = new Date().toISOString();
                    await db.run(UPDATE.entity('midnight.Documents')
                        .set({ anchoredTxHash: result.txHash, anchoredAt, modifiedAt: anchoredAt })
                        .where({ ID: documentId }));

                    return {
                        documentId,
                        attestationId: data.sha256!.toLowerCase(),
                        txHash:        result.txHash,
                        anchoredAt
                    };
                }
            });

            return { jobId: job.jobId, status: job.status, documentId };
        });
    });

    srv.on('verifyDocument', async (req: Request) => {
        const { documentId, providedSha256 } = req.data as {
            documentId?: string;
            providedSha256?: string;
        };

        if (!documentId)     return req.reject(400, 'documentId is required');
        if (!providedSha256) return req.reject(400, 'providedSha256 is required');
        if (!SHA256_HEX_RE.test(providedSha256)) {
            return req.reject(400, 'providedSha256 must be 64 hex chars (32 bytes)');
        }

        const doc: any = await db.run(
            SELECT.one.from('midnight.Documents').where({ ID: documentId })
        );
        if (!doc) return req.reject(404, `Document ${documentId} not found`);

        const hashMatches = doc.sha256?.toLowerCase() === providedSha256.toLowerCase();
        const anchoredOk  = Boolean(doc.anchoredTxHash);

        // Only resolve the on-chain status if we have a txHash and the hash
        // matched. Skipping the SELECT in the mismatch path saves one DB
        // round-trip on what is the "tampered" answer most of the time.
        let chainSuccess = false;
        if (anchoredOk && hashMatches) {
            const txRow: any = await db.run(
                SELECT.one.from('midnight.Transactions')
                    .columns('ID', 'hash')
                    .where({ hash: doc.anchoredTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from('midnight.TransactionResults')
                        .columns('status')
                        .where({ transaction_ID: txRow.ID })
                );
                chainSuccess = result?.status === 'SUCCESS';
            }
        }

        return {
            verified:       hashMatches && anchoredOk && chainSuccess,
            anchoredTxHash: doc.anchoredTxHash ?? '',
            anchoredAt:     doc.anchoredAt ?? null,
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

        if (!data.payloadHash)                  return req.reject(400, 'payloadHash is required');
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
        if (data.predicate === 'lessOrEqual')         op = 0;
        else if (data.predicate === 'greaterOrEqual') op = 1;
        else return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual'");

        if (!data.sessionId)       return req.reject(400, 'sessionId is required');
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
        await db.run(INSERT.into('midnight.PredicateAttestations').entries({
            ID:              predicateAttestationId,
            payloadHash:     data.payloadHash.toLowerCase(),
            contractAddress: data.contractAddress,
            predicate:       data.predicate,
            op,
            threshold:       data.threshold,
            unit:            data.unit ?? null,
            valueCommitment: data.valueCommitment ? data.valueCommitment.toLowerCase() : null,
            provenTxHash:    null,
            provenAt:        null,
            createdAt:       insertedAt,
            modifiedAt:      insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            const resolved = await contractResolver(compiledRef);
            const wallet = await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg });
            const submitter = submitterFactory(buildSubmitterDeps(db, resolved, wallet));
            const registration = {
                artifactPath:   resolved.artifactPath,
                privateStateId: resolved.privateStateId,
                zkConfigPath:   resolved.zkConfigPath
            };

            const job = await startJob({
                kind:           'issuePredicateAttestation',
                sessionId:      data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash:     data.payloadHash!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate:       data.predicate,
                    threshold:       String(data.threshold),
                    predicateAttestationId
                },
                work: async () => {
                    // 1. Bind the numeric commitment to the attestation. The
                    //    commitment is computed in-circuit from the witnesses.
                    await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit:         'commitValue',
                        args:            [payloadHashBytes],
                        contractName:    compiledRef,
                        registration,
                        sessionId:       data.sessionId!,
                        witnessValues
                    });
                    // 2. Prove the predicate. The ledger only accepts this tx if
                    //    the in-circuit asserts (commitment match + predicate)
                    //    held — so a successful tx IS the verified proof.
                    const proof = await submitter.call({
                        contractAddress: data.contractAddress!,
                        circuit:         'provePredicate',
                        args:            [payloadHashBytes, thresholdBig, BigInt(op)],
                        contractName:    compiledRef,
                        registration,
                        sessionId:       data.sessionId!,
                        witnessValues
                    });

                    const provenAt = new Date().toISOString();
                    await db.run(UPDATE.entity('midnight.PredicateAttestations')
                        .set({ provenTxHash: proof.txHash, provenAt, modifiedAt: provenAt })
                        .where({ ID: predicateAttestationId }));

                    return {
                        predicateAttestationId,
                        payloadHash: data.payloadHash!.toLowerCase(),
                        claim: {
                            predicate: data.predicate,
                            threshold: String(data.threshold),
                            unit:      data.unit ?? null
                        },
                        proof: {
                            system:             'midnight-compact',
                            circuit:            'provePredicate',
                            verificationMethod: data.contractAddress,
                            proofValue:         proof.txHash
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
            SELECT.one.from('midnight.PredicateAttestations').where({ ID: predicateAttestationId })
        );
        if (!row) return req.reject(404, `PredicateAttestation ${predicateAttestationId} not found`);

        const provenOk = Boolean(row.provenTxHash);
        // Same chain-success check as verifyDocument: the proof tx must resolve
        // to an indexed SUCCESS result. Only then is the on-chain predicate
        // verification trustworthy.
        let chainSuccess = false;
        if (provenOk) {
            const txRow: any = await db.run(
                SELECT.one.from('midnight.Transactions').columns('ID', 'hash').where({ hash: row.provenTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from('midnight.TransactionResults').columns('status').where({ transaction_ID: txRow.ID })
                );
                chainSuccess = result?.status === 'SUCCESS';
            }
        }

        return {
            verified:        provenOk && chainSuccess,
            predicate:       row.predicate ?? '',
            threshold:       row.threshold ?? 0,
            unit:            row.unit ?? '',
            valueCommitment: row.valueCommitment ?? '',
            provenTxHash:    row.provenTxHash ?? '',
            provenAt:        row.provenAt ?? null
        };
    });

    function buildSubmitterDeps(db: any, resolved: ResolvedContract, wallet: import('../midnight/providers').WalletMaterial): TransactionSubmitterDeps {
        const nightgateConfig = getNightgatePluginConfig();
        const { network, submissionEndpoints } = resolveNightgateRuntimeConfig(nightgateConfig);
        const privateStateBackend = getConfiguredPrivateStateBackend(nightgateConfig);

        const contractProvidersConfig: ContractProvidersConfig = {
            indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
            indexerWsUrl:   submissionEndpoints.indexerWsUrl,
            proofServerUrl: submissionEndpoints.proofServerUrl,
            zkConfigPath:   resolved.zkConfigPath
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
        networkId: network as 'preprod' | 'testnet' | 'mainnet',
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl:   submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        relayUrl:       nodeUrl
    };
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
        if (err instanceof ContractNotRegisteredError) {
            return req.reject(404, err.message);
        }
        if (err instanceof SessionNotFoundError) {
            return req.reject(401, err.message);
        }
        if (err instanceof WalletMaterialUnavailable) {
            // 501 = Not Implemented. T7 will replace this with real wallet material.
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
