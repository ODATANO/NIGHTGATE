/**
 * Resets the cursor of the ledger payload decode pass.
 * The pass decodes every block above the cursor, so lowering the cursor decodes those blocks again.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { lockReorgGeneration } from '../submission/reorg-generation';
import { Blocks, SyncState } from '#cds-models/midnight';

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface RedecodeResult {
    fromHeight: number;
    /** Previous cursor position. Null means nothing was decoded yet. */
    previousDecodedHeight: number | null;
    blocks: number;
    /** False when the cursor was already below `height` and was left alone. */
    changed: boolean;
}

export class RedecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RedecodeError';
    }
}

/**
 * Moves the decode cursor to `height - 1`, so the pass decodes again from `height` upwards.
 * The cursor is only ever lowered, because raising it would skip blocks.
 * Runs under the reorg lock, so a pass that is running at the same time discards its own cursor update.
 */
export async function redecodeFromHeight(db: cds.DatabaseService, height: unknown): Promise<RedecodeResult> {
    // An Integer64 arrives as a number or a decimal string. Anything else is rejected.
    const from = typeof height === 'number' || (typeof height === 'string' && /^\d+$/.test(height)) ? Number(height) : NaN;
    if (!Number.isInteger(from) || from < 0) throw new RedecodeError('height must be a non-negative integer');

    let result: RedecodeResult | null = null;
    await db.tx(async (tx) => {
        await lockReorgGeneration(tx);
        const sync: any = await tx.run(
            SELECT.one.from(SyncState).columns('lastDecodedHeight', 'lastIndexedHeight').where({ ID: 'SINGLETON' })
        );
        if (!sync) throw new RedecodeError('the index has no sync state yet');
        const cursor = sync.lastDecodedHeight == null ? null : Number(sync.lastDecodedHeight);
        const indexed = Number(sync.lastIndexedHeight ?? 0);
        const counted: any = await tx.run(
            SELECT.one.from(Blocks).columns('count(*) as blocks')
                .where({ height: { '>=': from } }).and({ height: { '<=': indexed } })
        );
        const blocks = Number(counted?.blocks ?? 0);
        if (cursor == null || cursor < from) {
            result = { fromHeight: from, previousDecodedHeight: cursor, blocks, changed: false };
            return;
        }
        await tx.run(UPDATE.entity(SyncState).set({ lastDecodedHeight: from === 0 ? null : from - 1 }).where({ ID: 'SINGLETON' }));
        result = { fromHeight: from, previousDecodedHeight: cursor, blocks, changed: true };
    });
    const r = result as unknown as RedecodeResult;
    if (r.changed) log.info(`ledger payload decode cursor moved from ${r.previousDecodedHeight} to below ${from}: ${r.blocks} block(s) to decode again`);
    return r;
}
