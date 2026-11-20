// SPDX-License-Identifier: Apache-2.0
// Rewrites hashes an older version stored with the node's `0x` prefix. It runs to the end before the crawler
// and the job reconciliation start, because both find a row by its hash and must see one spelling only.
import cds from '@sap/cds';
import { Blocks, Transactions, ReorgLog, SyncState, type Block } from '#cds-models/midnight';
import { affectedRows } from '../utils/db-types';

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

const PREFIXED = '0x%';

/** The value of `column` without its `0x` prefix. A value without the prefix stays as it is. */
function withoutPrefix(column: string) {
    const ref = { ref: [column] };
    return { xpr: ['case', 'when', ref, 'like', { val: PREFIXED }, 'then', { func: 'substring', args: [ref, { val: 2 }] }, 'else', ref, 'end'] };
}

const isPrefixed = (value: string | null | undefined): boolean => !!value && value.startsWith('0x');
const secondsSince = (started: number): number => Math.round((Date.now() - started) / 1000);

export interface StoredHexPrefixReport {
    blocks: number;
    transactions: number;
}

/** True while the newest block or the sync state still carries the prefix. All rows change in one transaction, so these tell for all. */
async function prefixLeft(db: cds.DatabaseService): Promise<boolean> {
    const newest: Pick<Block, 'hash'> | undefined = await db.run(SELECT.one.from(Blocks).columns('hash').orderBy('height desc'));
    if (isPrefixed(newest?.hash)) return true;
    const sync: Pick<SyncState, 'lastIndexedHash' | 'lastFinalizedHash'> | undefined = await db.run(
        SELECT.one.from(SyncState).columns('lastIndexedHash', 'lastFinalizedHash').where({ ID: 'SINGLETON' })
    );
    return isPrefixed(sync?.lastIndexedHash) || isPrefixed(sync?.lastFinalizedHash);
}

// An index the rewrite would change entry by entry is dropped first and built again from its own definition.
// PostgreSQL writes an entry into every index of a changed row. SQLite changes the indexes of the changed columns.
interface IndexStatements {
    dropping: string;
    creating: string;
}

const POSTGRES_TABLES = `'midnight_Blocks'::regclass, 'midnight_Transactions'::regclass`;
const POSTGRES_INDEXES = `
    WITH owned AS (
        SELECT oid, conrelid, conname, conindid FROM pg_constraint
         WHERE conrelid IN (${POSTGRES_TABLES}) AND contype IN ('p', 'u', 'x')
    )
    SELECT format('ALTER TABLE %s DROP CONSTRAINT %I', conrelid::regclass, conname) AS dropping,
           format('ALTER TABLE %s ADD CONSTRAINT %I %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS creating
      FROM owned
    UNION ALL
    SELECT format('DROP INDEX %s', indexrelid::regclass), pg_get_indexdef(indexrelid)
      FROM pg_index
     WHERE indrelid IN (${POSTGRES_TABLES}) AND indexrelid NOT IN (SELECT conindid FROM owned)`;

/** Lets PostgreSQL sort an index build in memory, for this transaction. A value the server sets itself stays. */
const POSTGRES_SORT_MEMORY = `
    SELECT set_config('maintenance_work_mem', '1GB', true)
      FROM pg_settings WHERE name = 'maintenance_work_mem' AND source = 'default'`;

const SQLITE_INDEXES = `
    SELECT 'DROP INDEX "' || m.name || '"' AS dropping, m.sql AS creating
      FROM sqlite_master m
     WHERE m.type = 'index' AND m.sql IS NOT NULL
       AND lower(m.tbl_name) IN ('midnight_blocks', 'midnight_transactions')
       AND EXISTS (SELECT 1 FROM pragma_index_info(m.name) c WHERE lower(c.name) IN ('hash', 'stateroot', 'author'))`;

interface IndexRebuild {
    statements: string;
    before?: string;
}

function indexRebuild(): IndexRebuild | undefined {
    const kind = String(cds.env.requires?.db?.kind ?? '');
    if (/postgres/i.test(kind)) return { statements: POSTGRES_INDEXES, before: POSTGRES_SORT_MEMORY };
    return /sqlite/i.test(kind) ? { statements: SQLITE_INDEXES } : undefined;
}

/** Rewrites every stored hash that starts with `0x`, in one transaction: a failure leaves the database as it was.
 *  Returns the rows changed; both are 0 on a database that has none. */
export async function dropStoredHexPrefix(db: cds.DatabaseService): Promise<StoredHexPrefixReport> {
    const report: StoredHexPrefixReport = { blocks: 0, transactions: 0 };
    if (!await prefixLeft(db)) return report;

    const started = Date.now();
    const rebuild = indexRebuild();
    await db.tx(async (tx) => {
        const indexes: IndexStatements[] = rebuild ? await tx.run(rebuild.statements) : [];
        log.info('stored hashes: dropping the 0x prefix in one transaction; the server starts when this is done');
        for (const index of indexes) await tx.run(index.dropping);

        report.transactions = affectedRows(await tx.run(
            UPDATE.entity(Transactions).set({ hash: withoutPrefix('hash') }).where({ hash: { like: PREFIXED } })
        ));
        log.info(`stored hashes: ${report.transactions} transaction(s) updated, ${secondsSince(started)} s so far`);
        report.blocks = affectedRows(await tx.run(
            UPDATE.entity(Blocks)
                .set({ hash: withoutPrefix('hash'), stateRoot: withoutPrefix('stateRoot'), author: withoutPrefix('author') })
                .where({ hash: { like: PREFIXED } })
        ));
        await tx.run(
            UPDATE.entity(ReorgLog).set({ oldTipHash: withoutPrefix('oldTipHash'), newTipHash: withoutPrefix('newTipHash') })
                .where`oldTipHash like ${PREFIXED} or newTipHash like ${PREFIXED}`
        );
        await tx.run(
            UPDATE.entity(SyncState).set({ lastIndexedHash: withoutPrefix('lastIndexedHash'), lastFinalizedHash: withoutPrefix('lastFinalizedHash') })
                .where({ ID: 'SINGLETON' })
        );

        log.info(`stored hashes: ${report.blocks} block(s) updated, ${secondsSince(started)} s so far; building ${indexes.length} index(es) again`);
        if (rebuild?.before) await tx.run(rebuild.before);
        for (const index of indexes) await tx.run(index.creating);
    });
    log.info(`stored hashes: ${report.blocks} block(s) and ${report.transactions} transaction(s) rewritten in ${secondsSince(started)} s`);
    return report;
}
