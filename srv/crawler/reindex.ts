// A manual reindex: the rollback runs from the tip down in slices, each committed on its own.
// The target height stays in SyncState until the last slice, because the crawler must not index upward
// from a half finished rollback. A restart or `resumeCrawler` finishes the rollback first.

import cds from '@sap/cds';
import { Blocks, SyncState } from '#cds-models/midnight';
import { rollbackIndexedDataFromHeight } from './rollback';
import { errorMessage } from '../utils/errors';
import type { DbService } from '../utils/db-types';

const { SELECT, UPDATE } = cds.ql;

const log = cds.log('nightgate:indexer');

export const REINDEX_SLICE_BLOCKS = 2000;

const LAST_ERROR_MAX = 500;

export interface ReindexProgress {
    requestedHeight: number;
    blocksRolledBack: number;
    transactionsRolledBack: number;
    effectiveStartHeight: number | null; // null = not finished
}

export interface ReindexCrawlerControl {
    /** Stops the crawler. True when it must run again after the rollback. */
    stop(): Promise<boolean>;
    start(): Promise<void>;
}

export interface ReindexOutcome {
    progress: ReindexProgress;
    crawlerResumed: boolean;
    resumeError: string | null;
}

let running: { progress: ReindexProgress } | null = null;

/** Not null from the claim, before the crawler stops, until the crawler runs again. */
export function reindexInProgress(): ReindexProgress | null {
    return running ? { ...running.progress } : null;
}

/** The height an unfinished rollback must still reach, null when none is open. */
export async function pendingReindexHeight(db: DbService): Promise<number | null> {
    const row: { reindexTargetHeight?: number | string | null } | undefined = await db.tx((tx) => tx.run(
        SELECT.one.from(SyncState).columns('reindexTargetHeight').where({ ID: 'SINGLETON' })
    ));
    return row?.reindexTargetHeight == null ? null : Number(row.reindexTargetHeight);
}

/** Claims the reindex at once and runs it. The promise settles when the crawler runs again, or with the first failure. */
export function startReindex(db: DbService, fromHeight: number, crawler: ReindexCrawlerControl, sliceBlocks = REINDEX_SLICE_BLOCKS): Promise<ReindexOutcome> {
    if (running) throw new Error('a reindex is already running');
    const progress: ReindexProgress = { requestedHeight: fromHeight, blocksRolledBack: 0, transactionsRolledBack: 0, effectiveStartHeight: null };
    running = { progress };
    return runReindex(db, progress, crawler, sliceBlocks).finally(() => { running = null; });
}

async function runReindex(db: DbService, progress: ReindexProgress, crawler: ReindexCrawlerControl, sliceBlocks: number): Promise<ReindexOutcome> {
    let resume = false;
    try {
        resume = await crawler.stop();
        await rollbackInSlices(db, progress, await saveTarget(db, progress.requestedHeight), sliceBlocks);
    } catch (err) {
        await recordFailure(db, progress.requestedHeight, err);
        throw err;
    }
    if (!resume) return { progress: { ...progress }, crawlerResumed: false, resumeError: null };
    try {
        await crawler.start();
        return { progress: { ...progress }, crawlerResumed: true, resumeError: null };
    } catch (err) {
        const resumeError = errorMessage(err);
        log.error('Failed to resume crawler after reindex:', resumeError);
        return { progress: { ...progress }, crawlerResumed: false, resumeError };
    }
}

// An open lower target stays: the blocks above it may still hold the old data.
async function saveTarget(db: DbService, height: number): Promise<number> {
    return db.tx(async (tx) => {
        const row: { reindexTargetHeight?: number | string | null } | undefined = await tx.run(
            SELECT.one.from(SyncState).columns('reindexTargetHeight').where({ ID: 'SINGLETON' })
        );
        const target = row?.reindexTargetHeight == null ? height : Math.min(height, Number(row.reindexTargetHeight));
        await tx.run(UPDATE.entity(SyncState).set({ reindexTargetHeight: target }).where({ ID: 'SINGLETON' }));
        return target;
    });
}

async function rollbackInSlices(db: DbService, progress: ReindexProgress, target: number, sliceBlocks: number): Promise<void> {
    for (;;) {
        // Every read runs in the slice's own transaction, never in the caller's request transaction.
        const { sliceFrom, result } = await db.tx(async (tx) => {
            const top: { height?: number } | undefined = await tx.run(
                SELECT.one.from(Blocks).columns('height').where({ height: { '>=': target } }).orderBy('height desc')
            );
            const from = top?.height == null ? target : Math.max(target, Number(top.height) - sliceBlocks + 1);
            const done = from === target ? { reindexTargetHeight: null, lastError: null, lastErrorAt: null } : {};
            return { sliceFrom: from, result: await rollbackIndexedDataFromHeight(tx, from, { syncStatus: 'stopped', extraSyncState: { syncProgress: 0, ...done } }) };
        });
        progress.blocksRolledBack += result.blocksRolledBack;
        progress.transactionsRolledBack += result.transactionsRolledBack;
        if (sliceFrom === target) {
            progress.effectiveStartHeight = result.forkBlock?.height != null ? Number(result.forkBlock.height) + 1 : 0;
            return;
        }
        log.info(`reindex from ${target}: rolled back down to ${sliceFrom}, ${progress.blocksRolledBack} block(s) so far`);
    }
}

async function recordFailure(db: DbService, height: number, err: unknown): Promise<void> {
    const message = `reindex from ${height} failed: ${errorMessage(err)}`;
    log.error(message);
    try {
        await db.tx((tx) => tx.run(UPDATE.entity(SyncState).set({
            syncStatus: 'error',
            lastError: message.slice(0, LAST_ERROR_MAX),
            lastErrorAt: new Date().toISOString()
        }).where({ ID: 'SINGLETON' })));
    } catch (writeErr) {
        log.error(`could not record the failed reindex: ${errorMessage(writeErr)}`);
    }
}

/** Test hook. */
export function __resetReindexForTests(): void {
    running = null;
}
