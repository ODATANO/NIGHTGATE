/**
 * Secondary indexes the hot query paths need. CDS emits only primary keys and
 * `@assert.unique` constraints; everything below was a full table scan:
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
}

export const NIGHTGATE_INDEXES: readonly IndexSpec[] = [
    { name: 'ng_blocks_height', table: 'midnight_Blocks', columns: ['height'] },
    { name: 'ng_transactions_hash', table: 'midnight_Transactions', columns: ['hash'] },
    { name: 'ng_transactions_block', table: 'midnight_Transactions', columns: ['block_ID'] },
    { name: 'ng_transactions_sender', table: 'midnight_Transactions', columns: ['senderAddress'] },
    { name: 'ng_transactions_receiver', table: 'midnight_Transactions', columns: ['receiverAddress'] },
    { name: 'ng_transactionresults_tx', table: 'midnight_TransactionResults', columns: ['transaction_ID'] },
    { name: 'ng_contractactions_address', table: 'midnight_ContractActions', columns: ['address'] },
    { name: 'ng_contractactions_tx', table: 'midnight_ContractActions', columns: ['transaction_ID'] },
    { name: 'ng_unshieldedutxos_owner', table: 'midnight_UnshieldedUtxos', columns: ['owner'] },
    { name: 'ng_unshieldedutxos_spent', table: 'midnight_UnshieldedUtxos', columns: ['spentAtTransaction_ID'] },
    { name: 'ng_pendingsubmissions_txhash', table: 'midnight_PendingSubmissions', columns: ['txHash'] },
    { name: 'ng_backgroundjobs_status', table: 'midnight_BackgroundJobs', columns: ['status', 'kind'] },
    { name: 'ng_backgroundjobs_parent', table: 'midnight_BackgroundJobs', columns: ['parentJobId'] }
];

/** The DDL for one index, dialect-neutral (SQLite + PostgreSQL). */
export function indexStatement(spec: IndexSpec): string {
    return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${spec.columns.join(', ')})`;
}

/**
 * Create every missing index. `kind` is the CAP db kind; HANA is skipped.
 * A single failing statement is logged and skipped (an index is a speed-up,
 * never a correctness requirement), the rest still apply.
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
            await db.run(indexStatement(spec));
            created++;
        } catch (err) {
            warn(`index ${spec.name} on ${spec.table} not created: ${String((err as Error)?.message ?? err)}`);
        }
    }
    return created;
}
