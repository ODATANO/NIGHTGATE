// Background pass that adds data from the Midnight indexer that the node's blocks do not contain.
// It has its own cursor. The crawler works the same whether it runs or not.
// Rows are matched on `Transactions.ledgerTxHash`, the hash the indexer uses for transactions.

import cds from '@sap/cds';
import {
    createIndexerClient, type IndexerClient, type SupplementBlock,
    type SupplementTransaction, type SupplementLedgerEvent, type SupplementDustEvent
} from './indexer-supplement';
import { readCapBinary, capBinaryInput } from './cap-binary';
import {
    DEFAULT_CONTRACT_STATE_POLICY, digestOfBase64, keepsStateHistory, upsertCurrentState,
    type ContractStatePolicy
} from './contract-state';
import { advancePassCursor, blocksInRange, readPassWindow, windowIsEmpty, PassPause, type PassPosition } from './cursor-pass';
import { affectedRows, type DbRunner } from '../utils/db-types';
import { isIndexerRateLimit } from '../utils/indexer-graphql';
import { Blocks, Transactions, TransactionResults, TransactionSegments, TransactionFees, ContractActions, ContractBalances, UnshieldedUtxos, ZswapLedgerEvents, DustLedgerEvents, type Block, type Transaction, type ContractAction, type TransactionResult } from '#cds-models/midnight';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface IndexerSupplementConfig {
    url: string;
    batchSize: number;
    intervalMs: number;
    /** Distance to the indexed tip. A block the indexer has not reached yet is retried either way. */
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
    private readonly pause = new PassPause();
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
                await this.pause.sleep(delay);
            }
        })();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.stopping = true;
        this.pause.wake();
        if (this.loop) {
            await this.loop.catch(() => { /* reported in the loop */ });
            this.loop = null;
        }
    }

    async runOnce(): Promise<SupplementRunResult> {
        const window = await readPassWindow(this.db, 'lastSupplementedHeight', this.config.lagBlocks);
        if (!window) return EMPTY_RUN;
        const { start, from, ceiling } = window;
        // A rollback can delete the block that stored the cached parameters, so the cache is cleared.
        if (this.cachedGeneration !== start.generation) {
            this.lastLedgerParameters = null;
            this.cachedGeneration = start.generation;
        }
        if (windowIsEmpty(window)) return EMPTY_RUN;

        const blocks = await blocksInRange(this.db, from, ceiling, this.config.batchSize);
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
        const byHash = new Map<string, string>(rows.map(r => [String(r.ledgerTxHash), String(r.ID)]));

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
        return affectedRows(changed) > 0 ? 1 : 0;
    }

    private async applySegments(dbTx: DbRunner, transactionId: string, tx: SupplementTransaction): Promise<number> {
        if (tx.segments.length === 0) return 0;
        const resultRow: Pick<TransactionResult, 'ID'> | undefined = await dbTx.run(
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
                        state: keep && match.state != null ? capBinaryInput(match.state) : null,
                        zswapState: keep && match.zswapState != null ? capBinaryInput(match.zswapState) : null,
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
            if (affectedRows(changed) > 0) updated++;
        }
        return updated;
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
        if (wait > 0) await this.pause.sleep(wait);
        this.lastRequestAt = this.now();
    }

    private now(): number {
        return Date.now();
    }


    private setCursor(expected: PassPosition, height: number): Promise<boolean> {
        return advancePassCursor(this.db, 'lastSupplementedHeight', expected, height, 'indexer supplement');
    }
}
