// Finds stored rows in formats this version no longer reads. Reads only, decrypts nothing.
// SPDX-License-Identifier: Apache-2.0

import { BOUND_ENVELOPE_VERSION } from './crypto';
import { ENVELOPE_COLUMNS } from './encryption-rewrap';
import type { DbService } from './db-types';

export interface OldStoredFormat {
    name: string;
    rows: number;
    fix: string;
}

/** Tables whose rows carry `keyScheme`. A row without it was written before the per-account data key. */
const KEY_SCHEME_TABLES = ['midnight_PrivateStates', 'midnight_ContractSigningKeys', 'midnight_WalletSyncStates'] as const;

/** Binary columns that older releases wrote as base64 text on PostgreSQL. */
const BINARY_COLUMNS = [
    ['midnight_ContractStates', 'state'], ['midnight_ContractStates', 'zswapState'],
    ['midnight_ContractActions', 'state'], ['midnight_ContractActions', 'zswapState'],
    ['midnight_Blocks', 'ledgerParameters']
] as const;
/** `midnight:` as base64. A stored value that starts with it is base64 text, not bytes. */
const BASE64_TAG = 'bWlkbmlnaHQ6';

const REWRAP_WITH_0_46 = 'Run nightgate-rewrap-keys of 0.46.x until it reports no legacy rows, then update.';

function countOf(rows: unknown): number {
    const row = (Array.isArray(rows) ? rows[0] : rows) as { n?: unknown; N?: unknown } | undefined;
    return Number(row?.n ?? row?.N ?? 0);
}

async function countWhere(db: DbService, table: string, where: string): Promise<number> {
    return countOf(await db.run(`SELECT count(*) AS n FROM ${table} WHERE ${where}`));
}

/** Every old format with its number of rows. Empty on a database this version reads completely. */
export async function findOldStoredFormats(db: DbService, kind: string): Promise<OldStoredFormat[]> {
    const found: OldStoredFormat[] = [];
    const add = (name: string, rows: number, fix: string) => { if (rows > 0) found.push({ name, rows, fix }); };

    let keyScheme = 0;
    for (const table of KEY_SCHEME_TABLES) keyScheme += await countWhere(db, table, 'keyScheme IS NULL');
    add('account-key-scheme', keyScheme, REWRAP_WITH_0_46);

    let envelopes = 0;
    for (const c of ENVELOPE_COLUMNS) {
        envelopes += await countWhere(db, c.table, [`${c.column} IS NOT NULL`, `substr(${c.column}, 1, 3) <> '${BOUND_ENVELOPE_VERSION}:'`, c.whereSql].filter(Boolean).join(' AND '));
    }
    add('unbound-envelope', envelopes, REWRAP_WITH_0_46);

    let spelling = 0;
    for (const table of ['midnight_PrivateStates', 'midnight_ContractSigningKeys']) {
        spelling += await countWhere(db, table, "contractAddress <> lower(contractAddress) OR contractAddress LIKE '0x%'");
    }
    add('contract-address-spelling', spelling,
        "Write the addresses of midnight_PrivateStates and midnight_ContractSigningKeys in lowercase without 0x: UPDATE <table> SET contractAddress = lower(contractAddress), then remove a leading 0x.");
    add('per-action-contract-state', await countWhere(db, 'midnight_ContractActions', 'state IS NOT NULL AND stateHash IS NULL'),
        'Run scripts/compact-contract-state.mjs with the server stopped.');
    if (/postgres/i.test(kind)) {
        let base64 = 0;
        for (const [table, column] of BINARY_COLUMNS) {
            base64 += await countWhere(db, table, `${column} IS NOT NULL AND substring(${column} from 1 for 12) = convert_to('${BASE64_TAG}', 'UTF8')`);
        }
        add('postgres-base64-binary', base64, 'Run the repair for binary columns in docs/operations.md.');
    }
    return found;
}
