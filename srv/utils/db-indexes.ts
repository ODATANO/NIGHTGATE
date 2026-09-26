/**
 * Secondary indexes the hot query paths need. CDS emits only primary keys and
 * `@assert.unique` constraints; everything below is otherwise a full table scan:
 * `Blocks.height` (latest / byHeight / rollback), `Transactions.hash` (job
 * reconciliation, verifyDocument), `PendingSubmissions.txHash` (scanned once
 * per extrinsic per block inside the persist transaction), the UTXO owner and
 * spend lookups, contract actions by address, job sweeps by status.
 *
 * Applied idempotently at startup (`ensureIndexes`) and by the schema-delta
 * script; both SQLite and PostgreSQL accept `CREATE INDEX IF NOT EXISTS`.
 * HANA manages indexes through its own deployer and is skipped.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface IndexSpec {
    name: string;
    table: string;
    columns: string[];
    /** PostgreSQL column list when it differs (SQLite accepts no NULLS placement in an index). */
    postgres?: string;
    unique?: boolean;
    /** An older index on the same columns, dropped once this one exists. */
    replaces?: string;
}

export const NIGHTGATE_INDEXES: readonly IndexSpec[] = [
    // One block per height: the crawler indexes finalized blocks only, so a second row is a bug.
    { name: 'ng_blocks_height_unique', table: 'midnight_Blocks', columns: ['height'], unique: true, replaces: 'ng_blocks_height' },
    // Newest-first reads (`$orderby=createdAt desc`, byType, history): createdAt is nullable, so the
    // renderer keeps DESC NULLS LAST and only an index in that order serves it (ASC NULLS FIRST reads it backwards).
    { name: 'ng_blocks_createdat_desc', table: 'midnight_Blocks', columns: ['createdAt DESC'], postgres: 'createdAt DESC NULLS LAST' },
    { name: 'ng_transactions_createdat_desc', table: 'midnight_Transactions', columns: ['createdAt DESC'], postgres: 'createdAt DESC NULLS LAST' },
    { name: 'ng_transactions_type_createdat', table: 'midnight_Transactions', columns: ['txType', 'createdAt DESC'], postgres: 'txType, createdAt DESC NULLS LAST' },
    { name: 'ng_contractactions_createdat_desc', table: 'midnight_ContractActions', columns: ['createdAt DESC'], postgres: 'createdAt DESC NULLS LAST' },
    { name: 'ng_transactions_hash', table: 'midnight_Transactions', columns: ['hash'] },
    { name: 'ng_transactions_ledgerhash', table: 'midnight_Transactions', columns: ['ledgerTxHash'] },
    { name: 'ng_transactions_block', table: 'midnight_Transactions', columns: ['block_ID'] },
    { name: 'ng_transactions_sender', table: 'midnight_Transactions', columns: ['senderAddress'] },
    { name: 'ng_transactions_receiver', table: 'midnight_Transactions', columns: ['receiverAddress'] },
    { name: 'ng_transactionresults_tx', table: 'midnight_TransactionResults', columns: ['transaction_ID'] },
    // The indexer supplement updates and deletes per transaction through these links.
    { name: 'ng_transactionfees_tx', table: 'midnight_TransactionFees', columns: ['transaction_ID'] },
    { name: 'ng_transactionsegments_result', table: 'midnight_TransactionSegments', columns: ['transactionResult_ID'] },
    { name: 'ng_contractbalances_action', table: 'midnight_ContractBalances', columns: ['contractAction_ID'] },
    { name: 'ng_zswapledgerevents_tx', table: 'midnight_ZswapLedgerEvents', columns: ['transaction_ID'] },
    { name: 'ng_dustledgerevents_tx', table: 'midnight_DustLedgerEvents', columns: ['transaction_ID'] },
    { name: 'ng_contractactions_address', table: 'midnight_ContractActions', columns: ['address'] },
    { name: 'ng_contractactions_tx', table: 'midnight_ContractActions', columns: ['transaction_ID'] },
    { name: 'ng_unshieldedutxos_owner', table: 'midnight_UnshieldedUtxos', columns: ['owner'] },
    { name: 'ng_unshieldedutxos_spent', table: 'midnight_UnshieldedUtxos', columns: ['spentAtTransaction_ID'] },
    { name: 'ng_unshieldedutxos_created', table: 'midnight_UnshieldedUtxos', columns: ['createdAtTransaction_ID'] },
    { name: 'ng_pendingsubmissions_txhash', table: 'midnight_PendingSubmissions', columns: ['txHash'] },
    { name: 'ng_backgroundjobs_status', table: 'midnight_BackgroundJobs', columns: ['status', 'kind'] },
    { name: 'ng_backgroundjobs_parent', table: 'midnight_BackgroundJobs', columns: ['parentJobId'] },
    { name: 'ng_backgroundjobs_grant', table: 'midnight_BackgroundJobs', columns: ['grantId', 'queuedAt'] }
];

/** The DDL for one index; the SQLite spelling unless `kind` is PostgreSQL and the spec carries one. */
export function indexStatement(spec: IndexSpec, kind?: string): string {
    const columns = spec.postgres && kind && /postgres/i.test(kind) ? spec.postgres : spec.columns.join(', ');
    return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns})`;
}

/**
 * Create every missing index. `kind` is the CAP db kind; HANA is skipped.
 * A single failing statement is logged and skipped, the rest still apply; a
 * unique index that existing duplicates refuse leaves the index it replaces in place.
 */
export async function ensureIndexes(
    db: { run: (q: unknown) => Promise<unknown> },
    kind: string | undefined,
    warn: (msg: string) => void = () => undefined
): Promise<number> {
    if (kind && /hana/i.test(kind)) return 0;
    let created = 0;
    for (const spec of NIGHTGATE_INDEXES) {
        try {
            await db.run(indexStatement(spec, kind));
            created++;
        } catch (err) {
            warn(`index ${spec.name} on ${spec.table} not created: ${String((err as Error)?.message ?? err)}` +
                (spec.unique ? ` (duplicate ${spec.columns.join(', ')} values in ${spec.table}?)` : ''));
            continue;
        }
        if (spec.replaces) {
            try {
                await db.run(`DROP INDEX IF EXISTS ${spec.replaces}`);
            } catch (err) {
                warn(`index ${spec.replaces} not dropped: ${String((err as Error)?.message ?? err)}`);
            }
        }
    }
    return created;
}
