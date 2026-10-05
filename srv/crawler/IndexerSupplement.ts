/**
 * Background pass that adds data from the Midnight indexer that the node's blocks do not contain.
 * It has its own cursor, and the crawler works the same whether it runs or not.
 * Rows are matched on `Transactions.ledgerTxHash`, the hash the indexer uses for transactions.
 */

import cds from '@sap/cds';
import {
    createIndexerClient, isIndexerRateLimit, type IndexerClient, type SupplementBlock,
    type SupplementTransaction, type SupplementLedgerEvent, type SupplementDustEvent
} from './indexer-supplement';
import { readCapBinary, capBinaryInput } from './cap-binary';
import {
    DEFAULT_CONTRACT_STATE_POLICY, digestOfBase64, keepsStateHistory, upsertCurrentState,
    type ContractStatePolicy
} from './contract-state';
import { lockReorgGeneration } from '../submission/reorg-generation';
import type { DbRunner, Row } from '../utils/db-types';
import { Blocks, Transactions, TransactionResults, TransactionSegments, TransactionFees, ContractActions, ContractBalances, UnshieldedUtxos, ZswapLedgerEvents, DustLedgerEvents, SyncState, type Block, type Transaction, type ContractAction } from '#cds-models/midnight';

/** Cursor and rollback counter at the start of a pass. Both must be unchanged when the pass saves its cursor. */
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
    /** Distance to the indexed tip, because the indexer is behind the node. */
    lagBlocks: number;
    requestTimeoutMs: number;
    /** Indexer requests per second, one block per request. 0 or unset means no limit. */
    maxBlocksPerSecond?: number;
    contractState?: ContractStatePolicy;
}

