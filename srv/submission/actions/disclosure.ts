/**
 * Disclosure grants, reindexing and grantee identities.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { DEFAULT_ATTESTATION_VAULT_REF, liveProviderConfigured, contractProvidersConfigFromEnv } from '../verify-state';
import { deriveGranteeId } from '../grantee-identity';
import { getConfiguredGranteeBinding, isSelfServiceGranteeRegistrationAllowed } from '../../utils/nightgate-config';
import { DisclosureGrants, GranteeIdentities, type DisclosureGrant } from '#cds-models/midnight';
import { grantDisclosure, revokeDisclosure, reindexDisclosures, registerGranteeIdentity } from '#cds-models/NightgateService';
import { disclosureRateLimiter, reindexRateLimiter, facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';

const { INSERT, UPDATE, SELECT, DELETE } = cds.ql;

export function registerDisclosureActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'attesterIdResolver' | 'contractResolver' | 'disclosureReindexer' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, attesterIdResolver, contractResolver, disclosureReindexer, resolveSponsorForRequest } = ctx;

    srv.on(grantDisclosure, async (req) => {
        const data = req.data;

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.grantee) return req.reject(400, 'grantee is required');

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

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            // Check session ownership first. The grant row controls who may read,
            // so nothing is written for a caller who does not own the session.
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id });

            // A new grant stays inactive until the indexer sees it on chain.
            // An existing grant keeps its confirmed level and stores the request in `pendingLevel`.
            // So the grantee never sees more than the chain has accepted.
            const insertedAt = new Date().toISOString();
            const existingGrant: DisclosureGrant | undefined = await db.run(
                SELECT.one.from(DisclosureGrants).columns('ID', 'pendingLevel').where({
                    contractAddress: contractAddressLc,
                    attesterId,
                    payloadHash: payloadHashLc,
                    grantee: granteeLc
                })
            );
            const disclosureGrantId = existingGrant?.ID ?? cds.utils.uuid();
            if (existingGrant) {
                await db.run(UPDATE.entity(DisclosureGrants)
                    .set({ pendingLevel: levelNum, modifiedAt: insertedAt })
                    .where({ ID: disclosureGrantId }));
            } else {
                await db.run(INSERT.into(DisclosureGrants).entries({
                    ID: disclosureGrantId,
                    payloadHash: payloadHashLc,
                    attesterId,
                    grantee: granteeLc,
                    level: levelNum,
                    pendingLevel: null,
                    contractAddress: contractAddressLc,
                    grantedTxHash: null,
                    revokedTxHash: null,
                    active: false,
                    createdAt: insertedAt,
                    modifiedAt: insertedAt
                }));
            }

            let job: Awaited<ReturnType<typeof startJob>>;
            try {
                job = await startJob({
                    kind: 'grantDisclosure',
                    sessionId: data.sessionId!,
                    idempotencyKey: data.idempotencyKey,
                    request: {
                        payloadHash: payloadHashLc,
                        attesterId,
                        grantee: granteeLc,
                        level: levelNum,
                        contractAddress: contractAddressLc,
                        disclosureGrantId,
                        feeSponsor: sponsor?.sponsorSessionId ?? null
                    },
                    requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                    commandVersion: 1,
                    encryptCommand: true,
                    command: {
                        op: 'grantDisclosure', disclosureGrantId, payloadHash: payloadHashLc, attesterId,
                        grantee: granteeLc, level: levelNum, contractAddress: contractAddressLc,
                        compiledArtifactRef: compiledRef, sponsorSessionId: sponsor?.sponsorSessionId
                    }
                });
            } catch (err) {
                // No job was started, so remove the row written above.
                if (existingGrant) {
                    await db.run(UPDATE.entity(DisclosureGrants)
                        .set({ pendingLevel: null, modifiedAt: new Date().toISOString() })
                        .where({ ID: disclosureGrantId, pendingLevel: levelNum }));
                } else {
                    await db.run(DELETE.from(DisclosureGrants).where({ ID: disclosureGrantId }));
                }
                throw err;
            }

            // A repeated request starts no job, so nothing else would clear the pendingLevel set above.
            if (job.deduplicated && existingGrant) {
                await db.run(UPDATE.entity(DisclosureGrants)
                    .set({ pendingLevel: existingGrant.pendingLevel ?? null })
                    .where({ ID: disclosureGrantId, pendingLevel: levelNum }));
            }

            return { jobId: job.jobId, status: job.status, disclosureGrantId };
        });
    });

    srv.on(revokeDisclosure, async (req) => {
        const data = req.data;

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.grantee) return req.reject(400, 'grantee is required');
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
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);
            const attesterId = await attesterIdResolver({ sessionId: data.sessionId!, db, expectedUserId: req.user?.id });

            const job = await startJob({
                kind: 'revokeDisclosure',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: payloadHashLc,
                    attesterId,
                    grantee: granteeLc,
                    contractAddress: contractAddressLc,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'revokeDisclosure', payloadHash: payloadHashLc, attesterId, grantee: granteeLc,
                    contractAddress: contractAddressLc, compiledArtifactRef: compiledRef,
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            return { jobId: job.jobId, status: job.status };
        });
    });

    srv.on(reindexDisclosures, async (req) => {
        const data = req.data;

        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;
        const contractAddressLc = data.contractAddress.toLowerCase();

        if (!checkRate(reindexRateLimiter, contractAddressLc, req)) return;

        // Without a live provider, answer with zero counts instead of a server error.
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
            // `indexed` counts the grants found on chain after the sync.
            return {
                contractAddress: contractAddressLc,
                active: result.indexed,
                deactivated: result.deactivated,
                reconciledAt: new Date().toISOString()
            };
        });
    });

    srv.on(registerGranteeIdentity, async (req) => {
        const userId = req.user?.id;
        if (!userId) return req.reject(401, 'authentication required');

        // The server does not verify that the caller owns the binding input.
        // Deployments that rely on grants for access should disable self-service registration.
        if (!isSelfServiceGranteeRegistrationAllowed(getNightgatePluginConfig())) {
            return req.reject(403, 'Self-service grantee registration is disabled on this deployment. ' +
                'Identities are registered through the operator\'s proofing flow.');
        }

        const { bindingInput, scope } = req.data;
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

        // One row per user and scope. Registering again updates it.
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
}
