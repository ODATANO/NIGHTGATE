/**
 * Extra database indexes for frequent queries. CDS only creates primary keys and unique constraints.
 * Without these indexes, the lookups below would scan whole tables.
 * They are created at startup if missing. HANA is skipped because it manages indexes through its own deployer.
 * SPDX-License-Identifier: Apache-2.0
 */
import { errorMessage } from './errors';

export interface IndexSpec {
    name: string;
    table: string;
    columns: string[];
    /** Column list for PostgreSQL, when it differs. SQLite does not accept NULLS FIRST or LAST in an index. */
    postgres?: string;
    unique?: boolean;
    /** An older index on the same columns. It is dropped once this one exists. */
    replaces?: string;
}

export const NIGHTGATE_INDEXES: readonly IndexSpec[] = [
    // One block per height. The crawler stores only finalized blocks, so a second row would be a bug.
    { name: 'ng_blocks_height_unique', table: 'midnight_Blocks', columns: ['height'], unique: true, replaces: 'ng_blocks_height' },
    // For newest-first reads. createdAt can be NULL, so Postgres sorts it DESC NULLS LAST.
    // Only an index in exactly that order can serve these queries.
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
    // Used when data from the Midnight indexer is updated or deleted per transaction.
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

/** The CREATE INDEX statement for one index. Uses the PostgreSQL column list when `kind` is PostgreSQL and one is given. */
export function indexStatement(spec: IndexSpec, kind?: string): string {
    const columns = spec.postgres && kind && /postgres/i.test(kind) ? spec.postgres : spec.columns.join(', ');
    return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns})`;
}

/**
 * Creates every missing index. `kind` is the CAP database kind.
 * A failing index is logged and skipped. If a unique index fails because of duplicates, the old index stays.
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
            warn(`index ${spec.name} on ${spec.table} not created: ${errorMessage(err)}` +
                (spec.unique ? ` (duplicate ${spec.columns.join(', ')} values in ${spec.table}?)` : ''));
            continue;
        }
        if (spec.replaces) {
            try {
                await db.run(`DROP INDEX IF EXISTS ${spec.replaces}`);
            } catch (err) {
                warn(`index ${spec.replaces} not dropped: ${errorMessage(err)}`);
            }
        }
    }
    return created;
}
