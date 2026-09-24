/**
 * Tests for the two passes that trail the indexed tip:
 * srv/crawler/LedgerPayloadDecoder.ts and srv/crawler/IndexerSupplement.ts.
 *
 * HYBRID: a REAL in-memory CAP DB via cds.test(), with the wasm decode and the
 * indexer HTTP call replaced at their seams. What is asserted is the rows each
 * pass writes and where it leaves its cursor.
 */

import cds from '@sap/cds';

const decodeLedgerPayload = vi.fn();
vi.mock('../../srv/crawler/ledger-payload', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../srv/crawler/ledger-payload')>()),
    decodeLedgerPayload: (bytes: Uint8Array) => decodeLedgerPayload(bytes)
}));

import { LedgerPayloadDecoder } from '../../srv/crawler/LedgerPayloadDecoder';
import { IndexerSupplement, RATE_LIMIT_BACKOFF_MS } from '../../srv/crawler/IndexerSupplement';
import { IndexerHttpError, createIndexerClient, isIndexerRateLimit } from '../../srv/crawler/indexer-supplement';
import { rollbackIndexedDataFromHeight } from '../../srv/crawler/rollback';
import { readCapBinary } from '../../srv/crawler/cap-binary';

cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const TX_RESULTS = 'midnight.TransactionResults';
const TX_SEGMENTS = 'midnight.TransactionSegments';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const CONTRACT_BALANCES = 'midnight.ContractBalances';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const ZSWAP_EVENTS = 'midnight.ZswapLedgerEvents';
const DUST_EVENTS = 'midnight.DustLedgerEvents';
const SYNC_STATE = 'midnight.SyncState';

const CONTRACT = 'cc'.repeat(32);

let db: any;

function compact(value: number): number[] {
    if (value <= 63) return [value << 2];
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE((value << 2) | 0x01, 0);
    return [...buf];
}

/** A Midnight-pallet extrinsic carrying `payloadLength` bytes, base64 as CAP stores it. */
function midnightExtrinsicBase64(payloadLength: number): string {
    const payload = Array.from({ length: payloadLength }, (_, i) => (i + 1) & 0xff);
    const body = [0x04, 5, 0, ...compact(payload.length), ...payload];
    return Buffer.from([...compact(body.length), ...body]).toString('base64');
}

/** An extrinsic with no ledger payload at all (a system inherent). */
function inherentBase64(): string {
    return Buffer.from([0x0c, 0x04, 1, 0]).toString('base64');
}

async function seedBlock(height: number, hash: string): Promise<string> {
    const ID = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({
        ID, hash, height, protocolVersion: 1, timestamp: 1_700_000_000, stateRoot: '0xstate'
    }));
    return ID;
}

async function seedTransaction(blockId: string, over: Record<string, any> = {}): Promise<string> {
    const ID = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID,
        transactionId: over.transactionId ?? 0,
        hash: over.hash ?? `0x${ID.slice(0, 8)}`,
        protocolVersion: 1,
        transactionType: 'REGULAR',
        block_ID: blockId,
        ...over
    }));
    return ID;
}

async function setSync(fields: Record<string, any>): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'syncing', ...fields }));
}

async function readSync(): Promise<any> {
    return db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
}

const facts = (over: Record<string, any> = {}) => ({
    identifiers: ['aa', 'bb'],
    contractActions: [],
    zswapInputCount: 1,
    zswapOutputCount: 2,
    zswapTransientCount: 0,
    dustSpendCount: 1,
    dustRegistrationCount: 0,
    dustSpendValue: 42n,
    ...over
});

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    vi.clearAllMocks();
    decodeLedgerPayload.mockReset();
    for (const entity of [
        CONTRACT_BALANCES, CONTRACT_ACTIONS, TX_SEGMENTS, TX_RESULTS, 'midnight.TransactionFees',
        ZSWAP_EVENTS, DUST_EVENTS, UNSHIELDED_UTXOS, TRANSACTIONS, BLOCKS
    ]) {
        await db.run(cds.ql.DELETE.from(entity));
    }
});

