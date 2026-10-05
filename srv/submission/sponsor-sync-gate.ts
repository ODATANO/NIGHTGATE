/**
 * The worker regularly reports whether each sponsor wallet is synced and ready.
 * The main thread reads these reports. Pool selection prefers ready sponsors.
 * SPDX-License-Identifier: Apache-2.0
 */

import { walletGetSyncProgress } from '../midnight/wallet-worker-client';
import { configMs, configNumber } from '../utils/config';

/**
 * How long a report stays valid: two report intervals, or the stale threshold if that is longer.
 */
function syncReadingMaxAgeMs(): number {
    return Math.max(configMs('NIGHTGATE_PROGRESS_WATCH_MS') * 2, configNumber('NIGHTGATE_SYNC_PROGRESS_STALE_S') * 1000);
}

export type SyncReading = {
    caughtUp?: boolean; updatedAt?: string; appliedIndex?: string; streamTip?: string;
    behindEvents?: string | null; indexerFresh?: boolean; isConnected?: boolean;
    indexerTipAgeMs?: number | null; indexerError?: string | null;
} | null;

function staleIndexerDetail(p: NonNullable<SyncReading>): string {
    if (p.indexerError) return `indexer unreachable (${p.indexerError})`;
    if (p.indexerTipAgeMs != null) return `indexer's newest block is ${Math.round(p.indexerTipAgeMs / 1000)}s old`;
    return 'indexer not fresh';
}

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
    if (p.indexerFresh === false) details.push(staleIndexerDetail(p));
    return { caughtUp: false, reason: `sponsor wallet is not at the sync gate: ${p.behindEvents ?? '?'} events behind (${details.join(', ')})` };
}

// Sponsor session id -> account id. Filled when a sponsor is resolved,
// because only that step decrypts the viewing key.
const sponsorAccounts = new Map<string, string>();

export function noteSponsorAccount(sponsorSessionId: string, accountId: string): void {
    sponsorAccounts.set(sponsorSessionId, accountId);
}

export function sponsorAtSyncGate(sponsorSessionId: string, now: number = Date.now()): boolean {
    const accountId = sponsorAccounts.get(sponsorSessionId);
    return !!accountId && syncGateReading(walletGetSyncProgress(accountId), now).caughtUp;
}

export function __resetSponsorAccountsForTests(): void {
    sponsorAccounts.clear();
}
