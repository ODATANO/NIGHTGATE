// Extra indexes for frequent queries, created at startup if missing. CDS only creates keys and unique constraints.
// HANA is skipped because its own deployer manages indexes.
// SPDX-License-Identifier: Apache-2.0
import { errorMessage } from './errors';
import type cds from '@sap/cds';
import type { DbRunner } from './db-types';

export interface IndexSpec {
    name: string;
    table: string;
    columns: string[];
    /** Column list for PostgreSQL, when it differs. SQLite does not accept NULLS FIRST or LAST in an index. */
    postgres?: string;
    unique?: boolean;
    /** The rows the index holds, as a condition. Without it every row. */
    where?: string;
    /** Older indexes this one stands for. They are dropped once it exists. */
    replaces?: readonly string[];
}

export const NIGHTGATE_INDEXES: readonly IndexSpec[] = [
    // One block per height. The crawler stores only finalized blocks, so a second row would be a bug.
    { name: 'ng_blocks_height_unique', table: 'midnight_Blocks', columns: ['height'], unique: true },
    // createdAt can be NULL, so Postgres sorts it DESC NULLS LAST. Only an index in exactly that order serves the read.
    { name: 'ng_blocks_createdat_desc', table: 'midnight_Blocks', columns: ['createdAt DESC'], postgres: 'createdAt DESC NULLS LAST' },
    // Chain order: blockHeight, indexInBlock, then the row's own index. Read forwards such an index gives the newest
    // rows first, read backwards the oldest.
    { name: 'ng_transactions_position', table: 'midnight_Transactions', columns: ['blockHeight DESC', 'indexInBlock DESC'], replaces: ['ng_transactions_createdat_desc'] },
    { name: 'ng_transactions_type_position', table: 'midnight_Transactions', columns: ['txType', 'blockHeight DESC', 'indexInBlock DESC'], replaces: ['ng_transactions_type_createdat'] },
    { name: 'ng_contractactions_position', table: 'midnight_ContractActions', columns: ['blockHeight DESC', 'indexInBlock DESC', 'actionIndex DESC'], replaces: ['ng_contractactions_createdat_desc'] },
    { name: 'ng_transactions_hash_position', table: 'midnight_Transactions', columns: ['extrinsicHash', 'blockHeight DESC', 'indexInBlock DESC'], replaces: ['ng_transactions_hash_createdat'] },
    { name: 'ng_transactions_ledgerhash', table: 'midnight_Transactions', columns: ['txHash'] },
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
    { name: 'ng_contractactions_address_position', table: 'midnight_ContractActions', columns: ['contractAddress', 'blockHeight DESC', 'indexInBlock DESC', 'actionIndex DESC'], replaces: ['ng_contractactions_address_createdat'] },
    { name: 'ng_contractactions_tx', table: 'midnight_ContractActions', columns: ['transaction_ID'] },
    { name: 'ng_unshieldedutxos_owner_position', table: 'midnight_UnshieldedUtxos', columns: ['owner', 'blockHeight DESC', 'indexInBlock DESC', 'outputIndex DESC'], replaces: ['ng_unshieldedutxos_owner_createdat'] },
    { name: 'ng_unshieldedutxos_spent_position', table: 'midnight_UnshieldedUtxos', columns: ['spentAtTransaction_ID', 'blockHeight DESC', 'indexInBlock DESC', 'outputIndex DESC'], replaces: ['ng_unshieldedutxos_spent_createdat'] },
    // PostgreSQL takes no order from an index whose first column is only compared with NULL, so the unspent rows get their own.
    { name: 'ng_unshieldedutxos_unspent_position', table: 'midnight_UnshieldedUtxos', columns: ['blockHeight DESC', 'indexInBlock DESC', 'outputIndex DESC'], where: 'spentAtTransaction_ID IS NULL' },
    { name: 'ng_nightbalances_balance_desc', table: 'midnight_NightBalances', columns: ['balance DESC'], postgres: 'balance DESC NULLS LAST' },
    { name: 'ng_unshieldedutxos_created', table: 'midnight_UnshieldedUtxos', columns: ['createdAtTransaction_ID'] },
    { name: 'ng_pendingsubmissions_txid', table: 'midnight_PendingSubmissions', columns: ['txId'], replaces: ['ng_pendingsubmissions_txhash'] },
    { name: 'ng_backgroundjobs_status', table: 'midnight_BackgroundJobs', columns: ['status', 'kind'] },
    { name: 'ng_backgroundjobs_parent', table: 'midnight_BackgroundJobs', columns: ['parentJobId'] },
    { name: 'ng_backgroundjobs_grant', table: 'midnight_BackgroundJobs', columns: ['grantId', 'queuedAt'] }
];

