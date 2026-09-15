/**
 * Rollback counter on SyncState. Indexer lookups run outside the transaction
 * that records them: capture the generation first, lock + compare at write.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { SyncState } from '#cds-models/midnight';

const { SELECT } = cds.ql;

type Runner = { run: (...args: any[]) => Promise<unknown> };

export async function readReorgGeneration(runner: Runner): Promise<number> {
    const row = await runner.run(SELECT.one.from(SyncState).columns('reorgGeneration').where({ ID: 'SINGLETON' })) as { reorgGeneration?: unknown } | null;
    const n = Number(row?.reorgGeneration ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Take the singleton's row lock (the same-value UPDATE), then read the
 * generation as this transaction sees it. Serialises with a rollback's bump.
 */
export async function lockReorgGeneration(tx: Runner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}

/**
 * Must be the rollback transaction's FIRST write: the lock it takes makes
 * confirmer commits wait, so none can slip old-fork evidence past the cleanup.
 */
export async function bumpReorgGeneration(tx: Runner): Promise<number> {
    await tx.run("UPDATE midnight_SyncState SET reorgGeneration = COALESCE(reorgGeneration, 0) + 1 WHERE ID = 'SINGLETON'");
    return readReorgGeneration(tx);
}
