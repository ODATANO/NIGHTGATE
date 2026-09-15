/**
 * Worker-pushed sync gate verdicts read on the main thread; pool selection
 * prefers sponsors at the gate.
 * SPDX-License-Identifier: Apache-2.0
 */

import { walletGetSyncProgress } from '../midnight/wallet-worker-client';
import { configMs, configNumber } from '../utils/config';

/**
 * A pushed sync reading counts while the worker's progress watch keeps it
 * fresh: two watch intervals, or the progress stale threshold if longer.
 */
function syncReadingMaxAgeMs(): number {
    return Math.max(configMs('NIGHTGATE_PROGRESS_WATCH_MS') * 2, configNumber('NIGHTGATE_SYNC_PROGRESS_STALE_S') * 1000);
}

export type SyncReading = {
    caughtUp?: boolean; updatedAt?: string; appliedIndex?: string; streamTip?: string;
    behindEvents?: string | null; indexerFresh?: boolean; isConnected?: boolean;
} | null;

export function syncGateReading(p: SyncReading, now: number = Date.now()): { caughtUp: boolean; reason: string | null } {
    if (!p) return { caughtUp: false, reason: 'sponsor wallet has not reported its sync state yet' };
    const updatedMs = p.updatedAt ? Date.parse(p.updatedAt) : NaN;
    if (!Number.isFinite(updatedMs) || now - updatedMs > syncReadingMaxAgeMs()) {
        const age = Number.isFinite(updatedMs) ? `${Math.round((now - updatedMs) / 1000)}s old` : 'undated';
        return { caughtUp: false, reason: `sponsor wallet sync reading is ${age}` };
    }
    if (p.caughtUp === true) return { caughtUp: true, reason: null };
    const details = [`appliedIndex ${p.appliedIndex ?? '?'}`, `stream tip ${p.streamTip ?? '?'}`];
    if (p.isConnected === false) details.push('not connected');
    if (p.indexerFresh === false) details.push('indexer not fresh');
    return { caughtUp: false, reason: `sponsor wallet is not at the sync gate: ${p.behindEvents ?? '?'} events behind (${details.join(', ')})` };
}

// Sponsor session id -> account id, filled by the sponsor resolve (the only
// place that decrypts the viewing key); unresolved sessions have no entry.
const sponsorAccounts = new Map<string, string>();

export function noteSponsorAccount(sponsorSessionId: string, accountId: string): void {
    sponsorAccounts.set(sponsorSessionId, accountId);
}

/** False when unknown. */
export function sponsorAtSyncGate(sponsorSessionId: string, now: number = Date.now()): boolean {
    const accountId = sponsorAccounts.get(sponsorSessionId);
    return !!accountId && syncGateReading(walletGetSyncProgress(accountId), now).caughtUp;
}

export function __resetSponsorAccountsForTests(): void {
    sponsorAccounts.clear();
}
