/**
 * Tests for srv/crawler/BlockProcessor.ts persistence paths.
 *
 * HYBRID approach: runs against a REAL in-memory CAP DB via cds.test()
 * (see test/jest.setup.ts). The whole point of this suite is persistence, so
 * we give the BlockProcessor the REAL db, run the persist path, then SELECT the
 * actual rows and assert their persisted field values (block, transactions,
 * tx-results, tx-fees, contract actions, unshielded UTXOs, NightBalances, and
 * the SyncState advance).
 *
 * The old test captured `INSERT.into(...).entries(...)` / `UPDATE` query objects
 * via a hand-rolled jest.mock('@sap/cds') cds.ql mock and asserted their shapes
 * with an `extractRows(queries, 'midnight.X')` helper. That mock is removed; the
 * processor now writes through the framework's real cds.ql into SQLite, and the
 * query-shape assertions are reframed to row-state assertions.
 *
 * External collaborators stay MOCKED:
 *  - MidnightNodeProvider          → per-test inline fake objects (no real RPC)
 *  - reconcilePendingSubmission    → jest.mock (no-op; PendingSubmissions is
 *    empty in these tests, so reconciliation is a no-op anyway — mocking keeps
 *    the persist path decoupled from the submission module).
 *
 * Note on the pallet map: the processor's constructor builds its pallet map from
 * `cds.env.requires.nightgate.palletMap`. The [test] profile config does not set
 * one, so the old test's pallet-15 → Zswap/shielded_transfer entry is injected
 * onto cds.env before constructing the processor (test-only env tweak, mirrors
 * what the old cds mock hard-coded). Defaults (System=0, Contracts=10,
 * Balances=4) come from the source's DEFAULT_PALLET_MAP.
 */

// External collaborator: keep mocked. jest.mock is hoisted; only override
// reconcilePendingSubmission, preserve every other real export so the
// framework-booted submission handlers still load normally.
const mockReconcile = jest.fn().mockResolvedValue(undefined);
jest.mock('../../srv/submission/TransactionSubmitter', () => ({
    ...jest.requireActual('../../srv/submission/TransactionSubmitter'),
    reconcilePendingSubmission: (...args: any[]) => mockReconcile(...args)
}));

import cds from '@sap/cds';
import { BlockProcessor } from '../../srv/crawler/BlockProcessor';

jest.setTimeout(60000);

// Boot the in-memory CAP server. Not assigned to a `test` const on purpose
// (would shadow Jest's global test()).
cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const TX_RESULTS = 'midnight.TransactionResults';
const TX_FEES = 'midnight.TransactionFees';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const NIGHT_BALANCES = 'midnight.NightBalances';
const SYNC_STATE = 'midnight.SyncState';

let db: any;

// ---------------------------------------------------------------------------
// Block-input builders (reused verbatim from the original suite — only the
// assertion/persistence layer changes).
// ---------------------------------------------------------------------------

function buildUnsignedExtrinsic(palletIndex: number, callIndex: number): string {
    return '0x' + Buffer.from([0x0c, 0x04, palletIndex, callIndex]).toString('hex');
}

function encodeCompact(value: number): number[] {
    if (value <= 63) {
        return [value << 2];
    }

    const buf = Buffer.alloc(2);
    buf.writeUInt16LE((value << 2) | 0x01, 0);
    return [...buf];
}

function buildSignedTransferExtrinsic(senderByte: number, receiverByte: number, amount: number): string {
    const payload: number[] = [
        0x84, // signed v4
        0x00, // signer address type: AccountId32
        ...Array(32).fill(senderByte),
        0x01, // signature type: Sr25519
        ...Array(64).fill(0xbb),
        0x00, // immortal era
        0x00, // nonce compact(0)
        0x00, // tip compact(0)
        0x04, // Balances pallet
        0x00, // transfer call
        0x00, // destination address type: AccountId32
        ...Array(32).fill(receiverByte),
        ...encodeCompact(amount)
    ];

    const encodedLength = encodeCompact(payload.length);
    return `0x${Buffer.from([...encodedLength, ...payload]).toString('hex')}`;
}

function buildTimestampHex(seconds: number): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(seconds) * 1000n);
    return '0x' + buf.toString('hex');
}

/** Construct a processor wired to the REAL in-memory db + a fake node provider. */
function makeProcessor(provider: any): BlockProcessor {
    const processor = new BlockProcessor(provider as any);
    (processor as any).db = db;
    return processor;
}

