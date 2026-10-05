/**
 * Settles jobs whose outcome is open: after a restart, after a send whose result was lost,
 * and by checking sent transactions against the chain indexer.
 * SPDX-License-Identifier: Apache-2.0
 */
import { REJECTED_ATTEMPT_BOOKKEEPING_PENDING } from './job-execution-context';
import cds from '@sap/cds';
import { BackgroundJobs, PendingSubmissions, type PendingSubmission, type BackgroundJob } from '#cds-models/midnight';
import { parseSubmitIntent } from './submit-intent';
import { isChainOutcome, isChainAbsent, type ChainOutcome, type ChainLookup } from './chain-outcome-confirmer';
import { configMs } from '../utils/config';
import { carriedSubmitFailure } from '../midnight/wallet-worker-protocol';
import { readReorgGeneration, lockReorgGeneration } from './reorg-generation';
import type { DbRunner, DbService } from '../utils/db-types';
import { kindsWithTrait, jobKindTraits, runReconciliationFinalizer } from './job-registry';
import { affectedRows, safeStringify, ReconciliationEvidence, getRuntimeWorkerId, markReconciliationRequired } from './job-store';
import { errorMessage } from '../utils/errors';
import { withLockContentionRetry, LOCK_CONTENTION_ATTEMPTS } from './db-write-retry';

const { SELECT, UPDATE } = cds.ql;

/** Sorts out jobs left by a restart without risking that a transaction is sent twice. */
export async function recoverInterruptedJobs(): Promise<number> {
    const db = await cds.connect.to('db');
    const stuck = await db.run(
        SELECT.from(BackgroundJobs)
            .columns('ID', 'status', 'commandVersion')
            .where({ status: { in: ['pending', 'running', 'external_execution', 'submitted'] } })
    );
    const count = Array.isArray(stuck) ? stuck.length : 0;
    if (count === 0) return 0;
    await withLockContentionRetry('recoverInterruptedJobs', async () => {
        // Must run before the re-queue below. A session-bound job only filled in-process
        // state, which died with the process.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_SESSION_JOB_DROPPED',
                    errorMessage: 'Dropped on restart: this job only warms in-process session state, and the caller that requested it did not survive the restart. Call the action again if a warm session is still wanted.',
                    finishedAt: new Date().toISOString(),
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: { in: ['pending', 'running'] }, kind: { in: kindsWithTrait('sessionBound') } })
        );
        // A `running` job has not sent anything yet, so it can run again.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'pending',
                    errorCode: null,
                    errorMessage: null,
                    startedAt: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: 'running', commandVersion: { '!=': null } })
        );
        // Jobs without a stored command cannot be rebuilt.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_BEFORE_EXECUTION',
                    errorMessage: 'The process restarted before the job crossed the external-effect boundary. A new idempotency key may be used for an intentional retry.',
                    finishedAt: new Date().toISOString()
                })
                .where({ status: { in: ['pending', 'running'] }, commandVersion: null })
        );
        // Every send path stores the hash before sending. So no hash means
        // nothing was sent and nothing is on chain.
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'failed',
                    errorCode: 'PROCESS_RESTART_BEFORE_BROADCAST',
                    errorMessage: 'The process restarted before this job announced a transaction for broadcast (or after its last attempt was rejected); nothing of it is on chain. A new idempotency key may be used for an intentional retry.',
                    finishedAt: new Date().toISOString(),
                    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
                })
                .where({ status: 'external_execution', txHash: null })
        );
        await db.run(
            UPDATE.entity(BackgroundJobs)
                .set({
                    status: 'reconciliation_required',
                    errorCode: 'PROCESS_RESTART_RECONCILE',
                    errorMessage: 'Execution was interrupted after an external effect may have occurred. Verify submission/chain state before retrying.',
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null
                })
                .where({ status: { in: ['external_execution', 'submitted'] } })
        );
    });
    return count;
}

export const SCAN_PAGE_SIZE = 100;

let reconciliationCursor: string | undefined;

let parentPendingCursor: string | undefined;

let parentLegacyCursor: string | undefined;

let confirmerPendingCursor: string | undefined;

let confirmerLegacyCursor: string | undefined;

type ChainOutcomeConfirmer = (txHash: string) => Promise<ChainLookup>;

