// SPDX-License-Identifier: Apache-2.0
/** The lookup table behind `Transactions/byTxId`: one row per identifier of the JSON list in `Transactions.identifiers`. */
import cds from '@sap/cds';
import { TransactionIdentifiers } from '#cds-models/midnight';
import type { DbRunner } from '../utils/db-types';
import { bareHex } from '../utils/hex-patterns';

const { INSERT, DELETE } = cds.ql;

export function normalizeIdentifier(raw: string): string {
    return bareHex(raw);
}

/** Replaces the identifier rows of one transaction. Running it again with the same list changes nothing. */
export async function replaceTransactionIdentifiers(tx: DbRunner, transactionId: string, identifiers: readonly string[]): Promise<void> {
    await tx.run(DELETE.from(TransactionIdentifiers).where({ transaction_ID: transactionId }));
    const rows = [...new Set(identifiers.map(normalizeIdentifier).filter(Boolean))]
        .map(txId => ({ txId, transaction_ID: transactionId }));
    if (rows.length) await tx.run(INSERT.into(TransactionIdentifiers).entries(rows));
}
