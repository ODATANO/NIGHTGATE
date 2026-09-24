/**
 * The pass that fills what a block does not carry, from the Midnight indexer.
 *
 * Deliberately a second source with its own cursor rather than a wider crawl:
 * the crawler reads a node and owes nothing to an indexer, and this pass can be
 * off without any of that changing. Rows are joined on `Transactions.ledgerTxHash`,
 * the hash the pallet reports and the indexer keys its transactions by.
 */

import cds from '@sap/cds';
import {
    createIndexerClient, isIndexerRateLimit, type IndexerClient, type SupplementBlock,
    type SupplementTransaction, type SupplementLedgerEvent, type SupplementDustEvent
} from './indexer-supplement';
import { readCapBinary } from './cap-binary';
import { lockReorgGeneration } from '../submission/reorg-generation';
import {
    Blocks, Transactions, TransactionResults, TransactionSegments, TransactionFees,
    ContractActions, ContractBalances, UnshieldedUtxos, ZswapLedgerEvents,
    DustLedgerEvents, SyncState
} from '#cds-models/midnight';

/** Where a pass started: both have to still hold when it writes its cursor. */
interface PassPosition {
    cursor: number | null;
    generation: number;
}

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface IndexerSupplementConfig {
    url: string;
    batchSize: number;
    intervalMs: number;
    /** Stay this far below the indexed tip: the indexer trails the node. */
    lagBlocks: number;
    requestTimeoutMs: number;
    /**
     * Indexer requests per second, paced per request (one request is one
     * block), so the batch size no longer sets the rate. 0 or unset = unpaced.
     */
    maxBlocksPerSecond?: number;
}

/** First wait after the indexer refused (403/429); doubles per refusal up to RATE_LIMIT_MAX_MS. */
export const RATE_LIMIT_BACKOFF_MS = 60_000;
export const RATE_LIMIT_MAX_MS = 15 * 60_000;

export interface SupplementRunResult {
    blocks: number;
    transactions: number;
    fees: number;
    segments: number;
    balances: number;
    zswapEvents: number;
    dustEvents: number;
    dustFlags: number;
}

const EMPTY_RUN: SupplementRunResult = {
    blocks: 0, transactions: 0, fees: 0, segments: 0, balances: 0, zswapEvents: 0, dustEvents: 0, dustFlags: 0
};

export class IndexerSupplement {
    private db!: cds.DatabaseService;
    private client!: IndexerClient;
    private running = false;
    private loop: Promise<void> | null = null;
    /** Set by stop(): the pass in flight ends after the block it is on. */
    private stopping = false;
    /** Resolves the sleep in progress, set while one is; stop() calls it. */
    private wake: (() => void) | null = null;
    /** Last parameters written, so an unchanged set is not stored again. */
    private lastLedgerParameters: string | null = null;
    /** The generation that cache belongs to; a rollback can delete its block. */
    private cachedGeneration: number | null = null;
    /** When the last indexer request went out, for the pacing. */
    private lastRequestAt = 0;
    /** Refusals (403/429) in a row; reset by the next pass that gets through. */
    private refusals = 0;

    constructor(private readonly config: IndexerSupplementConfig, client?: IndexerClient) {
        if (client) this.client = client;
    }

