/**
 * Platform sponsor POOL (0.17.2): lease-based selection + failover across the
 * sessions in `NIGHTGATE_FEE_SPONSOR_SESSION`.
 *
 * Why leases: a wallet can carry ONE dust spend in flight (the dust-wedge
 * snapshot/restore machinery assumes it, and concurrent balances on one wallet
 * race its dust notes into 1010 rejects, which is exactly why the try-it demo
 * leased one sponsor per visitor run). Concurrency therefore scales with the
 * NUMBER of sponsor wallets, and this module is the traffic cop: each
 * sponsored submission leases one sponsor for its duration, callers queue on
 * the pool rather than on one wallet, and a sponsor that just failed sits out
 * a cooldown while the job retries the next one.
 *
 * In-memory by design: leases guard the wallet worker of THIS process, and the
 * supported topology is one instance per wallet set (same rule as the sqlite
 * topology guard). A second instance sharing the same sponsor wallets would
 * race dust notes no matter what a table said.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Grants/requests may name this instead of a concrete sponsor session. A
 * RESERVED UUID (the tail spells 'pool' in hex), because every surface that
 * carries it (OData action params and returns, getJobStatus polling, the
 * AgentGrants.sponsorSessionId column) is typed UUID end to end; a plain
 * string would be rejected by OData deserialization before any handler ran.
 */
export const PLATFORM_POOL_SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';

interface LaneState {
    busy: boolean;
    lastUsed: number;
    cooldownUntil: number;
}

const lanes = new Map<string, LaneState>();

function lane(id: string): LaneState {
    let s = lanes.get(id);
    if (!s) { s = { busy: false, lastUsed: 0, cooldownUntil: 0 }; lanes.set(id, s); }
    return s;
}

/** Free, not cooling, least-recently-used first. Null when none is free. */
export function pickFreeSponsor(poolIds: string[], now: number = Date.now()): string | null {
    let best: string | null = null;
    let bestUsed = Infinity;
    for (const id of poolIds) {
        const s = lane(id);
        if (s.busy || s.cooldownUntil > now) continue;
        if (s.lastUsed < bestUsed) { best = id; bestUsed = s.lastUsed; }
    }
    return best;
}

/**
 * Lease a sponsor, waiting up to `waitMs` for one to free up. Rejects with a
 * clear message when the whole pool stays busy: the caller's transaction is
 * unaffected and can be resubmitted (its TTL permitting).
 */
export async function acquireSponsor(poolIds: string[], waitMs: number): Promise<string> {
    if (poolIds.length === 0) throw new Error('sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
    const deadline = Date.now() + waitMs;
    for (;;) {
        const id = pickFreeSponsor(poolIds);
        if (id) {
            const s = lane(id);
            s.busy = true;
            s.lastUsed = Date.now();
            return id;
        }
        if (Date.now() >= deadline) {
            throw new Error(`all ${poolIds.length} pool sponsors are busy or cooling down; resubmit shortly`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

export function releaseSponsor(id: string): void {
    lane(id).busy = false;
}

/** Bench a sponsor after a failure so retries move on instead of re-hitting it. */
export function benchSponsor(id: string, cooldownMs: number): void {
    const s = lane(id);
    s.busy = false;
    s.cooldownUntil = Date.now() + cooldownMs;
}

/**
 * Failures worth trying the NEXT sponsor for: the sponsor's own state is the
 * problem (cold facade, sync gap, stale dust, an expired or key-less session
 * row), not the caller's transaction. A policy refusal or a deserialization
 * error would fail on every sponsor identically and must NOT burn the pool.
 */
export function isRetryableSponsorFailure(err: unknown): boolean {
    // Resolution failures of a POOL member (expired, no signing key, gone)
    // are sponsor-state problems by definition.
    if ((err as Error)?.name === 'FeeSponsorError') return true;
    const msg = String((err as Error)?.message ?? err ?? '');
    return /genuine(ly)? sync|not caught up|sync.*(timeout|timed out)|No facade for sponsorSessionId|Custom error:? ?170|1010\/170|dust.*(stale|validity)|WALLET_SYNCING|Sponsor session/i.test(msg);
}

/**
 * Env-configured duration, fail-safe: anything that is not a finite
 * non-negative integer falls back to the default. 'abc' or 'Infinity' would
 * otherwise turn a bounded wait into an unbounded one (NaN deadline).
 */
export function envMsSetting(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Test seam. */
export function __resetSponsorPoolForTests(): void {
    lanes.clear();
}