describe('LedgerPayloadDecoder', () => {
    async function runDecoder(): Promise<any> {
        const decoder = new LedgerPayloadDecoder({ batchSize: 10, intervalMs: 1, lagBlocks: 2 });
        await decoder.init(db);
        return decoder.runOnce();
    }

    it('decodes a stored payload onto the transaction and its contract call', async () => {
        const blockId = await seedBlock(10, '0xd1');
        const txId = await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
            ID: cds.utils.uuid(), actionIndex: 0, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
        }));
        await setSync({ lastIndexedHeight: 20, lastDecodedHeight: null });
        decodeLedgerPayload.mockResolvedValue(facts({
            contractActions: [{ address: CONTRACT, entryPoint: 'increment' }]
        }));

        const result = await runDecoder();
        expect(result).toEqual(expect.objectContaining({ decoded: 1, failed: 0, absent: 0 }));

        const tx = await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ ID: txId }));
        expect(tx).toEqual(expect.objectContaining({
            payloadDecode: 'decoded',
            identifiers: JSON.stringify(['aa', 'bb']),
            circuitName: 'increment',
            zswapInputCount: 1,
            zswapOutputCount: 2,
            zswapTransientCount: 0,
            dustSpendCount: 1,
            dustRegistrationCount: 0
        }));
        expect(String(tx.dustConsumed)).toBe('42');

        const action = await db.run(cds.ql.SELECT.one.from(CONTRACT_ACTIONS).where({ transaction_ID: txId }));
        expect(action.entryPoint).toBe('increment');
        expect(Number((await readSync()).lastDecodedHeight)).toBe(10);
    });

    it('matches several calls on one contract in declaration order', async () => {
        const blockId = await seedBlock(10, '0xd2');
        const txId = await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        for (const i of [0, 1]) {
            await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
                ID: cds.utils.uuid(), actionIndex: i, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
            }));
        }
        await setSync({ lastIndexedHeight: 20, lastDecodedHeight: null });
        decodeLedgerPayload.mockResolvedValue(facts({
            contractActions: [
                { address: CONTRACT, entryPoint: 'first' },
                { address: CONTRACT, entryPoint: 'second' }
            ]
        }));

        await runDecoder();
        // Paired in action order, not sorted into agreement.
        const entryPoints = (await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS).where({ transaction_ID: txId })))
            .sort((a: any, b: any) => a.actionIndex - b.actionIndex)
            .map((a: any) => a.entryPoint);
        expect(entryPoints).toEqual(['first', 'second']);
    });

    it('records a transaction without a payload as absent and a failure as failed', async () => {
        const blockId = await seedBlock(10, '0xd3');
        const inherent = await seedTransaction(blockId, { transactionId: 0, raw: inherentBase64() });
        const broken = await seedTransaction(blockId, { transactionId: 1, raw: midnightExtrinsicBase64(20) });
        await setSync({ lastIndexedHeight: 20, lastDecodedHeight: null });
        decodeLedgerPayload.mockRejectedValue(new Error('no marker combination fits'));

        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            const result = await runDecoder();
            expect(result).toEqual(expect.objectContaining({ absent: 1, failed: 1, decoded: 0 }));
        } finally {
            warn.mockRestore();
        }

        expect((await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ ID: inherent }))).payloadDecode).toBe('absent');
        expect((await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ ID: broken }))).payloadDecode).toBe('failed');
        // A failed decode still advances the cursor: the pass is not a loop.
        expect(Number((await readSync()).lastDecodedHeight)).toBe(10);
    });

    it('replays a range when the cursor is reset, whatever the rows decoded to before', async () => {
        const blockId = await seedBlock(10, '0xd5');
        const txId = await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: null });
        decodeLedgerPayload.mockRejectedValue(new Error('old decoder'));
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            expect((await runDecoder()).failed).toBe(1);
        } finally {
            warn.mockRestore();
        }
        expect((await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ ID: txId }))).payloadDecode).toBe('failed');

        // A fixed decoder plus a cursor reset has to pick the row up again.
        decodeLedgerPayload.mockReset();
        decodeLedgerPayload.mockResolvedValue(facts());
        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: null });
        expect((await runDecoder()).decoded).toBe(1);
        expect((await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ ID: txId }))).payloadDecode).toBe('decoded');
    });

    it('stays below the lag and does not re-decode a finished row', async () => {
        const blockId = await seedBlock(19, '0xd4');
        await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        await setSync({ lastIndexedHeight: 20, lastDecodedHeight: null });

        // lagBlocks 2 puts the ceiling at 18, below this block.
        expect(await runDecoder()).toEqual(expect.objectContaining({ blocks: 0 }));
        expect(decodeLedgerPayload).not.toHaveBeenCalled();

        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: null });
        decodeLedgerPayload.mockResolvedValue(facts());
        expect((await runDecoder()).decoded).toBe(1);
        // Second pass with the cursor left where it landed: nothing above it.
        expect((await runDecoder()).decoded).toBe(0);
        expect(decodeLedgerPayload).toHaveBeenCalledTimes(1);
    });
});