function chainEvidencePatch(outcome: ChainOutcome): Record<string, unknown> {
    return {
        chainBlockHeight: Number.isInteger(outcome.blockHeight) ? outcome.blockHeight : null,
        chainBlockHash: outcome.blockHash ?? null,
        indexerTxHash: outcome.indexerTxHash ?? null
    };
}

/**
 * Which calls of a batch applied on chain. Combines the call names stored per transaction part
 * before sending with the parts the indexer reports as failed. Null when nothing was stored.
 */
export function chainSegmentsOf(submitIntentData: string | null | undefined, outcome: ChainOutcome): string | null {
    const segments = parseSubmitIntent(submitIntentData).segments;
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const failed = new Set(outcome.failedSegments ?? []);
    // FAILURE means the guaranteed part failed and nothing applied. SUCCESS means everything applied.
    const applied = (segment: number): boolean =>
        outcome.result === 'SUCCESS' || (outcome.result === undefined && outcome.status === 'success')
            ? true
            : outcome.result === 'PARTIAL_SUCCESS' ? !failed.has(segment) : false;
    return JSON.stringify(segments
        .filter(s => Number.isInteger(s?.segment) && Array.isArray(s?.calls))
        .map(s => ({ segment: s.segment, calls: s.calls.map(String), applied: applied(s.segment) })));
}

let chainOutcomeConfirmer: ChainOutcomeConfirmer | null = null;

let confirmerReconcileCursor: string | undefined;

let chainConfirmActive = false;

const CHAIN_CONFIRM_CONCURRENCY = 8;

/** Error code of a parked job whose sent transaction is neither found on chain nor known to be missing. */
export const BROADCAST_UNCONFIRMED = 'BROADCAST_UNCONFIRMED';

/** Final error code once the indexer is past the transaction's ttl and still does not know it. */
export const BROADCAST_NOT_INCLUDED = 'BROADCAST_NOT_INCLUDED';

/** For rows without a stored ttl. The longest ttl any send path sets. */
const LEGACY_BROADCAST_TTL_MS = 60 * 60 * 1000;

/**
 * Fails a parked job as never included once the indexer that reported it missing is past its ttl
 * plus a margin. Only that indexer's tip counts. A lagging replica must not turn a landed
 * transaction into a lost one, or the caller would pay twice.
 */
async function finalizeLostBroadcast(db: DbService, job: BackgroundJob, tipMs: number | null, generation: number): Promise<number> {
    if (tipMs === null || job.errorCode === REJECTED_ATTEMPT_BOOKKEEPING_PENDING || jobKindTraits(job.kind).workflowParent) return 0;
    const submission: PendingSubmission | undefined = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    const coordinates = parseSubmitIntent(submission?.submitIntentData);
    const reservation = coordinates.deployReservation ?? null;
    const recorded = typeof coordinates.ttl === 'string' ? Date.parse(coordinates.ttl) : NaN;
    const submittedAt = Date.parse(String(submission?.submittedAt ?? job.submittedAt ?? ''));
    const ttlMs = Number.isFinite(recorded) ? recorded : Number.isFinite(submittedAt) ? submittedAt + LEGACY_BROADCAST_TTL_MS : NaN;
    if (!Number.isFinite(ttlMs)) return 0;
    const margin = configMs('NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS');
    if (tipMs <= ttlMs + margin) return 0;
    const now = new Date().toISOString();
    const ttlIso = new Date(ttlMs).toISOString();
    const message = `Transaction ${job.txHash} was broadcast but never included: the indexer tip (${new Date(tipMs).toISOString()}) is past its validity window (ttl ${ttlIso}${Number.isFinite(recorded) ? '' : ', assumed from the submit time'}) and the indexer does not know it. Nothing of it is on chain; a new attempt needs a new idempotencyKey.`;
    const earlier = job.errorCode ? ` Earlier: ${job.errorCode}${job.errorMessage ? `: ${String(job.errorMessage).slice(0, 1000)}` : ''}` : '';
    return withLockContentionRetry(`finalizeLostBroadcast(${job.ID})`, () => db.tx(async (tx) => {
        if (await lockReorgGeneration(tx) !== generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set({
            status: 'failed', chainStatus: 'dropped', finishedAt: now,
            errorCode: BROADCAST_NOT_INCLUDED, errorMessage: (message + earlier).slice(0, 4000)
        }).where({ ID: job.ID, status: 'reconciliation_required' })));
        let rowClosed = 0;
        if (affected === 1 && submission?.ID) {
            rowClosed = affectedRows(await tx.run(UPDATE.entity(PendingSubmissions).set({
                status: 'failed', finalizedAt: now, errorCode: BROADCAST_NOT_INCLUDED,
                errorMessage: `not included before ttl ${ttlIso}`
            }).where({ ID: submission.ID, status: 'pending' })));
        }
        // Refund the reserved deploy exactly once. Only the row closed here can still hold it.
        if (rowClosed === 1 && reservation?.grantId && Number.isInteger(reservation.count) && (reservation.count as number) > 0) {
            await tx.run(
                UPDATE.entity('midnight.AgentGrants')
                    .set({ deploysUsed: { '-=': reservation.count } })
                    .where({ ID: reservation.grantId, deploysUsed: { '>=': reservation.count } })
            );
        }
        if (affected === 1) cds.log('nightgate').warn(`${job.kind} job ${job.ID}: ${message}${rowClosed === 1 && reservation?.count ? ` (refunded ${reservation.count} deploy reservation(s) on grant ${String(reservation.grantId).slice(0, 8)})` : ''}`);
        return affected;
    }));
}

