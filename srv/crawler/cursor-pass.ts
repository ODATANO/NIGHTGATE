// Cursor shared by the decode pass and the indexer supplement.
// Each pass walks indexed blocks behind the tip and stores its progress in its own SyncState column.
import cds from '@sap/cds';
import { Blocks, SyncState, type Block } from '#cds-models/midnight';
import { lockReorgGeneration } from '../submission/reorg-generation';
import type { Row } from '../utils/db-types';

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export type PassCursorColumn = 'lastDecodedHeight' | 'lastSupplementedHeight';

/** The cursor and rollback counter at the start of a pass. Both must be unchanged when the pass saves its cursor. */
export interface PassPosition {
    cursor: number | null;
    generation: number;
}

/** The range a pass may work on: from the cursor up to the lag distance below the tip. Null without a SyncState row. */
export async function readPassWindow(db: cds.DatabaseService, column: PassCursorColumn, lagBlocks: number): Promise<{ start: PassPosition; from: number; ceiling: number } | null> {
    // Cursor and rollback counter are read together. With two reads, a rollback in between
    // could pair an old cursor with a new counter, and the final check would not notice.
    const sync: Pick<SyncState, PassCursorColumn | 'lastIndexedHeight' | 'reorgGeneration'> | undefined = await db.run(
        SELECT.one.from(SyncState).columns(column, 'lastIndexedHeight', 'reorgGeneration').where({ ID: 'SINGLETON' })
    );
    if (!sync) return null;
    const ceiling = Number(sync.lastIndexedHeight ?? 0) - lagBlocks;
    const cursor = sync[column] == null ? null : Number(sync[column]);
    const generation = Number(sync.reorgGeneration ?? 0);
    const start: PassPosition = { cursor, generation: Number.isFinite(generation) ? generation : 0 };
    const from = cursor == null ? 0 : cursor + 1;
    return { start, from, ceiling };
}

/** True when the window holds no block to work on yet. */
export function windowIsEmpty(w: { from: number; ceiling: number }): boolean {
    return !Number.isFinite(w.ceiling) || w.from > w.ceiling;
}

/** Indexed blocks from `from` up to `ceiling`, at most `limit`, oldest first. */
export async function blocksInRange(db: cds.DatabaseService, from: number, ceiling: number, limit: number): Promise<Row<Block, 'ID' | 'height'>[]> {
    return await db.run(
        SELECT.from(Blocks).columns('ID', 'height')
            .where({ height: { '>=': from } }).and({ height: { '<=': ceiling } })
            .orderBy('height asc').limit(limit)
    ) || [];
}

// Saves the cursor only if cursor and rollback counter are unchanged since the pass started.
// Otherwise a reorg during the pass would be overwritten and re-indexed blocks skipped.
// The counter is needed because a rollback to exactly the cursor height leaves the cursor unchanged.
export async function advancePassCursor(db: cds.DatabaseService, column: PassCursorColumn, expected: PassPosition, height: number, pass: string): Promise<boolean> {
    let advanced = false;
    await db.tx(async (tx) => {
        const generation = await lockReorgGeneration(tx);
        const current: Pick<SyncState, PassCursorColumn> | undefined = await tx.run(
            SELECT.one.from(SyncState).columns(column).where({ ID: 'SINGLETON' })
        );
        const now = current?.[column] == null ? null : Number(current[column]);
        if (generation !== expected.generation || now !== expected.cursor) {
            log.info(`${pass} pass dropped: started at cursor ${expected.cursor} generation ${expected.generation}, found ${now} / ${generation}`);
            return;
        }
        await tx.run(UPDATE.entity(SyncState).set({ [column]: height }).where({ ID: 'SINGLETON' }));
        advanced = true;
    });
    return advanced;
}

/** A pause between passes that `wake()` ends early, so a stop never waits out a long backoff. */
export class PassPause {
    private wakeUp: (() => void) | null = null;

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                this.wakeUp = null;
                resolve();
            };
            const timer = setTimeout(done, ms);
            timer.unref();
            this.wakeUp = done;
        });
    }

    wake(): void {
        this.wakeUp?.();
    }
}