describe('IndexerSupplement', () => {
    function supplementWith(answers: Record<number, any>): IndexerSupplement {
        const client = { fetchBlock: vi.fn(async (height: number) => answers[height] ?? null) };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        (pass as any).client = client;
        return pass;
    }

    it('fills segments, contract state, balances and both event streams', async () => {
        const blockId = await seedBlock(10, '0xs1');
        const txId = await seedTransaction(blockId, { ledgerTxHash: 'abc' });
        const resultId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(TX_RESULTS).entries({
            ID: resultId, status: 'PARTIAL_SUCCESS', transaction_ID: txId
        }));
        const actionId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
            ID: actionId, actionIndex: 0, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
        }));
        // The crawler writes a zero fee from the envelope.
        await db.run(cds.ql.INSERT.into('midnight.TransactionFees').entries({
            ID: cds.utils.uuid(), paidFees: '0', estimatedFees: '0', transaction_ID: txId
        }));
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: null });

        const pass = supplementWith({
            10: {
                height: 10,
                ledgerParameters: null,
                transactions: [{
                    ledgerTxHash: 'abc',
                    status: 'PARTIAL_SUCCESS',
                    fee: '7',
                    segments: [{ segmentId: 0, success: true }, { segmentId: 3283, success: false }],
                    contractActions: [{
                        actionType: 'CALL', address: CONTRACT,
                        state: Buffer.from('beef', 'hex').toString('base64'),
                        zswapState: null,
                        balances: [{ tokenType: '00', amount: '500' }]
                    }],
                    zswapEvents: [{ eventId: 3, maxId: 9, raw: null }],
                    dustEvents: [
                        { eventId: 4, maxId: 9, raw: null, eventType: 'DTIME_UPDATE', dustOutputNonce: null },
                        { eventId: 5, maxId: 9, raw: null, eventType: 'INITIAL_UTXO', dustOutputNonce: 'ab' }
                    ],
                    dustRegisteredOutputs: []
                }]
            }
        });
        await pass.init(db);
        const result = await pass.runOnce();

        expect(result).toEqual(expect.objectContaining({
            transactions: 1, fees: 1, segments: 2, balances: 1, zswapEvents: 1, dustEvents: 2
        }));
        const fees = await db.run(cds.ql.SELECT.one.from('midnight.TransactionFees').where({ transaction_ID: txId }));
        expect(String(fees.paidFees)).toBe('7');
        const segments = (await db.run(cds.ql.SELECT.from(TX_SEGMENTS).where({ transactionResult_ID: resultId })))
            .sort((a: any, b: any) => a.segmentId - b.segmentId);
        expect(segments.map((s: any) => [s.segmentId, s.success])).toEqual([[0, true], [3283, false]]);
        expect(await db.run(cds.ql.SELECT.from(CONTRACT_BALANCES).where({ contractAction_ID: actionId }))).toHaveLength(1);
        expect(await db.run(cds.ql.SELECT.from(ZSWAP_EVENTS))).toHaveLength(1);
        const dust = (await db.run(cds.ql.SELECT.from(DUST_EVENTS))).sort((a: any, b: any) => a.eventId - b.eventId);
        expect(dust.map((d: any) => [d.eventType, d.dustOutputNonce]))
            .toEqual([['DTIME_UPDATE', null], ['INITIAL_UTXO', 'ab']]);
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(10);
    });

    it('gives two calls on one contract their own state, not the first one twice', async () => {
        const blockId = await seedBlock(10, '0xs6');
        const txId = await seedTransaction(blockId, { ledgerTxHash: 'abc' });
        const ids = [cds.utils.uuid(), cds.utils.uuid()];
        for (const [i, ID] of ids.entries()) {
            await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
                ID, actionIndex: i, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
            }));
        }
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: null });

        const call = (state: string, amount: string) => ({
            actionType: 'CALL', address: CONTRACT,
            state: Buffer.from(state, 'utf8').toString('base64'),
            zswapState: null,
            balances: [{ tokenType: '00', amount }]
        });
        const pass = supplementWith({
            10: {
                height: 10, ledgerParameters: null,
                transactions: [{
                    ledgerTxHash: 'abc', status: 'SUCCESS', fee: null, segments: [],
                    contractActions: [call('first', '1'), call('second', '2')],
                    zswapEvents: [], dustEvents: [], dustRegisteredOutputs: []
                }]
            }
        });
        await pass.init(db);
        await pass.runOnce();

        const rows = (await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS).columns('ID', 'actionIndex', 'state')))
            .sort((a: any, b: any) => a.actionIndex - b.actionIndex);
        const states = [];
        for (const r of rows) states.push((await readCapBinary(r.state))?.toString('utf8'));
        expect(states).toEqual(['first', 'second']);

        const amounts = [];
        for (const r of rows) {
            const b = await db.run(cds.ql.SELECT.one.from(CONTRACT_BALANCES).where({ contractAction_ID: r.ID }));
            amounts.push(String(b.amount));
        }
        expect(amounts).toEqual(['1', '2']);
    });

    it('assigns no state when the two sides disagree on how many actions there were', async () => {
        const blockId = await seedBlock(10, '0xs7');
        const txId = await seedTransaction(blockId, { ledgerTxHash: 'abc' });
        await db.run(cds.ql.INSERT.into(CONTRACT_ACTIONS).entries({
            ID: cds.utils.uuid(), actionIndex: 0, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
        }));
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: null });

        // A partial success: the indexer declares two calls, one applied.
        const declared = {
            actionType: 'CALL', address: CONTRACT,
            state: Buffer.from('x', 'utf8').toString('base64'), zswapState: null, balances: []
        };
        const pass = supplementWith({
            10: {
                height: 10, ledgerParameters: null,
                transactions: [{
                    ledgerTxHash: 'abc', status: 'PARTIAL_SUCCESS', fee: null, segments: [],
                    contractActions: [declared, declared],
                    zswapEvents: [], dustEvents: [], dustRegisteredOutputs: []
                }]
            }
        });
        await pass.init(db);
        const debug = vi.spyOn(cds.log('nightgate:crawler'), 'debug').mockImplementation(() => {});
        try {
            await pass.runOnce();
        } finally {
            debug.mockRestore();
        }
        const row = await db.run(cds.ql.SELECT.one.from(CONTRACT_ACTIONS).columns('state'));
        expect(await readCapBinary(row.state)).toBeNull();
    });

    it('turns the DUST registration flag on for the named outputs', async () => {
        const blockId = await seedBlock(10, '0xs2');
        const txId = await seedTransaction(blockId, { ledgerTxHash: 'abc' });
        await db.run(cds.ql.INSERT.into(UNSHIELDED_UTXOS).entries({
            ID: cds.utils.uuid(), owner: 'mn_addr_x', tokenType: '00', value: '5',
            intentHash: 'i1', outputIndex: 0, initialNonce: 'n1', createdAtTransaction_ID: txId
        }));
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: null });

        const pass = supplementWith({
            10: {
                height: 10,
                ledgerParameters: null,
                transactions: [{
                    ledgerTxHash: 'abc', status: 'SUCCESS', fee: null, segments: [], contractActions: [],
                    zswapEvents: [], dustEvents: [],
                    dustRegisteredOutputs: [{ intentHash: 'i1', outputIndex: 0 }]
                }]
            }
        });
        await pass.init(db);
        await pass.runOnce();

        const utxo = await db.run(cds.ql.SELECT.one.from(UNSHIELDED_UTXOS).where({ intentHash: 'i1' }));
        expect(utxo.registeredForDustGeneration).toBe(true);
    });

    it('stores ledger parameters only when they change', async () => {
        const first = await seedBlock(10, '0xp1');
        const second = await seedBlock(11, '0xp2');
        const third = await seedBlock(12, '0xp3');
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });

        const empty = (ledgerParameters: string) => ({
            height: 0, ledgerParameters,
            transactions: [] as any[]
        });
        const pass = supplementWith({
            10: { ...empty('cGFyYW1zLUE='), height: 10 },
            11: { ...empty('cGFyYW1zLUE='), height: 11 },
            12: { ...empty('cGFyYW1zLUI='), height: 12 }
        });
        await pass.init(db);
        await pass.runOnce();

        const read = async (id: string) =>
            (await db.run(cds.ql.SELECT.one.from(BLOCKS).columns('ledgerParameters').where({ ID: id })))?.ledgerParameters;
        // CAP hands a LargeBinary back as a Readable.
        const asBase64 = async (v: any) => (await readCapBinary(v))?.toString('base64') ?? null;

        expect(await asBase64(await read(first))).toBe('cGFyYW1zLUE=');
        // Unchanged: left null, meaning "as at the last block below".
        expect(await asBase64(await read(second))).toBeNull();
        expect(await asBase64(await read(third))).toBe('cGFyYW1zLUI=');
    });

    it('holds the cursor where the indexer has not caught up yet', async () => {
        await seedBlock(10, '0xs3');
        await seedBlock(11, '0xs4');
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: 9 });

        // The indexer answers for 10 and not for 11.
        const pass = supplementWith({ 10: { height: 10, ledgerParameters: null, transactions: [] } });
        await pass.init(db);
        await pass.runOnce();
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(10);
    });

    it('re-running a block replaces its rows instead of doubling them', async () => {
        const blockId = await seedBlock(10, '0xs5');
        const txId = await seedTransaction(blockId, { ledgerTxHash: 'abc' });
        await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: null });
        const answer = {
            10: {
                height: 10,
                ledgerParameters: null,
                transactions: [{
                    ledgerTxHash: 'abc', status: 'SUCCESS', fee: null, segments: [], contractActions: [],
                    zswapEvents: [{ eventId: 1, maxId: 2, raw: null }], dustEvents: [],
                    dustRegisteredOutputs: []
                }]
            }
        };
        for (const cursor of [null, null]) {
            await setSync({ lastIndexedHeight: 20, lastSupplementedHeight: cursor });
            const pass = supplementWith(answer);
            await pass.init(db);
            await pass.runOnce();
        }
        expect(await db.run(cds.ql.SELECT.from(ZSWAP_EVENTS).where({ transaction_ID: txId }))).toHaveLength(1);
    });
});

