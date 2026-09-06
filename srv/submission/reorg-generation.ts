/**
 * Reorg generation: a counter on the SyncState singleton that every rollback
 * transaction increments. An indexer lookup runs OUTSIDE the write
 * transaction that records its outcome, so a rollback in between would let
 * evidence of the rolled-back fork commit and leave the pending scan for
 * good. Readers capture the generation before the lookup and the write
 * transaction locks the singleton row (a rollback updates the same row, so
 * the two serialise) and compares; a changed generation means "look again".
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { SyncState } from '#cds-models/midnight';

const { SELECT } = cds.ql;

type Runner = { run: (...args: any[]) => Promise<unknown> };

/** The current generation; 0 when the singleton does not exist yet. */
export async function readReorgGeneration(runner: Runner): Promise<number> {
    const row = await runner.run(SELECT.one.from(SyncState).columns('reorgGeneration').where({ ID: 'SINGLETON' })) as { reorgGeneration?: unknown } | null;
    const n = Number(row?.reorgGeneration ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Inside a write transaction: take the singleton's row lock, then read the
 * generation as this transaction sees it. The same-value UPDATE is the lock
 * (PostgreSQL writes a new tuple version regardless; SQLite has one writer).
 * Unquoted identifiers fold to the names CAP created on both databases.
 */
export async function lockReorgGeneration(tx: Runner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}

/**
 * Inside the rollback transaction, as its FIRST write: one atomic increment
 * that also takes the singleton's row lock. From here until the rollback
 * commits, every confirmer commit waits on that lock and then sees the new
 * generation; a bump after the cleanup would leave a window in which a
 * confirmer commits the old fork's evidence and the cleanup misses it.
 */
export async function bumpReorgGeneration(tx: Runner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) + 1 WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}
