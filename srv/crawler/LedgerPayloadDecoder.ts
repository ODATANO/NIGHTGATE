/**
 * The pass that decodes stored ledger payloads, trailing the indexed tip.
 *
 * It reads `Transactions.raw`, which the crawler already persists, so a decoder
 * fix is replayed by resetting the cursor instead of re-fetching the chain, and
 * a wasm deserialization never sits inside the crawl loop. Each row records the
 * outcome in `payloadDecode`, so an empty range and a range that failed to
 * decode are not the same thing.
 */

import cds from '@sap/cds';
import { parseExtrinsicCall } from '../utils/scale';
import { extractLedgerPayload, decodeLedgerPayload } from './ledger-payload';
import { readCapBinary } from './cap-binary';
import { lockReorgGeneration } from '../submission/reorg-generation';
import { Blocks, Transactions, ContractActions, SyncState } from '#cds-models/midnight';

/** Where a pass started: both have to still hold when it writes its cursor. */
interface PassPosition {
    cursor: number | null;
    generation: number;
}

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface LedgerDecoderConfig {
    /** Blocks per pass; each one's transactions are decoded in a single db transaction. */
    batchSize: number;
    /** Pause between passes, and between batches, so the pass yields the thread. */
    intervalMs: number;
    /** Stay this far below the indexed tip, so a reorg rarely invalidates decoded work. */
    lagBlocks: number;
}

export interface DecodeRunResult {
    blocks: number;
    transactions: number;
    decoded: number;
    absent: number;
    failed: number;
}

const EMPTY_RUN: DecodeRunResult = { blocks: 0, transactions: 0, decoded: 0, absent: 0, failed: 0 };

/** Mirrors the PayloadDecodeState enum in db/types.cds. */
type DecodeState = 'decoded' | 'absent' | 'failed';

export class LedgerPayloadDecoder {
    private db!: cds.DatabaseService;
    private running = false;
    private loop: Promise<void> | null = null;

    constructor(private readonly config: LedgerDecoderConfig) {}

    async init(db: cds.DatabaseService): Promise<void> {
        this.db = db;
    }