/** First wait after a 403 or 429. Doubles with each refusal, up to RATE_LIMIT_MAX_MS. */
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
    private stopping = false;
    private wake: (() => void) | null = null;
    private lastLedgerParameters: string | null = null;
    /** Rollback counter the cache belongs to. A rollback can delete the block holding the cached parameters. */
    private cachedGeneration: number | null = null;
    private lastRequestAt = 0;
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
                        // The indexer blocks the whole host IP and every retry extends the block, so wait minutes.
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

    async runOnce(): Promise<SupplementRunResult> {
        const sync: any = await this.db.run(
            // Read cursor and rollback counter together. With two reads, a rollback in between
            // could pair an old cursor with a new counter, and the final check would not notice.
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
        // A rollback can delete the block that stored the cached parameters, so the cache is cleared.
        if (this.cachedGeneration !== start.generation) {
            this.lastLedgerParameters = null;
            this.cachedGeneration = start.generation;
        }
        if (!Number.isFinite(ceiling) || from > ceiling) return EMPTY_RUN;

        const blocks: Row<Block, 'ID' | 'height'>[] = await this.db.run(
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
                // The indexer has not reached this height yet. Retry this block next time instead of skipping it.
                return this.endBefore(start, blocks, index, result);
            }
            await this.applyBlockFields(block.ID, height, answer);
            const perBlock = await this.applyBlock(height, answer.transactions);
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

    /** Ledger parameters rarely change, so they are stored only on blocks where they differ from the previous ones. */
    private async applyBlockFields(blockId: string, height: number, answer: SupplementBlock): Promise<void> {
        if (!answer.ledgerParameters) return;
        if (this.lastLedgerParameters === null) {
            this.lastLedgerParameters = await this.readParametersBelow(height);
        }
        if (this.lastLedgerParameters === answer.ledgerParameters) return;
        await this.db.run(
            UPDATE.entity(Blocks).set({ ledgerParameters: capBinaryInput(answer.ledgerParameters) }).where({ ID: blockId })
        );
        this.lastLedgerParameters = answer.ledgerParameters;
    }

    private async readParametersBelow(height: number): Promise<string> {
        const row: Block | undefined = await this.db.run(
            SELECT.one.from(Blocks).columns('ledgerParameters')
                .where({ height: { '<': height }, ledgerParameters: { '!=': null } })
                .orderBy('height desc')
        );
        const stored = await readCapBinary(row?.ledgerParameters);
        return stored ? stored.toString('base64') : '';
    }

    private async applyBlock(height: number, transactions: SupplementTransaction[]): Promise<SupplementRunResult> {
        const result: SupplementRunResult = { ...EMPTY_RUN };
        if (transactions.length === 0) return result;

        const hashes = transactions.map(t => t.ledgerTxHash);
        const rows: Transaction[] = await this.db.run(
            SELECT.from(Transactions).columns('ID', 'ledgerTxHash').where({ ledgerTxHash: { in: hashes } })
        ) || [];
        const byHash = new Map<string, string>(rows.map((r: any) => [r.ledgerTxHash, r.ID]));

        for (const tx of transactions) {
            const transactionId = byHash.get(tx.ledgerTxHash);
            if (!transactionId) continue;
            result.transactions++;
            await this.db.tx(async (dbTx) => {
                result.fees += await this.applyFee(dbTx, transactionId, tx);
                result.segments += await this.applySegments(dbTx, transactionId, tx);
                result.balances += await this.applyContractState(dbTx, transactionId, height, tx);
                result.zswapEvents += await this.replaceZswapEvents(dbTx, transactionId, tx.zswapEvents);
                result.dustEvents += await this.replaceDustEvents(dbTx, transactionId, tx.dustEvents);
                result.dustFlags += await this.applyDustFlags(dbTx, tx);
            });
        }
        return result;
    }

    /** The crawler stores a zero fee, because the block does not contain the fee. */
    private async applyFee(dbTx: DbRunner, transactionId: string, tx: SupplementTransaction): Promise<number> {
        if (tx.fee == null) return 0;
        const changed = await dbTx.run(
            UPDATE.entity(TransactionFees).set({ paidFees: tx.fee }).where({ transaction_ID: transactionId })
        );
        return Number(changed ?? 0) > 0 ? 1 : 0;
    }

    private async applySegments(dbTx: DbRunner, transactionId: string, tx: SupplementTransaction): Promise<number> {
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

    /** Updates only actions the crawler stored. Actions it does not have, such as a failed call, are not created. */
    private async applyContractState(dbTx: DbRunner, transactionId: string, height: number, tx: SupplementTransaction): Promise<number> {
        if (tx.contractActions.length === 0) return 0;
        const actions: ContractAction[] = await dbTx.run(
            SELECT.from(ContractActions).columns('ID', 'actionIndex', 'address', 'actionType')
                .where({ transaction_ID: transactionId }).orderBy('actionIndex asc')
        ) || [];
        if (actions.length === 0) return 0;

        // Two calls on one contract have different states, so actions are paired in order,
        // and only if both sides have the same count. After a partial success the counts differ,
        // and no state is better than a wrong one.
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
                const state = digestOfBase64(match.state);
                const zswapState = digestOfBase64(match.zswapState);
                const keep = keepsStateHistory(this.config.contractState ?? DEFAULT_CONTRACT_STATE_POLICY, action.address);
                await dbTx.run(UPDATE.entity(ContractActions)
                    .set({
                        state: (keep ? match.state : null) as any,
                        zswapState: (keep ? match.zswapState : null) as any,
                        stateHash: state.hash,
                        stateSize: state.size,
                        zswapStateHash: zswapState.hash,
                        zswapStateSize: zswapState.size
                    })
                    .where({ ID: action.ID }));
                if (match.state != null && action.address) {
                    await upsertCurrentState(dbTx, {
                        address: action.address,
                        height,
                        state: match.state,
                        zswapState: match.zswapState,
                        stateHash: state.hash,
                        zswapStateHash: zswapState.hash,
                        contractActionId: action.ID
                    });
                }
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

    private async replaceZswapEvents(
        dbTx: DbRunner,
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

    private async replaceDustEvents(
        dbTx: DbRunner,
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

    /** DUST registration applies to the address, so the flag can turn on after the UTXO was created. */
    private async applyDustFlags(dbTx: DbRunner, tx: SupplementTransaction): Promise<number> {
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
     * Saves the cursor only if cursor and rollback counter are unchanged since the pass started.
     * Otherwise a reorg during the pass would be overwritten and re-indexed blocks skipped.
     * The counter is needed because a rollback to exactly the cursor height leaves the cursor unchanged.
     */
    private async setCursor(expected: PassPosition, height: number): Promise<boolean> {
        let advanced = false;
        await this.db.tx(async (tx) => {
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

    private async endBefore(start: PassPosition, blocks: any[], index: number, result: SupplementRunResult): Promise<SupplementRunResult> {
        if (index === 0) return EMPTY_RUN;
        result.blocks = index;
        await this.setCursor(start, Number(blocks[index].height) - 1);
        return result;
    }

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

    /** stop() can wake this early, because a backoff can last minutes and must not delay a shutdown. */
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
