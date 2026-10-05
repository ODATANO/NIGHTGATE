/**
 * Database rows of the swap offer board.
 * An offer closes when it is filled on chain, withdrawn by its poster, or expires.
 * The board only lists offers. It holds no funds.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { SwapOffers, type SwapOffer } from '#cds-models/midnight';
import { runWithoutAmbientTx } from './background-jobs';
import { HEX64_RE } from '../utils/hex';
import { parseJsonStringList } from '../utils/json-list';
import { errorMessage } from '../utils/errors';
import type { DbRunner } from '../utils/db-types';

const log = cds.log('nightgate:swap-offers');
const { SELECT, UPDATE } = cds.ql;


export type SwapOfferStatus = SwapOffer['status'];


export async function expireSwapOffers(db: DbRunner, now: Date = new Date()): Promise<number> {
    const stamp = now.toISOString();
    const n = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(SwapOffers).set({ status: 'expired', closedAt: stamp }).where({ status: 'open', expiresAt: { '<': stamp } })
    ));
    return typeof n === 'number' ? n : 0;
}

export async function loadSwapOffer(db: DbRunner, offerId: string): Promise<SwapOffer | null> {
    const row = await runWithoutAmbientTx(() => db.run(SELECT.one.from(SwapOffers).where({ ID: offerId })));
    return (row as SwapOffer | null) ?? null;
}

/** The status shown to readers. An open row past its expiry shows as expired, even before it is saved. */
export function effectiveSwapOfferStatus(row: SwapOffer, now: Date = new Date()): SwapOfferStatus {
    if (row.status !== 'open') return row.status;
    return row.expiresAt && Date.parse(row.expiresAt) <= now.getTime() ? 'expired' : 'open';
}

export function isSwapOfferOpen(row: SwapOffer | null, now: Date = new Date()): boolean {
    if (!row || row.status !== 'open') return false;
    return !row.expiresAt || Date.parse(row.expiresAt) > now.getTime();
}

/** Close one offer. Does nothing if it is no longer open. */
export async function closeSwapOffer(db: DbRunner, offerId: string, status: Exclude<SwapOfferStatus, 'open'>, txHash?: string | null): Promise<boolean> {
    const n = await runWithoutAmbientTx(() => db.run(
        UPDATE.entity(SwapOffers)
            .set({ status, closedAt: new Date().toISOString(), ...(txHash ? { filledTxHash: txHash } : {}) })
            .where({ ID: offerId, status: 'open' })
    ));
    return typeof n === 'number' ? n > 0 : !!n;
}

/**
 * Close every open offer that uses an input spent by a confirmed transaction.
 * That input is gone, so the offer can never be filled.
 */
export async function closeSwapOffersByNullifiers(db: DbRunner, nullifiers: unknown[], txHash?: string | null): Promise<string[]> {
    const landed = new Set(nullifiers.map(n => String(n ?? '').trim().toLowerCase()).filter(n => HEX64_RE.test(n)));
    if (landed.size === 0) return [];
    try {
        const open: SwapOffer[] = await runWithoutAmbientTx(() => db.run(
            SELECT.from(SwapOffers).columns('ID', 'nullifiers').where({ status: 'open' })
        )) ?? [];
        const hit = open.filter(row => parseJsonStringList(row.nullifiers).some(n => landed.has(n.toLowerCase())));
        const closed: string[] = [];
        for (const row of hit) {
            if (await closeSwapOffer(db, row.ID, 'filled', txHash)) closed.push(row.ID);
        }
        if (closed.length) log.info(`swap offer(s) ${closed.map(id => id.slice(0, 8)).join(', ')} filled by ${txHash ? txHash.slice(0, 16) : 'a landed transaction'}`);
        return closed;
    } catch (err) {
        // The swap is on chain anyway. The row closes later, on the next match or when a taker is refused.
        log.error(`could not close swap offers by nullifier: ${errorMessage(err)}`);
        return [];
    }
}