/**
 * Finishes a job and its attempt row in one transaction. A job settled after a lost send
 * gets the same result a normal run returns, rebuilt from the data stored before sending.
 * For a `succeeded` job only chainStatus moves forward.
 */
async function finalizeIdentifierKeyedJob(
    db: DbService, job: BackgroundJob, outcome: ChainOutcome,
    opts: { fromStatus: 'reconciliation_required' | 'in_flight' | 'succeeded'; chainStatusWas?: string | null; generation: number }
): Promise<number> {
    const status = outcome.status;
    const evidence = chainEvidencePatch(outcome);
    const now = new Date().toISOString();
    const submission: PendingSubmission | undefined = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    const coordinates = parseSubmitIntent(submission?.submitIntentData);
    const canonicalResult = {
        txHash: job.txHash,
        circuits: Array.isArray(coordinates.circuits) && coordinates.circuits.length ? coordinates.circuits : (submission?.circuitName ? [submission.circuitName] : []),
        contractAddress: coordinates.contractAddress ?? submission?.contractAddress ?? '',
        ...(coordinates.note ? { note: coordinates.note } : {}),
        feeSponsor: coordinates.feeSponsor ?? job.sessionId,
        reconciled: true
    };
    const terminal = opts.fromStatus === 'reconciliation_required' || opts.fromStatus === 'in_flight';
    // The job kind's result writer runs first. If it throws, the job stays parked.
    let finalizedResult: unknown = canonicalResult;
    if (opts.fromStatus === 'reconciliation_required' && status === 'success') {
        const reconciliationEvidence: ReconciliationEvidence = {
            submissionId: submission?.ID ?? job.submissionId ?? null,
            txHash: job.txHash!,
            contractAddress: submission?.contractAddress ?? null,
            finalizedAt: submission?.finalizedAt ?? null,
            blockHeight: outcome.blockHeight
        };
        const fromFinalizer = await runReconciliationFinalizer(job, reconciliationEvidence);
        if (fromFinalizer !== undefined) finalizedResult = { ...canonicalResult, ...(fromFinalizer as object) };
    }
    const jobPatch: Record<string, unknown> = {
        ...(terminal
            ? (status === 'success'
                ? { status: 'succeeded', chainStatus: 'success', chainFinalizedAt: now, errorCode: null, errorMessage: null, finishedAt: now, result: safeStringify(finalizedResult) }
                : { status: 'failed', chainStatus: 'failure', chainFinalizedAt: now, finishedAt: now,
                    errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: `Transaction ${job.txHash} is on-chain but its contract call did not apply (ledger result failure)` })
            : { chainStatus: status, chainFinalizedAt: now }),
        ...evidence
    };
    const segments = chainSegmentsOf(submission?.submitIntentData, outcome);
    if (segments) jobPatch.chainSegments = segments;
    if (opts.fromStatus === 'in_flight') Object.assign(jobPatch, { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null });
    const jobWhere: Record<string, unknown> = opts.fromStatus === 'reconciliation_required'
        ? { ID: job.ID, status: 'reconciliation_required' }
        : opts.fromStatus === 'in_flight'
            ? { ID: job.ID, leaseOwner: getRuntimeWorkerId(), status: { in: ['running', 'external_execution', 'submitted'] } }
            : { ID: job.ID, status: 'succeeded', chainStatus: opts.chainStatusWas ?? null };
    const subPatch: Record<string, unknown> = {
        status: status === 'success' ? 'finalized' : 'failed',
        finalizedAt: now,
        ...evidence,
        ...(status === 'failure' ? { errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: 'contract call did not apply (ledger result failure)' } : {})
    };
    return withLockContentionRetry(`finalizeIdentifierKeyedJob(${job.ID})`, () => db.tx(async (tx) => {
        // A chain rollback since the lookup means the outcome may be from the old fork.
        if (await lockReorgGeneration(tx) !== opts.generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set(jobPatch).where(jobWhere)));
        if (affected === 1 && submission?.ID) {
            await tx.run(UPDATE.entity(PendingSubmissions).set(subPatch).where({ ID: submission.ID }));
        }
        return affected;
    }));
}

