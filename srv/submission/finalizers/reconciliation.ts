/**
 * Writes a job's database results once its transaction is proven to be on chain.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { assertArtifactGeneration } from '../contract-registry';
import type { ReconciliationEvidence } from '../job-store';
import { Documents, DisclosureGrants, PendingSubmissions, type PendingSubmission, type BackgroundJob } from '#cds-models/midnight';
import { parseSubmitIntent } from '../submit-intent';
import { recordDeployedContracts } from '../../sessions/agent-grants';
import { recordPlatformMint } from '../platform-mints';
import { closeSwapOffer, closeSwapOffersByNullifiers } from '../swap-offers';
import { ContractCommandV1, ContractCommandV1WithProvenance } from '../actions/common';
import type { SubmissionContext } from '../actions/context';
import { errorMessage } from '../../utils/errors';

const { UPDATE, SELECT } = cds.ql;

/** Result writers for jobs whose transaction landed but whose send outcome was lost. */
export function createReconciliationFinalizers(ctx: Pick<SubmissionContext, 'db' | 'contractResolver' | 'confirmedDisclosureLevel' | 'heightStamp' | 'notNewerThan' | 'reindexAfterSubmit'>) {

    const { db, contractResolver, confirmedDisclosureLevel, heightStamp, notNewerThan, reindexAfterSubmit } = ctx;

    const finalizeSponsoredSubmission = async (raw: unknown, _job: BackgroundJob, evidence: ReconciliationEvidence): Promise<unknown> => {
        const command = raw as { grantId?: string; sponsorSessionId?: string };
        const submission: PendingSubmission | undefined = evidence.submissionId
            ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: evidence.submissionId }))
            : await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: evidence.txHash }));
        const coordinates = parseSubmitIntent(submission?.submitIntentData);
        const deployed: string[] = Array.isArray(coordinates.deployed) ? coordinates.deployed.map(String) : [];
        const grantId = coordinates.deployReservation?.grantId ?? command?.grantId;
        if (deployed.length && grantId) await recordDeployedContracts(db, String(grantId), deployed);
        const minted: string[] = Array.isArray(coordinates.minted) ? coordinates.minted.map(String) : [];
        if (minted.length) await recordPlatformMint(db, minted, { grantId: grantId ? String(grantId) : null, sponsorSessionId: command?.sponsorSessionId ?? null, txHash: evidence.txHash ?? null });
        const nullifiers: string[] = Array.isArray(coordinates.nullifiers) ? coordinates.nullifiers.map(String) : [];
        // The swap is already on chain. A failed write to the offer board must not fail the job.
        try {
            if (coordinates.offerId) await closeSwapOffer(db, String(coordinates.offerId), 'filled', evidence.txHash ?? null);
            if (nullifiers.length) await closeSwapOffersByNullifiers(db, nullifiers, evidence.txHash ?? null);
        } catch (e) {
            cds.log('nightgate').warn(`swap offers of ${evidence.txHash ?? 'the reconciled swap'} not closed: ${errorMessage(e)}`);
        }
        return {
            reconciled: true, ...evidence, status: 'finalized',
            circuits: Array.isArray(coordinates.circuits) ? coordinates.circuits : [],
            contractAddress: coordinates.contractAddress ?? evidence.contractAddress ?? '',
            ...(coordinates.note ? { note: coordinates.note } : {}),
            ...(deployed.length ? { deployed } : {}),
            feeSponsor: coordinates.feeSponsor ?? command?.sponsorSessionId ?? _job.sessionId
        };
    };

    const finalizeFactoryMint = async (raw: unknown, job: BackgroundJob, evidence: ReconciliationEvidence): Promise<unknown> => {
        const command = raw as Extract<ContractCommandV1, { op: 'call' }>;
        const tokenType = command?.mintedTokenType;
        if (tokenType) await recordPlatformMint(db, [tokenType], { grantId: job.grantId ?? null, sponsorSessionId: command.sponsorSessionId ?? null, txHash: evidence.txHash ?? null });
        return {
            reconciled: true, txHash: evidence.txHash, status: 'finalized',
            contractAddress: command?.contractAddress ?? evidence.contractAddress ?? '',
            ...(tokenType ? { tokenType } : {}),
            ...(command?.sponsorSessionId ? { feeSponsor: command.sponsorSessionId } : {})
        };
    };

    const finalizeContractProjection = async (raw: unknown, _job: BackgroundJob, evidence: ReconciliationEvidence): Promise<unknown> => {
        const command = raw as ContractCommandV1WithProvenance;

        if (typeof command.compiledArtifactRef === 'string') {
            assertArtifactGeneration(
                command.compiledArtifactRef,
                command.artifactDigest,
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
                // Same database update the executor makes after a normal submit.
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
        throw new Error(`Unsupported projection finalizer operation '${String((raw as { op?: unknown } | null)?.op)}'`);
    };

    return { finalizeSponsoredSubmission, finalizeContractProjection, finalizeFactoryMint };
}
