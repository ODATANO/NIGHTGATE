/**
 * Job executors for sponsored submissions and their attempt bookkeeping.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { resolveFeeSponsor, ensureFeeSponsorFacade, getConfiguredFeeSponsorSessions } from '../fee-sponsor';
import { getNightgatePluginConfig } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { withLockContentionRetry, SponsorAttemptBookkeepingPendingError, type BackgroundJobRow } from '../background-jobs';
import { reportSubmissionRejectedOn, reportBroadcastOn } from '../job-execution-context';
import { PendingSubmissions } from '#cds-models/midnight';
import { walletSponsorFinalizedTx, walletSponsorUnboundTx } from '../../midnight/wallet-worker-client';
import { PLATFORM_POOL_SENTINEL, acquireSponsor, releaseSponsor, benchSponsor, decideSponsorFailure, sponsorCandidatesNonExclusive, touchSponsor } from '../sponsor-pool';
import { recordDeployedContracts, reserveDeployBudget, releaseDeployBudget } from '../../sessions/agent-grants';
import { sponsorAtSyncGate } from '../sponsor-sync-gate';
import { configMs, configNumber } from '../../utils/config';
import type { DbRunner } from '../../utils/db-types';
import { liveSponsorPolicyForJob, facadeConfigFromEnv, runInOneTransaction } from '../actions/common';
import type { SponsorPolicy } from '../sponsor-policy';
import type { SubmissionContext } from '../actions/context';

const { INSERT, UPDATE } = cds.ql;

export function createSponsorExecutors(ctx: Pick<SubmissionContext, 'db'>) {
    const { db } = ctx;

    /**
     * Bookkeeping across broadcast attempts of a sponsoring job: the boundary is
     * crossed once, each attempt gets its own PendingSubmissions row, and a later
     * attempt first closes the previous one (REJECTED or REBUILT).
     */
    const sponsorAttemptLedger = (db: DbRunner, job: BackgroundJobRow, command: any, feeSponsorSessionId: () => string) => {
        let boundaryCrossed = false;
        let currentSubmissionId: string | null = null;
        let currentTxHash: string | null = null;
        // Kept across rebuilds; refunded only when an attempt is provably not on chain.
        let reservedDeploys = 0;
        const failPreviousAttempt = async (why: string, rejectedPreInclusion: boolean) => {
            if (!currentSubmissionId) return;
            // Row close, refund and taking the hash off the job are one transaction;
            // if it still fails, never rebuild on an unclosed attempt.
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
                cds.log('nightgate').error(`sponsor attempt ${rowId} of job ${job.ID} could not be closed as ${rejectedPreInclusion ? 'REJECTED' : 'REBUILT'}${refund > 0 ? ` (deploy reservation of ${refund} NOT refunded)` : ''}; not retrying: ${String((e as Error)?.message ?? e)}`);
                if (rejectedPreInclusion) {
                    // settleRejectedSponsorAttempts re-runs the bookkeeping from this error
                    // code; generic reconciliation cannot, the hash never reached a mempool.
                    throw new SponsorAttemptBookkeepingPendingError(
                        `sponsoring attempt ${rowId} was rejected before inclusion but its bookkeeping (close, refund, hash) could not be committed: ${String((e as Error)?.message ?? e)}. Settled by the reconciler. Original failure: ${why.slice(0, 200)}`,
                        { submissionId: rowId, txHash: rowHash, grantId: refund > 0 ? String(command.grantId) : undefined, refund });
                }
                throw new Error(`sponsoring attempt could not be closed (${String((e as Error)?.message ?? e)}); the job stops here for reconciliation instead of rebuilding on an open attempt. Original failure: ${why.slice(0, 200)}`);
            }
            if (refund > 0) reservedDeploys = 0;
            currentSubmissionId = null; currentTxHash = null;
        };
        // The intent carries what the worker chose (contract, circuits, backing,
        // payer), so a reconciled result can be rebuilt from the attempt row.
        const onSubmitIntent = () => async (txHash: string, intent?: { contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string; segments?: Array<{ segment: number; calls: string[] }> }) => {
            const submissionId = cds.utils.uuid();
            const deployed = (intent?.deployed ?? []).map(String).filter(Boolean);
            const grantId = command?.grantId ? String(command.grantId) : null;
            // A deploy reserves grant budget before the ack lets the worker broadcast
            // (fail-closed), in the same transaction as the attempt row.
            const need = grantId && deployed.length > reservedDeploys ? deployed.length - reservedDeploys : 0;
            const coordinates = {
                feeSponsor: feeSponsorSessionId(), sponsorAccountId: intent?.sponsorAccountId ?? null,
                circuits: intent?.circuits ?? [], contractAddress: intent?.contractAddress ?? null,
                ...(intent?.note ? { note: intent.note } : {}),
                ...(intent?.ttl ? { ttl: intent.ttl } : {}),
                ...(intent?.segments?.length ? { segments: intent.segments } : {}),
                ...(deployed.length ? { deployed } : {}),
                ...(grantId && deployed.length ? { deployReservation: { grantId, count: deployed.length } } : {})
            };
            const row = {
                ID: submissionId, txHash, contractAddress: intent?.contractAddress ?? null, circuitName: intent?.circuits?.[0] ?? null,
                actionType: (deployed.length ? 'DEPLOY' : 'CALL') as 'DEPLOY' | 'CALL', submittedAt: new Date().toISOString(), status: 'pending' as const, sessionId: job.sessionId,
                submitIntentData: JSON.stringify(coordinates)
            };
            // The job transition shares the transaction: after a crash the job is running
            // with nothing reserved, or submitted with hash, row and reservation.
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

    /** Candidate order for a job; an explicit sponsor stays exact (grant pinning is a security boundary). */
    const sponsorCandidates = (command: any, fromPool: (pool: string[]) => string[]): string[] => {
        if (command.sponsorSessionId !== PLATFORM_POOL_SENTINEL) return [String(command.sponsorSessionId)];
        const pool = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
        if (pool.length === 0) throw new Error('platform sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
        return fromPool(pool);
    };

    /** One attempt on one sponsor wallet: resolve it, apply the live policy, hand the tx to the worker. */
    const sponsorAttempt = async <T extends { contractAddress?: string; circuits?: string[] }>(
        sessionId: string,
        command: any,
        job: BackgroundJobRow,
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
        allowedTokenTypes: policy.allowedTokenTypes
    });

    // Bound sponsoring job: no contract call of our own, just deserialize the
    // caller's finalized tx, enforce policy, pay dust, submit.
    const executeSponsorFinalized = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
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
        // One shared deadline: a fully busy pool queues instead of failing at once.
        const deadline = Date.now() + waitMs;
        let lastErr: unknown;
        while (candidates.length > 0) {
            let sessionId: string;
            try {
                sessionId = await acquireSponsor(candidates, Math.max(0, deadline - Date.now()), sponsorAtSyncGate);
            } catch (e) {
                throw lastErr ?? e; // pool stayed busy/cooling until the deadline
            }
            // Same-sponsor rebuilds on a dust race, then the pool decision.
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
                    if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                    return { ...out, feeSponsor: sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    // Ambiguous or on-chain: the job runner reconciles or fails it.
                    if (verdict.decision === 'ambiguous' || verdict.decision === 'landed-not-applied') { releaseSponsor(sessionId); throw e; }
                    // Everything else builds a NEW transaction: close this attempt's row.
                    try {
                        await ledger.failPreviousAttempt(String((e as Error)?.message ?? e), verdict.preInclusion);
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
                        // Rebuilds exhausted: a coded race may clear on the next
                        // wallet, a pool Invalid is the caller's transaction.
                        if (verdict.generic) { releaseSponsor(sessionId); throw e; }
                    } else if (verdict.decision === 'fail') {
                        releaseSponsor(sessionId);
                        cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
                        throw e; // fails identically on every sponsor; do not burn the pool
                    }
                    // Bench on every failover so the next job skips this sponsor too.
                    benchSponsor(sessionId, cooldownMs);
                    cds.log('nightgate').warn(`sponsor ${sessionId.slice(0, 8)} failed over (${String((e as Error).message).slice(0, 120)})`);
                    candidates = candidates.filter(c => c !== sessionId);
                    outcome = 'next';
                }
            }
        }
        throw lastErr ?? new Error('no sponsor candidate available');
    };

    // No exclusive wallet lease: per-note locking in the worker lets many jobs
    // share one wallet; this loop only spreads load and fails over.
    const executeSponsorUnbound = async (command: any, job: BackgroundJobRow): Promise<unknown> => {
        const facadeCfg = facadeConfigFromEnv();
        await ensureNetworkId(facadeCfg.networkId);

        const candidates = sponsorCandidates(command, pool => sponsorCandidatesNonExclusive(pool, Date.now(), sponsorAtSyncGate));
        const cooldownMs = configMs('NIGHTGATE_SPONSOR_COOLDOWN_MS');
        // A dust race is not sponsor health: rebuild on the same sponsor after a
        // backoff (the rebuild succeeds only once the local dust wallet applied the
        // lost spend). Only a non-dust retryable failure benches and fails over.
        const dustRetries = configNumber('NIGHTGATE_SPONSOR_DUST_RETRIES');
        const dustBackoffMs = configMs('NIGHTGATE_SPONSOR_DUST_BACKOFF_MS');
        cds.log('nightgate').info(`sponsorUnboundTransaction job: ${command.unboundTxB64?.length ?? 0} b64 chars, candidates ${candidates.map(c => c.slice(0, 8)).join('>')}`);

        let lastErr: unknown;
        let activeSponsorSessionId = String(command.sponsorSessionId ?? job.sessionId);
        const ledger = sponsorAttemptLedger(db, job, command, () => activeSponsorSessionId);
        const { failPreviousAttempt, onSubmitIntent } = ledger;
        for (const sessionId of candidates) {
            // Touch before the first await: concurrent jobs order candidates in the
            // same tick and would otherwise all pick the same wallet.
            touchSponsor(sessionId);
            for (let attempt = 0; attempt <= dustRetries; attempt++) {
                try {
                    const { sponsorSessionId, out } = await sponsorAttempt(sessionId, command, job, facadeCfg, ledger,
                        id => { activeSponsorSessionId = id; },
                        (accountId, policy) => walletSponsorUnboundTx({
                            sponsorSessionId: accountId,
                            unboundTxB64: command.unboundTxB64,
                            networkId: facadeCfg.networkId,
                            ...policyArgs(policy)
                        }, onSubmitIntent()));
                    if (command.grantId && out.deployed?.length) await recordDeployedContracts(db, command.grantId, out.deployed);
                    return { ...out, feeSponsor: sponsorSessionId };
                } catch (e) {
                    lastErr = e;
                    const verdict = decideSponsorFailure(e);
                    if (verdict.decision === 'ambiguous') {
                        // May still be included: no rebuild (two fees could land);
                        // the indexer confirmer resolves the job by identifier.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: ambiguous submit outcome, leaving the job for reconciliation: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    if (verdict.decision === 'landed-not-applied') {
                        // Landed but not applied: the caller's transcript is stale,
                        // which no sponsor-side rebuild fixes. The job fails terminally.
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)}: sponsored call landed but did not apply (caller transcript stale); not retrying: ${String((e as Error).message).slice(0, 120)}`);
                        throw e;
                    }
                    await failPreviousAttempt(String((e as Error)?.message ?? e), verdict.preInclusion);
                    if (verdict.decision === 'dust-rebuild') {
                        // Generic pool-Invalid: one rebuild only (it may be the caller's tx).
                        const budget = verdict.generic ? Math.min(1, dustRetries) : dustRetries;
                        if (attempt < budget) {
                            cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} hit a dust race (1010/170|171|196 or pool Invalid), rebuild-retry ${attempt + 1}/${budget}: ${String((e as Error).message).slice(-120)}`);
                            await new Promise(resolve => setTimeout(resolve, dustBackoffMs));
                            continue; // rebuild the dust spend fresh on the SAME sponsor
                        }
                        // Exhausted: the caller's transaction is losing, not the sponsor; no bench.
                        throw e;
                    }
                    if (verdict.decision === 'fail') {
                        cds.log('nightgate').warn(`unbound sponsor ${sessionId.slice(0, 8)} failed, not retrying: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
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
