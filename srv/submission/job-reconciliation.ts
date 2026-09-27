/**
 * Job reconciliation: restart recovery, lease-free chain confirmation, lost broadcasts and rejected sponsor attempts.
 * SPDX-License-Identifier: Apache-2.0
 */
import { REJECTED_ATTEMPT_BOOKKEEPING_PENDING } from './job-execution-context';
import cds from '@sap/cds';
import { BackgroundJobs, PendingSubmissions } from '#cds-models/midnight';
import { isChainOutcome, isChainAbsent, type ChainOutcome, type ChainLookup } from './chain-outcome-confirmer';
import { configMs } from '../utils/config';
import { carriedSubmitFailure } from '../midnight/wallet-worker-protocol';
import { readReorgGeneration, lockReorgGeneration } from './reorg-generation';
import type { DbRunner, DbService } from '../utils/db-types';
import { kindsWithTrait, jobKindTraits, runReconciliationFinalizer } from './job-registry';
import { withStatusWriteRetry, BackgroundJobRow, affectedRows, safeStringify, ReconciliationEvidence, getRuntimeWorkerId, STATUS_WRITE_ATTEMPTS, markReconciliationRequired } from './job-store';

const { SELECT, UPDATE } = cds.ql;

/** Classify jobs left by a restart without risking a duplicate external effect. Idempotent. */
export async function recoverInterruptedJobs(): Promise<number> {
    const db = await cds.connect.to('db');
    const stuck = await db.run(
        SELECT.from(BackgroundJobs)
            .columns('ID', 'status', 'commandVersion')
            .where({ status: { in: ['pending', 'running', 'external_execution', 'submitted'] } })
    );
    const count = Array.isArray(stuck) ? stuck.length : 0;
    if (count === 0) return 0;
    await withStatusWriteRetry('recoverInterruptedJobs', async () => {
        // FIRST, before the re-queue below can claim them: a session-bound job's
        // product died with the process.
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
        // `running` is before the external-effect boundary: safe to re-queue.
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
        // Legacy closures cannot be reconstructed.
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
        // No hash = never broadcast: every submit path persists the identifier
        // (submit-intent ack) before sending. Nothing is on chain, fail plainly.
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

/** Evidence columns written with every confirmed outcome, on job and attempt row alike. */
function chainEvidencePatch(outcome: ChainOutcome): Record<string, unknown> {
    return {
        chainBlockHeight: Number.isInteger(outcome.blockHeight) ? outcome.blockHeight : null,
        chainBlockHash: outcome.blockHash ?? null,
        indexerTxHash: outcome.indexerTxHash ?? null
    };
}

/**
 * `chainSegments` of a batch: which calls applied, from the call names the submit intent
 * recorded per segment and the segments the indexer reports as failed. Null without segments.
 */
export function chainSegmentsOf(submitIntentData: string | null | undefined, outcome: ChainOutcome): string | null {
    let segments: unknown;
    try { segments = submitIntentData ? JSON.parse(submitIntentData)?.segments : undefined; } catch { return null; }
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const failed = new Set(outcome.failedSegments ?? []);
    // FAILURE: the guaranteed part failed, nothing applied; SUCCESS: everything applied.
    const applied = (segment: number): boolean =>
        outcome.result === 'SUCCESS' || (outcome.result === undefined && outcome.status === 'success')
            ? true
            : outcome.result === 'PARTIAL_SUCCESS' ? !failed.has(segment) : false;
    return JSON.stringify(segments
        .filter((s: any) => Number.isInteger(s?.segment) && Array.isArray(s?.calls))
        .map((s: any) => ({ segment: s.segment, calls: s.calls.map(String), applied: applied(s.segment) })));
}

let chainOutcomeConfirmer: ChainOutcomeConfirmer | null = null;

let confirmerReconcileCursor: string | undefined;

let chainConfirmActive = false;

const CHAIN_CONFIRM_CONCURRENCY = 8;

/** Park code while a broadcast is neither seen on chain nor provably absent. */
export const BROADCAST_UNCONFIRMED = 'BROADCAST_UNCONFIRMED';

/** Terminal code once the indexer tip is past the ttl and the transaction is still unknown. */
export const BROADCAST_NOT_INCLUDED = 'BROADCAST_NOT_INCLUDED';

/** For rows without a recorded ttl: the longest ttl any submitting path sets. */
const LEGACY_BROADCAST_TTL_MS = 60 * 60 * 1000;

/**
 * Fail a parked job as never included once the absence answer's own tip is past
 * its ttl plus margin. Only that tip counts: a lagging or other replica must not
 * turn a landed tx into a lost one (the caller would pay twice).
 */
async function finalizeLostBroadcast(db: DbService, job: BackgroundJobRow, tipMs: number | null, generation: number): Promise<number> {
    if (tipMs === null || job.errorCode === REJECTED_ATTEMPT_BOOKKEEPING_PENDING || jobKindTraits(job.kind).workflowParent) return 0;
    const submission = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    let coordinates: any = {};
    try { coordinates = submission?.submitIntentData ? JSON.parse(submission.submitIntentData) : {}; } catch { coordinates = {}; }
    const reservation: { grantId?: string; count?: number } | null = coordinates?.deployReservation ?? null;
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
    return withStatusWriteRetry(`finalizeLostBroadcast(${job.ID})`, () => db.tx(async (tx) => {
        if (await lockReorgGeneration(tx) !== generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set({
            status: 'failed', chainStatus: 'dropped', finishedAt: now,
            errorCode: BROADCAST_NOT_INCLUDED, errorMessage: (message + earlier).slice(0, 4000)
        } as any).where({ ID: job.ID, status: 'reconciliation_required' })));
        let rowClosed = 0;
        if (affected === 1 && submission?.ID) {
            rowClosed = affectedRows(await tx.run(UPDATE.entity(PendingSubmissions).set({
                status: 'failed', finalizedAt: now, errorCode: BROADCAST_NOT_INCLUDED,
                errorMessage: `not included before ttl ${ttlIso}`
            } as any).where({ ID: submission.ID, status: 'pending' })));
        }
        // Refund the deploy reservation exactly once: only the row closed here can still hold it.
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
 * Finalize an identifier-keyed job and its attempt row in ONE transaction. A
 * reconciled success gets the action's canonical result, rebuilt from the
 * submit-intent coordinates. `succeeded` only advances chainStatus (CAS).
 */
async function finalizeIdentifierKeyedJob(
    db: DbService, job: BackgroundJobRow, outcome: ChainOutcome,
    opts: { fromStatus: 'reconciliation_required' | 'in_flight' | 'succeeded'; chainStatusWas?: string | null; generation: number }
): Promise<number> {
    const status = outcome.status;
    const evidence = chainEvidencePatch(outcome);
    const now = new Date().toISOString();
    const submission = await db.run(SELECT.one.from(PendingSubmissions).where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
    let coordinates: any = {};
    try { coordinates = submission?.submitIntentData ? JSON.parse(submission.submitIntentData) : {}; } catch { coordinates = {}; }
    const canonicalResult = {
        txHash: job.txHash,
        circuits: Array.isArray(coordinates.circuits) && coordinates.circuits.length ? coordinates.circuits : (submission?.circuitName ? [submission.circuitName] : []),
        contractAddress: coordinates.contractAddress ?? submission?.contractAddress ?? '',
        ...(coordinates.note ? { note: coordinates.note } : {}),
        feeSponsor: coordinates.feeSponsor ?? job.sessionId,
        reconciled: true
    };
    const terminal = opts.fromStatus === 'reconciliation_required' || opts.fromStatus === 'in_flight';
    // The kind's finalizer runs first; if it throws, the job stays parked.
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
    return withStatusWriteRetry(`finalizeIdentifierKeyedJob(${job.ID})`, () => db.tx(async (tx) => {
        // A rollback since the lookup: the outcome may describe the old fork.
        if (await lockReorgGeneration(tx) !== opts.generation) return 0;
        const affected = affectedRows(await tx.run(UPDATE.entity(BackgroundJobs).set(jobPatch as any).where(jobWhere)));
        if (affected === 1 && submission?.ID) {
            await tx.run(UPDATE.entity(PendingSubmissions).set(subPatch as any).where({ ID: submission.ID }));
        }
        return affected;
    }));
}

let settleRejectedCursor: string | undefined;

/**
 * Settle rejected attempts whose bookkeeping did not commit: close the row,
 * refund, clear the hash, fail the job. One idempotent transaction per job.
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
            const submission: any = job.submissionId
                ? await db.run(SELECT.one.from(PendingSubmissions).where({ ID: job.submissionId }))
                : (job.txHash ? await db.run(SELECT.one.from(PendingSubmissions).where({ txHash: job.txHash, status: 'pending' })) : null);
            let reservation: { grantId?: string; count?: number } | null = null;
            try { reservation = submission?.submitIntentData ? JSON.parse(submission.submitIntentData)?.deployReservation ?? null : null; } catch { reservation = null; }
            const now = new Date().toISOString();
            const affected = await withStatusWriteRetry(`settleRejectedSponsorAttempt(${job.ID})`, () => db.tx(async (tx) => {
                let rowClosed = 0;
                if (submission?.ID) {
                    rowClosed = affectedRows(await tx.run(
                        UPDATE.entity(PendingSubmissions)
                            .set({ status: 'failed', errorCode: 'REJECTED', errorMessage: 'rejected before inclusion; bookkeeping settled by the reconciler' })
                            .where({ ID: submission.ID, status: 'pending' })
                    ));
                }
                // Only a row closed here (still pending) can still hold the reservation.
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
            cds.log('nightgate').warn(`could not settle the rejected sponsoring attempt of job ${job.ID} this tick: ${String((err as Error)?.message ?? err)}`);
        }
    }
    return settled;
}

export function registerChainOutcomeConfirmer(confirmer: ChainOutcomeConfirmer | null): void {
    chainOutcomeConfirmer = confirmer;
}

// Single-flight and detached: slow indexer lookups must not stall the command poller.
export function triggerChainConfirmPass(): void {
    if (!chainOutcomeConfirmer || chainConfirmActive) return;
    chainConfirmActive = true;
    void confirmChainOutcomesViaIndexer()
        .catch(err => cds.log('nightgate').warn(
            `Chain-outcome confirm pass failed: ${String((err as Error)?.message ?? err)}`))
        .finally(() => { chainConfirmActive = false; });
}

/**
 * One bounded page that advances past every inspected row (poison rows too) and
 * wraps. Process-local cursors suffice because the deployment is single-instance.
 */
async function scanBackgroundJobPage(
    db: DbRunner,
    where: Record<string, unknown>,
    cursor: string | undefined
): Promise<{ rows: BackgroundJobRow[]; cursor: string | undefined }> {
    const select = async (after?: string): Promise<BackgroundJobRow[]> => db.run(
        SELECT.from(BackgroundJobs)
            .where(after ? { ...where, ID: { '>': after } } : where)
            .orderBy('ID asc')
            .limit(SCAN_PAGE_SIZE)
    ) as Promise<BackgroundJobRow[]>;

    let rows = await select(cursor);
    if (rows.length === 0 && cursor) rows = await select();
    return {
        rows,
        cursor: rows.length > 0 ? rows[rows.length - 1].ID : undefined
    };
}

/**
 * Re-queue parked workflow parents once all children succeeded (the processor
 * rebuilds the result without re-submitting). Leaf jobs resolve only via the indexer confirmer.
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
            ) as BackgroundJobRow[];
            if (children.length > 0 && children.every(child => child.status === 'succeeded')) {
                const affected = await withStatusWriteRetry(`requeueReconciledParent(${job.ID})`, () => db.run(
                    UPDATE.entity(BackgroundJobs).set({
                        status: 'pending', errorCode: null, errorMessage: null,
                        startedAt: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
                    }).where({ ID: job.ID, status: 'reconciliation_required' })
                ));
                resolved += affectedRows(affected);
                continue;
            }
            // A failed child can never re-run under its immutable step key: the parent fails too.
            const failedChild = children.find(child => child.status === 'failed');
            if (failedChild) {
                const landed = children.filter(child => child.status === 'succeeded').map(child => child.workflowStep ?? child.ID);
                const affected = await withStatusWriteRetry(`failReconciledParent(${job.ID})`, () => db.run(
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

/** Aggregate a succeeded workflow parent's `chainStatus` from its children. */
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
        const children = await db.run(SELECT.from(BackgroundJobs).where({ parentJobId: parent.ID })) as BackgroundJobRow[];
        if (children.length === 0) continue;
        const aggregate = children.some(child => child.chainStatus === 'failure')
            ? 'failure'
            : children.every(child => child.chainStatus === 'success') ? 'success' : 'pending';
        if (parent.chainStatus === aggregate) continue;
        const affected = await withStatusWriteRetry(`refreshParentChainOutcome(${parent.ID})`, () => db.run(
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
 * Chain evidence for leaf jobs: per-tx indexer lookup advances succeeded jobs'
 * `chainStatus` and resolves parked ones, recording the inclusion height a rollback reverts by.
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
    // Every parked kind with a hash resolves here: the indexer is the only evidence.
    const reconcilePage = await scanBackgroundJobPage(db, {
        status: 'reconciliation_required', txHash: { '!=': null }
    }, confirmerReconcileCursor);
    confirmerReconcileCursor = reconcilePage.cursor;
    let updated = 0;
    // Captured before the lookups; each commit compares under the row lock.
    let generation = await readReorgGeneration(db);
    for (const job of reconcilePage.rows) {
        let outcome: ChainLookup;
        try { outcome = await confirmer(job.txHash!); } catch (err) {
            cds.log('nightgate').debug(`Reconciliation lookup for ${job.kind} job ${job.ID} deferred: ${String((err as Error)?.message ?? err)}`);
            continue;
        }
        if (!isChainOutcome(outcome)) {
            // Only absence is evidence; an indexed-but-unconfirmable tx may be on chain.
            if (isChainAbsent(outcome)) {
                try { updated += await finalizeLostBroadcast(db, job, outcome.asOfMs, generation); } catch (err) {
                    cds.log('nightgate').debug(`Lost-broadcast finalization of ${job.kind} job ${job.ID} deferred: ${String((err as Error)?.message ?? err)}`);
                }
            }
            continue;
        }
        try {
            updated += await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'reconciliation_required', generation });
        } catch (err) {
            cds.log('nightgate').debug(`Crawler-free reconciliation of ${job.kind} job ${job.ID} deferred: ${String((err as Error)?.message ?? err)}`);
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
        // CAS on the exact chainStatus read: `IN (...)` would never match a NULL.
        try {
            if (jobKindTraits(job.kind).identifierKeyed) {
                // Not `updated += await f()`: that reads `updated` before the await
                // and loses concurrent increments.
                const n = await finalizeIdentifierKeyedJob(db, job, outcome, { fromStatus: 'succeeded', chainStatusWas: job.chainStatus ?? null, generation });
                updated += n;
            } else {
                const now = new Date().toISOString();
                const evidence = chainEvidencePatch(outcome);
                const attempt = await db.run(SELECT.one.from(PendingSubmissions).columns('submitIntentData')
                    .where(job.submissionId ? { ID: job.submissionId } : { txHash: job.txHash }));
                const segments = chainSegmentsOf(attempt?.submitIntentData, outcome);
                // One transaction: a terminal job leaves the scan, its attempt row must not stay behind.
                const n: number = await withStatusWriteRetry(`confirmChainOutcome(${job.ID})`, () => db.tx(async (tx): Promise<number> => {
                    // A rollback since the lookup: the outcome may describe the old fork.
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
 * At most `limit` in flight; resolves only when ALL items finished, errors
 * swallowed per item, so the caller's single-flight guard holds for the whole pass.
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

/** Terminal failure straight from the running job, for an outcome the worker proved (in a block, call not applied). */
export async function markChainFailureAfterBroadcast(jobId: string, current: BackgroundJobRow, err: unknown): Promise<void> {
    // The worker's probe is not generation-protected: re-ask the confirmer under
    // a captured generation, else park for the reconciliation pass.
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
            `markChainFailureAfterBroadcast(${jobId}): could not persist the terminal status after ${STATUS_WRITE_ATTEMPTS} attempts; ` +
            `job row stays non-terminal until restart recovery (identifier ${current.txHash}).`,
            writeErr
        );
    }
}

/** Test hook: scan cursors and the confirmer back to boot state. */
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