describe('cursor against a reorg', () => {
    it('the decoder does not write its cursor over one a rollback lowered', async () => {
        const blockId = await seedBlock(10, '0xc1');
        await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: null });
        decodeLedgerPayload.mockResolvedValue(facts());

        const decoder = new LedgerPayloadDecoder({ batchSize: 10, intervalMs: 1, lagBlocks: 2 });
        await decoder.init(db);
        // A reorg lands while the pass is between reading the cursor and writing it.
        decodeLedgerPayload.mockImplementation(async () => {
            await db.run(cds.ql.UPDATE.entity(SYNC_STATE).set({ lastDecodedHeight: 0 }).where({ ID: 'SINGLETON' }));
            return facts();
        });

        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await decoder.runOnce();
        } finally {
            info.mockRestore();
        }
        // The rollback's position stands; the replacement blocks are not skipped.
        expect(Number((await readSync()).lastDecodedHeight)).toBe(0);
    });

    it('the supplement does not write its cursor over one a rollback lowered', async () => {
        await seedBlock(10, '0xc2');
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });

        const client = {
            fetchBlock: vi.fn(async (height: number) => {
                await db.run(cds.ql.UPDATE.entity(SYNC_STATE).set({ lastSupplementedHeight: 0 }).where({ ID: 'SINGLETON' }));
                return { height, ledgerParameters: null, transactions: [] };
            })
        };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await pass.runOnce();
        } finally {
            info.mockRestore();
        }
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(0);
    });

    it('paces its indexer requests at maxBlocksPerSecond instead of firing the batch at once', async () => {
        for (const h of [10, 11, 12]) await seedBlock(h, `0xp${h}`);
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });
        const client = { fetchBlock: vi.fn(async (height: number) => ({ height, ledgerParameters: null, transactions: [] })) };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100, maxBlocksPerSecond: 2 },
            client
        );
        await pass.init(db);
        let clock = 1_000_000;
        (pass as any).now = () => clock;
        const waits: number[] = [];
        (pass as any).sleep = vi.fn(async (ms: number) => { waits.push(ms); clock += ms; });

        await pass.runOnce();

        expect(client.fetchBlock).toHaveBeenCalledTimes(3);
        // The first request goes out at once; each further one waits for its 500 ms slot.
        expect(waits).toEqual([500, 500]);
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(12);
    });

    it('backs off for minutes after a 403 or 429 and returns to the interval once a pass gets through', async () => {
        await seedBlock(10, '0xr1');
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });
        const client = {
            fetchBlock: vi.fn()
                .mockRejectedValueOnce(new IndexerHttpError(403))
                .mockRejectedValueOnce(new IndexerHttpError(429))
                .mockResolvedValue({ height: 10, ledgerParameters: null, transactions: [] })
        };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1000, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);
        const waits: number[] = [];
        (pass as any).sleep = vi.fn(async (ms: number) => {
            waits.push(ms);
            if (waits.length === 3) (pass as any).running = false;
        });
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            pass.start();
            await (pass as any).loop;
        } finally {
            warn.mockRestore();
            info.mockRestore();
        }
        // 60 s, then 120 s; the pass that got through resets the ladder and sleeps its interval.
        expect(waits).toEqual([RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * 2, 1000]);
        expect((pass as any).refusals).toBe(0);
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(10);
    });

    it('stop() wakes a pass that is backing off instead of waiting the backoff out', async () => {
        await seedBlock(10, '0xs1');
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });
        const client = { fetchBlock: vi.fn().mockRejectedValue(new IndexerHttpError(403)) };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1000, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'warn').mockImplementation(() => {});
        try {
            pass.start();
            // Until the loop sleeps its first minute.
            while (!(pass as any).wake) await new Promise(resolve => setTimeout(resolve, 5));
            const outcome = await Promise.race([
                pass.stop().then(() => 'stopped'),
                new Promise<string>(resolve => setTimeout(() => resolve('still sleeping'), 2000))
            ]);
            expect(outcome).toBe('stopped');
        } finally {
            warn.mockRestore();
        }
        expect(client.fetchBlock).toHaveBeenCalledTimes(1);
    });

    it('stop() during a pass ends it after the block in flight and records the blocks done', async () => {
        for (const h of [10, 11, 12]) await seedBlock(h, `0xe${h}`);
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9 });
        let pass: IndexerSupplement;
        const client = {
            fetchBlock: vi.fn(async (height: number) => {
                void pass.stop();
                return { height, ledgerParameters: null, transactions: [] };
            })
        };
        pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);

        const result = await pass.runOnce();

        expect(client.fetchBlock).toHaveBeenCalledTimes(1);
        expect(result.blocks).toBe(1);
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(10);
    });

    it('the client reports the HTTP status, so a refusal is told apart from an outage', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
        try {
            const client = createIndexerClient('http://indexer.invalid', 100);
            await expect(client.fetchBlock(1)).rejects.toMatchObject({ status: 403, message: 'indexer answered 403' });
        } finally {
            vi.unstubAllGlobals();
        }
        expect(isIndexerRateLimit(new IndexerHttpError(429))).toBe(true);
        expect(isIndexerRateLimit(new IndexerHttpError(502))).toBe(false);
        expect(isIndexerRateLimit(new Error('indexer answered 403'))).toBe(false);
    });
});

