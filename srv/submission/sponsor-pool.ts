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

import { classifySubmitFailure } from '../midnight/submit-error-classification';

/**
 * Grants/requests may name this instead of a concrete sponsor session. A
 * RESERVED UUID (the tail spells 'pool' in hex), because every surface that
 * carries it (OData action params and returns, getJobStatus polling, the
 * AgentGrants.sponsorSessionId column) is typed UUID end to end; a plain
 * string would be rejected by OData deserialization before any handler ran.
 */
export const PLATFORM_POOL_SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';

interface SponsorLane {
    busy: boolean;
    lastUsed: number;
    cooldownUntil: number;
}

const lanes = new Map<string, SponsorLane>();

function lane(id: string): SponsorLane {
    let s = lanes.get(id);
    if (!s) {
        s = { busy: false, lastUsed: 0, cooldownUntil: 0 };
        lanes.set(id, s);
    }
    return s;
}

/** Free, not cooling, least-recently-used first. Null when none is free. */
export function pickFreeSponsor(poolIds: string[], now: number = Date.now()): string | null {
    let best: string | null = null;
    let bestUsed = Infinity;
    for (const id of poolIds) {
        const s = lane(id);
        if (s.busy || s.cooldownUntil > now) continue;
        if (s.lastUsed < bestUsed) {
            best = id;
            bestUsed = s.lastUsed;
        }
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
 * A coded dust race (170/196) counts too: once the same-sponsor rebuilds are
 * exhausted the next wallet may hold a fresher dust state; a pool-status
 * Invalid does not (it is the caller's bytes, not the sponsor's health).
 */
export function isRetryableSponsorFailure(err: unknown): boolean {
    // Resolution failures of a POOL member (expired, no signing key, gone)
    // are sponsor-state problems by definition.
    if ((err as any)?.name === 'FeeSponsorError') return true;
    const info = classifySubmitFailure(err);
    if (info.code === 'dust-race') return info.ledgerCode !== 'pool-invalid';
    if (info.code !== 'internal') return false;
    // Sponsor-health failures are not submit failures and never cross the
    // worker RPC with a code (sync gates, facade lookup, session rows), so
    // they are recognised by their wording. Pinned in sponsor-pool.test.ts.
    const msg = String((err as any)?.message ?? err ?? '');
    return /genuine(ly)? sync|not caught up|sync.*(timeout|timed out|stalled)|not synced to tip|No facade for sponsorSessionId|dust.*(stale|validity)|WALLET_SYNCING|Sponsor session/i.test(msg);
}

/**
 * A TRANSIENT dust race: `1010/170` (InvalidDustSpendProof: stale merkle root
 * or validity window), `1010/196` (the spent note's nullifier is already
 * known: a concurrent spend on the same note) or a pool status Invalid (the
 * loser reached the pool, the winner consumed the note first). The fix is to
 * REBUILD the dust spend fresh on the SAME sponsor and resubmit, once the
 * local dust wallet has caught up. NOT a dust race: a transaction in a block
 * whose call did not apply (the caller's transcript lost, only the caller
 * can rebuild), and a watch timeout (ambiguous, never rebuild).
 */
export function isDustRaceFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'dust-race';
}

/**
 * The transaction is in a block but its contract call did not apply
 * (PARTIAL_SUCCESS): terminal for this job. The caller's transcript is stale
 * (same-contract conflict); the attempt row records it, the job fails with
 * the identifier, the caller rebuilds against the current contract state.
 */
export function isCallNotAppliedFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'landed-not-applied';
}

/**
 * The announced attempt can NOT be on-chain: a node reject at admission,
 * pool status Invalid, the send died on the client's own closing socket, or
 * the main thread nacked the intent. Safe to clear the job's hash and
 * rebuild; an exhausted run of these is a plain `failed`. Deliberately NOT
 * matched: landed-not-applied (the tx IS on-chain) and ambiguous.
 */
export function isPreInclusionReject(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    if (info.code === 'pre-mempool-reject' || info.code === 'dust-race') return true;
    return info.code === 'transport' && info.ledgerCode === 'closing-socket';
}

/**
 * The watch died and the indexer did not know the transaction within the
 * confirmation window: the broadcast MAY still be included later. Never
 * rebuild on this (two different identifiers, at least two fees could land);
 * the job must end in reconciliation_required with the identifier and be
 * resolved by the indexer confirmer.
 */
export function isAmbiguousSubmitOutcome(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'ambiguous';
}

/**
 * The GENERIC pool-status Invalid (no ledger code) cannot be told apart from
 * a caller transaction that is structurally allowed but cryptographically
 * invalid; every retry of it costs a full sponsor dust proof. Such failures
 * get at most ONE rebuild, the coded rejects keep the configured retries.
 */
export function isGenericInvalidFailure(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    return info.code === 'dust-race' && info.ledgerCode === 'pool-invalid';
}

/**
 * What a sponsoring executor does with a failed attempt. ONE table for the
 * finalized (exclusive lease) and the unbound (parallel) channel:
 *
 *  ambiguous           leave the attempt row pending, the job reconciles by identifier
 *  landed-not-applied  terminal: on-chain, the caller's call lost
 *  dust-rebuild        close the attempt, rebuild fresh on the SAME sponsor
 *                      (`generic`: pool Invalid, one rebuild only)
 *  failover            close the attempt, bench this sponsor, try the next candidate
 *  fail                close the attempt, fail the job (policy, causality,
 *                      transport, unknown): identical on every sponsor
 */
export type SponsorFailureDecision = 'ambiguous' | 'landed-not-applied' | 'dust-rebuild' | 'failover' | 'fail';

export function decideSponsorFailure(err: unknown): { decision: SponsorFailureDecision; generic: boolean; preInclusion: boolean } {
    const info = classifySubmitFailure(err);
    const preInclusion = isPreInclusionReject(err);
    if (info.code === 'ambiguous') return { decision: 'ambiguous', generic: false, preInclusion: false };
    if (info.code === 'landed-not-applied') return { decision: 'landed-not-applied', generic: false, preInclusion: false };
    // Dust race wins over the generic bench: the sponsor is healthy, its dust
    // state merely lags; benching it and failing over would waste the pool.
    if (info.code === 'dust-race') return { decision: 'dust-rebuild', generic: info.ledgerCode === 'pool-invalid', preInclusion };
    if (isRetryableSponsorFailure(err)) return { decision: 'failover', generic: false, preInclusion };
    return { decision: 'fail', generic: false, preInclusion };
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
