/**
 * Job executors that pay the fees of a caller's transaction and submit it.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { resolveFeeSponsor, ensureFeeSponsorFacade, getConfiguredFeeSponsorSessions } from '../fee-sponsor';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { SponsorAttemptBookkeepingPendingError } from '../background-jobs';
import { reportSubmissionRejectedOn, reportBroadcastOn } from '../job-execution-context';
import { PendingSubmissions, type BackgroundJob } from '#cds-models/midnight';
import { walletSponsorFinalizedTx, walletSponsorUnboundTx } from '../../midnight/wallet-worker-client';
import { PLATFORM_POOL_SENTINEL, acquireSponsor, releaseSponsor, benchSponsor, decideSponsorFailure, sponsorCandidatesNonExclusive, touchSponsor } from '../sponsor-pool';
import { recordDeployedContracts, reserveDeployBudget, releaseDeployBudget } from '../../sessions/agent-grants';
import { recordPlatformMint } from '../platform-mints';
import { closeSwapOffer, closeSwapOffersByNullifiers } from '../swap-offers';
import { sponsorAtSyncGate } from '../sponsor-sync-gate';
import { configMs, configNumber } from '../../utils/config';
import type { DbRunner } from '../../utils/db-types';
import { liveSponsorPolicyForJob, facadeConfigFromEnv, runInOneTransaction } from '../actions/common';
import type { SponsorPolicy } from '../sponsor-policy';
import type { SubmissionContext } from '../actions/context';
import type { SubmitIntentCoordinates } from '../submit-intent';
import { errorMessage } from '../../utils/errors';
import { withLockContentionRetry } from '../db-write-retry';

const { INSERT, UPDATE } = cds.ql;

export function createSponsorExecutors(ctx: Pick<SubmissionContext, 'db'>) {
    const { db } = ctx;

    /**
     * Tracks the broadcast attempts of one sponsoring job.
     * Each attempt gets its own PendingSubmissions row. A new attempt first closes
     * the previous row as REJECTED or REBUILT.
     */
    const sponsorAttemptLedger = (db: DbRunner, job: BackgroundJob, command: any, feeSponsorSessionId: () => string) => {
        let boundaryCrossed = false;
        let currentSubmissionId: string | null = null;
        let currentTxHash: string | null = null;
        // Survives rebuilds. Refunded only when the attempt is known not to be on chain.
        let reservedDeploys = 0;
        const failPreviousAttempt = async (why: string, rejectedPreInclusion: boolean) => {
            if (!currentSubmissionId) return;
            // Closing the row, the refund and removing the hash from the job are one transaction.
            // If that fails, the job stops rather than rebuilding while the old attempt is open.
            const refund = rejectedPreInclusion && reservedDeploys > 0 && command?.grantId ? reservedDeploys : 0;
            const rowId = currentSubmissionId;
            const rowHash = currentTxHash ?? undefined;
            try {
                await withLockContentionRetry(`failSponsorAttempt(${job.ID})`, () => runInOneTransaction(db, async (tx) => {
                    await tx.run(UPDATE.entity(PendingSubmissions).set({ status: 'failed', errorCode: rejectedPreInclusion ? 'REJECTED' : 'REBUILT', errorMessage: why.slice(0, 500) }).where({ ID: rowId }));
                    if (refund > 0) await releaseDeployBudget(tx, String(command.grantId), refund);
                    if (rejectedPreInclusion) await reportSubmissionRejectedOn(tx, { submissionId: rowId, txHash: rowHash });
                }));
            } catch (e) {
                cds.log('nightgate').error(`sponsor attempt ${rowId} of job ${job.ID} could not be closed as ${rejectedPreInclusion ? 'REJECTED' : 'REBUILT'}${refund > 0 ? ` (deploy reservation of ${refund} NOT refunded)` : ''}; not retrying: ${errorMessage(e)}`);
                if (rejectedPreInclusion) {
                    // settleRejectedSponsorAttempts finishes the cleanup later, based on this error.
                    // The normal reconciliation cannot, because the hash never reached a mempool.
                    throw new SponsorAttemptBookkeepingPendingError(
                        `sponsoring attempt ${rowId} was rejected before inclusion but its bookkeeping (close, refund, hash) could not be committed: ${errorMessage(e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                        { submissionId: rowId, txHash: rowHash, grantId: refund > 0 ? String(command.grantId) : undefined, refund });
                }
                throw new Error(`sponsoring attempt could not be closed (${errorMessage(e)}); the job stops here for reconciliation instead of rebuilding on an open attempt. Original failure: ${why.slice(0, 200)}`);
            }
            if (refund > 0) reservedDeploys = 0;
            currentSubmissionId = null; currentTxHash = null;
        };
        // Called just before the worker broadcasts. It stores what the worker chose,
        // so the result can be reconstructed from the attempt row after a crash.
        const onSubmitIntent = () => async (txHash: string, intent?: { contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string; segments?: Array<{ segment: number; calls: string[] }>; minted?: string[]; nullifiers?: string[] }) => {
            const submissionId = cds.utils.uuid();
            const deployed = (intent?.deployed ?? []).map(String).filter(Boolean);
            const grantId = command?.grantId ? String(command.grantId) : null;
            // A deploy reserves the grant's deploy budget before the worker may broadcast.
            // The reservation is written in the same transaction as the attempt row.
            const need = grantId && deployed.length > reservedDeploys ? deployed.length - reservedDeploys : 0;
            const coordinates = {
                feeSponsor: feeSponsorSessionId(), sponsorAccountId: intent?.sponsorAccountId ?? null,
                circuits: intent?.circuits ?? [], contractAddress: intent?.contractAddress ?? null,
                ...(intent?.note ? { note: intent.note } : {}),
                ...(intent?.ttl ? { ttl: intent.ttl } : {}),
                ...(intent?.segments?.length ? { segments: intent.segments } : {}),
                ...(deployed.length ? { deployed } : {}),
                ...(intent?.minted?.length ? { minted: intent.minted } : {}),
                ...(intent?.nullifiers?.length ? { nullifiers: intent.nullifiers } : {}),
                ...(command?.swap?.offerId ? { offerId: String(command.swap.offerId) } : {}),
                ...(grantId && deployed.length ? { deployReservation: { grantId, count: deployed.length } } : {})
            } satisfies SubmitIntentCoordinates;
            const row = {
                ID: submissionId, txHash, contractAddress: intent?.contractAddress ?? null, circuitName: intent?.circuits?.[0] ?? null,
                actionType: (deployed.length ? 'DEPLOY' : 'CALL') as 'DEPLOY' | 'CALL', submittedAt: new Date().toISOString(), status: 'pending' as const, sessionId: job.sessionId,
                submitIntentData: JSON.stringify(coordinates)
            };
            // The job's status change is in the same transaction. After a crash the job is
            // either still running with nothing reserved, or submitted with all of it saved.
            let budgetExhausted: Error | null = null;
            await withLockContentionRetry(`sponsorAttempt(${job.ID})`, () => runInOneTransaction(db, async (tx) => {
                await tx.run(INSERT.into(PendingSubmissions).entries(row));
                if (need > 0) {
                    const ok = await reserveDeployBudget(tx, grantId!, need);
                    if (!ok) {
                        budgetExhausted = new Error(`deploy budget of the grant is exhausted or the grant no longer allows deploys (${deployed.length} deploy(s) in this transaction); not broadcasting`);
                        throw budgetExhausted;
                    }
                }
                await reportBroadcastOn(tx, { submissionId, txHash, firstBoundary: !boundaryCrossed });
            })).catch((e) => { throw budgetExhausted ?? e; });
            boundaryCrossed = true;
            if (grantId && deployed.length) reservedDeploys = deployed.length;
            currentSubmissionId = submissionId; currentTxHash = txHash;
        };
        const markIncluded = async (out: { contractAddress?: string; circuits?: string[] }) => {
            if (!currentSubmissionId) return;
            try { await db.run(UPDATE.entity(PendingSubmissions).set({ status: 'included', contractAddress: out.contractAddress ?? null, circuitName: out.circuits?.[0] ?? null }).where({ ID: currentSubmissionId })); } catch { /* best effort */ }
        };
        return { failPreviousAttempt, onSubmitIntent, markIncluded };
    };

    /** Sponsor wallets to try, in order. A named sponsor is never swapped for another, since grants pin it. */
    const sponsorCandidates = (command: any, fromPool: (pool: string[]) => string[]): string[] => {
        if (command.sponsorSessionId !== PLATFORM_POOL_SENTINEL) return [String(command.sponsorSessionId)];
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
        return fromPool(pool);
    };

    const sponsorAttempt = async <T extends { contractAddress?: string; circuits?: string[] }>(
        sessionId: string,
        command: any,
        job: BackgroundJob,
        facadeCfg: ReturnType<typeof facadeConfigFromEnv>,
        ledger: ReturnType<typeof sponsorAttemptLedger>,
        setActive: (sponsorSessionId: string) => void,
        send: (sponsorAccountId: string, policy: SponsorPolicy) => Promise<T>
    ): Promise<{ sponsorSessionId: string; out: T }> => {
        const sponsor = await resolveFeeSponsor({ db, sponsorSessionId: sessionId, requestingUserId: job.requestedBy ?? undefined, config: getNightgatePluginConfig() });
        await ensureFeeSponsorFacade(sponsor, facadeCfg);
        setActive(sponsor.sponsorSessionId);
        const policy = await liveSponsorPolicyForJob(db, command);
        const out = await send(sponsor.accountId, policy);
        await ledger.markIncluded(out);
        return { sponsorSessionId: sponsor.sponsorSessionId, out };
    };

    const policyArgs = (policy: SponsorPolicy) => ({
        allowedContracts: policy.allowedContracts,
        allowedCircuits: policy.allowedCircuits,
        allowDeploy: policy.allowDeploy === true,
        ownContracts: policy.ownContracts,
        allowedTokenTypes: policy.allowedTokenTypes,
        allowContractMints: policy.allowContractMints === true
    });

    /** Records what a landed job produced: minted token types, closed offers and deployed contracts. */
    const recordOnGrant = async (command: any, out: { deployed?: string[]; minted?: string[]; txHash?: string; nullifiers?: string[] }): Promise<void> => {
        if (out.minted?.length) await recordPlatformMint(db, out.minted, { grantId: command.grantId ?? null, sponsorSessionId: command.sponsorSessionId ?? null, txHash: out.txHash ?? null });
        if (command.swap) await closeSwapOffersOf(command, out.nullifiers ?? [], out.txHash ?? null);
        if (!command.grantId) return;
        if (out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
    };

    /** A landed swap closes the offer it filled and every other open half that shared an input. */
    const closeSwapOffersOf = async (command: any, nullifiers: string[], txHash: string | null): Promise<void> => {
        // The swap is already on chain, so a failed write here must not fail the job.
        try {
            if (command?.swap?.offerId) await closeSwapOffer(db, String(command.swap.offerId), 'filled', txHash);
            if (nullifiers.length) await closeSwapOffersByNullifiers(db, nullifiers, txHash);
        } catch (e) {
            cds.log('nightgate').warn(`swap offers of ${txHash ?? 'the landed swap'} not closed: ${errorMessage(e)}`);
        }
    };

    // Sponsors a transaction the caller already finalized and bound.
    const executeSponsorFinalized = async (command: any, job: BackgroundJob): Promise<unknown> => {
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        let candidates = sponsorCandidates(command, pool => [...pool]);
        cds.log('nightgate').info(`sponsorFinalizedTransaction job: ${command.finalizedTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        const waitMs = configMs('NIGHTGATE_SPONSOR_LEASE_WAIT_MS');
        const cooldownMs = configMs('NIGHTGATE_SPONSOR_COOLDOWN_MS');
        const dustRetries = configNumber('NIGHTGATE_SPONSOR_DUST_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS');
        // One deadline for all waits, so a busy pool makes the job wait instead of failing.
        const deadline = Date.now() + waitMs;
        let lastErr: unknown;
        while (candidates.length > 0) {
            let sessionId: string;
            try {
                sessionId = await acquireSponsor(candidates, Math.max(0, deadline - Date.now()), sponsorAtSyncGate);
            } catch (e) {
                throw lastErr ?? e; // no sponsor became free before the deadline
            }
            let outcome: 'next' | undefined;
            for (let attempt = 0; attempt <= dustRetries && outcome === undefined; attempt++) {
                try {
                    const { sponsorSessionId, out } = await sponsorAttempt(sessionId, command, job, facadeCfg, ledger,
                        id => { activeSponsorSessionId = id; },
                        (accountId, policy) => walletSponsorFinalizedTx({
                            sponsorSessionId: accountId,
                            finalizedTxB64: command.finalizedTxB64,
                            networkId: facadeCfg.networkId,
                            ...policyArgs(policy)
                        }, ledger.onSubmitIntent()));
                    releaseSponsor(sessionId);
                    await recordOnGrant(command, out);
                    return { ...out, feeSponsor: sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    // The tx may be on chain. The job runner checks the chain and settles the job.
                    if (verdict.decision === 'ambiguous' || verdict.decision === 'landed-not-applied') { releaseSponsor(sessionId); throw e; }
                    // Every other case builds a new transaction, so close this attempt's row.
                    try {
                        await ledger.failPreviousAttempt(errorMessage(e), verdict.preInclusion);
                    } catch (closeErr) {
                        releaseSponsor(sessionId);
                        throw closeErr;
                    }
                    if (verdict.decision === 'dust-rebuild') {
                        const budget = verdict.generic ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} hit a dust race, rebuild-retry ${attempt + 1}/${budget} on the same sponsor: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue;
                        }
                        // No rebuilds left. A known dust race may pass with another wallet.
                        // A generic pool rejection points at the caller's transaction.
                        if (verdict.generic) { releaseSponsor(sessionId); throw e; }
                    } else if (verdict.decision === 'fail') {
                        releaseSponsor(sessionId);
                        cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${errorMessage(e).slice(0, 200)}`);
                        throw e; // would fail the same way with every sponsor
                    }
                    // Pause this sponsor so the next job skips it too.
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed over (${String((e as Error).message).slice(0, 120)})`);
                    candidates = candidates.filter(c => c !== sessionId);
                    outcome = 'next';
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };

    // Sponsors a caller's transaction that is not yet bound.
    // Many jobs can share one wallet, because the worker locks single dust notes.
    // This loop only spreads the load and moves to the next wallet on failure.
    const executeSponsorUnbound = async (command: any, job: BackgroundJob): Promise<unknown> => {
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        const candidates = sponsorCandidates(command, pool => sponsorCandidatesNonExclusive(pool, Date.now(), sponsorAtSyncGate));
        const cooldownMs = configMs('NIGHTGATE_SPONSOR_COOLDOWN_MS');
        // A dust race says nothing about the sponsor's health. Wait, then rebuild with
        // the same sponsor once its dust wallet has caught up. Only other retryable
        // failures pause the sponsor and move on.
        const dustRetries = configNumber('NIGHTGATE_SPONSOR_DUST_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS');
        const size = command.swap ? (command.swap.makerHalfB64?.length ?? 0) + (command.swap.takerHalfB64?.length ?? 0) : command.unboundTxB64?.length ?? 0;
        cds.log('nightgate').info(`${job.kind} job: ${size} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        let lastErr: unknown;
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const { failPreviousAttempt, onSubmitIntent } = ledger;
        for (const sessionId of candidates) {
            // Mark the wallet as used before the first await. Otherwise jobs started at
            // the same moment would all pick the same wallet.
            touchSponsor(sessionId);
            for (let attempt = 0; attempt <= dustRetries; attempt++) {
                try {
                    const { sponsorSessionId, out } = await sponsorAttempt(sessionId, command, job, facadeCfg, ledger,
                        id => { activeSponsorSessionId = id; },
                        (accountId, policy) => walletSponsorUnboundTx({
                            sponsorSessionId: accountId,
                            ...(command.swap
                                ? { swap: command.swap, allowSwaps: policy.allowSwaps === true }
                                : { unboundTxB64: command.unboundTxB64 }),
                            networkId: facadeCfg.networkId,
                            ...policyArgs(policy)
                        }, onSubmitIntent()));
                    await recordOnGrant(command, out);
                    return { ...out, feeSponsor: sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    if (verdict.decision === 'ambiguous') {
                        // The tx may still land, so a rebuild could pay twice.
                        // The chain confirmer settles the job later.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: ambiguous submit outcome, leaving the job for reconciliation: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    if (verdict.decision === 'landed-not-applied') {
                        // The tx landed but its contract call failed on outdated state.
                        // Only the caller can fix that, so the job fails.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: sponsored call landed but did not apply (caller transcript stale); not retrying: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    await failPreviousAttempt(errorMessage(e), verdict.preInclusion);
                    if (verdict.decision === 'dust-rebuild') {
                        // A generic pool rejection gets one rebuild only, since the caller's tx may be the cause.
                        const budget = verdict.generic ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} hit a dust race (1010/170|171|196 or pool Invalid), rebuild-retry ${attempt + 1}/${budget}: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue; // rebuild the dust payment with the same sponsor
                        }
                        // No rebuilds left. The problem is the caller's tx, so the sponsor is not paused.
                        throw e;
                    }
                    if (verdict.decision === 'fail') {
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${errorMessage(e).slice(0, 200)}`);
                        throw e;
                    }
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed over (${String((e as Error).message).slice(0, 120)})`);
                    break; // fail over to the next candidate
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };
    return { executeSponsorFinalized, executeSponsorUnbound };
}
