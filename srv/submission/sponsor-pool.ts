/**
 * Sponsor pool leases + failover. A wallet carries ONE dust spend in flight, so
 * concurrency scales with the number of sponsors. In-memory: one instance per
 * wallet set. SPDX-License-Identifier: Apache-2.0
 */

import { classifySubmitFailure } from '../midnight/submit-error-classification';

/**
 * Names the pool instead of one sponsor session. A reserved UUID because every
 * surface carrying it is typed UUID; a plain string fails OData deserialization.
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

/** Sponsors at the sync gate rank first; lagging ones stay candidates behind them. */
export type SponsorAtGate = (sponsorSessionId: string) => boolean;

function gateRank(id: string, atGate?: SponsorAtGate): number {
    return atGate && !atGate(id) ? 1 : 0;
}

/** Free and not cooling; gate rank first, then least recently used. */
export function pickFreeSponsor(poolIds: string[], now: number = Date.now(), atGate?: SponsorAtGate): string | null {
    let best: string | null = null;
    let bestRank = Infinity;
    let bestUsed = Infinity;
    for (const id of poolIds) {
        const s = lane(id);
        if (s.busy || s.cooldownUntil > now) continue;
        const rank = gateRank(id, atGate);
        if (rank < bestRank || (rank === bestRank && s.lastUsed < bestUsed)) {
            best = id;
            bestRank = rank;
            bestUsed = s.lastUsed;
        }
    }
    return best;
}

/** Lease a sponsor, waiting up to `waitMs` for one to free up. */
export async function acquireSponsor(poolIds: string[], waitMs: number, atGate?: SponsorAtGate): Promise<string> {
    if (poolIds.length === 0) throw new Error('sponsor pool is empty (NIGHTGATE_FEE_SPONSOR_SESSION)');
    const deadline = Date.now() + waitMs;
    for (;;) {
        const id = pickFreeSponsor(poolIds, Date.now(), atGate);
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
 * Failures caused by the sponsor's own state, worth trying the next sponsor.
 * Caller-side failures (policy, deserialization, pool Invalid) must not burn the pool.
 */
export function isRetryableSponsorFailure(err: unknown): boolean {
    if ((err as any)?.name === 'FeeSponsorError') return true;
    const info = classifySubmitFailure(err);
    if (info.code === 'dust-race') return info.ledgerCode !== 'pool-invalid';
    if (info.code !== 'internal') return false;
    // Sponsor-health failures cross the worker RPC without a code, so match by wording.
    const msg = String((err as any)?.message ?? err ?? '');
    return /genuine(ly)? sync|not caught up|sync.*(timeout|timed out|stalled)|not synced to tip|No facade for sponsorSessionId|dust.*(stale|validity)|WALLET_SYNCING|Sponsor session/i.test(msg);
}

/** Transient dust race (1010/170, 1010/196, pool Invalid): rebuild on the SAME sponsor. */
export function isDustRaceFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'dust-race';
}

/** In a block but the call did not apply: terminal, only the caller can rebuild. */
export function isCallNotAppliedFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'landed-not-applied';
}

/**
 * The attempt cannot be on-chain, so clearing the job's hash and rebuilding is
 * safe. Never matches landed-not-applied or ambiguous.
 */
export function isPreInclusionReject(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    if (info.code === 'pre-mempool-reject' || info.code === 'dust-race') return true;
    // The request never left the client.
    return info.code === 'transport' && (info.ledgerCode === 'closing-socket' || info.ledgerCode === 'not-sent');
}

/**
 * The broadcast may still land. Never rebuild (two identifiers, two fees);
 * the job goes to reconciliation_required.
 */
export function isAmbiguousSubmitOutcome(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'ambiguous';
}

/**
 * Uncoded pool Invalid, indistinguishable from an invalid caller tx; each retry
 * costs a sponsor dust proof, so it gets at most one rebuild.
 */
export function isGenericInvalidFailure(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    return info.code === 'dust-race' && info.ledgerCode === 'pool-invalid';
}

/** One failure table for the finalized and the unbound sponsoring channel. */
export type SponsorFailureDecision = 'ambiguous' | 'landed-not-applied' | 'dust-rebuild' | 'failover' | 'fail';

export function decideSponsorFailure(err: unknown): { decision: SponsorFailureDecision; generic: boolean; preInclusion: boolean } {
    const info = classifySubmitFailure(err);
    const preInclusion = isPreInclusionReject(err);
    if (info.code === 'ambiguous') return { decision: 'ambiguous', generic: false, preInclusion: false };
    if (info.code === 'landed-not-applied') return { decision: 'landed-not-applied', generic: false, preInclusion: false };
    // Before failover: a dust race means a healthy sponsor whose dust state lags.
    if (info.code === 'dust-race') return { decision: 'dust-rebuild', generic: info.ledgerCode === 'pool-invalid', preInclusion };
    if (isRetryableSponsorFailure(err)) return { decision: 'failover', generic: false, preInclusion };
    return { decision: 'fail', generic: false, preInclusion };
}

/**
 * Candidate order for the unbound path, no lease (the worker locks per backing).
 * Cooling sponsors are excluded, not ranked last.
 */
export function sponsorCandidatesNonExclusive(poolIds: string[], now: number = Date.now(), atGate?: SponsorAtGate): string[] {
    return poolIds
        .filter((id) => lane(id).cooldownUntil <= now)
        .map((id) => ({ id, rank: gateRank(id, atGate) }))
        .sort((a, b) => a.rank - b.rank || lane(a.id).lastUsed - lane(b.id).lastUsed)
        .map((c) => c.id);
}

/** Update LRU without taking a lease. */
export function touchSponsor(id: string): void { lane(id).lastUsed = Date.now(); }

/** Test seam. */
export function __resetSponsorPoolForTests(): void {
    lanes.clear();
}
