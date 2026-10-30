// SPDX-License-Identifier: Apache-2.0
/** The lookup table behind `Transactions/byIdentifier`: one row per identifier of the JSON list in `Transactions.identifiers`. */
import cds from '@sap/cds';
import { Transactions, TransactionIdentifiers, SyncState } from '#cds-models/midnight';
import { parseJsonStringList } from '../utils/json-list';
import type { DbRunner } from '../utils/db-types';
import { bareHex } from '../utils/hex-patterns';

const { SELECT, INSERT, DELETE, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export function normalizeIdentifier(raw: string): string {
    return bareHex(raw);
}

/** Replaces the identifier rows of one transaction. Running it again with the same list changes nothing. */
export async function replaceTransactionIdentifiers(tx: DbRunner, transactionId: string, identifiers: readonly string[]): Promise<void> {
    await tx.run(DELETE.from(TransactionIdentifiers).where({ transaction_ID: transactionId }));
    const rows = [...new Set(identifiers.map(normalizeIdentifier).filter(Boolean))]
        .map(identifier => ({ identifier, transaction_ID: transactionId }));
    if (rows.length) await tx.run(INSERT.into(TransactionIdentifiers).entries(rows));
}

export interface IdentifierBackfillReport {
    transactions: number;
    identifiers: number;
}

// Fills the table for transactions decoded before it existed. `SyncState.identifiersBackfilledAt` marks a finished run;
// an interrupted run leaves it null and the next start resumes past the rows that already have theirs.
export async function backfillTransactionIdentifiers(db: DbRunner, batchSize = 500): Promise<IdentifierBackfillReport> {
    const report: IdentifierBackfillReport = { transactions: 0, identifiers: 0 };
    const sync: Pick<SyncState, 'identifiersBackfilledAt'> | undefined = await db.run(
        SELECT.one.from(SyncState).columns('identifiersBackfilledAt').where({ ID: 'SINGLETON' })
    );
    if (sync?.identifiersBackfilledAt) return report;

    let offset = 0;
    for (;;) {
        const batch: Array<{ ID: string; identifiers: string | null }> = await db.run(
            SELECT.from(Transactions).columns('ID', 'identifiers').where({ identifiers: { '!=': null } })
                .orderBy('ID').limit(batchSize, offset)
        ) || [];
        if (!batch.length) break;
        offset += batch.length;
        const done = new Set<string>(((await db.run(
            SELECT.from(TransactionIdentifiers).columns('transaction_ID').where({ transaction_ID: { in: batch.map(r => r.ID) } })
        )) || []).map((r: { transaction_ID: string }) => r.transaction_ID));
        for (const row of batch) {
            if (done.has(row.ID)) continue;
            const list = parseJsonStringList(row.identifiers);
            if (!list.length) continue;
            await replaceTransactionIdentifiers(db, row.ID, list);
            report.transactions++;
            report.identifiers += list.length;
        }
    }
    await db.run(UPDATE.entity(SyncState).set({ identifiersBackfilledAt: new Date().toISOString() }).where({ ID: 'SINGLETON' }));
    if (report.transactions) log.info(`transaction identifiers: ${report.identifiers} row(s) for ${report.transactions} transaction(s) filled in`);
    return report;
}
