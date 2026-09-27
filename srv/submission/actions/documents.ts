/**
 * Document anchoring, verification, passport registration and retraction.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { type NightgateNetwork, VALID_NIGHTGATE_NETWORKS } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { SHA256_HEX_RE, DEFAULT_ATTESTATION_VAULT_REF, liveProviderConfigured } from '../verify-state';
import { agentOutputProducedAt } from '../document-proof';
import { Documents, Transactions, TransactionResults, type Document, type Transaction } from '#cds-models/midnight';
import type { Row } from '../../utils/db-types';
import type { NightgateRequest } from '../../utils/request-types';
import { anchorRateLimiter, registrarRateLimiter, facadeConfigFromEnv, recordedNetworkId, artifactDigestOrNull, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';

const { INSERT, UPDATE, SELECT, DELETE } = cds.ql;

export function registerDocumentActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'attesterIdResolver' | 'contractResolver' | 'verifyDocumentViaState' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, attesterIdResolver, contractResolver, verifyDocumentViaState, resolveSponsorForRequest } = ctx;

    srv.on('anchorDocument', async (req: NightgateRequest) => {
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
            userId: req.user?.id ?? null,
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
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            // The record is keyed by the session's attester id and the hash, so a
            // plain attest cannot be pre-empted by another identity.
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id });
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
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
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

    srv.on('verifyDocument', async (req: NightgateRequest) => {
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

        const doc: Row<Document, 'ID' | 'sha256'> | undefined = await db.run(
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
            const txRow: Row<Transaction, 'ID'> | undefined = await db.run(
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

    srv.on('registerPassport', async (req: NightgateRequest) => {
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
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
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
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
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
    async function submitRetract(req: NightgateRequest, mode: number, key: string, data: { sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string }) {
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
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = mode === 0 ? await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id }) : undefined;
            const job = await startJob({
                kind: 'retract',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: { mode, key: keyLc, contractAddress: contractAddressLc, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'retract', mode, key: keyLc, attesterId, contractAddress: contractAddressLc, compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId }
            });
            return { jobId: job.jobId, status: job.status };
        });
    }

    // Owner-initiated removal of a payload: attestation, anchor, disclosures
    // and document binding leave the chain (retract mode 0).
    srv.on('retractAttestation', async (req: NightgateRequest) => {
        const data = req.data as { payloadHash?: string; sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string };
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        return submitRetract(req, 0, data.payloadHash, data);
    });

    // Anyone removes an expired claim (`kind` claim, key = claim key).
    srv.on('purgeExpired', async (req: NightgateRequest) => {
        const data = req.data as { kind?: string; key?: string; sessionId?: string; contractAddress?: string; compiledArtifactRef?: string; idempotencyKey?: string; sponsorSessionId?: string };
        const mode = data.kind === 'claim' ? 1 : null;
        if (mode === null) return req.reject(400, "kind must be 'claim'");
        if (!data.key) return req.reject(400, 'key is required');
        return submitRetract(req, mode, data.key, data);
    });
}
