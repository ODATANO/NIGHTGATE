/**
 * The offer board's rows: open maker halves and how they close (a landed
 * nullifier, the poster, the clock). Intent only; no value is held here.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { SwapOffers } from '#cds-models/midnight';
import { runWithoutAmbientTx } from './background-jobs';
import { HEX64_RE } from '../utils/hex';
import { parseJsonStringList } from '../utils/json-list';

const log = cds.log('nightgate:swap-offers');
const { SELECT, UPDATE } = cds.ql;

type Runner = { run(q: unknown): Promise<any> };

export type SwapOfferStatus = 'open' | 'filled' | 'retired' | 'expired';

export interface SwapOfferRow {
    ID: string;
    offer: string;
    givesType: string;
    givesAmount: string;
    wantsType: string;
    wantsAmount: string;
    bound: boolean;
    inputs?: number | null;
    nullifiers: string;
    tags?: string | null;
    status: SwapOfferStatus;
    expiresAt?: string | null;
    posterUserId: string;
    posterGrantId?: string | null;
    sessionId?: string | null;
    filledTxHash?: string | null;
    closedAt?: string | null;
    createdAt?: string | null;
    modifiedAt?: string | null; // maintained by the managed aspect on every update
}

export const parseJsonList = parseJsonStringList;

/** Open offers whose `expiresAt` has passed turn `expired`; returns how many. */
export async function expireSwapOffers(db: Runner, now: Date = new Date()): Promise<number> {
    const stamp = now.toISOString();
    const n = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(SwapOffers).set({ status: 'expired', closedAt: stamp }).where({ status: 'open', expiresAt: { '<': stamp } })
    ));
    return typeof n === 'number' ? n : 0;
}

export async function loadSwapOffer(db: Runner, offerId: string): Promise<SwapOfferRow | null> {
    const row = await runWithoutAmbientTx(() => db.run(SELECT.one.from(SwapOffers).where({ ID: offerId })));
    return (row as SwapOfferRow | null) ?? null;
}

/** The status a reader sees: an open row past its expiry reads as expired before any write stamps it. */
export function effectiveSwapOfferStatus(row: SwapOfferRow, now: Date = new Date()): SwapOfferStatus {
    if (row.status !== 'open') return row.status;
    return row.expiresAt && Date.parse(row.expiresAt) <= now.getTime() ? 'expired' : 'open';
}

/** An offer counts as open while its row says so and its clock has not run out. */
export function isSwapOfferOpen(row: SwapOfferRow | null, now: Date = new Date()): boolean {
    if (!row || row.status !== 'open') return false;
    return !row.expiresAt || Date.parse(row.expiresAt) > now.getTime();
}

/** Close one offer; a no-op when it is not open any more. */
export async function closeSwapOffer(db: Runner, offerId: string, status: Exclude<SwapOfferStatus, 'open'>, txHash?: string | null): Promise<boolean> {
    const n = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(SwapOffers)
            .set({ status, closedAt: new Date().toISOString(), ...(txHash ? { filledTxHash: txHash } : {}) })
            .where({ ID: offerId, status: 'open' })
    ));
    return typeof n === 'number' ? n > 0 : !!n;
}

/**
 * Close every open offer whose half shares an input with a landed transaction:
 * the chain spent that input, so the half can never be filled again.
 */
export async function closeSwapOffersByNullifiers(db: Runner, nullifiers: unknown[], txHash?: string | null): Promise<string[]> {
    const landed = new Set(nullifiers.map(n => String(n ?? '').trim().toLowerCase()).filter(n => HEX64_RE.test(n)));
    if (landed.size === 0) return [];
    try {
        const open: SwapOfferRow[] = await runWithoutAmbientTx(() => db.run(
            SELECT.from(SwapOffers).columns('ID', 'nullifiers').where({ status: 'open' })
        )) ?? [];
        const hit = open.filter(row => parseJsonList(row.nullifiers).some(n => landed.has(n.toLowerCase())));
        const closed: string[] = [];
        for (const row of hit) {
            if (await closeSwapOffer(db, row.ID, 'filled', txHash)) closed.push(row.ID);
        }
        if (closed.length) log.info(`swap offer(s) ${closed.map(id => id.slice(0, 8)).join(', ')} filled by ${txHash ? txHash.slice(0, 16) : 'a landed transaction'}`);
        return closed;
    } catch (err) {
        // The swap is on chain; the row closes on the next landed nullifier or when a taker is refused.
        log.error(`could not close swap offers by nullifier: ${(err as Error)?.message ?? err}`);
        return [];
    }
}