    async init(db: cds.DatabaseService): Promise<void> {
        this.db = db;
        if (!this.client) this.client = createIndexerClient(this.config.url, this.config.requestTimeoutMs);
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.stopping = false;
        this.loop = (async () => {
            while (this.running) {
                let delay: number;
                try {
                    const progressed = (await this.runOnce()).blocks;
                    this.refusals = 0;
                    delay = progressed > 0 ? this.config.intervalMs : this.config.intervalMs * 4;
                } catch (err) {
                    if (isIndexerRateLimit(err)) {
                        // The edge blocks the host IP, not this request, and
                        // every retry keeps the block alive: wait minutes, not
                        // the four seconds a passing outage gets.
                        this.refusals += 1;
                        delay = Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** (this.refusals - 1), RATE_LIMIT_MAX_MS);
                        log.warn(`indexer supplement refused (${(err as Error).message}); backing off ${Math.round(delay / 1000)} s`);
                    } else {
                        log.warn(`indexer supplement pass failed: ${(err as Error).message}`);
                        delay = this.config.intervalMs * 4;
                    }
                }
                await this.sleep(delay);
            }
        })();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.stopping = true;
        this.wake?.();
        if (this.loop) {
            await this.loop.catch(() => { /* reported in the loop */ });
            this.loop = null;
        }
    }

    /** One pass over the next batch of blocks above the cursor. */
    async runOnce(): Promise<SupplementRunResult> {
        const sync: any = await this.db.run(
            // One read of the singleton: a rollback between separate reads of
            // the cursor and the generation would hand this pass the old chain
            // position under the new generation, which the final check then
            // accepts as its own.
            SELECT.one.from(SyncState)
                .columns('lastSupplementedHeight', 'lastIndexedHeight', 'reorgGeneration')
                .where({ ID: 'SINGLETON' })
        );
        if (!sync) return EMPTY_RUN;

        const ceiling = Number(sync.lastIndexedHeight ?? 0) - this.config.lagBlocks;
        const cursor = sync.lastSupplementedHeight == null ? null : Number(sync.lastSupplementedHeight);
        const from = cursor == null ? 0 : cursor + 1;
        const generation = Number(sync.reorgGeneration ?? 0);
        const start: PassPosition = { cursor, generation: Number.isFinite(generation) ? generation : 0 };
        // A rollback can remove the block the cached parameters were written
        // to, and then "unchanged" would leave the replacement block empty
        // with nothing below it to fall back on. Re-read after a reorg.
        if (this.cachedGeneration !== start.generation) {
            this.lastLedgerParameters = null;
            this.cachedGeneration = start.generation;
        }
        if (!Number.isFinite(ceiling) || from > ceiling) return EMPTY_RUN;

        const blocks: any[] = await this.db.run(
            SELECT.from(Blocks).columns('ID', 'height')
                .where({ height: { '>=': from } }).and({ height: { '<=': ceiling } })
                .orderBy('height asc').limit(this.config.batchSize)
        ) || [];
        if (blocks.length === 0) {
            await this.setCursor(start, Math.min(from + this.config.batchSize - 1, ceiling));
            return EMPTY_RUN;
        }

        const result: SupplementRunResult = { ...EMPTY_RUN, blocks: blocks.length };
        for (const [index, block] of blocks.entries()) {
            const height = Number(block.height);
            await this.pace();
            if (this.stopping) return this.endBefore(start, blocks, index, result);
            const answer = await this.client.fetchBlock(height);
            if (!answer) {
                // The indexer has not reached this height yet: stop here and
                // retry the same block, rather than moving the cursor past it.
                return this.endBefore(start, blocks, index, result);
            }
            await this.applyBlockFields(block.ID, height, answer);
            const perBlock = await this.applyBlock(answer.transactions);
            result.transactions += perBlock.transactions;
            result.fees += perBlock.fees;
            result.segments += perBlock.segments;
            result.balances += perBlock.balances;
            result.zswapEvents += perBlock.zswapEvents;
            result.dustEvents += perBlock.dustEvents;
            result.dustFlags += perBlock.dustFlags;
        }

        if (!await this.setCursor(start, Number(blocks[blocks.length - 1].height))) return EMPTY_RUN;
        if (result.fees || result.segments || result.balances || result.zswapEvents || result.dustEvents) {
            log.info(
                `indexer supplement up to height ${blocks[blocks.length - 1].height}: ` +
                `${result.fees} fees, ${result.segments} segments, ${result.balances} balances, ` +
                `${result.zswapEvents} zswap and ${result.dustEvents} dust events`
            );
        }
        return result;
    }

    /**
     * The block's ledger parameters, which the node does not serve. Written
     * only when they differ from the last set stored below this height: they
     * are 724 bytes and hold for thousands of blocks, so storing them per
     * block would be gigabytes of duplicates on a full chain.
     */
    private async applyBlockFields(blockId: string, height: number, answer: SupplementBlock): Promise<void> {
        if (!answer.ledgerParameters) return;
        if (this.lastLedgerParameters === null) {
            this.lastLedgerParameters = await this.readParametersBelow(height);
        }
        if (this.lastLedgerParameters === answer.ledgerParameters) return;
        await this.db.run(
            UPDATE.entity(Blocks).set({ ledgerParameters: answer.ledgerParameters as any }).where({ ID: blockId })
        );
        this.lastLedgerParameters = answer.ledgerParameters;
    }

    /** The parameters in force below `height`, for the first block of a pass. */
    private async readParametersBelow(height: number): Promise<string> {
        const row: any = await this.db.run(
            SELECT.one.from(Blocks).columns('ledgerParameters')
                .where({ height: { '<': height }, ledgerParameters: { '!=': null } })
                .orderBy('height desc')
        );
        const stored = await readCapBinary(row?.ledgerParameters);
        return stored ? stored.toString('base64') : '';
    }

    private async applyBlock(transactions: SupplementTransaction[]): Promise<SupplementRunResult> {
        const result: SupplementRunResult = { ...EMPTY_RUN };
        if (transactions.length === 0) return result;

        const hashes = transactions.map(t => t.ledgerTxHash);
        const rows: any[] = await this.db.run(
            SELECT.from(Transactions).columns('ID', 'ledgerTxHash').where({ ledgerTxHash: { in: hashes } })
        ) || [];
        const byHash = new Map<string, string>(rows.map((r: any) => [r.ledgerTxHash, r.ID]));

        for (const tx of transactions) {
            const transactionId = byHash.get(tx.ledgerTxHash);
            if (!transactionId) continue;
            result.transactions++;
            await this.db.tx(async (dbTx: any) => {
                result.fees += await this.applyFee(dbTx, transactionId, tx);
                result.segments += await this.applySegments(dbTx, transactionId, tx);
                result.balances += await this.applyContractState(dbTx, transactionId, tx);
                result.zswapEvents += await this.replaceZswapEvents(dbTx, transactionId, tx.zswapEvents);
                result.dustEvents += await this.replaceDustEvents(dbTx, transactionId, tx.dustEvents);
                result.dustFlags += await this.applyDustFlags(dbTx, tx);
            });
        }
        return result;
    }

    /** The crawler writes a zero fee from the envelope; this is the real one. */
    private async applyFee(dbTx: any, transactionId: string, tx: SupplementTransaction): Promise<number> {
        if (tx.fee == null) return 0;
        const changed = await dbTx.run(
            UPDATE.entity(TransactionFees).set({ paidFees: tx.fee as any }).where({ transaction_ID: transactionId })
        );
        return Number(changed ?? 0) > 0 ? 1 : 0;
    }

    private async applySegments(dbTx: any, transactionId: string, tx: SupplementTransaction): Promise<number> {
        if (tx.segments.length === 0) return 0;
        const resultRow: any = await dbTx.run(
            SELECT.one.from(TransactionResults).columns('ID').where({ transaction_ID: transactionId })
        );
        if (!resultRow) return 0;
        await dbTx.run(DELETE.from(TransactionSegments).where({ transactionResult_ID: resultRow.ID }));
        await dbTx.run(INSERT.into(TransactionSegments).entries(tx.segments.map(segment => ({
            ID: cds.utils.uuid(),
            segmentId: segment.segmentId,
            success: segment.success,
            transactionResult_ID: resultRow.ID
        }))));
        return tx.segments.length;
    }

    /**
     * Fills `state`/`zswapState` on the contract actions the node already
     * recorded and replaces their balances. Actions the node does not have,
     * a call in a failed segment above all, are the indexer's declared set and
     * are not invented here.
     */
    private async applyContractState(dbTx: any, transactionId: string, tx: SupplementTransaction): Promise<number> {
        if (tx.contractActions.length === 0) return 0;
        const actions: any[] = await dbTx.run(
            SELECT.from(ContractActions).columns('ID', 'actionIndex', 'address', 'actionType')
                .where({ transaction_ID: transactionId }).orderBy('actionIndex asc')
        ) || [];
        if (actions.length === 0) return 0;

        // Two calls on one contract carry different state, so a match by
        // address alone would give both the first one's. They are paired in
        // order, and only when both sides report the same number: a partial
        // success leaves the indexer with actions that never applied, and
        // guessing which of ours they belong to would be worse than no state.
        const ours = new Map<string, any[]>();
        for (const action of actions) {
            const key = `${action.address}:${action.actionType}`;
            const list = ours.get(key) ?? [];
            list.push(action);
            ours.set(key, list);
        }
        const theirs = new Map<string, typeof tx.contractActions>();
        for (const declared of tx.contractActions) {
            const key = `${declared.address}:${declared.actionType}`;
            const list = theirs.get(key) ?? [];
            list.push(declared);
            theirs.set(key, list);
        }

        let balances = 0;
        for (const [key, mine] of ours) {
            const matched = theirs.get(key);
            if (!matched || matched.length !== mine.length) {
                if (matched) {
                    log.debug(
                        `transaction ${transactionId}: ${mine.length} indexed ${key} action(s) against ` +
                        `${matched.length} reported; state not assigned`
                    );
                }
                continue;
            }
            for (let i = 0; i < mine.length; i++) {
                const action = mine[i];
                const match = matched[i];
                await dbTx.run(UPDATE.entity(ContractActions)
                    .set({ state: match.state as any, zswapState: match.zswapState as any })
                    .where({ ID: action.ID }));
                await dbTx.run(DELETE.from(ContractBalances).where({ contractAction_ID: action.ID }));
                if (match.balances.length === 0) continue;
                await dbTx.run(INSERT.into(ContractBalances).entries(match.balances.map(balance => ({
                    ID: cds.utils.uuid(),
                    tokenType: balance.tokenType,
                    amount: balance.amount,
                    contractAction_ID: action.ID
                }))));
                balances += match.balances.length;
            }
        }
        return balances;
    }

    /** Replaces a transaction's zswap event rows wholesale, so a re-run is idempotent. */
    private async replaceZswapEvents(
        dbTx: any,
        transactionId: string,
        events: SupplementLedgerEvent[]
    ): Promise<number> {
        await dbTx.run(DELETE.from(ZswapLedgerEvents).where({ transaction_ID: transactionId }));
        if (events.length === 0) return 0;
        await dbTx.run(INSERT.into(ZswapLedgerEvents).entries(events.map(event => ({
            ID: cds.utils.uuid(),
            eventId: event.eventId,
            maxId: event.maxId,
            raw: event.raw as any,
            transaction_ID: transactionId
        }))));
        return events.length;
    }

    /** Same, for the DUST stream, which carries its kind and the backing nonce. */
    private async replaceDustEvents(
        dbTx: any,
        transactionId: string,
        events: SupplementDustEvent[]
    ): Promise<number> {
        await dbTx.run(DELETE.from(DustLedgerEvents).where({ transaction_ID: transactionId }));
        if (events.length === 0) return 0;
        await dbTx.run(INSERT.into(DustLedgerEvents).entries(events.map(event => ({
            ID: cds.utils.uuid(),
            eventId: event.eventId,
            maxId: event.maxId,
            raw: event.raw as any,
            eventType: event.eventType,
            dustOutputNonce: event.dustOutputNonce,
            transaction_ID: transactionId
        }))));
        return events.length;
    }

    /** Registration binds the address, so the flag can turn on after the UTXO exists. */
    private async applyDustFlags(dbTx: any, tx: SupplementTransaction): Promise<number> {
        let updated = 0;
        for (const output of tx.dustRegisteredOutputs) {
            const changed = await dbTx.run(
                UPDATE.entity(UnshieldedUtxos)
                    .set({ registeredForDustGeneration: true })
                    .where({ intentHash: output.intentHash, outputIndex: output.outputIndex })
            );
            if (Number(changed ?? 0) > 0) updated++;
        }
        return updated;
    }

    /**
     * Advances the cursor only when it still holds what this pass started
     * from. A reorg lowers it while a pass is in flight, and writing the
     * pass's own height over that would skip every re-indexed block.
     */
    /**
     * Advances the cursor only when neither the cursor nor the rollback
     * generation moved since this pass started. The generation is the decisive
     * one: a rollback to exactly the cursor's height leaves the cursor alone,
     * so comparing values would miss it and the replacement blocks would be
     * skipped. The lock serialises this against a rollback's bump.
     */
    private async setCursor(expected: PassPosition, height: number): Promise<boolean> {
        let advanced = false;
        await this.db.tx(async (tx: any) => {
            const generation = await lockReorgGeneration(tx);
            const current: any = await tx.run(
                SELECT.one.from(SyncState).columns('lastSupplementedHeight').where({ ID: 'SINGLETON' })
            );
            const now = current?.lastSupplementedHeight == null ? null : Number(current.lastSupplementedHeight);
            if (generation !== expected.generation || now !== expected.cursor) {
                log.info(
                    `indexer supplement pass dropped: started at cursor ${expected.cursor} generation ` +
                    `${expected.generation}, found ${now} / ${generation}`
                );
                return;
            }
            await tx.run(
                UPDATE.entity(SyncState).set({ lastSupplementedHeight: height }).where({ ID: 'SINGLETON' })
            );
            advanced = true;
        });
        return advanced;
    }

    /** Ends the pass before `blocks[index]`: the cursor records the blocks done, the rest wait for the next pass. */
    private async endBefore(start: PassPosition, blocks: any[], index: number, result: SupplementRunResult): Promise<SupplementRunResult> {
        if (index === 0) return EMPTY_RUN;
        result.blocks = index;
        await this.setCursor(start, Number(blocks[index].height) - 1);
        return result;
    }

    /** Holds the next indexer request until its slot at `maxBlocksPerSecond` has come. */
    private async pace(): Promise<void> {
        const cap = this.config.maxBlocksPerSecond ?? 0;
        if (cap <= 0) return;
        const wait = this.lastRequestAt + 1000 / cap - this.now();
        if (wait > 0) await this.sleep(wait);
        this.lastRequestAt = this.now();
    }

    private now(): number {
        return Date.now();
    }

    /** Sleeps `ms`, or until stop() wakes it: a backoff can be minutes long and must not hold a shutdown or pause. */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                this.wake = null;
                resolve();
            };
            const timer = setTimeout(done, ms);
            (timer as any).unref?.();
            this.wake = done;
        });
    }
}