/** The CREATE INDEX statement for one index. Uses the PostgreSQL column list when `kind` is PostgreSQL and one is given. */
export function indexStatement(spec: IndexSpec, kind?: string): string {
    const columns = spec.postgres && kind && /postgres/i.test(kind) ? spec.postgres : spec.columns.join(', ');
    return `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns})${spec.where ? ` WHERE ${spec.where}` : ''}`;
}

/** Creates every missing index. `kind` is the CAP database kind.
 *  A failing index is logged and skipped. If a unique index fails because of duplicates, the old index stays. */
export async function ensureIndexes(
    db: DbRunner,
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
        for (const older of spec.replaces ?? []) {
            try {
                await db.run(`DROP INDEX IF EXISTS ${older}`);
            } catch (err) {
                warn(`index ${older} not dropped: ${errorMessage(err)}`);
            }
        }
    }
    return created;
}

/** A column that got a new name. An older database is renamed in place before its schema is compared with the model. */
export interface ColumnRename {
    entity: string;
    table: string;
    from: string;
    to: string;
}

// The order matters: a table's `txHash` becomes `txId` before its `indexerTxHash` takes the freed name.
export const COLUMN_RENAMES: readonly ColumnRename[] = [
    { entity: 'midnight.Transactions', table: 'midnight_Transactions', from: 'hash', to: 'extrinsicHash' },
    { entity: 'midnight.Transactions', table: 'midnight_Transactions', from: 'ledgerTxHash', to: 'txHash' },
    { entity: 'midnight.Transactions', table: 'midnight_Transactions', from: 'transactionId', to: 'indexInBlock' },
    { entity: 'midnight.TransactionIdentifiers', table: 'midnight_TransactionIdentifiers', from: 'identifier', to: 'txId' },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', from: 'txHash', to: 'txId' },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', from: 'indexerTxHash', to: 'txHash' },
    { entity: 'midnight.PendingSubmissions', table: 'midnight_PendingSubmissions', from: 'txHash', to: 'txId' },
    { entity: 'midnight.PendingSubmissions', table: 'midnight_PendingSubmissions', from: 'indexerTxHash', to: 'txHash' },
    { entity: 'midnight.Documents', table: 'midnight_Documents', from: 'sha256', to: 'payloadHash' },
    { entity: 'midnight.Transactions', table: 'midnight_Transactions', from: 'circuitName', to: 'circuit' },
    { entity: 'midnight.PendingSubmissions', table: 'midnight_PendingSubmissions', from: 'circuitName', to: 'circuit' },
    { entity: 'midnight.ContractActions', table: 'midnight_ContractActions', from: 'entryPoint', to: 'circuit' },
    { entity: 'midnight.ContractActions', table: 'midnight_ContractActions', from: 'address', to: 'contractAddress' },
    { entity: 'midnight.ContractStates', table: 'midnight_ContractStates', from: 'address', to: 'contractAddress' },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', from: 'chainBlockHeight', to: 'blockHeight' },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', from: 'chainBlockHash', to: 'blockHash' },
    { entity: 'midnight.PendingSubmissions', table: 'midnight_PendingSubmissions', from: 'chainBlockHeight', to: 'blockHeight' },
    { entity: 'midnight.PendingSubmissions', table: 'midnight_PendingSubmissions', from: 'chainBlockHash', to: 'blockHash' },
    { entity: 'midnight.DisclosureGrants', table: 'midnight_DisclosureGrants', from: 'active', to: 'isActive' },
    { entity: 'midnight.HolderDisclosureGrants', table: 'midnight_HolderDisclosureGrants', from: 'active', to: 'isActive' },
    { entity: 'midnight.ContractRegistrations', table: 'midnight_ContractRegistrations', from: 'networkId', to: 'network' },
    { entity: 'midnight.SyncState', table: 'midnight_SyncState', from: 'networkId', to: 'network' },
    { entity: 'midnight.WalletSyncStates', table: 'midnight_WalletSyncStates', from: 'networkId', to: 'network' },
    { entity: 'midnight.AgentGrants', table: 'midnight_AgentGrants', from: 'agentLabel', to: 'label' },
    { entity: 'midnight.Documents', table: 'midnight_Documents', from: 'compiledArtifactRef', to: 'contractName' },
    { entity: 'midnight.PredicateAttestations', table: 'midnight_PredicateAttestations', from: 'compiledArtifactRef', to: 'contractName' }
];

