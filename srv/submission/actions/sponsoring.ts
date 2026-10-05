/**
 * Fee sponsoring of caller-built transactions.
 * SPDX-License-Identifier: Apache-2.0
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { resolveFeeSponsor } from '../fee-sponsor';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { PLATFORM_POOL_SENTINEL } from '../sponsor-pool';
import { resolveSponsorPolicyForRequest } from '../sponsor-policy';
import { getConfiguredFeeSponsorSessions } from '../fee-sponsor';
import { sponsorRateLimiter, facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import { NightgateError } from '../../utils/errors';
import { transactionBytesOf } from '../../utils/offer-file';
import { expireSwapOffers, isSwapOfferOpen, loadSwapOffer } from '../swap-offers';
import type { SubmissionContext } from './context';
import { sponsorFinalizedTransaction, sponsorSwap, sponsorUnboundTransaction } from '#cds-models/NightgateService';

export function registerSponsoringActions(ctx: Pick<SubmissionContext, 'srv' | 'db'>): void {
    const { srv, db } = ctx;

    srv.on(sponsorFinalizedTransaction, async (req) => {
        const { finalizedTxB64, sponsorSessionId, idempotencyKey } = req.data;
        if (!finalizedTxB64) return req.reject(400, 'finalizedTxB64 is required');
        // With the pool placeholder, the job picks a sponsor wallet when it runs.
        // If one wallet fails, another can take over.
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) {
                return req.reject(400, 'sponsorSessionId is required (the wallet that pays dust); no platform pool is configured');
            }
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(sponsorRateLimiter, 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            // A named sponsor is checked here only against its database row.
            // Loading its wallet is slow and happens when the job runs.
            // Pool jobs skip this check, so one broken pool wallet cannot block new requests.
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            // The server policy, narrowed by the agent grant. Refuses here, before a job exists.
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes } = resolveSponsorPolicyForRequest(req);
            // If this is a deploy, the new contract address is stored on this grant.
            const grantId: string | undefined = req.agentGrant?.ID ? String(req.agentGrant.ID) : undefined;
            // Sponsors are shared by many callers. Mixing the caller into the key
            // stops one caller's key from colliding with another's.
            const caller = String(req.user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorFinalizedTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                // Hash the content, so two different transactions of equal size are not treated as one.
                request: {
                    feeSponsor: effectiveSponsor,
                    caller,
                    bytes: finalizedTxB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(finalizedTxB64, 'base64')))
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorFinalized', finalizedTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, grantId }
            });
            // The job belongs to the sponsor session. The caller needs it to poll the job.
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on(sponsorUnboundTransaction, async (req) => {
        const { unboundTxB64, sponsorSessionId, idempotencyKey } = req.data;
        if (!unboundTxB64) return req.reject(400, 'unboundTxB64 is required');
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) return req.reject(400, 'sponsorSessionId is required; no platform pool is configured');
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(sponsorRateLimiter, 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes } = resolveSponsorPolicyForRequest(req);
            const grantId: string | undefined = req.agentGrant?.ID ? String(req.agentGrant.ID) : undefined;
            const caller = String(req.user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorUnboundTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                request: {
                    feeSponsor: effectiveSponsor, caller,
                    bytes: unboundTxB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(unboundTxB64, 'base64')))
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorUnbound', unboundTxB64, sponsorSessionId: effectiveSponsor, allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, grantId }
            });
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on(sponsorSwap, async (req) => {
        const { takerHalfB64, sponsorSessionId, idempotencyKey, offerId } = req.data;
        let makerHalfB64 = req.data.makerHalfB64 as string | undefined;
        if (offerId && makerHalfB64) return req.reject(400, 'makerHalfB64 and offerId: one or the other');
        if (offerId) {
            await expireSwapOffers(db);
            const row = await loadSwapOffer(db, String(offerId));
            if (!row) return req.reject(404, 'swap offer not found');
            if (!isSwapOfferOpen(row)) return req.reject(409, `swap offer is ${row.status === 'open' ? 'expired' : row.status}`);
            makerHalfB64 = row.offer;
        }
        if (!makerHalfB64) return req.reject(400, 'makerHalfB64 is required');
        if (!takerHalfB64) return req.reject(400, 'takerHalfB64 is required');
        // Each half may be an offer file or plain base64. The job always stores base64.
        const halves: Record<'makerHalfB64' | 'takerHalfB64', string> = { makerHalfB64: '', takerHalfB64: '' };
        for (const [name, value] of [['makerHalfB64', makerHalfB64], ['takerHalfB64', takerHalfB64]] as const) {
            try { halves[name] = Buffer.from(await transactionBytesOf(value)).toString('base64'); }
            catch (e) { return req.reject(400, `${name}: ${(e as Error).message}`); }
        }
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        let effectiveSponsor = sponsorSessionId;
        if (!effectiveSponsor || effectiveSponsor === PLATFORM_POOL_SENTINEL) {
            if (pool.length === 0) return req.reject(400, 'sponsorSessionId is required; no platform pool is configured');
            effectiveSponsor = PLATFORM_POOL_SENTINEL;
        }
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(sponsorRateLimiter, 'sponsor', req)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            const policy = resolveSponsorPolicyForRequest(req);
            if (policy.allowSwaps !== true) {
                throw new NightgateError('SPONSOR_POLICY_EMPTY', 'swaps are not sponsored here (NIGHTGATE_SPONSOR_ALLOW_SWAPS or policy file allowSwaps)');
            }
            if (!policy.allowedTokenTypes?.length) {
                throw new NightgateError('SPONSOR_POLICY_EMPTY', 'a swap needs its token types in allowedTokenTypes, and none is sponsored for this caller');
            }
            const grantId: string | undefined = req.agentGrant?.ID ? String(req.agentGrant.ID) : undefined;
            const caller = String(req.user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorSwap', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                request: {
                    feeSponsor: effectiveSponsor, caller,
                    bytes: halves.makerHalfB64.length + halves.takerHalfB64.length,
                    txHash: bytesToHex(sha256(Buffer.concat([Buffer.from(halves.makerHalfB64, 'base64'), Buffer.from(halves.takerHalfB64, 'base64')])))
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorUnbound', swap: { ...halves, ...(offerId ? { offerId: String(offerId) } : {}) }, sponsorSessionId: effectiveSponsor, grantId }
            });
            return { ...job, sessionId: effectiveSponsor };
        });
    });
}