let settleRejectedCursor: string | undefined;

/**
 * Finishes the cleanup for rejected sends whose database writes failed earlier.
 * One transaction per job, safe to repeat.
 */
export async function settleRejectedSponsorAttempts(existingDb?: DbService): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const page = await scanBackgroundJobPage(db, {
        status: 'reconciliation_required', errorCode: REJECTED_ATTEMPT_BOOKKEEPING_PENDING
    }, settleRejectedCursor);
    settleRejectedCursor = page.cursor;
    let settled = 0;
    for (const job of page.rows) {
        try {
            const submission: PendingSubmission | null | undefined = job.submissionId
                ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: job.submissionId }))
                : (job.txHash ? await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: job.txHash, status: 'pending' })) : null);
            const reservation = parseSubmitIntent(submission?.submitIntentData).deployReservation ?? null;
            const now = new Date().toISOString();
            const affected = await withLockContentionRetry(`settleRejectedSponsorAttempt(${job.ID})`, () => db.tx(async (tx) => {
                let rowClosed = 0;
                if (submission?.ID) {
                    rowClosed = affectedRows(await tx.run(
                        UPDATE.entity(PendingSubmissions)
                            .set({ status: 'failed', errorCode: 'REJECTED', errorMessage: 'rejected before inclusion; bookkeeping settled by the reconciler' })
                            .where({ ID: submission.ID, status: 'pending' })
                    ));
                }
                // Only a row closed here can still hold the reserved deploy.
                if (rowClosed === 1 && reservation?.grantId && Number.isInteger(reservation.count) && (reservation.count as number) > 0) {
                    await tx.run(
                        UPDATE.entity('midnight.AgentGrants')
                            .set({ deploysUsed: { '-=': reservation.count } })
                            .where({ ID: reservation.grantId, deploysUsed: { '>=': reservation.count } })
                    );
                }
                return affectedRows(await tx.run(
                    UPDATE.entity(BackgroundJobs)
                        .set({
                            status: 'failed', txHash: null, chainStatus: null, finishedAt: now,
                            errorCode: 'SPONSOR_ATTEMPT_REJECTED',
                            errorMessage: `The sponsoring attempt was rejected before inclusion (nothing is on chain) and its bookkeeping was settled by the reconciler. ${String(job.errorMessage ?? '').slice(0, 1500)}`
                        })
                        .where({ ID: job.ID, status: 'reconciliation_required', errorCode: REJECTED_ATTEMPT_BOOKKEEPING_PENDING })
                ));
            }));
            if (affected === 1) {
                settled++;
                cds.log('nightgate').info(`settled the rejected sponsoring attempt of job ${job.ID}${reservation?.count ? ` (refunded ${reservation.count} deploy reservation(s) on grant ${String(reservation.grantId).slice(0, 8)}…)` : ''}`);
            }
        } catch (err) {
            cds.log('nightgate').warn(`could not settle the rejected sponsoring attempt of job ${job.ID} this tick: ${errorMessage(err)}`);
        }
    }
    return settled;
}

export function registerChainOutcomeConfirmer(confirmer: ChainOutcomeConfirmer | null): void {
    chainOutcomeConfirmer = confirmer;
}