/** The renames a database still needs, in order. `columnsOf` names the columns a table has now, or nothing when the table is missing. */
export function pendingColumnRenames(columnsOf: (table: string) => readonly string[] | undefined): ColumnRename[] {
    const known = new Map<string, Set<string>>();
    const pending: ColumnRename[] = [];
    for (const rename of COLUMN_RENAMES) {
        if (!known.has(rename.table)) known.set(rename.table, new Set((columnsOf(rename.table) ?? []).map(c => c.toLowerCase())));
        const columns = known.get(rename.table)!;
        const from = rename.from.toLowerCase();
        const to = rename.to.toLowerCase();
        if (!columns.has(from) || columns.has(to)) continue;
        columns.delete(from);
        columns.add(to);
        pending.push(rename);
    }
    return pending;
}

type CsnElement = Record<string, unknown>;
type CsnConstraint = { paths?: Array<{ ref?: unknown[] }> };
type CsnDefinition = {
    elements?: Record<string, CsnElement>;
    projection?: unknown;
    query?: unknown;
    $tableConstraints?: { unique?: Record<string, CsnConstraint> };
} & Record<string, unknown>;
/** The model CAP stored at the last deploy. */
export interface StoredModel {
    definitions?: Record<string, CsnDefinition>;
}

const PERSISTENCE_NAME = '@cds.persistence.name';

/** Applies renames to the tables of a stored model, so a later schema comparison sees the same columns as the database.
 *  Views stay as stored: the comparison finds them changed and the deploy builds them again. Returns how many elements it renamed. */
export function renameInStoredModel(csn: StoredModel, renames: readonly ColumnRename[]): number {
    let renamed = 0;
    for (const rename of renames) {
        const def = csn.definitions?.[rename.entity];
        if (!def?.elements || !(rename.from in def.elements) || rename.to in def.elements) continue;
        def.elements = Object.fromEntries(Object.entries(def.elements).map(([name, element]) => (name === rename.from
            ? [rename.to, PERSISTENCE_NAME in element ? { ...element, [PERSISTENCE_NAME]: rename.to.toUpperCase() } : element]
            : [name, element])));
        for (const [key, value] of Object.entries(def)) {
            if (!key.startsWith('@assert.unique') || !Array.isArray(value)) continue;
            def[key] = value.map((item: unknown) => (item && typeof item === 'object' && (item as { '='?: unknown })['='] === rename.from ? { '=': rename.to } : item));
        }
        for (const constraint of Object.values(def.$tableConstraints?.unique ?? {})) {
            for (const path of constraint.paths ?? []) {
                if (path.ref?.length === 1 && path.ref[0] === rename.from) path.ref = [rename.to];
            }
        }
        renamed++;
    }
    return renamed;
}

/** A table whose key moved to another of its columns. The former key column is dropped. */
export interface KeyChange {
    entity: string;
    table: string;
    from: string;
    to: string;
}

export const KEY_CHANGES: readonly KeyChange[] = [
    { entity: 'midnight.WalletSessions', table: 'midnight_WalletSessions', from: 'ID', to: 'sessionId' }
];

