/**
 * Public counts for the offer board and the sponsor pool. Shows no ids and no amounts.
 * Sponsor readiness comes from the reports the worker sends anyway, so no worker call is needed.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { SwapOffers, BackgroundJobs } from '#cds-models/midnight';
import type { DbRunner } from '../utils/db-types';
import { getConfiguredFeeSponsorSessions } from './fee-sponsor';
import { getNightgatePluginConfig } from '../utils/nightgate-config';
import { loadSigningSessionAccountId } from '../sessions/wallet-session-lifecycle';
import { walletGetSyncProgress } from '../midnight/wallet-worker-client';
import { syncGateReading } from './sponsor-sync-gate';
import { runWithoutAmbientTx } from './background-jobs';

const { SELECT } = cds.ql;

export interface BoardStatus {
    openOffers: number;
    offersFilledToday: number;
    swapsToday: number;
    sponsorsConfigured: number;
    sponsorsReady: number;
    asOf: string;
}

async function countRows(db: DbRunner, query: unknown): Promise<number> {
    const row = await runWithoutAmbientTx(() => db.run(query as any)) as { count?: number | string } | null | undefined;
    const n = Number(row?.count ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/** A sponsor is ready when its last report says it is synced and has spendable dust. */
export async function countReadySponsors(db: DbRunner, sponsorIds: string[]): Promise<number> {
    let ready = 0;
    for (const sessionId of sponsorIds) {
        try {
            const sess = await loadSigningSessionAccountId(db, sessionId, undefined, true);
            if (!sess.ok) continue;
            const progress = walletGetSyncProgress(sess.accountId);
            if (syncGateReading(progress).caughtUp && Number(progress?.dust?.availableNotes ?? 0) > 0) ready++;
        } catch {
            // A sponsor that cannot be read counts as not ready.
        }
    }
    return ready;
}

// Anyone can poll this, so one result is shared by all readers for a few seconds.
const MEMO_MS = 10_000;
let memo: { at: number; value: Promise<BoardStatus> } | null = null;

export function buildBoardStatus(db: DbRunner, now: Date = new Date()): Promise<BoardStatus> {
    if (memo && now.getTime() - memo.at < MEMO_MS) return memo.value;
    const value = computeBoardStatus(db, now);
    memo = { at: now.getTime(), value };
    value.catch(() => { if (memo?.value === value) memo = null; });
    return value;
}

export function __resetBoardStatusForTests(): void {
    memo = null;
}

async function computeBoardStatus(db: DbRunner, now: Date): Promise<BoardStatus> {
    const nowIso = now.toISOString();
    const dayStart = nowIso.slice(0, 10) + 'T00:00:00.000Z';
    const [openOffers, offersFilledToday, swapsToday] = await Promise.all([
        countRows(db, SELECT.one.from(SwapOffers).columns('count(*) as count').where({ status: 'open' }).and('expiresAt is null or expiresAt >', nowIso)),
        countRows(db, SELECT.one.from(SwapOffers).columns('count(*) as count').where({ status: 'filled' }).and('closedAt >=', dayStart)),
        // Jobs that finished today without a chain failure. Some may not be confirmed on chain yet.
        countRows(db, SELECT.one.from(BackgroundJobs).columns('count(*) as count').where({ kind: 'sponsorSwap', status: 'succeeded' }).and("chainStatus is null or chainStatus != 'failure'").and('finishedAt >=', dayStart))
    ]);
    const sponsorIds = getConfiguredFeeSponsorSessions(getNightgatePluginConfig());
    const sponsorsReady = sponsorIds.length ? await countReadySponsors(db, sponsorIds) : 0;
    return { openOffers, offersFilledToday, swapsToday, sponsorsConfigured: sponsorIds.length, sponsorsReady, asOf: nowIso };
}
