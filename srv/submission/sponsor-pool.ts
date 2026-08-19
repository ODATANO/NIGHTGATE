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
    return /genuine(ly)? sync|not caught up|sync.*(timeout|timed out)|No facade for sponsorSessionId|Custom error:? ?(170|196)\b|1010\/(170|196)\b|InvalidDustSpendProof|dust.*(stale|validity)|WALLET_SYNCING|Sponsor session/i.test(msg);
}

/**
 * A TRANSIENT dust race: the dust spend was built against a dust state the
 * node has already moved past. `1010/170` (InvalidDustSpendProof: stale
 * merkle root / validity window) and `1010/196` (the spent note's nullifier is
 * already known to the node: a concurrent spend on the same note, live-proven
 * by forcing two sponsorings onto one note). Unlike a sponsor-health failure it
 * must NOT bench the sponsor; the fix is to REBUILD the dust spend fresh on the
 * SAME sponsor and resubmit (the consumer-side rebuild-on-170 pattern), once
 * the local dust wallet has caught up. Kept deliberately narrower than
 * {@link isRetryableSponsorFailure}, so a genuinely unhealthy sponsor still
 * fails over. The same race surfaces as `TransactionInvalidError` (pool status
 * Invalid: the tx was accepted, then a competing tx consumed the note first)
 * when the loser reached the pool before the winner landed. Both are also what
 * a conflicting write to the SAME contract state can surface as; the retries
 * are then wasted but harmless, the job still fails. Matches the worker's
 * message, which carries the cause chain (formatErrWithCauses), so the node's
 * line is visible on this side. NOT a dust race: a transaction that sits in
 * a block with its contract call NOT applied (ledger PARTIAL_SUCCESS). That
 * is the CALLER's transcript losing to a concurrent write on the same
 * contract; only the caller can rebuild it against the current state, the
 * sponsor re-attaching fresh dust to the same caller bytes is rejected at
 * admission every time (live: 6 losers x 4 retries x 1010). Also NOT a
 * dust race: `submit watch timed out` (ambiguous, see
 * isAmbiguousSubmitOutcome).
 */
export function isDustRaceFailure(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err ?? '');
    return /Custom error:? ?(170|196)\b|1010\/(170|196)\b|InvalidDustSpendProof|TransactionInvalidError|Transaction is invalid and was rejected by the node/i.test(msg);
}

/**
 * The transaction is in a block but its contract call did not apply
 * (PARTIAL_SUCCESS): terminal for this job. The caller's transcript is stale
 * (same-contract conflict); the attempt row records it, the job fails with
 * the identifier, the caller rebuilds against the current contract state.
 */
export function isCallNotAppliedFailure(err: unknown): boolean {
    return /did NOT apply/i.test(String((err as Error)?.message ?? err ?? ''));
}

/**
 * The announced attempt can NOT be on-chain: a node reject at admission
 * (1010/*), pool status Invalid, the send died on the client's own closing
 * socket, or the main thread nacked the intent. Safe to clear the job's hash
 * and rebuild; an exhausted run of these is a plain `failed`. Deliberately
 * NOT matched: `did NOT apply` (the tx IS on-chain, only the call lost; the
 * attempt row records that) and `submit watch timed out` (ambiguous).
 */
export function isPreInclusionReject(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err ?? '');
    return /Custom error:? ?\d+|1010\/\d+|1010:\s*Invalid|InvalidDustSpendProof|TransactionInvalidError|Transaction is invalid and was rejected by the node|closing socket|submit-intent (rejected|was not acknowledged)/i.test(msg)
        && !/did NOT apply/i.test(msg);
}

/**
 * The watch died and the indexer did not know the transaction within the
 * confirmation window: the broadcast MAY still be included later. Never
 * rebuild on this (two different identifiers, at least two fees could land);
 * the job must end in reconciliation_required with the identifier and be
 * resolved by the indexer confirmer.
 */
export function isAmbiguousSubmitOutcome(err: unknown): boolean {
    return /submit watch timed out/i.test(String((err as Error)?.message ?? err ?? ''));
}

/**
 * The GENERIC pool-status Invalid (`TransactionInvalidError` without a ledger
 * code) cannot be told apart from a caller transaction that is structurally
 * allowed but cryptographically invalid; every retry of it costs a full
 * sponsor dust proof. Such failures get at most ONE rebuild (enough for the
 * genuine race seen live), the coded rejects keep the configured retries.
 */
export function isGenericInvalidFailure(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err ?? '');
    return /TransactionInvalidError|Transaction is invalid and was rejected by the node/i.test(msg)
        && !/Custom error:? ?\d+|1010\/\d+|InvalidDustSpendProof|did NOT apply/i.test(msg);
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

/**
 * Non-exclusive candidate order for the UNBOUND note-pool path: sponsors in
 * cooldown are EXCLUDED (a bench means "do not use until the cooldown ends",
 * not "use last"), the rest least-recently-used first. No lease is taken here
 * (per-backing locking in the worker handles concurrency); this only spreads
 * load and applies failover cooldowns. When EVERY member is cooling the list
 * is empty and the job fails fast with a clear message instead of re-hitting
 * a sponsor that was just benched.
 */
export function sponsorCandidatesNonExclusive(poolIds: string[], now: number = Date.now()): string[] {
    return poolIds
        .filter((id) => lane(id).cooldownUntil <= now)
        .sort((a, b) => lane(a).lastUsed - lane(b).lastUsed); // LRU
}

/** Mark a non-exclusive use (updates LRU without taking a lease). */
export function touchSponsor(id: string): void { lane(id).lastUsed = Date.now(); }

/** Test seam. */
export function __resetSponsorPoolForTests(): void {
    lanes.clear();
}
