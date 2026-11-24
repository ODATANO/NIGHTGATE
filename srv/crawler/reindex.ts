// A manual reindex: the rollback runs from the tip down in slices, each committed on its own.
// The target height stays in SyncState until the last slice, because the crawler must not index upward
// from a half finished rollback. A restart or `resumeCrawler` finishes the rollback first.

import cds from '@sap/cds';
import { Blocks, SyncState, WalletSyncStates, type Block } from '#cds-models/midnight';
import { rollbackIndexedDataFromHeight } from './rollback';
import { errorMessage } from '../utils/errors';
import { bareHex } from '../utils/hex-patterns';
import type { DbService } from '../utils/db-types';

const { SELECT, UPDATE, DELETE } = cds.ql;

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

/** What the tool for a relaunched chain reads from the node: its finalized head and the hash of a finalized block. */
export interface FinalizedChain {
    head(): Promise<{ height: number; hash: string }>;
    hashAt(height: number): Promise<string | null | undefined>;
}

export interface ChainAdoption {
    indexedHeight: number | null; // null = the index is empty
    nodeHeight: number;
    lastCommonHeight: number | null; // null = no stored block is on the node's chain
    blocksAbove: number; // stored blocks that are not on the node's chain
    walletStates: number; // saved wallet states, all dropped by an adoption
    verdict: 'same' | 'node-behind' | 'other-chain';
    applied: boolean;
}

/** The highest stored block the node's finalized chain also has, searched between the lowest stored block and `top`. Null when it has none. */
async function lastCommonBlock(db: DbService, node: FinalizedChain, lowest: number, top: number): Promise<number | null> {
    const same = async (height: number): Promise<boolean> => {
        const stored: Pick<Block, 'hash'> | undefined = await db.run(SELECT.one.from(Blocks).columns('hash').where({ height }));
        const onNode = bareHex(await node.hashAt(height));
        if (!stored?.hash || !onNode) throw new Error(`block ${height} cannot be compared: ${stored?.hash ? 'the node does not answer for it' : 'it is not stored'}`);
        return stored.hash === onNode;
    };
    if (await same(top)) return top;
    if (!await same(lowest)) return null;
    // `low` is on the node's chain, `high` is not. Blocks are stored without gaps, so the two meet at the fork.
    let low = lowest;
    let high = top;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (await same(middle)) low = middle; else high = middle;
    }
    return low;
}

/** Compares the index with the node's finalized chain and, with `apply`, moves the database to that chain:
 *  the saved wallet states are dropped and the index is rolled back to the last common block. Run it with the server stopped. */
export async function adoptNodeChain(db: DbService, node: FinalizedChain, opts: { apply: boolean; sliceBlocks?: number }): Promise<ChainAdoption> {
    const { height: nodeHeight } = await node.head();
    const [lowest]: Array<Pick<Block, 'height'>> = await db.run(SELECT.from(Blocks).columns('height').orderBy('height asc').limit(1)) ?? [];
    const [highest]: Array<Pick<Block, 'height'>> = await db.run(SELECT.from(Blocks).columns('height').orderBy('height desc').limit(1)) ?? [];
    const walletStates = (await db.run(SELECT.from(WalletSyncStates).columns('accountId')) ?? []).length;
    const report: ChainAdoption = {
        indexedHeight: highest ? Number(highest.height) : null, nodeHeight, lastCommonHeight: null, blocksAbove: 0, walletStates, verdict: 'same', applied: false
    };
    if (!lowest || !highest) return report;
    const first = Number(lowest.height);
    const top = Math.min(Number(highest.height), nodeHeight);
    // A node below the lowest stored block has nothing to compare with.
    if (top < first) return { ...report, verdict: 'node-behind' };
    const common = await lastCommonBlock(db, node, first, top);
    report.lastCommonHeight = common;
    if (common === top) return { ...report, verdict: top < Number(highest.height) ? 'node-behind' : 'same' };

    const from = common === null ? first : common + 1;
    report.verdict = 'other-chain';
    report.blocksAbove = (await db.run(SELECT.from(Blocks).columns('ID').where({ height: { '>=': from } })) ?? []).length;
    if (!opts.apply) return report;

    // Wallet states first: an interrupted rollback is finished by the next start, a later delete would not be.
    await db.tx(tx => tx.run(DELETE.from(WalletSyncStates)));
    const progress: ReindexProgress = { requestedHeight: from, blocksRolledBack: 0, transactionsRolledBack: 0, effectiveStartHeight: null };
    try {
        await rollbackInSlices(db, progress, await saveTarget(db, from), opts.sliceBlocks ?? REINDEX_SLICE_BLOCKS);
    } catch (err) {
        await recordFailure(db, from, err);
        throw err;
    }
    return { ...report, applied: true };
}

/** Test hook. */
export function __resetReindexForTests(): void {
    running = null;
}
