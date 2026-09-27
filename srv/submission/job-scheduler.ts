/**
 * Job dispatch: concurrency classes, detached execution, the command poller and lease reclaim.
 * SPDX-License-Identifier: Apache-2.0
 */
import { SponsorAttemptBookkeepingPendingError } from './job-execution-context';
import { isBackgroundFenced } from '../utils/instance-lease';
import cds from '@sap/cds';
import { BackgroundJobs } from '#cds-models/midnight';
import { classifySubmissionError } from './TransactionSubmitter';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig } from '../utils/nightgate-config';
import { runInJobExecutionContext } from './job-execution-context';
import { isCallNotAppliedFailure } from './sponsor-pool';
import { configMs } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { jobKindTraits, executePersistedCommand, undeclaredOrUnregisteredJobKinds, processors, processorKey } from './job-registry';
import { WorkflowReconciliationRequiredError, runWithoutAmbientTx, getJobById, STATUS_WRITE_ATTEMPTS, markRunning, markSucceeded, markFailed, markReconciliationRequired, startLeaseHeartbeat, markJobExternalExecution, markJobBroadcastOn, markJobSubmissionRejectedOn, markJobSubmitted, BackgroundJobRow, withStatusWriteRetry, affectedRows } from './job-store';
import { BROADCAST_UNCONFIRMED, BROADCAST_NOT_INCLUDED, markChainFailureAfterBroadcast, settleRejectedSponsorAttempts, triggerChainConfirmPass, reconcileBackgroundJobs, refreshSucceededChainOutcomes, SCAN_PAGE_SIZE } from './job-reconciliation';

const { SELECT, UPDATE } = cds.ql;

const DEFAULT_CONCURRENCY = { heavy: 4, light: 16, serial: 1 } as const;

class Semaphore {
    private inFlight = 0;
    private waiters: Array<() => void> = [];
    constructor(public readonly max: number) { }

    async acquire(): Promise<void> {
        if (this.inFlight < this.max) {
            this.inFlight++;
            return;
        }
        await new Promise<void>(resolve => this.waiters.push(resolve));
        // Slot transferred directly from release(); inFlight already counted.
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
        } else {
            this.inFlight = Math.max(0, this.inFlight - 1);
        }
    }

    /** Slots a new dispatch would get without waiting. */
    available(): number {
        return Math.max(0, this.max - this.inFlight - this.waiters.length);
    }
}

const semaphores: Map<string, Semaphore> = new Map();

/**
 * Heavy kinds share ONE pool (the proofs compete for the same prover); workflow
 * parents get their own, since a parent waits on heavy children and must never
 * hold a slot they need. Serial and light caps stay per kind.
 */
function concurrencyClass(kind: string): { key: string; cap: 'heavy' | 'light' | 'serial' } {
    const traits = jobKindTraits(kind);
    if (traits.serial) return { key: `serial:${kind}`, cap: 'serial' };
    if (traits.workflowParent) return { key: 'workflow', cap: 'heavy' };
    if (traits.heavy) return { key: 'heavy', cap: 'heavy' };
    return { key: `light:${kind}`, cap: 'light' };
}

function getSemaphore(kind: string): Semaphore {
    const { key, cap } = concurrencyClass(kind);
    const cached = semaphores.get(key);
    if (cached) return cached;
    const userCaps = ((cds.env as any).requires?.nightgate?.jobs?.concurrency || {}) as { heavy?: number; light?: number; serial?: number };
    const max = typeof userCaps[cap] === 'number' ? userCaps[cap]! : DEFAULT_CONCURRENCY[cap];
    const sem = new Semaphore(max);
    semaphores.set(key, sem);
    return sem;
}

let cachedNetwork: 'preprod' | 'testnet' | 'mainnet' | undefined;

function getNetwork(): 'preprod' | 'testnet' | 'mainnet' {
    if (!cachedNetwork) {
        try {
            cachedNetwork = resolveNightgateRuntimeConfig(getNightgatePluginConfig()).network as
                'preprod' | 'testnet' | 'mainnet';
        } catch {
            cachedNetwork = 'preprod';
        }
    }
    return cachedNetwork;
}

/**
 * Dispatch after commit: must use the same `cds.context` check as startJob's
 * insert, so a row on the caller's tx dispatches on 'succeeded' (never on
 * rollback). A lost hook is recovered by the command poller.
 */