// Runs at most once at a time and in the background, so slow indexer lookups do not stall the job poller.
export function triggerChainConfirmPass(): void {
    if (!chainOutcomeConfirmer || chainConfirmActive) return;
    chainConfirmActive = true;
    void confirmChainOutcomesViaIndexer()
        .catch(err => cds.log('nightgate').warn(
            `Chain-outcome confirm pass failed: ${errorMessage(err)}`))
        .finally(() => { chainConfirmActive = false; });
}

/**
 * Reads one page and moves past every row read, including rows that keep failing, then wraps.
 * Cursors live in memory, which is enough because only one server instance runs.
 */
async function scanBackgroundJobPage(
    db: DbRunner,
    where: Record<string, unknown>,
    cursor: string | undefined
): Promise<{ rows: BackgroundJob[]; cursor: string | undefined }> {
    const select = async (after?: string): Promise<BackgroundJob[]> => db.run(
        SELECT.from(BackgroundJobs)
            .where(after ? { ...where, ID: { '>': after } } : where)
            .orderBy('ID asc')
            .limit(SCAN_PAGE_SIZE)
    ) as Promise<BackgroundJob[]>;

    let rows = await select(cursor);
    if (rows.length === 0 && cursor) rows = await select();
    return {
        rows,
        cursor: rows.length > 0 ? rows[rows.length - 1].ID : undefined
    };
}

/**
 * Re-queues parked workflow jobs once all their child jobs succeeded. The re-run builds the
 * result without sending again. Other jobs are settled only by the indexer check.
 */
export async function reconcileBackgroundJobs(existingDb?: DbRunner): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const page = await scanBackgroundJobPage(
        db, { status: 'reconciliation_required' }, reconciliationCursor
    );
    reconciliationCursor = page.cursor;
    const candidates = page.rows;
    let resolved = 0;

    for (const job of candidates) {
        if (jobKindTraits(job.kind).workflowParent) {
            const children = await db.run(
                SELECT.from(BackgroundJobs).where({ parentJobId: job.ID })
            ) as BackgroundJob[];
            if (children.length > 0 && children.every(child => child.status === 'succeeded')) {
                const affected = await withLockContentionRetry(`requeueReconciledParent(${job.ID})`, () => db.run(
                    UPDATE.entity(BackgroundJobs).set({
                        status: 'pending', errorCode: null, errorMessage: null,
                        startedAt: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
                    }).where({ ID: job.ID, status: 'reconciliation_required' })
                ));
                resolved += affectedRows(affected);
                continue;
            }
            // A failed child can never run again under its fixed step key, so the parent fails too.
            const failedChild = children.find(child => child.status === 'failed');
            if (failedChild) {
                const landed = children.filter(child => child.status === 'succeeded').map(child => child.workflowStep ?? child.ID);
                const affected = await withLockContentionRetry(`failReconciledParent(${job.ID})`, () => db.run(
                    UPDATE.entity(BackgroundJobs).set({
                        status: 'failed', errorCode: 'CHILD_FAILED', finishedAt: new Date().toISOString(),
                        errorMessage: `Child job ${failedChild.ID} (workflow step '${failedChild.workflowStep ?? '?'}') failed [${failedChild.errorCode ?? 'UNKNOWN'}]: ${String(failedChild.errorMessage ?? 'unknown error').slice(0, 1500)}` +
                            (landed.length ? ` Steps already on chain: ${landed.join(', ')}.` : ' No step of this workflow is on chain.') +
                            ' A new attempt needs a new idempotencyKey.'
                    }).where({ ID: job.ID, status: 'reconciliation_required' })
                ));
                resolved += affectedRows(affected);
            }
            continue;
        }

    }
    return resolved;
}

