// Actions that store document hashes on-chain, verify them, register documents and remove them.
// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { type NightgateNetwork, VALID_NIGHTGATE_NETWORKS } from '../../utils/nightgate-config';
import { startJob } from '../background-jobs';
import { vaultRef, liveProviderConfigured } from '../verify-state';
import { agentOutputProducedAt } from '../document-proof';
import { Documents, type Document } from '#cds-models/midnight';
import type { Row } from '../../utils/db-types';
import type { ActionRequest } from '@sap/cds';
import { facadeConfigFromEnv, recordedNetworkId, artifactDigestOrNull, rejectIfMainnetBlocked, runSubmission, startJobWithRows, landedOnChain } from './common';
import type { SubmissionContext } from './context';
import { anchorDocument, purgeExpired, registerDocument, retractAttestation, verifyDocument } from '#cds-models/NightgateService';
import { checkRateClass } from '../../utils/rate-classes';

const { INSERT, SELECT } = cds.ql;

export function registerDocumentActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'attesterIdResolver' | 'contractResolver' | 'verifyDocumentViaState' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, attesterIdResolver, contractResolver, verifyDocumentViaState, resolveSponsorForRequest } = ctx;

    srv.on(anchorDocument, async (req) => {
        const data = req.data;

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.storageRef) return req.reject(400, 'storageRef is required');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const metadataStr = data.metadata ?? '';
        const compiledRef = vaultRef(data.contractName);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        const metadataHashBytes = sha256(new TextEncoder().encode(metadataStr));
        const producedAt = agentOutputProducedAt(data.contentType, metadataStr);

        const anchorId = cds.utils.uuid();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await contractResolver(compiledRef);
            // Ownership first, so nothing is written for a caller who does not own the session.
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id });

            const insertedAt = new Date().toISOString();
            // verifyDocument later trusts only what is stored here, never values from its caller.
            const insertRows = INSERT.into(Documents).entries({
                ID: anchorId,
                payloadHash: data.payloadHash!.toLowerCase(),
                contentType: data.contentType ?? null,
                size: data.size ?? null,
                storageRef: data.storageRef,
                anchoredTxHash: null,
                anchoredAt: null,
                userId: req.user?.id ?? null,
                contractAddress: data.contractAddress,
                network: recordedNetworkId(),
                contractName: compiledRef,
                artifactDigest: artifactDigestOrNull(compiledRef),
                sessionId: data.sessionId,
                attesterId,
                createdAt: insertedAt,
                modifiedAt: insertedAt
            });
            const job = await startJobWithRows(db, Documents, [anchorId], insertRows, () => startJob({
                kind: 'anchorDocument',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    compiledRef,
                    anchorId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null,
                    ...(producedAt ? { producedAt } : {})
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), contractAddress: data.contractAddress,
                    compiledRef, metadata: metadataStr, storageRef: data.storageRef ?? null, contentType: data.contentType ?? null, size: data.size ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'anchorDocument', anchorId, payloadHash: data.payloadHash!.toLowerCase(),
                    metadataHash: bytesToHex(metadataHashBytes), attesterId, contractAddress: data.contractAddress!,
                    contractName: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                }
            }));
            const stableAnchorId = job.originalRequest?.anchorId ?? anchorId;
            return { jobId: job.jobId, status: job.status, anchorId: stableAnchorId, attesterId };
        });
    });

    srv.on(verifyDocument, async (req) => {
        const { anchorId, payloadHash, contractAddress, contractName } = req.data;

        if (!anchorId) return req.reject(400, 'anchorId is required');
        if (!payloadHash) return req.reject(400, 'payloadHash is required');
        if (!checkRateClass('read', 'read', req)) return;

        const doc: Row<Document, 'ID' | 'payloadHash'> | undefined = await db.run(
            SELECT.one.from(Documents).where({ ID: anchorId })
        );
        if (!doc) return req.reject(404, `Document ${anchorId} not found`);

        // The stored contract and network win. Otherwise another contract that attests the same
        // public hash could verify this document. Old rows without them use the caller's values.
        const recordedContract: string | null = doc.contractAddress ?? null;
        if (recordedContract && contractAddress
            && contractAddress.toLowerCase() !== recordedContract.toLowerCase()) {
            return req.reject(400, 'contractAddress does not match the vault this document was anchored in');
        }
        const effectiveContract = recordedContract ?? contractAddress;
        const recordedArtifact: string | null = doc.contractName ?? null;
        if (recordedArtifact && contractName && contractName !== recordedArtifact) {
            return req.reject(400, 'contractName does not match the artifact this document was anchored with');
        }
        const effectiveArtifact = recordedArtifact ?? contractName;
        const recordedNetwork = doc.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(doc.network)
            ? doc.network as NightgateNetwork
            : undefined;

        const hashMatches = doc.payloadHash?.toLowerCase() === payloadHash.toLowerCase();
        const anchoredOk = Boolean(doc.anchoredTxHash);

        // `included` only says the transaction landed. The verdict needs the live state,
        // because the attestation may have been retracted since.
        let included = false;
        let stateChecked = false;
        let current = false;
        if (anchoredOk && hashMatches) {
            included = await landedOnChain(db, doc.anchoredTxHash);
            if (effectiveContract && doc.attesterId && liveProviderConfigured(recordedNetwork)) {
                stateChecked = true;
                current = await verifyDocumentViaState(
                    effectiveContract, doc.attesterId, doc.payloadHash, effectiveArtifact, recordedNetwork,
                    doc.artifactDigest ?? null);
            }
        }

        return {
            verified: hashMatches && anchoredOk && stateChecked && current,
            included,
            stateChecked,
            anchoredTxHash: doc.anchoredTxHash ?? '',
            anchoredAt: doc.anchoredAt ?? null,
            // Only returned on a match, so a document id alone does not reveal the hash.
            payloadHash: hashMatches ? doc.payloadHash ?? '' : ''
        };
    });

    srv.on(registerDocument, async (req) => {
        const data = req.data;

        const mode = data.mode ?? 0;
        if (![0, 1, 2, 3, 4].includes(mode)) return req.reject(400, 'mode must be 0 (register), 1 (unregister), 2 (transfer registrar), 3 (recovery: set registrar) or 4 (recovery: set recovery)');
        const zeroId = '00'.repeat(32);
        // Mode 1 has no owner and modes 2-4 have no id. The unused argument is sent as zeros.
        if (mode === 1) data.ownerId = zeroId;
        if (mode >= 2) data.documentId = zeroId;
        if (!data.documentId) return req.reject(400, 'documentId is required');
        if (!data.ownerId) return req.reject(400, 'ownerId is required');
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.contractName);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        const documentIdLc = data.documentId.toLowerCase();
        const ownerIdLc = data.ownerId.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'registerDocument',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    documentId: documentIdLc,
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
                    op: 'registerDocument', documentId: documentIdLc, ownerId: ownerIdLc, mode,
                    contractAddress: contractAddressLc, contractName: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    /** Submits the retract circuit. Mode 0 removes an attestation, mode 1 an expired claim. */
    async function submitRetract(req: ActionRequest<unknown, unknown>, mode: number, key: string, data: { sessionId?: string | null; contractAddress?: string | null; contractName?: string | null; idempotencyKey?: string | null; sponsorSessionId?: string | null }) {
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');
        const compiledRef = vaultRef(data.contractName);
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;
        const keyLc = key.toLowerCase();
        const contractAddressLc = data.contractAddress.toLowerCase();
        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = mode === 0 ? await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id }) : undefined;
            const job = await startJob({
                kind: mode === 1 ? 'purgeExpired' : 'retractAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: { mode, key: keyLc, contractAddress: contractAddressLc, feeSponsor: sponsor?.sponsorSessionId ?? null },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: { op: 'retract', mode, key: keyLc, attesterId, contractAddress: contractAddressLc, contractName: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId }
            });
            return { jobId: job.jobId, status: job.status };
        });
    }

    // The owner removes an attestation. Its stored root, disclosure grants and document link go with it.
    srv.on(retractAttestation, async (req) => {
        const data = req.data;
        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        return submitRetract(req, 0, data.payloadHash, data);
    });

    // Anyone may remove an expired claim.
    srv.on(purgeExpired, async (req) => {
        const data = req.data;
        const mode = data.kind === 'claim' ? 1 : null;
        if (mode === null) return req.reject(400, "kind must be 'claim'");
        if (!data.key) return req.reject(400, 'key is required');
        return submitRetract(req, mode, data.key, data);
    });
}