export function scheduleJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    const ctx = cds.context as { on?: (event: string, handler: () => void) => void } | undefined;
    if (!ctx) return dispatchJob(jobId, kind, legacyWork);
    if (typeof ctx.on === 'function') {
        ctx.on('succeeded', () => dispatchJob(jobId, kind, legacyWork));
        return;
    }
    // No commit signal (only mock contexts lack `.on`): dispatch now. An
    // uncommitted row is not claimable; the poller picks it up after commit.
    cds.log('nightgate').warn(
        `startJob(${kind}): ambient context without lifecycle events; dispatching job ${jobId} immediately (its row may not be committed yet)`
    );
    dispatchJob(jobId, kind, legacyWork);
}

// Dispatches in flight in this process; the poller skips them (once per lease, not per tick).
const dispatching = new Set<string>();

/** Queued this long with a free slot: the claim path was slow, log it. */
const CLAIM_LATENCY_WARN_MS = 15_000;

function dispatchJob(jobId: string, kind: string, legacyWork?: () => Promise<unknown>): void {
    if (dispatching.has(jobId)) return;
    // The row stays pending for the process that holds the lease now.
    if (isBackgroundFenced()) return;
    dispatching.add(jobId);
    const semaphore = getSemaphore(kind);
    const dispatchedAt = Date.now();
    setImmediate(() => void runWithoutAmbientTx(async () => {
        try {
            await semaphore.acquire();
        } catch (err) {
            dispatching.delete(jobId);
            throw err;
        }
        const semaphoreWaitMs = Date.now() - dispatchedAt;
        try {
            const claimed = await markRunning(jobId);
            if (!claimed) {
                cds.log('nightgate').debug(`startJob(${kind}): job ${jobId} was already claimed or is no longer pending; skipping work`);
                return;
            }
            const stopHeartbeat = startLeaseHeartbeat(jobId);
            try {
                const row = await getJobById(jobId);
                if (!row) throw new Error(`Background job ${jobId} disappeared after claim`);
                const queuedMs = row.queuedAt && row.startedAt ? Date.parse(row.startedAt) - Date.parse(row.queuedAt) : NaN;
                if (queuedMs > CLAIM_LATENCY_WARN_MS && semaphoreWaitMs < 1_000) {
                    cds.log('nightgate').warn(`Job ${jobId} (${kind}) started ${Math.round(queuedMs / 1000)}s after it was queued, with a free slot`);
                }
                const executable = row.command && row.commandVersion
                    ? () => executePersistedCommand(row)
                    : legacyWork;
                if (!executable) throw new Error(`Background job ${jobId} has neither a persisted command nor in-memory work`);
                const result = await runWithoutAmbientTx(() => runInJobExecutionContext(
                    {
                        reportExternalExecution: handle => markJobExternalExecution(jobId, handle),
                        reportSubmitted: handle => markJobSubmitted(jobId, handle),
                        markBroadcastOn: (runner, handle) => markJobBroadcastOn(runner, jobId, handle),
                        markSubmissionRejectedOn: (runner, handle) => markJobSubmissionRejectedOn(runner, jobId, handle)
                    },
                    executable
                ));
                try {
                    await markSucceeded(jobId, result);
                } catch (persistErr) {
                    const current = await getJobById(jobId);
                    if (current?.status === 'failed' && current.errorCode === 'SUPERSEDED') {
                        cds.log('nightgate').info(`markSucceeded(${jobId}): job was superseded mid-run; discarding its result`);
                    } else {
                        cds.log('nightgate').error(
                            `markSucceeded(${jobId}): could not persist the result after ${STATUS_WRITE_ATTEMPTS} attempts; marking failed:RESULT_PERSIST_FAILED`,
                            persistErr
                        );
                        await markFailed(jobId, {
                            code: 'RESULT_PERSIST_FAILED',
                            retryable: false,
                            message: 'The job work completed but its result could not be persisted (database lock contention or a lost worker lease). On-chain effects may exist; verify chain state before retrying.'
                        });
                    }
                }
            } finally {
                stopHeartbeat();
            }
        } catch (err) {
            if (err instanceof WorkflowReconciliationRequiredError) {
                await markReconciliationRequired(jobId, {
                    code: 'CHILD_RECONCILIATION_REQUIRED',
                    message: err.message
                });
            } else {
                const classification = classifySubmissionError(err, getNetwork());
                const current = await getJobById(jobId);
                if (current?.txHash) {
                    cds.log('nightgate').warn(`Job ${jobId} (${current.kind}) failed after announcing ${current.txHash.slice(0, 16)}: ${classification.code}: ${classification.message.slice(0, 300)}`);
                } else if (current?.submissionId) {
                    cds.log('nightgate').warn(`Job ${jobId} (${current.kind}) failed after an announced attempt was closed: ${classification.code}: ${classification.message.slice(0, 300)}`);
                }
                // Only a recorded txHash can mean an on-chain effect; without one
                // the job fails plainly (a false predicate must not need an operator).
                if (current?.status === 'failed' && current.errorCode === 'SUPERSEDED') {
                    cds.log('nightgate').info(
                        `Job ${jobId} errored after being superseded mid-run; keeping SUPERSEDED (dropped: ${classification.code})`
                    );
                } else if (current?.txHash && jobKindTraits(current.kind).identifierKeyed && isCallNotAppliedFailure(err)) {
                    // Outcome proven via the indexer: terminal, no transient reconciliation state.
                    await markChainFailureAfterBroadcast(jobId, current, err);
                } else if (err instanceof SponsorAttemptBookkeepingPendingError && current?.txHash) {
                    // Park under the code settleRejectedSponsorAttempts looks for; the indexer never resolves it.
                    await markReconciliationRequired(jobId, { code: err.code, message: err.message });
                } else if (current?.txHash && classification.code === 'SubmitAmbiguous') {
                    // Not a failure yet: the confirmer ends it from chain evidence or absence past the ttl.
                    await markReconciliationRequired(jobId, {
                        code: BROADCAST_UNCONFIRMED,
                        message: `Broadcast of ${current.txHash} is unconfirmed: ${classification.message}. The job ends succeeded or failed once the indexer shows the transaction, or failed/${BROADCAST_NOT_INCLUDED} once the indexer tip is past its validity window; a new attempt needs a new idempotencyKey either way.`
                    });
                } else if (current?.txHash) {
                    await markReconciliationRequired(jobId, {
                        code: 'EXTERNAL_EXECUTION_FAILED',
                        message: `Execution failed after broadcasting ${current.txHash}; verify chain state before retrying. ${classification.message}`
                    });
                } else {
                    await markFailed(jobId, classification);
                }
            }
        } finally {
            dispatching.delete(jobId);
            semaphore.release();
        }
    }).catch(err => cds.log('nightgate').error(`Detached job ${jobId} crashed outside its guarded execution path`, err)));
}