/** Upsert the SINGLETON SyncState row to a known shape. */
async function setSyncState(fields: Record<string, any> = {}): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', ...fields }));
}

beforeAll(async () => {
    db = await cds.connect.to('db');

    // The [test] profile does not configure a pallet map; inject the Zswap entry
    // (pallet 15) the original test hard-coded in its cds mock so pallet-15
    // extrinsics classify as shielded_transfer / isShielded. The BlockProcessor
    // reads this in its constructor via getNightgatePluginConfig().
    const env = cds.env as any;
    env.requires = env.requires || {};
    env.requires.nightgate = env.requires.nightgate || {};
    env.requires.nightgate.palletMap = {
        ...(env.requires.nightgate.palletMap || {}),
        15: { name: 'Zswap', txType: 'shielded_transfer', isShielded: true }
    };
});

beforeEach(async () => {
    jest.clearAllMocks();
    mockReconcile.mockResolvedValue(undefined);

    // Reset DB state used by these tests (children before parents).
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from(TX_FEES));
    await db.run(cds.ql.DELETE.from(TX_RESULTS));
    await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    await setSyncState({ syncStatus: 'stopped', lastIndexedHeight: 0, chainHeight: 0, consecutiveErrors: 0 });
});

describe('BlockProcessor persistence paths', () => {
    // ------------------------------------------------------------------------
    // init() — connects the real db. (Was asserted against a fake cds.connect.)
    // ------------------------------------------------------------------------
    it('initializes the database connection through cds.connect', async () => {
        const processor = new BlockProcessor({} as any);
        await processor.init();

        // Behavioral: init() resolved the framework db. The same connection the
        // suite uses (cds.connect.to('db') is memoized to the in-memory service).
        expect((processor as any).db).toBeTruthy();
        expect((processor as any).db).toBe(db);
    });

    // ------------------------------------------------------------------------
    // Already-indexed short-circuit: no write, no full-block fetch.
    // ------------------------------------------------------------------------
    it('returns early for blocks that are already indexed', async () => {
        // Seed the block so blockExists() is true.
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: cds.utils.uuid(),
            hash: '0xknown',
            height: 42,
            protocolVersion: 1,
            timestamp: 1_700_000_000,
            ledgerParameters: '0xstate'
        }));

        const provider = {
            getHeader: jest.fn().mockResolvedValue({ number: '0x2a' }),
            getBlock: jest.fn()
        };
        const processor = makeProcessor(provider);

        const result = await processor.processBlockByHash('0xknown');
        expect(result).toEqual(expect.objectContaining({
            blockHeight: 42,
            blockHash: '0xknown',
            transactionCount: 0,
            contractActionCount: 0
        }));
        expect(typeof result.processingTimeMs).toBe('number');

        expect(provider.getHeader).toHaveBeenCalledWith('0xknown');
        // The expensive full-block fetch was skipped.
        expect(provider.getBlock).not.toHaveBeenCalled();

        // No duplicate block, no transactions persisted.
        expect((await db.run(cds.ql.SELECT.from(BLOCKS).where({ hash: '0xknown' }))).length).toBe(1);
        expect((await db.run(cds.ql.SELECT.from(TRANSACTIONS))).length).toBe(0);
    });

    // ------------------------------------------------------------------------
    // Full persist: block + 5 transactions + results/fees + 3 contract actions
    // + SyncState advance, all written to the real DB.
    // ------------------------------------------------------------------------
    it('persists a new block, transactions, and sync state in one DB transaction', async () => {
        // Seed the parent block so parent_ID resolves.
        const parentId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: parentId,
            hash: '0xparent',
            height: 4,
            protocolVersion: 77,
            timestamp: 1_699_999_999,
            ledgerParameters: '0xstate-parent'
        }));

        const extrinsics = [
            buildUnsignedExtrinsic(0, 0),   // System → system
            buildUnsignedExtrinsic(10, 0),  // Contracts call 0 → contract_call
            buildUnsignedExtrinsic(10, 1),  // Contracts call 1 → contract_deploy
            buildUnsignedExtrinsic(10, 2),  // Contracts call 2 → contract_update
            buildUnsignedExtrinsic(15, 0)   // Zswap → shielded_transfer (from injected palletMap)
        ];
        const provider = {
            getBlock: jest.fn().mockResolvedValue({
                block: {
                    header: {
                        parentHash: '0xparent',
                        number: '0x05',
                        stateRoot: '0xstate',
                        digest: {
                            logs: ['0x0642414245deadbeef']
                        }
                    },
                    extrinsics
                },
                justifications: null
            }),
            getRuntimeVersion: jest.fn().mockResolvedValue({ specVersion: 77 }),
            getStorage: jest.fn().mockResolvedValue(buildTimestampHex(1_700_000_000))
        };

        const processor = makeProcessor(provider);

        const result = await processor.processBlockByHash('0xnew');

        expect(result).toEqual(expect.objectContaining({
            blockHeight: 5,
            blockHash: '0xnew',
            transactionCount: 5,
            contractActionCount: 3
        }));

        // --- Block row ---
        const blockRow = await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xnew' }));
        expect(blockRow).toEqual(expect.objectContaining({
            hash: '0xnew',
            protocolVersion: 77,
            timestamp: 1_700_000_000,
            author: 'BABE:0xdeadbeef',
            ledgerParameters: '0xstate',
            parent_ID: parentId
        }));
        // Integer64: number on CAP 9, string on CAP 10 (ieee754compatible).
        expect(Number(blockRow.height)).toBe(5);
        const blockId = blockRow.ID;

        // --- Transactions (ordered by index within block) ---
        const txRows = (await db.run(cds.ql.SELECT.from(TRANSACTIONS)))
            .sort((a: any, b: any) => a.transactionId - b.transactionId);
        expect(txRows).toHaveLength(5);
        expect(txRows.map((t: any) => t.txType)).toEqual([
            'system', 'contract_call', 'contract_deploy', 'contract_update', 'shielded_transfer'
        ]);
        expect(txRows.map((t: any) => t.transactionType)).toEqual([
            'SYSTEM', 'REGULAR', 'REGULAR', 'REGULAR', 'REGULAR'
        ]);
        expect(txRows[4].isShielded).toBe(true);
        expect(txRows.slice(0, 4).every((t: any) => t.isShielded === false)).toBe(true);
        expect(txRows.map((t: any) => t.size)).toEqual([4, 4, 4, 4, 4]);
        expect(txRows.map((t: any) => t.hasProof)).toEqual([false, false, false, false, true]);
        expect(txRows.map((t: any) => t.circuitName)).toEqual(['0:0', '10:0', '10:1', '10:2', '15:0']);
        // Contract txs (indices 1-3) get a derived 28-byte contract address.
        expect(txRows.slice(1, 4).every((t: any) => /^0x[0-9a-f]{56}$/.test(t.contractAddress))).toBe(true);
        expect(txRows[0].contractAddress).toBeNull();
        expect(txRows[4].contractAddress).toBeNull();
        expect(txRows.every((t: any) => t.block_ID === blockId)).toBe(true);
        expect(txRows.every((t: any) => /^0x[0-9a-f]{64}$/.test(t.hash))).toBe(true);

        // --- Transaction results: one SUCCESS per tx, linked to the tx ---
        const txIds = new Set(txRows.map((t: any) => t.ID));
        const resultRows = await db.run(cds.ql.SELECT.from(TX_RESULTS));
        expect(resultRows).toHaveLength(5);
        expect(resultRows.every((r: any) => r.status === 'SUCCESS')).toBe(true);
        expect(resultRows.every((r: any) => txIds.has(r.transaction_ID))).toBe(true);

        // --- Transaction fees: one zero-fee row per tx ---
        const feeRows = await db.run(cds.ql.SELECT.from(TX_FEES));
        expect(feeRows).toHaveLength(5);
        expect(feeRows.every((f: any) => String(f.paidFees) === '0' && String(f.estimatedFees) === '0')).toBe(true);
        expect(feeRows.every((f: any) => txIds.has(f.transaction_ID))).toBe(true);

        // --- Contract actions: CALL/DEPLOY/UPDATE for the three Contracts txs ---
        const actionRows = (await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS)));
        expect(actionRows).toHaveLength(3);
        // Order by the circuit entryPoint to make the assertion deterministic.
        const actionsByEntry = actionRows.sort((a: any, b: any) => a.entryPoint.localeCompare(b.entryPoint));
        expect(actionsByEntry.map((a: any) => a.entryPoint)).toEqual(['10:0', '10:1', '10:2']);
        expect(actionsByEntry.map((a: any) => a.actionType)).toEqual(['CALL', 'DEPLOY', 'UPDATE']);
        expect(actionRows.every((a: any) => /^0x[0-9a-f]{56}$/.test(a.address))).toBe(true);
        expect(actionRows.every((a: any) => txIds.has(a.transaction_ID))).toBe(true);

        // --- SyncState advanced to the new tip ---
        const sync = await db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));
        expect(Number(sync.lastIndexedHeight)).toBe(5);
        expect(sync.lastIndexedHash).toBe('0xnew');
        expect(sync.syncStatus).toBe('syncing');
        expect(typeof sync.lastIndexedAt).toBe('string');

        // --- Reconciliation hook fired once per tx ---
        expect(mockReconcile).toHaveBeenCalledTimes(5);
    });

    // ------------------------------------------------------------------------
    // Fallback metadata: missing runtime version + missing timestamp storage.
    // ------------------------------------------------------------------------
    it('falls back cleanly when runtime and timestamp metadata are unavailable', async () => {
        const provider = {
            getBlock: jest.fn().mockResolvedValue({
                block: {
                    header: {
                        parentHash: '0xmissing-parent',
                        number: '0x06',
                        stateRoot: '0xstate-2'
                    },
                    extrinsics: ['0x' + 'aa'.repeat(60)]
                },
                justifications: null
            }),
            getRuntimeVersion: jest.fn().mockRejectedValue(new Error('runtime unavailable')),
            getStorage: jest.fn().mockResolvedValue(null)
        };

        const processor = makeProcessor(provider);

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        // getBlockTimestamp falls back to Math.floor(Date.now()/1000) when storage
        // is null; pin Date.now so the persisted timestamp is deterministic.
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

        try {
            const result = await processor.processBlockByHash('0xfallback');
            expect(result).toEqual(expect.objectContaining({
                blockHeight: 6,
                blockHash: '0xfallback',
                transactionCount: 1,
                contractActionCount: 0
            }));

            // --- Block row: cached specVersion 0 (runtime fetch failed), no parent,
            //     no author (no digest logs), timestamp from wall-clock fallback. ---
            const blockRow = await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xfallback' }));
            expect(blockRow).toEqual(expect.objectContaining({
                protocolVersion: 0,
                timestamp: 1_700_000_000,
                author: null,
                parent_ID: null
            }));

            // --- Single unclassified transaction (60-byte size, REGULAR, unknown). ---
            const txRows = await db.run(cds.ql.SELECT.from(TRANSACTIONS));
            expect(txRows).toHaveLength(1);
            expect(txRows[0]).toEqual(expect.objectContaining({
                txType: 'unknown',
                transactionType: 'REGULAR',
                isShielded: false,
                hasProof: false,
                size: 60,
                protocolVersion: 0,
                block_ID: blockRow.ID
            }));

            // No contract actions for an unclassified tx.
            expect((await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS))).length).toBe(0);

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get runtime version'));
        } finally {
            warnSpy.mockRestore();
            nowSpy.mockRestore();
        }
    });

    // ------------------------------------------------------------------------
    // Signed night transfer → projected into a UTXO + sender/receiver balances.
    // ------------------------------------------------------------------------
    it('projects signed night transfers into addresses, UTXOs, and NightBalances', async () => {
        // Seed the parent block so parent_ID resolves.
        const parentId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: parentId,
            hash: '0xparent-3',
            height: 8,
            protocolVersion: 88,
            timestamp: 1_700_099_999,
            ledgerParameters: '0xstate-parent-3'
        }));

        const transferExtrinsic = buildSignedTransferExtrinsic(0x11, 0x22, 100);
        const provider = {
            getBlock: jest.fn().mockResolvedValue({
                block: {
                    header: {
                        parentHash: '0xparent-3',
                        number: '0x09',
                        stateRoot: '0xstate-3',
                        digest: { logs: [] }
                    },
                    extrinsics: [transferExtrinsic]
                },
                justifications: null
            }),
            getRuntimeVersion: jest.fn().mockResolvedValue({ specVersion: 88 }),
            getStorage: jest.fn().mockResolvedValue(buildTimestampHex(1_700_100_000))
        };

        const processor = makeProcessor(provider);

        await expect(processor.processBlockByHash('0xtransfer')).resolves.toEqual(expect.objectContaining({
            blockHeight: 9,
            transactionCount: 1,
            contractActionCount: 0
        }));

        // --- Transaction row carries sender/receiver/amount. ---
        const txRows = await db.run(cds.ql.SELECT.from(TRANSACTIONS));
        expect(txRows).toHaveLength(1);
        const txRow = txRows[0];
        expect(txRow).toEqual(expect.objectContaining({
            txType: 'night_transfer',
            senderAddress: `0x${'11'.repeat(32)}`,
            receiverAddress: `0x${'22'.repeat(32)}`,
            nightAmount: '100'
        }));

        // --- UTXO created for the receiver. ---
        const utxoRows = await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS));
        expect(utxoRows).toHaveLength(1);
        expect(utxoRows[0]).toEqual(expect.objectContaining({
            owner: `0x${'22'.repeat(32)}`,
            tokenType: '0x4e49474854',
            value: '100',
            outputIndex: 0,
            ctime: 1_700_100_000,
            createdAtTransaction_ID: txRow.ID
        }));
        expect(utxoRows[0].intentHash).toMatch(/^0x[0-9a-f]{64}$/);

        // --- NightBalances: one credited receiver, one debited sender. ---
        const balanceRows = await db.run(cds.ql.SELECT.from(NIGHT_BALANCES));
        expect(balanceRows).toHaveLength(2);

        const receiverBalance = balanceRows.find((b: any) => b.address === `0x${'22'.repeat(32)}`);
        expect(receiverBalance).toBeTruthy();
        expect(String(receiverBalance.balance)).toBe('100');
        expect(receiverBalance.utxoCount).toBe(1);
        expect(receiverBalance.txReceivedCount).toBe(1);
        expect(String(receiverBalance.totalReceived)).toBe('100');
        expect(receiverBalance.txSentCount).toBe(0);
        expect(String(receiverBalance.totalSent)).toBe('0');

        const senderBalance = balanceRows.find((b: any) => b.address === `0x${'11'.repeat(32)}`);
        expect(senderBalance).toBeTruthy();
        expect(String(senderBalance.balance)).toBe('0');
        expect(senderBalance.txSentCount).toBe(1);
        expect(String(senderBalance.totalSent)).toBe('100');
        expect(senderBalance.txReceivedCount).toBe(0);
        expect(String(senderBalance.totalReceived)).toBe('0');
    });
});

