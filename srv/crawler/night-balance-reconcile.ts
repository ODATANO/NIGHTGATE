/**
 * Checks the stored NightBalances rows against the values computed from the indexed UTXOs.
 * Uses `computeNightBalance`, the same rule a reorg rollback uses to rebuild balances. Writes nothing.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { NightBalances, UnshieldedUtxos } from '#cds-models/midnight';
import { NIGHT_RAW_TOKEN_TYPE } from './block-events';
import { computeNightBalance, type NightBalanceFigures } from './rollback';
import type { DbRunner } from '../utils/db-types';

const { SELECT } = cds.ql;

export const RECONCILE_MAX_PAGE = 500;

export interface NightBalanceDrift {
    address: string;
    /** A column name, or `row` when the whole row is missing or should not exist. */
    field: string;
    stored: string | null;
    computed: string | null;
}

export interface NightBalanceReconcileReport {
    checked: number;
    /** Pass as `after` for the next page; null when the scan is complete. */
    next: string | null;
    drifted: NightBalanceDrift[];
}

const FIELDS: Array<keyof NightBalanceFigures> = [
    'balance', 'utxoCount', 'txSentCount', 'txReceivedCount', 'totalSent', 'totalReceived', 'firstSeenHeight', 'lastActivityHeight'
];

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Checks one address. An empty list means the row is correct. */
export async function reconcileNightBalance(db: DbRunner, address: string): Promise<NightBalanceDrift[]> {
    const figures = await computeNightBalance(db, address);
    const row = await db.run(SELECT.one.from(NightBalances).columns(...FIELDS).where({ address }));
    if (!figures && !row) return [];
    if (!figures) {
        // A rollback keeps a zeroed row for an address registered for dust. Only non-zero values are wrong.
        const nonZero = FIELDS.filter(f => row[f] !== null && row[f] !== undefined && String(row[f]) !== '0');
        return nonZero.map(f => ({ address, field: f, stored: text(row[f]), computed: null }));
    }
    if (!row) return [{ address, field: 'row', stored: null, computed: text(figures.balance) }];
    const drift: NightBalanceDrift[] = [];
    for (const f of FIELDS) {
        const stored = text(row[f]);
        const computed = text(figures[f]);
        if (stored !== computed) drift.push({ address, field: f, stored, computed });
    }
    return drift;
}

export async function reconcileNightBalances(
    db: DbRunner, opts: { address?: string | null; after?: string | null; limit?: number | null } = {}
): Promise<NightBalanceReconcileReport> {
    if (opts.address) {
        return { checked: 1, next: null, drifted: await reconcileNightBalance(db, opts.address) };
    }
    const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? RECONCILE_MAX_PAGE)), RECONCILE_MAX_PAGE);
    const after = opts.after ?? '';
    const rows: Array<{ address: string }> = await db.run(
        SELECT.from(NightBalances).columns('address').where({ address: { '>': after } }).orderBy('address asc').limit(limit)
    ) || [];
    const owners: Array<{ owner: string }> = await db.run(
        SELECT.distinct.from(UnshieldedUtxos).columns('owner')
            .where({ tokenType: NIGHT_RAW_TOKEN_TYPE }).and({ owner: { '>': after } })
            .orderBy('owner asc').limit(limit)
    ) || [];
    const merged = [...new Set([...rows.map(r => r.address), ...owners.map(o => o.owner)])].sort();
    const page = merged.slice(0, limit);
    // If either source filled its page, it may hold more addresses, so the scan continues.
    const more = merged.length > limit || rows.length === limit || owners.length === limit;
    const drifted: NightBalanceDrift[] = [];
    for (const address of page) drifted.push(...await reconcileNightBalance(db, address));
    return { checked: page.length, next: more && page.length ? page[page.length - 1] : null, drifted };
}