    /** Runs passes until `stop()`; a failing pass is logged and retried next tick. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = (async () => {
            while (this.running) {
                let progressed = 0;
                try {
                    progressed = (await this.runOnce()).blocks;
                } catch (err) {
                    log.warn(`ledger payload decode pass failed: ${(err as Error).message}`);
                }
                // Nothing to do means wait a full interval; work means yield briefly.
                await this.sleep(progressed > 0 ? this.config.intervalMs : this.config.intervalMs * 4);
            }
        })();
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.loop) {
            await this.loop.catch(() => { /* reported in the loop */ });
            this.loop = null;
        }
    }

    /** One pass over the next batch of blocks above the cursor. */
    async runOnce(): Promise<DecodeRunResult> {
        const sync: any = await this.db.run(
            // One read of the singleton: a rollback between separate reads of
            // the cursor and the generation would hand this pass the old chain
            // position under the new generation, which the final check then
            // accepts as its own.
            SELECT.one.from(SyncState)
                .columns('lastDecodedHeight', 'lastIndexedHeight', 'reorgGeneration')
                .where({ ID: 'SINGLETON' })
        );
        if (!sync) return EMPTY_RUN;

        const indexed = Number(sync.lastIndexedHeight ?? 0);
        const ceiling = indexed - this.config.lagBlocks;
        const cursor = sync.lastDecodedHeight == null ? null : Number(sync.lastDecodedHeight);
        const from = cursor == null ? 0 : cursor + 1;
        const generation = Number(sync.reorgGeneration ?? 0);
        const start: PassPosition = { cursor, generation: Number.isFinite(generation) ? generation : 0 };
        if (!Number.isFinite(ceiling) || from > ceiling) return EMPTY_RUN;

        const blocks: any[] = await this.db.run(
            SELECT.from(Blocks).columns('ID', 'height')
                .where({ height: { '>=': from } }).and({ height: { '<=': ceiling } })
                .orderBy('height asc').limit(this.config.batchSize)
        ) || [];
        if (blocks.length === 0) {
            // A gap below the ceiling: nothing indexed there, so move the cursor past it.
            await this.setCursor(start, Math.min(from + this.config.batchSize - 1, ceiling));
            return EMPTY_RUN;
        }

        const result: DecodeRunResult = { ...EMPTY_RUN, blocks: blocks.length };
        for (const block of blocks) {
            const perBlock = await this.decodeBlock(block.ID);
            result.transactions += perBlock.transactions;
            result.decoded += perBlock.decoded;
            result.absent += perBlock.absent;
            result.failed += perBlock.failed;
        }

        if (!await this.setCursor(start, Number(blocks[blocks.length - 1].height))) return EMPTY_RUN;
        if (result.decoded || result.failed) {
            log.info(
                `ledger payloads decoded up to height ${blocks[blocks.length - 1].height}: ` +
                `${result.decoded} decoded, ${result.absent} without a payload, ${result.failed} failed`
            );
        }
        return result;
    }

    private async decodeBlock(blockId: string): Promise<DecodeRunResult> {
        // Every transaction of the block, whatever it decoded to last time:
        // the cursor is the only gate, so resetting it replays the range,
        // which is how a decoder fix is rolled out.
        const rows: any[] = await this.db.run(
            SELECT.from(Transactions).columns('ID', 'raw', 'payloadDecode')
                .where({ block_ID: blockId })
        ) || [];
        if (rows.length === 0) return EMPTY_RUN;

        // Decoding is wasm and must not hold a db transaction open, so the whole
        // batch is decoded first and written afterwards.
        const updates: Array<{ id: string; facts: Awaited<ReturnType<typeof decodeLedgerPayload>> | null; state: DecodeState }> = [];
        const result: DecodeRunResult = { ...EMPTY_RUN, transactions: rows.length };

        for (const row of rows) {
            const buf = await readCapBinary(row.raw);
            const call = buf ? parseExtrinsicCall('0x' + buf.toString('hex')) : null;
            const payload = call ? extractLedgerPayload(call.buf, call.argsOffset) : null;
            if (!payload) {
                updates.push({ id: row.ID, facts: null, state: 'absent' });
                result.absent++;
                continue;
            }
            try {
                updates.push({ id: row.ID, facts: await decodeLedgerPayload(payload), state: 'decoded' });
                result.decoded++;
            } catch (err) {
                log.warn(`transaction ${row.ID}: ledger payload did not decode: ${(err as Error).message}`);
                updates.push({ id: row.ID, facts: null, state: 'failed' });
                result.failed++;
            }
        }

        await this.db.tx(async (tx: any) => {
            for (const update of updates) {
                await this.applyFacts(tx, update.id, update.facts, update.state);
            }
        });
        return result;
    }

    private async applyFacts(tx: any, transactionId: string, facts: any, state: DecodeState): Promise<void> {
        if (!facts) {
            await tx.run(UPDATE.entity(Transactions).set({ payloadDecode: state }).where({ ID: transactionId }));
            return;
        }

        const firstCall = facts.contractActions.find((a: any) => a.entryPoint) ?? null;
        await tx.run(UPDATE.entity(Transactions).set({
            payloadDecode: state,
            identifiers: facts.identifiers.length ? JSON.stringify(facts.identifiers) : null,
            circuitName: firstCall?.entryPoint ?? null,
            zswapInputCount: facts.zswapInputCount,
            zswapOutputCount: facts.zswapOutputCount,
            zswapTransientCount: facts.zswapTransientCount,
            dustSpendCount: facts.dustSpendCount,
            dustRegistrationCount: facts.dustRegistrationCount,
            dustConsumed: facts.dustSpendValue.toString() as any
        }).where({ ID: transactionId }));

        // The events name the contract but not the circuit. Two calls on one
        // contract are paired with the declared ones in order, and only when
        // both sides report the same number: on a partial success the payload
        // declares calls that never applied, and assigning those names to the
        // ones that did would be wrong rather than merely incomplete.
        const actions: any[] = await tx.run(
            SELECT.from(ContractActions).columns('ID', 'actionIndex', 'address', 'actionType')
                .where({ transaction_ID: transactionId, actionType: 'CALL' })
                .orderBy('actionIndex asc')
        ) || [];
        if (actions.length === 0) return;

        const ours = new Map<string, any[]>();
        for (const action of actions) {
            const list = ours.get(action.address) ?? [];
            list.push(action);
            ours.set(action.address, list);
        }
        const declared = new Map<string, string[]>();
        for (const entry of facts.contractActions) {
            if (!entry.entryPoint) continue;
            const list = declared.get(entry.address) ?? [];
            list.push(entry.entryPoint);
            declared.set(entry.address, list);
        }

        for (const [address, mine] of ours) {
            const names = declared.get(address);
            if (!names || names.length !== mine.length) {
                if (names) {
                    log.debug(
                        `transaction ${transactionId}: ${mine.length} indexed call(s) on ${address} against ` +
                        `${names.length} declared; circuit names not assigned`
                    );
                }
                continue;
            }
            for (let i = 0; i < mine.length; i++) {
                await tx.run(UPDATE.entity(ContractActions).set({ entryPoint: names[i] }).where({ ID: mine[i].ID }));
            }
        }
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
                SELECT.one.from(SyncState).columns('lastDecodedHeight').where({ ID: 'SINGLETON' })
            );
            const now = current?.lastDecodedHeight == null ? null : Number(current.lastDecodedHeight);
            if (generation !== expected.generation || now !== expected.cursor) {
                log.info(
                    `ledger payload decode pass dropped: started at cursor ${expected.cursor} generation ` +
                    `${expected.generation}, found ${now} / ${generation}`
                );
                return;
            }
            await tx.run(
                UPDATE.entity(SyncState).set({ lastDecodedHeight: height }).where({ ID: 'SINGLETON' })
            );
            advanced = true;
        });
        return advanced;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, ms);
            (timer as any).unref?.();
        });
    }
}