// ----------------------------------------------------------------------------
// Parent enforcement on height-sequenced paths
//
// persistPreparedBlock (catch-up pipeline) and processBlockByHeight (live)
// refuse to persist a non-genesis block whose parent is not indexed: that is
// an index gap and must fail loudly instead of writing parent_ID = null.
// processBlockByHash (on-demand, hash-addressed) keeps the lenient fallback,
// covered by the 'missing parent' test above.
// ----------------------------------------------------------------------------
describe('parent enforcement (height-sequenced paths)', () => {
    function preparedBlock(height: number, hash: string, parentHash: string): any {
        return {
            blockHash: hash,
            height,
            signedBlock: {
                block: {
                    header: {
                        parentHash,
                        number: `0x${height.toString(16)}`,
                        stateRoot: '0xstate',
                        extrinsicsRoot: '0x00',
                        digest: { logs: [] }
                    },
                    extrinsics: []
                }
            },
            protocolVersion: 1,
            timestamp: 1_700_000_000 + height,
            fetchStartedAt: Date.now(),
            fetchCompletedAt: Date.now(),
            alreadyIndexed: false
        };
    }

    it('rejects a pipeline block whose parent is missing and persists nothing', async () => {
        const processor = makeProcessor({});

        await expect(
            processor.persistPreparedBlock(preparedBlock(7, '0xorphan', '0xmissing-parent'))
        ).rejects.toThrow('refusing to persist an orphan');

        // The insert ran inside a tx → rolled back, no partial block row.
        const rows = await db.run(cds.ql.SELECT.from(BLOCKS).where({ hash: '0xorphan' }));
        expect(rows.length).toBe(0);
    });

    it('persists genesis (height 0) without a parent', async () => {
        const processor = makeProcessor({});

        const result = await processor.persistPreparedBlock(preparedBlock(0, '0xgenesis', '0x' + '00'.repeat(32)));
        expect(result.blockHeight).toBe(0);

        const row = await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xgenesis' }));
        expect(row).toBeTruthy();
        expect(row.parent_ID).toBeNull();
    });

    it('persists and links a pipeline block whose parent is indexed', async () => {
        const parentId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into(BLOCKS).entries({
            ID: parentId,
            hash: '0xparent-6',
            height: 6,
            protocolVersion: 1,
            timestamp: 1_700_000_000,
            ledgerParameters: '0xstate'
        }));
        const processor = makeProcessor({});

        const result = await processor.persistPreparedBlock(preparedBlock(7, '0xchild-7', '0xparent-6'));
        expect(result.blockHeight).toBe(7);

        const row = await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xchild-7' }));
        expect(row.parent_ID).toBe(parentId);
    });
});