describe('a rollback that leaves the cursor where it was', () => {
    /**
     * Cursor 5, a pass working on block 10, a rollback to height 5: clamping
     * min(5, 5) leaves the cursor untouched, so only the generation tells the
     * pass that its work is gone.
     */
    it('the decoder drops its pass when the generation moved but the cursor did not', async () => {
        // Block 5 survives, so the fork lands exactly on the cursor.
        for (const h of [5, 6, 10]) await seedBlock(h, `0xg${h}`);
        const blockId = await seedBlock(11, '0xg11');
        await seedTransaction(blockId, { raw: midnightExtrinsicBase64(20) });
        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: 5, reorgGeneration: 1 });

        const decoder = new LedgerPayloadDecoder({ batchSize: 10, intervalMs: 1, lagBlocks: 2 });
        await decoder.init(db);
        decodeLedgerPayload.mockImplementation(async () => {
            // The rollback lands mid-pass and forks exactly at the cursor.
            await db.tx(async (tx: any) => {
                await rollbackIndexedDataFromHeight(tx, 6, { syncStatus: 'syncing' });
            });
            return facts();
        });

        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await decoder.runOnce();
        } finally {
            info.mockRestore();
        }

        const sync = await readSync();
        expect(Number(sync.reorgGeneration)).toBe(2);
        // Still 5: blocks 6 upward are re-indexed and must be decoded again.
        expect(Number(sync.lastDecodedHeight)).toBe(5);
    });

    it('the supplement drops its pass on the same shape', async () => {
        for (const h of [5, 6, 10]) await seedBlock(h, `0xh${h}`);
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 5, reorgGeneration: 1 });

        const client = {
            fetchBlock: vi.fn(async (height: number) => {
                await db.tx(async (tx: any) => {
                    await rollbackIndexedDataFromHeight(tx, 6, { syncStatus: 'syncing' });
                });
                return { height, ledgerParameters: null, transactions: [] };
            })
        };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await pass.runOnce();
        } finally {
            info.mockRestore();
        }
        expect(Number((await readSync()).lastSupplementedHeight)).toBe(5);
    });

    it('re-reads the ledger parameters after a reorg instead of trusting the cache', async () => {
        const first = await seedBlock(10, '0xlp1');
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 9, reorgGeneration: 1 });

        const params = 'cGFyYW1zLVg=';
        const answers: Record<number, any> = {
            10: { height: 10, ledgerParameters: params, transactions: [] }
        };
        const client = { fetchBlock: vi.fn(async (h: number) => answers[h] ?? null) };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);
        await pass.runOnce();
        expect((await readCapBinary(
            (await db.run(cds.ql.SELECT.one.from(BLOCKS).columns('ledgerParameters').where({ ID: first })))?.ledgerParameters
        ))?.toString()).toBe(Buffer.from(params, 'base64').toString());

        // Block 10 is rolled back and re-indexed with the same parameters.
        await db.tx(async (tx: any) => {
            await rollbackIndexedDataFromHeight(tx, 10, { syncStatus: 'syncing' });
        });
        const replacement = await seedBlock(10, '0xlp2');
        await setSync({
            lastIndexedHeight: 30, lastSupplementedHeight: 9,
            reorgGeneration: Number((await readSync())?.reorgGeneration ?? 2)
        });

        const second = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 10, intervalMs: 1, lagBlocks: 2, requestTimeoutMs: 100 },
            client
        );
        await second.init(db);
        // Same instance state would say "unchanged"; the generation moved.
        (second as any).lastLedgerParameters = params;
        (second as any).cachedGeneration = 1;
        await second.runOnce();

        const stored = await readCapBinary(
            (await db.run(cds.ql.SELECT.one.from(BLOCKS).columns('ledgerParameters').where({ ID: replacement })))?.ledgerParameters
        );
        expect(stored?.toString()).toBe(Buffer.from(params, 'base64').toString());
    });
});

