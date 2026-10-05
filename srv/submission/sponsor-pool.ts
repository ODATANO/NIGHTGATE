/**
 * Picks a sponsor wallet from the pool and decides what to do when one fails.
 * State is kept in memory, so each server process needs its own set of wallets.
 * SPDX-License-Identifier: Apache-2.0
 */

import { classifySubmitFailure } from '../midnight/submit-error-classification';
import { findNightgateError } from '../utils/errors';

/**
 * Stands for "any sponsor from the pool" instead of one sponsor session.
 * It is a UUID because every field that carries it is typed as UUID in OData.
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

/** True when the sponsor's wallet is synced enough. Such sponsors are tried first, the others after them. */
export type SponsorAtGate = (sponsorSessionId: string) => boolean;

function gateRank(id: string, atGate?: SponsorAtGate): number {
    return atGate && !atGate(id) ? 1 : 0;
}

/** A sponsor that is neither busy nor paused. Prefers synced ones, then the least recently used. */
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

/** Pauses a sponsor after a failure, so retries use another one. */
export function benchSponsor(id: string, cooldownMs: number): void {
    const s = lane(id);
    s.busy = false;
    s.cooldownUntil = Date.now() + cooldownMs;
}

/**
 * True for failures caused by the sponsor's own state, where the next sponsor may succeed.
 * Failures caused by the caller's transaction return false, so they do not pause every sponsor.
 */
export function isRetryableSponsorFailure(err: unknown): boolean {
    const coded = findNightgateError(err)?.code;
    if (coded === 'WALLET_NOT_SYNCED' || coded === 'FEE_SPONSOR_UNUSABLE') return true;
    if ((err as any)?.name === 'FeeSponsorError') return true;
    const info = classifySubmitFailure(err);
    if (info.code === 'dust-race') return info.ledgerCode !== 'pool-invalid';
    if (info.code !== 'internal') return false;
    // These failures arrive from the worker without an error code, so match the message text.
    const msg = String((err as any)?.message ?? err ?? '');
    return /genuine(ly)? sync|not caught up|sync.*(timeout|timed out|stalled)|not synced to tip|No facade for sponsorSessionId|dust.*(stale|validity)|WALLET_SYNCING|Sponsor session/i.test(msg);
}

/** A short-lived dust conflict. Rebuild with the same sponsor. */
export function isDustRaceFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'dust-race';
}

/** The tx is in a block but its contract call failed. Final: only the caller can build a new one. */
export function isCallNotAppliedFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'landed-not-applied';
}

/** The tx cannot be on chain, so removing its hash from the job and rebuilding is safe. */
export function isPreInclusionReject(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    if (info.code === 'pre-mempool-reject' || info.code === 'dust-race') return true;
    // The request never left the client.
    return info.code === 'transport'
        && (info.ledgerCode === 'closing-socket' || info.ledgerCode === 'not-sent' || info.ledgerCode === 'wallet-not-synced');
}

/**
 * The tx may still land. Never rebuild, or the fee could be paid twice.
 * The job goes to reconciliation_required.
 */
export function isAmbiguousSubmitOutcome(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'ambiguous';
}

/**
 * The node rejected the tx without a reason. That looks the same as an invalid caller tx.
 * Each retry costs the sponsor a dust proof, so it gets at most one rebuild.
 */
export function isGenericInvalidFailure(err: unknown): boolean {
    const info = classifySubmitFailure(err);
    return info.code === 'dust-race' && info.ledgerCode === 'pool-invalid';
}

/** What to do after a failed sponsoring attempt. Used for both bound and unbound transactions. */
export type SponsorFailureDecision = 'ambiguous' | 'landed-not-applied' | 'dust-rebuild' | 'failover' | 'fail';

export function decideSponsorFailure(err: unknown): { decision: SponsorFailureDecision; generic: boolean; preInclusion: boolean } {
    const info = classifySubmitFailure(err);
    const preInclusion = isPreInclusionReject(err);
    if (info.code === 'ambiguous') return { decision: 'ambiguous', generic: false, preInclusion: false };
    if (info.code === 'landed-not-applied') return { decision: 'landed-not-applied', generic: false, preInclusion: false };
    // Checked before failover: a dust race means the sponsor is fine, its dust state is just behind.
    if (info.code === 'dust-race') return { decision: 'dust-rebuild', generic: info.ledgerCode === 'pool-invalid', preInclusion };
    if (isRetryableSponsorFailure(err)) return { decision: 'failover', generic: false, preInclusion };
    return { decision: 'fail', generic: false, preInclusion };
}

/**
 * Sponsor order for unbound transactions. Reserves nothing, since the worker locks single dust notes.
 * Paused sponsors are left out.
 */
export function sponsorCandidatesNonExclusive(poolIds: string[], now: number = Date.now(), atGate?: SponsorAtGate): string[] {
    return poolIds
        .filter((id) => lane(id).cooldownUntil <= now)
        .map((id) => ({ id, rank: gateRank(id, atGate) }))
        .sort((a, b) => a.rank - b.rank || lane(a.id).lastUsed - lane(b.id).lastUsed)
        .map((c) => c.id);
}

/** Marks the sponsor as just used, without reserving it. */
export function touchSponsor(id: string): void { lane(id).lastUsed = Date.now(); }

/** Test seam. */
export function __resetSponsorPoolForTests(): void {
    lanes.clear();
}
