/**
 * One process per database runs the background work (job loops, restart recovery, crawler):
 * it holds a heartbeated row in `InstanceLeases`. A graceful stop releases it.
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

// The lease this process holds, and whether it lost it: a fenced process dispatches no
// job, refuses write actions and never crosses a broadcast boundary again.
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
 * Before a broadcast boundary commits: the row must still name this process. A process
 * without a lease (tests, SKIP_AUTO_INIT) is not checked.
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

/** Takes the role when it is ours, free, or its heartbeat is older than `ttlMs`; else names the live holder. */
export async function tryAcquireInstanceLease(
    db: DbRunner, role: string, holder: string, ttlMs: number, now: number = Date.now(), afterInsertRace = false
): Promise<LeaseAttempt> {
    const nowIso = new Date(now).toISOString();
    if (affected(await db.run(UPDATE.entity(InstanceLeases).set({ heartbeatAt: nowIso }).where({ role, instanceId: holder }))) > 0) {
        return { acquired: true };
    }
    // CAS on the stale heartbeat: of two instances taking over, one matches.
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
            // Lost the insert race: the row exists now, one more pass reports the winner.
            if (!isUniqueViolation(err) || afterInsertRace) throw err;
            return tryAcquireInstanceLease(db, role, holder, ttlMs, now, true);
        }
    }
    const age = row.heartbeatAt ? Math.max(0, now - Date.parse(String(row.heartbeatAt))) : 0;
    return { acquired: false, holder: String(row.instanceId), heartbeatAgeMs: age };
}

/**
 * `tryAcquireInstanceLease` that waits out a holder whose heartbeat may still expire
 * (a killed process), polling every `pollMs`. A holder that keeps renewing: InstanceLeaseHeldError.
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
        // A live holder renews before its ttl runs out; one full ttl past the first sighting settles it.
        deadline ??= now + ttlMs;
        if (now >= deadline) throw new InstanceLeaseHeldError(attempt.holder, attempt.heartbeatAgeMs);
        opts.onWait?.(attempt.holder, deadline - now);
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline! - now)));
    }
}

/** Renews the heartbeat; false when another instance took the role over. */
export async function renewInstanceLease(db: DbRunner, role: string, holder: string): Promise<boolean> {
    const n = await db.run(UPDATE.entity(InstanceLeases).set({ heartbeatAt: new Date().toISOString() }).where({ role, instanceId: holder }));
    return affected(n) > 0;
}

export async function releaseInstanceLease(db: DbRunner, role: string, holder: string): Promise<void> {
    await db.run(DELETE.from(InstanceLeases).where({ role, instanceId: holder }));
}

/**
 * Heartbeat every `intervalMs`; `onLost` once when the row no longer names `holder`.
 * A failed write only logs: the next tick retries before the ttl runs out.
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