describe('a rollback between reading the cursor and the generation', () => {
    /**
     * The pass used to read the cursor and the generation in two queries. A
     * rollback landing between them gave it the old chain position under the
     * new generation, and the closing check then accepted its own stale work.
     * Fires the rollback right after the FIRST SyncState read, so a single
     * read sees it at the close and two reads straddle it.
     */
    function rollbackAfterFirstSyncRead(): { restore: () => void } {
        const original = db.run.bind(db);
        let fired = false;
        const spy = vi.spyOn(db, 'run').mockImplementation(async (...args: any[]) => {
            const result = await original(...args);
            const target = String((args[0] as any)?.SELECT?.from?.ref?.[0] ?? '');
            if (!fired && target.includes('SyncState')) {
                fired = true;
                spy.mockRestore();
                await db.tx(async (tx: any) => {
                    await rollbackIndexedDataFromHeight(tx, 6, { syncStatus: 'syncing' });
                });
            }
            return result;
        });
        return { restore: () => spy.mockRestore() };
    }

    it('the decoder does not combine the old chain position with the new generation', async () => {
        for (const h of [5, 6, 20]) await seedBlock(h, `0xw${h}`);
        await setSync({ lastIndexedHeight: 30, lastDecodedHeight: 5, reorgGeneration: 1 });

        const decoder = new LedgerPayloadDecoder({ batchSize: 25, intervalMs: 1, lagBlocks: 10 });
        await decoder.init(db);
        decodeLedgerPayload.mockResolvedValue(facts());

        const hook = rollbackAfterFirstSyncRead();
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await decoder.runOnce();
        } finally {
            hook.restore();
            info.mockRestore();
        }

        // Blocks 6 upward are gone and will be re-indexed; the cursor stays.
        expect(Number((await readSync()).lastDecodedHeight)).toBe(5);
    });

    it('the supplement does not combine the old chain position with the new generation', async () => {
        for (const h of [5, 6, 20]) await seedBlock(h, `0xv${h}`);
        await setSync({ lastIndexedHeight: 30, lastSupplementedHeight: 5, reorgGeneration: 1 });

        const client = {
            fetchBlock: vi.fn(async (height: number) => ({ height, ledgerParameters: null, transactions: [] }))
        };
        const pass = new IndexerSupplement(
            { url: 'http://indexer.invalid', batchSize: 25, intervalMs: 1, lagBlocks: 10, requestTimeoutMs: 100 },
            client
        );
        await pass.init(db);

        const hook = rollbackAfterFirstSyncRead();
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            await pass.runOnce();
        } finally {
            hook.restore();
            info.mockRestore();
        }

        expect(Number((await readSync()).lastSupplementedHeight)).toBe(5);
    });
});

