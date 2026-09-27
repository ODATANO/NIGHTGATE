/**
 * Reconciliation finalizers: record the projection once inclusion is proven.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { assertArtifactGeneration } from '../contract-registry';
import type { BackgroundJobRow, ReconciliationEvidence } from '../job-store';
import { Documents, DisclosureGrants, PendingSubmissions } from '#cds-models/midnight';
import { recordDeployedContracts } from '../../sessions/agent-grants';
import { ContractCommandV1, ContractCommandV1WithProvenance } from '../actions/common';
import type { SubmissionContext } from '../actions/context';

const { UPDATE, SELECT } = cds.ql;

export function createReconciliationFinalizers(ctx: Pick<SubmissionContext, 'db' | 'contractResolver' | 'confirmedDisclosureLevel' | 'heightStamp' | 'notNewerThan' | 'reindexAfterSubmit'>) {
    const { db, contractResolver, confirmedDisclosureLevel, heightStamp, notNewerThan, reindexAfterSubmit } = ctx;

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
    return { finalizeSponsoredSubmission, finalizeContractProjection };
}