/** The key changes a database still needs: every table that still has its former key column. */
export function pendingKeyChanges(columnsOf: (table: string) => readonly string[] | undefined): KeyChange[] {
    return KEY_CHANGES.filter(change => (columnsOf(change.table) ?? []).some(c => c.toLowerCase() === change.from.toLowerCase()));
}

/** Applies key changes to the tables of a stored model. Returns how many tables it changed. */
export function moveKeyInStoredModel(csn: StoredModel, changes: readonly KeyChange[]): number {
    let moved = 0;
    for (const change of changes) {
        const def = csn.definitions?.[change.entity];
        if (!def?.elements || !(change.from in def.elements) || !(change.to in def.elements)) continue;
        const { [change.from]: _former, ...kept } = def.elements;
        const { notNull: _notNull, ...key } = kept[change.to];
        def.elements = { ...kept, [change.to]: { key: true, ...key } };
        const onlyTheKey = (columns: unknown[]): boolean => columns.length === 1 && columns[0] === change.to;
        for (const [name, value] of Object.entries(def)) {
            if (name.startsWith('@assert.unique') && Array.isArray(value) && onlyTheKey(value.map((item: { '='?: unknown }) => item?.['=']))) delete def[name];
        }
        const unique = def.$tableConstraints?.unique ?? {};
        for (const [name, constraint] of Object.entries(unique)) {
            if (onlyTheKey((constraint.paths ?? []).map(path => (path.ref?.length === 1 ? path.ref[0] : path.ref)))) delete unique[name];
        }
        if (def.$tableConstraints && Object.keys(unique).length === 0) delete def.$tableConstraints;
        moved++;
    }
    return moved;
}

/** A number column that became text. `cds deploy` refuses that change, so an older database is converted before the deploy. */
export interface ColumnToText {
    entity: string;
    table: string;
    column: string;
    length: number;
}

export const COLUMNS_TO_TEXT: readonly ColumnToText[] = [
    { entity: 'midnight.PredicateAttestations', table: 'midnight_PredicateAttestations', column: 'threshold', length: 78 }
];

/** The columns a database still holds as numbers. `typeOf` names the type a column has now, or nothing when it is missing. */
export function pendingTextColumns(typeOf: (table: string, column: string) => string | undefined): ColumnToText[] {
    return COLUMNS_TO_TEXT.filter(change => {
        const type = typeOf(change.table, change.column);
        return type !== undefined && !/char|text|clob/i.test(type);
    });
}

/** Gives the columns their text type in a stored model. Returns how many elements it changed. */
export function toTextInStoredModel(csn: StoredModel, changes: readonly ColumnToText[]): number {
    let changed = 0;
    for (const change of changes) {
        const element = csn.definitions?.[change.entity]?.elements?.[change.column];
        if (!element || element.type === 'cds.String') continue;
        Object.assign(element, { type: 'cds.String', length: change.length });
        changed++;
    }
    return changed;
}

/** A column that repeats what a parent row says. An older database gets it filled before the deploy, because it is NOT NULL. */
export interface DerivedColumn {
    entity: string;
    table: string;
    column: string;
    type: 'cds.Integer64' | 'cds.Integer';
}

/** The chain position each row carries itself. */
export const CHAIN_POSITION_COLUMNS: readonly DerivedColumn[] = [
    { entity: 'midnight.Transactions', table: 'midnight_Transactions', column: 'blockHeight', type: 'cds.Integer64' },
    { entity: 'midnight.ContractActions', table: 'midnight_ContractActions', column: 'blockHeight', type: 'cds.Integer64' },
    { entity: 'midnight.ContractActions', table: 'midnight_ContractActions', column: 'indexInBlock', type: 'cds.Integer' },
    { entity: 'midnight.UnshieldedUtxos', table: 'midnight_UnshieldedUtxos', column: 'blockHeight', type: 'cds.Integer64' },
    { entity: 'midnight.UnshieldedUtxos', table: 'midnight_UnshieldedUtxos', column: 'indexInBlock', type: 'cds.Integer' }
];

// An older version kept the pallet call index in `circuit`, such as `5:0`. No circuit name holds a colon.
const NAMED_CIRCUIT = (alias: string): string => `CASE WHEN ${alias}.circuit LIKE '%:%' THEN NULL ELSE ${alias}.circuit END`;

