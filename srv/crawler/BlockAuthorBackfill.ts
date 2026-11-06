// SPDX-License-Identifier: Apache-2.0
// One-time pass over blocks stored before the validator was resolved. It reads their headers again
// and writes the validator and the slot. `SyncState.authorsBackfilledAt` marks the end.

import cds from '@sap/cds';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Blocks, SyncState, type Block } from '#cds-models/midnight';
import type { BlockHeader, MidnightNodeProvider } from '../providers/MidnightNodeProvider';
import { errorMessage } from '../utils/errors';
import type { Row } from '../utils/db-types';
import { BlockAuthorResolver, type BlockProducer } from './block-author';
import { PassPause } from './cursor-pass';

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface AuthorBackfillConfig {
    /** Blocks per pass. Their headers come in one JSON-RPC frame and are written in one database transaction. */
    batchSize: number;
    /** Pause after a pass that rewrote blocks, so other work gets the thread. */
    intervalMs: number;
    /** Pause after a failed pass. */
    retryMs: number;
}

/** Seal checks in a row before the event loop gets a turn. */
const YIELD_EVERY = 20;
const PROGRESS_LOG_EVERY = 50_000;

export class BlockAuthorBackfill {
    private db!: cds.DatabaseService;
    private running = false;
    private loop: Promise<void> | null = null;
    private readonly pause = new PassPause();
    private readonly authors: BlockAuthorResolver;
    private rewritten = 0;
    private loggedAt = 0;

    constructor(
        private readonly node: Pick<MidnightNodeProvider, 'rpcBatch' | 'getStorage'>,
        private readonly config: AuthorBackfillConfig
    ) {
        this.authors = new BlockAuthorResolver(node);
    }

    async init(db: cds.DatabaseService): Promise<void> {
        this.db = db;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = (async () => {
            while (this.running) {
                try {
                    const rewrote = await this.runOnce();
                    if (rewrote === 'done') break;
                    if (rewrote > 0) await this.pause.sleep(this.config.intervalMs);
                } catch (err) {
                    log.warn(`block author backfill pass failed: ${errorMessage(err)}`);
                    await this.pause.sleep(this.config.retryMs);
                }
            }
            this.running = false;
        })();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.pause.wake();
        if (this.loop) {
            await this.loop;
            this.loop = null;
        }
    }

    /** One batch above the cursor. Returns the blocks rewritten, or 'done' once no block is left. */
    async runOnce(): Promise<number | 'done'> {
        const sync: Pick<SyncState, 'authorBackfillHeight' | 'authorsBackfilledAt'> | undefined = await this.db.run(
            SELECT.one.from(SyncState).columns('authorBackfillHeight', 'authorsBackfilledAt').where({ ID: 'SINGLETON' })
        );
        if (!sync || sync.authorsBackfilledAt) return 'done';

        const from = sync.authorBackfillHeight == null ? 0 : Number(sync.authorBackfillHeight) + 1;
        const blocks: Row<Block, 'ID' | 'hash' | 'height'>[] = await this.db.run(
            SELECT.from(Blocks).columns('ID', 'hash', 'height', 'slot')
                .where({ height: { '>=': from } }).orderBy('height asc').limit(this.config.batchSize)
        ) || [];
        if (blocks.length === 0) {
            // Every block stored from now on gets its validator when it is indexed.
            await this.db.run(UPDATE.entity(SyncState).set({ authorsBackfilledAt: new Date().toISOString() }).where({ ID: 'SINGLETON' }));
            if (this.rewritten) log.info(`block authors: ${this.rewritten} block(s) rewritten, backfill complete`);
            return 'done';
        }

        const unresolved = blocks.filter(block => block.slot == null);
        const producers = await this.resolve(unresolved);
        const last = Number(blocks[blocks.length - 1].height);
        await this.db.tx(async (tx) => {
            for (let i = 0; i < unresolved.length; i++) {
                await tx.run(UPDATE.entity(Blocks).set({ author: producers[i].author, slot: producers[i].slot }).where({ ID: unresolved[i].ID }));
            }
            await tx.run(UPDATE.entity(SyncState).set({ authorBackfillHeight: last }).where({ ID: 'SINGLETON' }));
        });

        this.rewritten += unresolved.length;
        if (this.rewritten - this.loggedAt >= PROGRESS_LOG_EVERY) {
            this.loggedAt = this.rewritten;
            log.info(`block authors: ${this.rewritten} block(s) rewritten, up to height ${last}`);
        }
        return unresolved.length;
    }

    private async resolve(blocks: Row<Block, 'ID' | 'hash' | 'height'>[]): Promise<BlockProducer[]> {
        if (blocks.length === 0) return [];
        const headers = await this.node.rpcBatch(
            blocks.map(block => ({ method: 'chain_getHeader', params: [block.hash] }))
        ) as Array<BlockHeader | null>;
        const producers: BlockProducer[] = [];
        for (let i = 0; i < blocks.length; i++) {
            const header = headers[i];
            if (!header) throw new Error(`No header for block ${blocks[i].hash} at height ${blocks[i].height}`);
            producers.push(await this.authors.resolve(blocks[i].hash, header));
            if (i % YIELD_EVERY === YIELD_EVERY - 1) await nextTurn();
        }
        return producers;
    }
}
