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
import type { NightgateRequest } from '../../utils/request-types';
import { sponsorRateLimiter, facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';

export function registerSponsoringActions(ctx: Pick<SubmissionContext, 'srv' | 'db'>): void {
    const { srv, db } = ctx;

    // Sponsoring phase 2: policy check, dust from the sponsor, submit.
    srv.on('sponsorFinalizedTransaction', async (req: NightgateRequest) => {
        const { finalizedTxB64, sponsorSessionId, idempotencyKey } = req.data as {
            finalizedTxB64?: string; sponsorSessionId?: string; idempotencyKey?: string;
        };
        if (!finalizedTxB64) return req.reject(400, 'finalizedTxB64 is required');
        // The pool sentinel defers the concrete sponsor to execution (failover).
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
            // Explicit sponsor: row-level check only (the slow facade restore is the
            // executor's). Pool jobs check nothing and key under the sentinel, so a
            // broken member cannot block admission and the idempotency key is stable.
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            // Floor narrowed by the grant; an empty intersection or unusable policy
            // file refuses before a job exists.
            const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes } = resolveSponsorPolicyForRequest(req);
            // A sponsored deploy's address is recorded onto this grant.
            const grantId: string | undefined = req.agentGrant?.ID ? String(req.agentGrant.ID) : undefined;
            // Per-caller key: sponsors are shared, so a raw key would let one
            // caller's key dedupe or block another's.
            const caller = String(req.user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorFinalizedTransaction', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                // Fingerprint the content: equal-size txs under one key must not dedupe.
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
            // Keyed by the sponsor session, which the caller needs to poll.
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    // As sponsorFinalizedTransaction, for an unbound caller tx.
    srv.on('sponsorUnboundTransaction', async (req: NightgateRequest) => {
        const { unboundTxB64, sponsorSessionId, idempotencyKey } = req.data as {
            unboundTxB64?: string; sponsorSessionId?: string; idempotencyKey?: string;
        };
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
}