export async function refreshSucceededChainOutcomes(existingDb?: DbRunner): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    let updated = 0;

    const pendingParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: kindsWithTrait('workflowParent') }, chainStatus: 'pending'
    }, parentPendingCursor);
    parentPendingCursor = pendingParents.cursor;
    const legacyParents = await scanBackgroundJobPage(db, {
        status: 'succeeded', kind: { in: kindsWithTrait('workflowParent') }, chainStatus: null
    }, parentLegacyCursor);
    parentLegacyCursor = legacyParents.cursor;
    const parents = [...pendingParents.rows, ...legacyParents.rows];
    for (const parent of parents) {
        const children = await db.run(SELECT.from(BackgroundJobs).where({ parentJobId: parent.ID })) as BackgroundJob[];
        if (children.length === 0) continue;
        const aggregate = children.some(child => child.chainStatus === 'failure')
            ? 'failure'
            : children.every(child => child.chainStatus === 'success') ? 'success' : 'pending';
        if (parent.chainStatus === aggregate) continue;
        const affected = await withLockContentionRetry(`refreshParentChainOutcome(${parent.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set({
                chainStatus: aggregate,
                chainFinalizedAt: aggregate === 'pending' ? null : new Date().toISOString()
            }).where({ ID: parent.ID, status: 'succeeded' })
        ));
        updated += affectedRows(affected);
    }
    return updated;
}

/**
 * Looks up each job's transaction in the indexer. Moves `chainStatus` forward on succeeded jobs
 * and settles parked ones. Stores the block height, which a chain rollback uses to revert.
 */
export async function confirmChainOutcomesViaIndexer(existingDb?: DbService): Promise<number> {
    const confirmer = chainOutcomeConfirmer;
    if (!confirmer) return 0;
    const db = existingDb ?? await cds.connect.to('db');
    const pendingPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: 'pending'
    }, confirmerPendingCursor);
    confirmerPendingCursor = pendingPage.cursor;
    const legacyPage = await scanBackgroundJobPage(db, {
        status: 'succeeded', txHash: { '!=': null }, chainStatus: null
    }, confirmerLegacyCursor);
    confirmerLegacyCursor = legacyPage.cursor;
    // Every parked job with a hash is settled here, because only the indexer can prove the outcome.
    const reconcilePage = await scanBackgroundJobPage(db, {
        status: 'reconciliation_required', txHash: { '!=': null }
    }, confirmerReconcileCursor);
    confirmerReconcileCursor = reconcilePage.cursor;
    let updated = 0;
    // Rollback counter read before the lookups. Each write compares it again under the row lock.
    let generation = await readReorgGeneration(db);
    for (const job of reconcilePage.rows) {
        let outcome: ChainLookup;
        try { outcome = await confirmer(job.txHash!); } catch (err) {
            cds.log('nightgate').debug(`Reconciliation lookup for ${job.kind} job ${job.ID} deferred: ${errorMessage(err)}`);
            continue;
        }
        if (!isChainOutcome(outcome)) {
            // Only a clear "not found" counts. A transaction that is found but not yet confirmed may land.
            if (isChainAbsent(outcome)) {
                try { updated += await finalizeLostBroadcast(db, job, outcome.asOfMs, generation); } catch (err) {
                    cds.log('nightgate').debug(`Lost-broadcast finalization of ${job.kind} job ${job.ID} deferred: ${errorMessage(err)}`);
                }
            }
            continue;
        }
        try {
            updated += await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'reconciliation_required', generation });
        } catch (err) {
            cds.log('nightgate').debug(`Crawler-free reconciliation of ${job.kind} job ${job.ID} deferred: ${errorMessage(err)}`);
        }
    }
    const jobs = [...pendingPage.rows, ...legacyPage.rows]
        .filter(job => !jobKindTraits(job.kind).workflowParent);
    let lookupErrors = 0;
    let writeErrors = 0;
    generation = await readReorgGeneration(db);
    let staleGeneration = 0;
    await mapWithConcurrency(jobs, CHAIN_CONFIRM_CONCURRENCY, async job => {
        let outcome: ChainLookup;
        try {
            outcome = await confirmer(job.txHash!);
        } catch {
            lookupErrors++;
            return;
        }
        if (!isChainOutcome(outcome)) return;
        // Update only if chainStatus is still the value read. `IN (...)` would never match a NULL.
        try {
            if (jobKindTraits(job.kind).identifierKeyed) {
                // Not `updated += await f()`. That reads `updated` before the await
                // and loses parallel increments.
                const n = await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'succeeded', chainStatusWas: job.chainStatus ?? null, generation });
                updated += n;
            } else {
                const now = new Date().toISOString();
                const evidence = chainEvidencePatch(outcome);
                const attempt = await db.run(SELECT.one.from(PendingSubmissions).columns('submitIntentData')
                    .where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
                const segments = chainSegmentsOf(attempt?.submitIntentData, outcome);
                // One transaction, because a finished job leaves the scan and its attempt row must not stay behind.
                const n: number = await withLockContentionRetry(`confirmChainOutcome(${job.ID})`, () => db.tx(async (tx): Promise<number> => {
                    // A chain rollback since the lookup means the outcome may be from the old fork.
                    if (await lockReorgGeneration(tx) !== generation) { staleGeneration++; return 0; }
                    const affected = affectedRows(await tx.run(
                        UPDATE.entity(BackgroundJobs).set({
                            chainStatus: outcome!.status,
                            chainFinalizedAt: now,
                            ...evidence,
                            ...(segments ? { chainSegments: segments } : {})
                        }).where({ ID: job.ID, status: 'succeeded', chainStatus: job.chainStatus ?? null })
                    ));
                    if (affected === 1) {
                        await tx.run(
                            UPDATE.entity(PendingSubmissions).set({
                                status: outcome!.status === 'success' ? 'finalized' : 'failed',
                                finalizedAt: now,
                                ...evidence,
                                ...(outcome!.status === 'failure' ? { errorCode: 'CHAIN_EXECUTION_FAILED', errorMessage: 'contract call did not apply (ledger result failure)' } : {})
                            }).where(job.submissionId
                                ? { ID: job.submissionId, status: { in: ['pending', 'included'] } }
                                : { txHash: job.txHash, status: { in: ['pending', 'included'] } })
                        );
                    }
                    return affected;
                }));
                updated += n;
            }
        } catch {
            writeErrors++;
        }
    });
    if (staleGeneration > 0) {
        cds.log('nightgate').info(`Crawler-free chain confirm: ${staleGeneration} outcome(s) read before a reorg rollback were not recorded; next tick looks again`);
    }
    if (lookupErrors > 0 || writeErrors > 0) {
        cds.log('nightgate').warn(
            `Crawler-free chain confirm: ${lookupErrors} lookup / ${writeErrors} write error(s) of ${jobs.length} this pass`
        );
    }
    return updated;
}

/**
 * Runs at most `limit` items at once and resolves only when all finished. Errors are swallowed
 * per item, so the caller's run-once guard covers the whole pass.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            try { await fn(items[next++]); } catch { /* per-item backstop; fn owns its errors */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Fails the job right away when the worker saw the transaction in a block without the call applied. */
export async function markChainFailureAfterBroadcast(jobId: string, current: BackgroundJob, err: unknown): Promise<void> {
    // The worker's check ignores chain rollbacks. So ask the indexer again with the rollback
    // counter read first, or park the job for the next pass.
    const db = await cds.connect.to('db');
    const carried = carriedSubmitFailure(err)?.blockHeight;
    const generation = await readReorgGeneration(db);
    let outcome: ChainLookup = null;
    try { outcome = chainOutcomeConfirmer ? await chainOutcomeConfirmer(current.txHash!) : null; } catch { outcome = null; }
    if (!isChainOutcome(outcome)) {
        await markReconciliationRequired(jobId, {
            code: 'CHAIN_EXECUTION_FAILED_UNCONFIRMED',
            message: `Transaction ${current.txHash} is on-chain and its contract call did not apply` +
                (Number.isInteger(carried) ? ` (worker saw block ${carried})` : '') +
                `; the indexer confirmer finalizes it with generation-checked coordinates`
        });
        return;
    }
    try {
        const affected = await finalizeIdentifierKeyedJob(db, current, outcome, { fromStatus: 'in_flight', generation });
        if (affected !== 1) {
            await markReconciliationRequired(jobId, { code: 'CHAIN_EXECUTION_FAILED_UNCONFIRMED', message: `Transaction ${current.txHash}: terminal chain-failure write refused (lease or reorg generation changed); the reconciliation pass finalizes it` });
            return;
        }
    } catch (writeErr) {
        cds.log('nightgate').error(
            `markChainFailureAfterBroadcast(${jobId}): could not persist the terminal status after ${LOCK_CONTENTION_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery (identifier ${current.txHash}).`,
            writeErr
        );
    }
}

/** Test hook. Resets scan cursors and the confirmer. */
export function __resetReconciliationForTests(): void {
    confirmerReconcileCursor = undefined;
    reconciliationCursor = undefined;
    parentPendingCursor = undefined;
    parentLegacyCursor = undefined;
    confirmerPendingCursor = undefined;
    confirmerLegacyCursor = undefined;
    chainOutcomeConfirmer = null;
    chainConfirmActive = false;
}
