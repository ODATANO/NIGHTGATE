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
import { facadeConfigFromEnv, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import { NightgateError, isNightgateError } from '../../utils/errors';
import { walletDescribeSwapHalf, walletDescribeTransaction, walletDescribeTransfer } from '../../midnight/wallet-worker-client';
import { transactionBytesOf } from '../../utils/offer-file';
import { expireSwapOffers, isSwapOfferOpen, loadSwapOffer, takerSecretMatches } from '../swap-offers';
import { consumeValueBudget } from '../../sessions/agent-grants';
import { HEX64_RE } from '../../utils/hex';
import type { SubmissionContext } from './context';
import type { Request } from '@sap/cds';
import { sponsorFinalizedTransaction, sponsorSwap, sponsorTransfer, sponsorUnboundTransaction } from '#cds-models/NightgateService';

/** True when the worker refused the bytes themselves, not the call. */
function isRefusal(e: unknown): boolean {
    return (isNightgateError(e) && e.code === 'SPONSOR_REFUSED')
        || /not a proven transaction|not a swap half|not a transfer|is empty/.test((e as Error)?.message ?? String(e));
}

/** The policy fields a sponsor job carries to the worker. */
function policyFieldsFor(req: Request) {
    const { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, allowUnshieldedOffers, allowedUnshieldedTokenTypes } = resolveSponsorPolicyForRequest(req);
    return { allowedContracts, allowedCircuits, allowDeploy, ownContracts, allowedTokenTypes, allowUnshieldedOffers, allowedUnshieldedTokenTypes };
}

/** A grant's value budget takes the amount the caller moves out. Returns false after rejecting. */
async function takeValueBudget(req: Request, db: SubmissionContext['db'], tokenType: string, amount: string): Promise<boolean> {
    const grantId = req.agentGrant?.ID;
    if (!grantId) return true;
    let atoms: bigint;
    try { atoms = BigInt(amount); } catch { return true; }
    return consumeValueBudget(db, req, String(grantId), tokenType, atoms);
}

/**
 * Deserializes the caller's bytes before a job exists: junk answers 400 here and never
 * takes a heavy slot or a budget unit. Returns false after rejecting.
 */
async function rejectUnlessProven(req: Request, describe: () => Promise<unknown>): Promise<boolean> {
    try { await describe(); return true; }
    catch (e) {
        if (isRefusal(e)) { req.reject(400, (e as Error).message); return false; }
        req.reject(503, `could not check the transaction (${(e as Error)?.message ?? String(e)})`);
        return false;
    }
}

/** The platform pool pays, or the wallet session a grant is pinned to. Returns undefined when nothing can pay, after rejecting the request. */
function sponsorSessionFor(req: Request): string | undefined {
    const pinned = req.agentGrant?.sponsorSessionId;
    if (pinned && pinned !== PLATFORM_POOL_SENTINEL) return String(pinned);
    if (getConfiguredFeeSponsorSessions(getNightgatePluginConfig()).length === 0) {
        req.reject(503, 'no fee sponsor is configured on this server (NIGHTGATE_FEE_SPONSOR_SESSION)');
        return undefined;
    }
    return PLATFORM_POOL_SENTINEL;
}

export function registerSponsoringActions(ctx: Pick<SubmissionContext, 'srv' | 'db'>): void {
    const { srv, db } = ctx;

    srv.on(sponsorFinalizedTransaction, async (req) => {
        const { finalizedTxB64, idempotencyKey } = req.data;
        if (!finalizedTxB64) return req.reject(400, 'finalizedTxB64 is required');
        // A pool job picks its wallet when it runs, so another wallet can take over if one fails.
        const effectiveSponsor = sponsorSessionFor(req);
        if (!effectiveSponsor) return;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('sponsor', 'sponsor', req)) return;
        if (!await rejectUnlessProven(req, () => walletDescribeTransaction({ txB64: finalizedTxB64 }))) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            // A pinned sponsor is checked here only against its database row.
            // Loading its wallet is slow and happens when the job runs.
            // Pool jobs skip this check, so one broken pool wallet cannot block new requests.
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            // The server policy, narrowed by the agent grant. Refuses here, before a job exists.
            const policy = policyFieldsFor(req);
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
                command: { op: 'sponsorFinalized', finalizedTxB64, sponsorSessionId: effectiveSponsor, ...policy, grantId }
            });
            // The job belongs to the sponsor session. The caller needs it to poll the job.
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on(sponsorUnboundTransaction, async (req) => {
        const { unboundTxB64, idempotencyKey } = req.data;
        if (!unboundTxB64) return req.reject(400, 'unboundTxB64 is required');
        const effectiveSponsor = sponsorSessionFor(req);
        if (!effectiveSponsor) return;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('sponsor', 'sponsor', req)) return;
        if (!await rejectUnlessProven(req, () => walletDescribeTransaction({ txB64: unboundTxB64 }))) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            const policy = policyFieldsFor(req);
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
                command: { op: 'sponsorUnbound', unboundTxB64, sponsorSessionId: effectiveSponsor, ...policy, grantId }
            });
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on(sponsorTransfer, async (req) => {
        const { transferTxB64, idempotencyKey } = req.data;
        if (!transferTxB64) return req.reject(400, 'transferTxB64 is required');
        const tokenType = String(req.data.tokenType ?? '').trim().toLowerCase();
        if (!HEX64_RE.test(tokenType)) return req.reject(400, 'tokenType must be 64 hex characters (a raw token type)');
        const amount = String(req.data.amount ?? '').trim();
        if (!/^[1-9]\d*$/.test(amount)) return req.reject(400, 'amount must be a positive integer in atoms');
        let txB64: string;
        try { txB64 = Buffer.from(await transactionBytesOf(transferTxB64)).toString('base64'); }
        catch (e) { return req.reject(400, `transferTxB64: ${(e as Error).message}`); }
        const effectiveSponsor = sponsorSessionFor(req);
        if (!effectiveSponsor) return;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('sponsor', 'sponsor', req)) return;
        if (!await rejectUnlessProven(req, () => walletDescribeTransfer({ txB64 }))) return;
        if (!await takeValueBudget(req, db, tokenType, amount)) return;

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            if (effectiveSponsor !== PLATFORM_POOL_SENTINEL) {
                await resolveFeeSponsor({ db, sponsorSessionId: effectiveSponsor, requestingUserId: req.user?.id, config: getNightgatePluginConfig() });
            }
            const policy = resolveSponsorPolicyForRequest(req);
            if (policy.allowTransfers !== true) {
                throw new NightgateError('SPONSOR_POLICY_EMPTY', 'transfers are not sponsored here (NIGHTGATE_SPONSOR_ALLOW_TRANSFERS or policy file allowTransfers, and sponsorTransfer in the grant)');
            }
            if (!policy.allowedTokenTypes?.includes(tokenType)) {
                throw new NightgateError('SPONSOR_POLICY_EMPTY', `token type ${tokenType.slice(0, 16)}… is not in allowedTokenTypes for this caller`);
            }
            const grantId: string | undefined = req.agentGrant?.ID ? String(req.agentGrant.ID) : undefined;
            const caller = String(req.user?.id ?? 'anonymous');
            const scopedIdempotencyKey = idempotencyKey
                ? bytesToHex(sha256(Buffer.from(`${caller}\u0000${idempotencyKey}`, 'utf8')))
                : undefined;
            const job = await startJob({
                kind: 'sponsorTransfer', sessionId: effectiveSponsor, idempotencyKey: scopedIdempotencyKey,
                request: {
                    feeSponsor: effectiveSponsor, caller, tokenType, amount,
                    bytes: txB64.length,
                    txHash: bytesToHex(sha256(Buffer.from(txB64, 'base64')))
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID, commandVersion: 1, encryptCommand: true,
                command: { op: 'sponsorUnbound', transfer: { txB64, tokenType, amount }, sponsorSessionId: effectiveSponsor, allowedTokenTypes: policy.allowedTokenTypes, grantId }
            });
            return { ...job, sessionId: effectiveSponsor };
        });
    });

    srv.on(sponsorSwap, async (req) => {
        const { takerHalfB64, idempotencyKey, offerId, takerSecret } = req.data;
        let makerHalfB64 = req.data.makerHalfB64 as string | undefined;
        if (offerId && makerHalfB64) return req.reject(400, 'makerHalfB64 and offerId: one or the other');
        // The value the caller moves out: what the maker wants, since the caller takes the offer.
        let callerGives: { tokenType: string; amount: string } | undefined;
        if (offerId) {
            await expireSwapOffers(db);
            const row = await loadSwapOffer(db, String(offerId));
            if (!row) return req.reject(404, 'swap offer not found');
            if (!isSwapOfferOpen(row)) return req.reject(409, `swap offer is ${row.status === 'open' ? 'expired' : row.status}`);
            if (row.takerSecretHash && !takerSecretMatches(row, takerSecret)) {
                return req.reject(403, 'this offer is directed: sponsoring it needs the taker secret its poster handed out');
            }
            makerHalfB64 = row.offer;
            callerGives = { tokenType: row.wantsType, amount: row.wantsAmount };
        }
        if (!makerHalfB64) return req.reject(400, 'makerHalfB64 is required');
        if (!takerHalfB64) return req.reject(400, 'takerHalfB64 is required');
        // Each half may be an offer file or plain base64. The job always stores base64.
        const halves: Record<'makerHalfB64' | 'takerHalfB64', string> = { makerHalfB64: '', takerHalfB64: '' };
        for (const [name, value] of [['makerHalfB64', makerHalfB64], ['takerHalfB64', takerHalfB64]] as const) {
            try { halves[name] = Buffer.from(await transactionBytesOf(value)).toString('base64'); }
            catch (e) { return req.reject(400, `${name}: ${(e as Error).message}`); }
        }
        const effectiveSponsor = sponsorSessionFor(req);
        if (!effectiveSponsor) return;
        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate('sponsor', 'sponsor', req)) return;
        for (const name of offerId ? ['takerHalfB64' as const] : ['makerHalfB64' as const, 'takerHalfB64' as const]) {
            let half: Awaited<ReturnType<typeof walletDescribeSwapHalf>> | undefined;
            if (!await rejectUnlessProven(req, async () => { half = await walletDescribeSwapHalf({ halfB64: halves[name] }); })) return;
            if (name === 'takerHalfB64' && half && !callerGives) callerGives = half.gives;
        }
        if (callerGives && !await takeValueBudget(req, db, callerGives.tokenType, callerGives.amount)) return;

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
