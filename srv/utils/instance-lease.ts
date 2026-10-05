/**
 * Only one process per database may run background work such as jobs and the crawler.
 * That process holds a row in `InstanceLeases` (the "lease") and refreshes it regularly. A clean shutdown deletes the row.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { NightgateError } from './errors';
import { InstanceLeases } from '#cds-models/midnight';
import type { DbRunner } from './db-types';
import { isUniqueViolation } from './db-errors';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

export const BACKGROUND_LEASE_ROLE = 'background';

export type LeaseAttempt =
    | { acquired: true }
    | { acquired: false; holder: string; heartbeatAgeMs: number };

export class InstanceLeaseHeldError extends NightgateError {
    constructor(readonly holder: string, readonly heartbeatAgeMs: number) {
        super('INSTANCE_LEASE_HELD', `another NIGHTGATE instance (${holder}) runs the background work on this database `
            + `(heartbeat ${Math.round(heartbeatAgeMs / 1000)} s ago); one database serves one instance`);
    }
}

// The lease this process holds, and whether it lost it ("fenced").
// A fenced process starts no jobs, refuses writes and never sends a transaction again.
let activeLease: { role: string; holder: string } | null = null;
let fenced = false;

export function setActiveLease(role: string, holder: string): void {
    activeLease = { role, holder };
    fenced = false;
}

export function clearActiveLease(): void {
    activeLease = null;
}

export function fenceBackgroundWork(): void {
    fenced = true;
}

export function isBackgroundFenced(): boolean {
    return fenced;
}

/**
 * Called right before a transaction is sent. Throws unless the lease row still names this process.
 * A process without a lease, as in tests or with SKIP_AUTO_INIT, is not checked.
 */
export async function assertLeaseHeld(db: DbRunner): Promise<void> {
    if (fenced) throw leaseLostError();
    if (!activeLease) return;
    const row = await db.run(SELECT.one.from(InstanceLeases).columns('instanceId').where({ role: activeLease.role }));
    if (row?.instanceId !== activeLease.holder) {
        fenced = true;
        throw leaseLostError();
    }
}

function leaseLostError(): NightgateError {
    return new NightgateError('INSTANCE_LEASE_HELD',
        'this process lost the instance lease to another NIGHTGATE process on the same database; nothing was broadcast',
        { exposeMessage: true });
}

export function __resetInstanceLeaseForTests(): void {
    activeLease = null;
    fenced = false;
}

function affected(value: unknown): number {
    return typeof value === 'number' ? value : Number((value as { changes?: number } | null)?.changes ?? 0);
}

/**
 * Takes the lease when it is ours, free, or not refreshed for `ttlMs`.
 * Otherwise returns the process that holds it.
 */
export async function tryAcquireInstanceLease(
    db: DbRunner, role: string, holder: string, ttlMs: number, now: number = Date.now(), afterInsertRace = false
): Promise<LeaseAttempt> {
    const nowIso = new Date(now).toISOString();
    if (affected(await db.run(UPDATE.entity(InstanceLeases).set({ heartbeatAt: nowIso }).where({ role, instanceId: holder }))) > 0) {
        return { acquired: true };
    }
    // The update only matches a stale row, so if two processes try at once only one wins.
    const staleBefore = new Date(now - ttlMs).toISOString();
    const takeover = await db.run(UPDATE.entity(InstanceLeases)
        .set({ instanceId: holder, acquiredAt: nowIso, heartbeatAt: nowIso })
        .where({ role }).and({ heartbeatAt: { '<': staleBefore } }));
    if (affected(takeover) > 0) return { acquired: true };
    const row = await db.run(SELECT.one.from(InstanceLeases).columns('instanceId', 'heartbeatAt').where({ role }));
    if (!row) {
        try {
            await db.run(INSERT.into(InstanceLeases).entries({ role, instanceId: holder, acquiredAt: nowIso, heartbeatAt: nowIso }));
            return { acquired: true };
        } catch (err) {
            // Another process inserted first. One more pass reports who holds it.
            if (!isUniqueViolation(err) || afterInsertRace) throw err;
            return tryAcquireInstanceLease(db, role, holder, ttlMs, now, true);
        }
    }
    const age = row.heartbeatAt ? Math.max(0, now - Date.parse(String(row.heartbeatAt))) : 0;
    return { acquired: false, holder: String(row.instanceId), heartbeatAgeMs: age };
}

/**
 * Like `tryAcquireInstanceLease`, but waits for a lease left by a killed process to expire.
 * Throws InstanceLeaseHeldError when the holder keeps refreshing it.
 */
export async function acquireInstanceLease(
    db: DbRunner, role: string, holder: string, ttlMs: number,
    opts: { pollMs?: number; onWait?: (holder: string, waitMs: number) => void } = {}
): Promise<void> {
    const pollMs = opts.pollMs ?? Math.max(1000, Math.floor(ttlMs / 6));
    let deadline: number | undefined;
    for (;;) {
        const attempt = await tryAcquireInstanceLease(db, role, holder, ttlMs);
        if (attempt.acquired) return;
        const now = Date.now();
        // A live holder refreshes within one ttl. Wait that long before giving up.
        deadline ??= now + ttlMs;
        if (now >= deadline) throw new InstanceLeaseHeldError(attempt.holder, attempt.heartbeatAgeMs);
        opts.onWait?.(attempt.holder, deadline - now);
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline! - now)));
    }
}

/** Refreshes the lease. Returns false when another process has taken it over. */
export async function renewInstanceLease(db: DbRunner, role: string, holder: string): Promise<boolean> {
    const n = await db.run(UPDATE.entity(InstanceLeases).set({ heartbeatAt: new Date().toISOString() }).where({ role, instanceId: holder }));
    return affected(n) > 0;
}

export async function releaseInstanceLease(db: DbRunner, role: string, holder: string): Promise<void> {
    await db.run(DELETE.from(InstanceLeases).where({ role, instanceId: holder }));
}

/**
 * Refreshes the lease every `intervalMs`. Calls `onLost` once when another process holds it.
 * A failed write is only reported. The next tick retries before the lease expires.
 */
export function startInstanceLeaseHeartbeat(
    db: DbRunner, role: string, holder: string, intervalMs: number,
    onLost: () => void, onError: (err: unknown) => void
): () => void {
    let stopped = false;
    const timer = setInterval(() => {
        void renewInstanceLease(db, role, holder).then(ok => {
            if (!ok && !stopped) { stopped = true; clearInterval(timer); onLost(); }
        }, onError);
    }, intervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
}
