/**
 * A counter on SyncState that goes up with every chain rollback.
 * Indexer lookups run outside the database transaction that saves their result.
 * So read the counter before the lookup, then lock and compare it when writing.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { SyncState } from '#cds-models/midnight';
import type { DbRunner } from '../utils/db-types';

const { SELECT } = cds.ql;


export async function readReorgGeneration(runner: DbRunner): Promise<number> {
    const row = await runner.run(SELECT.one.from(SyncState).columns('reorgGeneration').where({ ID: 'SINGLETON' })) as { reorgGeneration?: unknown } | null;
    const n = Number(row?.reorgGeneration ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Lock the SyncState row, then read the counter. The lock makes this wait for a running rollback.
 */
export async function lockReorgGeneration(tx: DbRunner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}

/**
 * Must be the first write of the rollback transaction. Its lock makes confirmations wait,
 * so none can save data from the abandoned fork after the cleanup.
 */
export async function bumpReorgGeneration(tx: DbRunner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) + 1 WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}