/** Fills the position of rows that have none, one statement per table, in this order, and clears a pallet call index in `circuit`.
 *  The text runs on PostgreSQL and SQLite. */
export const CHAIN_POSITION_FILLS: readonly { table: string; sql: string }[] = [
    { table: 'midnight_Transactions', sql: `UPDATE midnight_Transactions AS t SET blockHeight = b.height, circuit = ${NAMED_CIRCUIT('t')} FROM midnight_Blocks AS b WHERE b.ID = t.block_ID AND t.blockHeight IS NULL` },
    { table: 'midnight_ContractActions', sql: `UPDATE midnight_ContractActions AS a SET blockHeight = t.blockHeight, indexInBlock = t.indexInBlock, circuit = ${NAMED_CIRCUIT('a')} FROM midnight_Transactions AS t WHERE t.ID = a.transaction_ID AND a.blockHeight IS NULL` },
    { table: 'midnight_UnshieldedUtxos', sql: 'UPDATE midnight_UnshieldedUtxos AS u SET blockHeight = t.blockHeight, indexInBlock = t.indexInBlock FROM midnight_Transactions AS t WHERE t.ID = u.createdAtTransaction_ID AND u.blockHeight IS NULL' }
];

/** The position columns a database still lacks. A missing table needs none: the deploy creates it whole. */
export function pendingDerivedColumns(columnsOf: (table: string) => readonly string[] | undefined): DerivedColumn[] {
    return CHAIN_POSITION_COLUMNS.filter((derived) => {
        const columns = columnsOf(derived.table);
        return columns !== undefined && !columns.some(c => c.toLowerCase() === derived.column.toLowerCase());
    });
}

/** Adds the columns to the tables of a stored model, as the deploy would describe them. Returns how many it added. */
export function addToStoredModel(csn: StoredModel, columns: readonly DerivedColumn[]): number {
    let added = 0;
    for (const derived of columns) {
        const elements = csn.definitions?.[derived.entity]?.elements;
        if (!elements || derived.column in elements) continue;
        elements[derived.column] = { type: derived.type, notNull: true, [PERSISTENCE_NAME]: derived.column.toUpperCase() };
        added++;
    }
    return added;
}

/** The views of a stored model: the name the database has for the view, in lowercase, to the name of its definition. */
export function viewsOfStoredModel(csn: StoredModel): Map<string, string> {
    const views = new Map<string, string>();
    for (const [name, def] of Object.entries(csn.definitions ?? {})) {
        if (def.projection || def.query) views.set(String(def[PERSISTENCE_NAME] ?? name.replace(/\./g, '_')).toLowerCase(), name);
    }
    return views;
}

/** The tables `cds deploy` creates for the `midnight` entities of a linked model, with their columns. */
export function modelTables(model: cds.linked.LinkedCSN): Array<{ entity: string; table: string; columns: string[] }> {
    const tables: Array<{ entity: string; table: string; columns: string[] }> = [];
    for (const def of model.each<cds.entity>('entity')) {
        // A linked projection also carries `query`.
        if (def.query || !def.name.startsWith('midnight.')) continue;
        if (def['@cds.persistence.skip'] || def['@cds.persistence.exists']) continue;
        const associations = def.associations ?? {};
        const columns = Object.values(def.elements).filter(el => !el.virtual && !(el.name in associations)).map(el => el.name);
        tables.push({ entity: def.name, table: def.name.replace(/\./g, '_'), columns });
    }
    return tables;
}

/** The columns a table has now, in lowercase. Empty when the table is missing or the database is HANA. */
export async function tableColumns(db: DbRunner, kind: string | undefined, table: string): Promise<string[]> {
    if (kind && /hana/i.test(kind)) return [];
    const rows: Array<{ name: unknown }> = await db.run(kind && /postgres/i.test(kind)
        ? `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table.toLowerCase()}'`
        : `SELECT name FROM pragma_table_info('${table}')`);
    return (rows ?? []).map(row => String(row.name).toLowerCase());
}
