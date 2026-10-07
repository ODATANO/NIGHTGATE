/**
 * Background pass that decodes the stored ledger transactions, a few blocks behind the indexed tip.
 *
 * It reads `Transactions.raw`, which the crawler already stored.
 * To decode blocks again, reset the cursor. Nothing has to be fetched from the chain again.
 * Each row stores the result in `payloadDecode`, so "no payload" and "decoding failed" stay distinguishable.
 */

import cds from '@sap/cds';
import { parseExtrinsicCall } from '../utils/scale';
import { extractLedgerPayload, carriesShieldedCoins, carriesProof, callFreeTxType, type LedgerPayloadFacts } from './ledger-payload';
import { readCapBinary } from './cap-binary';
import { lockReorgGeneration } from '../submission/reorg-generation';
import { Blocks, Transactions, ContractActions, SyncState, type Block, type Transaction, type ContractAction } from '#cds-models/midnight';
import type { DbRunner, Row } from '../utils/db-types';

/**
 * Cursor and rollback counter at the start of a pass.
 * Both must be unchanged when the pass saves its new cursor.
 */
interface PassPosition {
    cursor: number | null;
    generation: number;
}

const { SELECT, UPDATE } = cds.ql;
const log = cds.log('nightgate:crawler');

export interface LedgerDecoderConfig {
    /** Blocks per pass. The transactions of each block are written in one database transaction. */
    batchSize: number;
    /** Pause between passes, so other work gets the thread. */
    intervalMs: number;
    /** Distance to the indexed tip, so a reorg rarely undoes decoded blocks. */
    lagBlocks: number;
    /** Decodes one ledger transaction. The crawler passes the decode worker's method. */
    decode: (payload: Uint8Array) => Promise<LedgerPayloadFacts>;
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

    async runOnce(): Promise<DecodeRunResult> {
        const sync: any = await this.db.run(
            // Cursor and rollback counter are read together.
            // With two reads, a rollback in between could pair an old cursor with a new counter,
            // and the final check would not notice.
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

        const blocks: Row<Block, 'ID' | 'height'>[] = await this.db.run(
            SELECT.from(Blocks).columns('ID', 'height')
                .where({ height: { '>=': from } }).and({ height: { '<=': ceiling } })
                .orderBy('height asc').limit(this.config.batchSize)
        ) || [];
        if (blocks.length === 0) {
            // No blocks are indexed in this range, so move the cursor past it.
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
        // All transactions of the block are decoded, even ones decoded before.
        // Only the cursor decides what is decoded, so resetting it decodes the range again.
        const rows: Row<Transaction, 'ID'>[] = await this.db.run(
            SELECT.from(Transactions).columns('ID', 'raw', 'payloadDecode', 'transactionType', 'txType', 'isShielded', 'hasProof')
                .where({ block_ID: blockId })
        ) || [];
        if (rows.length === 0) return EMPTY_RUN;

        // Decoding is slow and must not keep a database transaction open.
        // So everything is decoded first and written afterwards.
        const updates: Array<{ id: string; facts: LedgerPayloadFacts | null; state: DecodeState; txType?: string | null; unknownFlags?: boolean }> = [];
        const result: DecodeRunResult = { ...EMPTY_RUN, transactions: rows.length };

        for (const row of rows) {
            // Inherents and MidnightSystem calls contain no ledger transaction.
            // Their arguments only look like one.
            if (row.transactionType === 'SYSTEM') {
                updates.push({ id: row.ID, facts: null, state: 'absent' });
                result.absent++;
                continue;
            }
            // An undecodable transaction has unknown flags, so they become null, not false.
            const unknownFlags = (row as { isShielded?: boolean | null }).isShielded != null || (row as { hasProof?: boolean | null }).hasProof != null;
            const buf = await readCapBinary(row.raw);
            const call = buf ? parseExtrinsicCall('0x' + buf.toString('hex')) : null;
            const payload = call ? extractLedgerPayload(call.buf, call.argsOffset) : null;
            if (!payload) {
                updates.push({ id: row.ID, facts: null, state: 'absent', unknownFlags });
                result.absent++;
                continue;
            }
            try {
                updates.push({ id: row.ID, facts: await this.config.decode(payload), state: 'decoded', txType: (row as { txType?: string | null }).txType });
                result.decoded++;
            } catch (err) {
                log.warn(`transaction ${row.ID}: ledger payload did not decode: ${(err as Error).message}`);
                updates.push({ id: row.ID, facts: null, state: 'failed', unknownFlags });
                result.failed++;
            }
        }

        await this.db.tx(async (tx) => {
            for (const update of updates) {
                await this.applyFacts(tx, update.id, update.facts, update.state, update.txType, update.unknownFlags);
            }
        });
        return result;
    }

    private async applyFacts(tx: DbRunner, transactionId: string, facts: LedgerPayloadFacts | null, state: DecodeState, storedTxType?: string | null, unknownFlags = false): Promise<void> {
        if (!facts) {
            await tx.run(UPDATE.entity(Transactions).set({
                payloadDecode: state,
                ...(unknownFlags ? { isShielded: null, hasProof: null } : {})
            }).where({ ID: transactionId }));
            return;
        }

        const firstCall = facts.contractActions.find(a => a.entryPoint) ?? null;
        // Replace only the default type. A type derived from the block events is kept.
        const txType = storedTxType === 'contract_call' ? callFreeTxType(facts) : null;
        await tx.run(UPDATE.entity(Transactions).set({
            ...(txType ? { txType } : {}),
            payloadDecode: state,
            identifiers: facts.identifiers.length ? JSON.stringify(facts.identifiers) : null,
            circuitName: firstCall?.entryPoint ?? null,
            isShielded: carriesShieldedCoins(facts),
            hasProof: carriesProof(facts),
            zswapInputCount: facts.zswapInputCount,
            zswapOutputCount: facts.zswapOutputCount,
            zswapTransientCount: facts.zswapTransientCount,
            dustSpendCount: facts.dustSpendCount,
            dustRegistrationCount: facts.dustRegistrationCount,
            dustConsumed: facts.dustSpendValue.toString()
        }).where({ ID: transactionId }));

        // The events name the contract but not the circuit, so circuit names come from the payload.
        // Names are assigned in order, and only if the call counts per contract match.
        // After a partial success the payload lists calls that never ran, and their names would be wrong.
        const actions: Row<ContractAction, 'ID' | 'address'>[] = await tx.run(
            SELECT.from(ContractActions).columns('ID', 'actionIndex', 'address', 'actionType')
                .where({ transaction_ID: transactionId, actionType: 'CALL' })
                .orderBy('actionIndex asc')
        ) || [];
        if (actions.length === 0) return;

        const ours = new Map<string | null, any[]>();
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
            const names = address === null ? undefined : declared.get(address);
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
     * Saves the new cursor only if the cursor and the rollback counter are unchanged since the pass started.
     * Otherwise a reorg during the pass would be overwritten and the re-indexed blocks skipped.
     * The counter matters because a rollback to exactly the cursor height leaves the cursor unchanged.
     */
    private async setCursor(expected: PassPosition, height: number): Promise<boolean> {
        let advanced = false;
        await this.db.tx(async (tx) => {
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