let commandPollTimer: ReturnType<typeof setInterval> | undefined;

let commandPollActive = false;

/**
 * Start the durable command poller after processors and the wallet worker are
 * ready. The atomic `pending -> running` claim is the final duplicate guard.
 */
export async function startBackgroundJobProcessor(): Promise<void> {
    if (commandPollTimer) return;
    const missing = undeclaredOrUnregisteredJobKinds();
    if (missing.length > 0) {
        throw new Error(`background-job kinds declared without a processor: ${missing.join(', ')} (srv/submission/job-kinds.ts vs the registrations)`);
    }
    await pollPersistedCommands();
    await settleRejectedSponsorAttempts();
    await reconcileBackgroundJobs();
    await refreshSucceededChainOutcomes();
    triggerChainConfirmPass();
    commandPollTimer = setInterval(() => void pollPersistedCommands().catch(err => {
        cds.log('nightgate').warn(`Background-job poll failed: ${String((err as Error)?.message ?? err)}`);
    }), 2000);
    commandPollTimer.unref?.();
}

export function stopBackgroundJobProcessor(): void {
    if (commandPollTimer) clearInterval(commandPollTimer);
    commandPollTimer = undefined;
}

/**
 * Only `running` leases are reclaimable: past the external-effect boundary a
 * second dispatch could spend a second fee, reconciliation resolves those.
 */
const JOB_LEASE_TTL_MS = configMs('NIGHTGATE_JOB_LEASE_TTL_MS');

/** Fail instead of re-queue after this many reclaims: a crash loop must end. */
const MAX_LEASE_RECLAIMS = 3;