describe('rollback', () => {
    it('pulls both trailing cursors back to the surviving tip', async () => {
        await seedBlock(10, '0xr1');
        await seedBlock(11, '0xr2');
        await setSync({ lastIndexedHeight: 11, lastDecodedHeight: 11, lastSupplementedHeight: 5 });

        await db.tx(async (tx: any) => {
            await rollbackIndexedDataFromHeight(tx, 11, { syncStatus: 'syncing' });
        });

        const sync = await readSync();
        expect(Number(sync.lastIndexedHeight)).toBe(10);
        // Above the fork: pulled back. Below it: left alone.
        expect(Number(sync.lastDecodedHeight)).toBe(10);
        expect(Number(sync.lastSupplementedHeight)).toBe(5);
    });

    it('leaves a cursor that never ran unset', async () => {
        await seedBlock(10, '0xr3');
        await seedBlock(11, '0xr4');
        await setSync({ lastIndexedHeight: 11, lastDecodedHeight: null, lastSupplementedHeight: null });

        await db.tx(async (tx: any) => {
            await rollbackIndexedDataFromHeight(tx, 11, { syncStatus: 'syncing' });
        });

        const sync = await readSync();
        expect(sync.lastDecodedHeight).toBeNull();
        expect(sync.lastSupplementedHeight).toBeNull();
    });
});
