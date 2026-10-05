/**
 * Runs contract jobs: deploys, circuit calls, batches and the proof steps of workflows.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { assertArtifactGeneration } from '../contract-registry';
import { resolveFeeSponsor, ensureFeeSponsorFacade } from '../fee-sponsor';
import { coerceCircuitArgs } from '../arg-coercion';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { runChildCommand } from '../background-jobs';
import { jobKindOp } from '../job-kinds';
import { vaultDims } from '../verify-state';
import { expandAllowedMask, computeRecordKey } from '../predicate-state';
import { Documents, PredicateAttestations, DisclosureGrants, BackgroundJobs, type BackgroundJob } from '#cds-models/midnight';
import { currentGrantRow, grantJobScopeViolation } from '../../sessions/agent-grants';
import { hexToBytes } from '../../utils/hex';
import { recordProven, claimValidUntil, MerkleProofBundle, ContractCommandV1, ContractCommandV1WithProvenance, facadeConfigFromEnv } from '../actions/common';
import type { SubmissionContext } from '../actions/context';

const { UPDATE, SELECT } = cds.ql;

export function createContractCommandExecutor(ctx: Pick<SubmissionContext, 'db' | 'walletFactory' | 'contractResolver' | 'submitterFactory' | 'argTypesLoader' | 'confirmedDisclosureLevel' | 'heightStamp' | 'notNewerThan' | 'clearPendingDisclosureLevel' | 'reindexAfterSubmit' | 'buildSubmitterDeps'>) {
    const { db, walletFactory, contractResolver, submitterFactory, argTypesLoader, confirmedDisclosureLevel, heightStamp, notNewerThan, clearPendingDisclosureLevel, reindexAfterSubmit, buildSubmitterDeps } = ctx;

    const executeContractCommand = async (raw: unknown, job: BackgroundJob): Promise<unknown> => {
        const command = raw as ContractCommandV1;
        if (!command || job.commandVersion !== 1 || !job.sessionId || !job.requestedBy) {
            throw new Error(`Invalid persisted contract command for job ${job.ID}`);
        }
        const expectedOp = jobKindOp(job.kind);
        if (expectedOp === undefined || command.op !== expectedOp) {
            throw new Error(`Persisted command operation '${command.op}' is incompatible with ${job.kind}`);
        }

        // A contract name can later point to another build. Refuse to run if the build
        // differs from the one the command was created for, or if no digest was stored.
        {
            const cmd = command as ContractCommandV1WithProvenance;
            if (typeof (cmd as any).compiledArtifactRef === 'string') {
                assertArtifactGeneration(
                    (cmd as any).compiledArtifactRef,
                    cmd.artifactDigest,
                    `Persisted '${command.op}' command of job ${job.ID}`);
            }
        }
        // Read the agent grant again when the job runs. Step jobs carry the parent's grant.
        // A grant revoked, expired or narrowed after the job was queued stops it.
        if (job.grantId) {
            const grant = await currentGrantRow(db, String(job.grantId));
            if (!grant) {
                throw Object.assign(new Error(`agent grant ${job.grantId} is revoked or expired; the job was not executed`), { code: 'AGENT_GRANT_REVOKED', retryable: false });
            }
            let parentKind: string | null = null;
            if (job.parentJobId) {
                const parent: BackgroundJob | undefined = await db.run(SELECT.one.from(BackgroundJobs).columns('kind').where({ ID: job.parentJobId }));
                parentKind = parent?.kind ?? null;
            }
            const scope = grantJobScopeViolation(grant, { kind: job.kind, parentJobId: job.parentJobId, parentKind }, command as unknown as Record<string, unknown>);
            if (scope) {
                throw Object.assign(new Error(`agent grant ${job.grantId}: ${scope}; the job was not executed`), { code: 'AGENT_GRANT_SCOPE', retryable: false });
            }
        }
        // Step jobs get the parent's contract digest. If the name changes between steps,
        // the step fails instead of mixing two contract builds in one workflow.
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
            // The digest is a public circuit argument. Only the Merkle path stays private.
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
            // Each optional contentRoot is stored in its own transaction.
            // The batch action does everything in one transaction.
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
            // One circuit serves both comparisons through a mode argument, because each circuit
            // adds deploy size. The unused mode gets harmless values, mask 0 or k 1.
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
            // One transaction. First the optional contentRoot, then one proof call per claim
            // with its own private inputs. A false claim fails during local proving.
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
                // The claims do not depend on each other, so their order is free.
                // Only a contentRoot call in the batch must stay first.
                command: { op: 'callBatch', contractAddress: command.contractAddress, calls, compiledArtifactRef: command.compiledArtifactRef, sponsorSessionId: command.sponsorSessionId, independentCalls: true, orderedPrefix: calls[0]?.circuit === 'anchorContentRoot' ? 1 : 0 }
            });
            // Update all rows in one statement. The transaction is on chain, so no row may be missed.
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
        // The resolver checks the digest against the exact copy it loads,
        // so a parallel registerContract cannot swap the contract in between.
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
                // The chain did not take the change, so the confirmed level stays.
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
            // Mode 0 registers the id, 1 removes it, 2 hands the registrar role to someone else.
            // In modes 3 and 4 the recovery identity sets a new registrar or a new recovery identity.
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
                // Retracting the attestation also removed its disclosure grants on-chain.
                const changedAt = new Date().toISOString();
                const landed = result.blockHeight ?? null;
                await db.run(notNewerThan(UPDATE.entity(DisclosureGrants).set({ active: false, revokedTxHash: result.txHash, modifiedAt: changedAt, ...heightStamp(landed) }).where({ contractAddress: command.contractAddress, attesterId: command.attesterId, payloadHash: command.key, active: true }), landed));
                await reindexAfterSubmit(command.contractAddress, resolved, landed, job, command.compiledArtifactRef);
            }
            return { mode: command.mode, key: command.key, contractAddress: command.contractAddress, txHash: result.txHash, ...(sponsor ? { feeSponsor: sponsor.sponsorSessionId } : {}) };
        }

        if (command.op === 'callBatch') {
            // The stored args are raw JSON. Convert each call's args like the single call below.
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
            // Build, sign and finalize with the caller's keys. No sponsor and no submit.
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
            // The circuit takes the mask as Vector<width, Boolean>, built from the integer.
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
    return executeContractCommand;
}