/** Re-queue silent `running` jobs; the CAS includes heartbeatAt, so a late heartbeat keeps the lease. */
export async function reclaimExpiredLeases(existingDb?: DbRunner): Promise<number> {
    const db = existingDb ?? await cds.connect.to('db');
    const cutoff = new Date(Date.now() - JOB_LEASE_TTL_MS).toISOString();
    const columns = ['ID', 'kind', 'attempt', 'leaseOwner', 'heartbeatAt', 'startedAt', 'commandVersion'];
    const silent = await db.run(
        SELECT.from(BackgroundJobs).columns(...columns).where({ status: 'running', heartbeatAt: { '<': cutoff } }).limit(SCAN_PAGE_SIZE)
    ) as BackgroundJobRow[];
    const neverBeat = await db.run(
        SELECT.from(BackgroundJobs).columns(...columns).where({ status: 'running', heartbeatAt: null, startedAt: { '<': cutoff } }).limit(SCAN_PAGE_SIZE)
    ) as BackgroundJobRow[];
    let reclaimed = 0;
    for (const row of [...(silent ?? []), ...(neverBeat ?? [])]) {
        const guard = { ID: row.ID, status: 'running', leaseOwner: row.leaseOwner ?? null, heartbeatAt: row.heartbeatAt ?? null };
        const attempt = (row.attempt ?? 1) + 1;
        const terminal = !row.commandVersion
            ? 'its work was an in-process closure that died with the lease owner'
            : attempt > MAX_LEASE_RECLAIMS + 1
                ? `its lease expired ${MAX_LEASE_RECLAIMS} times`
                : null;
        const patch: Record<string, unknown> = terminal
            ? {
                status: 'failed', errorCode: 'LEASE_EXPIRED',
                errorMessage: `no heartbeat from ${row.leaseOwner ?? 'unknown owner'} for more than ${JOB_LEASE_TTL_MS} ms; ${terminal}`.slice(0, 4000),
                finishedAt: new Date().toISOString(), leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null
            }
            : { status: 'pending', attempt, startedAt: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null };
        const affected = await withStatusWriteRetry(`reclaimLease(${row.ID})`, () => db.run(
            UPDATE.entity(BackgroundJobs).set(patch).where(guard)
        ));
        if (affectedRows(affected) !== 1) continue;
        reclaimed++;
        (terminal ? cds.log('nightgate').error : cds.log('nightgate').warn).call(cds.log('nightgate'),
            `lease of ${row.kind} job ${row.ID} held by ${row.leaseOwner ?? 'unknown'} expired (no heartbeat since ${row.heartbeatAt ?? row.startedAt}): ` +
            (terminal ? `failed LEASE_EXPIRED, ${terminal}` : `re-queued as attempt ${attempt}`));
    }
    return reclaimed;
}

async function pollPersistedCommands(): Promise<void> {
    if (commandPollActive) return;
    commandPollActive = true;
    try {
        const db = await cds.connect.to('db');
        await reclaimExpiredLeases(db);
        const rows = await db.run(
            SELECT.from(BackgroundJobs)
                .columns('ID', 'kind', 'commandVersion')
                .where({ status: 'pending', commandVersion: { '!=': null } })
                .orderBy('createdAt asc')
                .limit(100)
        );
        // Dispatch only up to free capacity; the rest waits for the next tick.
        const budget = new Map<Semaphore, number>();
        for (const row of rows as Array<{ ID: string; kind: string; commandVersion: number }>) {
            if (dispatching.has(row.ID)) continue;
            if (!processors.has(processorKey(row.kind, row.commandVersion))) continue;
            const semaphore = getSemaphore(row.kind);
            const free = budget.get(semaphore) ?? semaphore.available();
            if (free <= 0) continue;
            budget.set(semaphore, free - 1);
            scheduleJob(row.ID, row.kind);
        }
        await settleRejectedSponsorAttempts(db);
        await reconcileBackgroundJobs(db);
        await refreshSucceededChainOutcomes(db);
        triggerChainConfirmPass();
    } finally {
        commandPollActive = false;
    }
}

export function __pollOnceForTests(): Promise<void> { return pollPersistedCommands(); }

/** Test hook: stop the poller, drop semaphores and in-flight dispatch marks. */
export function __resetSchedulerForTests(): void {
    dispatching.clear();
    stopBackgroundJobProcessor();
    semaphores.clear();
    cachedNetwork = undefined;
    commandPollActive = false;
}
