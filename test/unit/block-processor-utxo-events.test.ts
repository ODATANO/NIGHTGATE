/**
 * Tests for the event-driven half of srv/crawler/BlockProcessor.ts: the rows
 * the Midnight pallet's events produce.
 *
 * HYBRID, like block-processor-persistence.test.ts: a REAL in-memory CAP DB via
 * cds.test(), a fake node provider, and the persist path run for real. The SDK
 * seam (srv/crawler/utxo-identity) is mocked, so no wasm and no address-format
 * package loads; the real derivations are pinned by
 * scripts/integration-test-utxo-identity.mjs against the indexer's values.
 */

import cds from '@sap/cds';

vi.mock('../../srv/crawler/utxo-identity', () => ({
    // Reversible stand-ins: the assertions stay readable and a swapped
    // argument still shows up as a wrong row.
    encodeUnshieldedOwner: async (raw: string, network: string) => `mn_addr_${network}_${raw.slice(0, 8)}`,
    computeInitialNonce: async (outputNo: number, intentHash: string) => `nonce-${intentHash.slice(0, 8)}-${outputNo}`,
    resetUtxoIdentityCache: () => undefined
}));

import { BlockProcessor } from '../../srv/crawler/BlockProcessor';
import { recomputeNightBalance } from '../../srv/crawler/rollback';

cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const TX_RESULTS = 'midnight.TransactionResults';
const CONTRACT_ACTIONS = 'midnight.ContractActions';
const UNSHIELDED_UTXOS = 'midnight.UnshieldedUtxos';
const NIGHT_BALANCES = 'midnight.NightBalances';
const SYNC_STATE = 'midnight.SyncState';

const ADDR_A = 'aa'.repeat(32);
const ADDR_B = 'bb'.repeat(32);
const NIGHT = '0'.repeat(64);
const CONTRACT = 'cc'.repeat(32);
const OWNER_A = `mn_addr_preprod_${ADDR_A.slice(0, 8)}`;
const OWNER_B = `mn_addr_preprod_${ADDR_B.slice(0, 8)}`;

let db: any;

/** A Midnight-pallet extrinsic (pallet 5, call 0), unsigned. */
function midnightExtrinsic(salt: number): string {
    return '0x' + Buffer.from([0x14, 0x04, 5, 0, salt]).toString('hex');
}

function timestampHex(seconds: number): string {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(seconds) * 1000n);
    return '0x' + buf.toString('hex');
}

function utxoEvent(address: string, intentHash: string, outputNo: number, value: bigint, tokenType = NIGHT) {
    return { address, tokenType, intentHash, value, outputNo };
}

function events(over: Partial<any> = {}): any {
    return { outcome: 'SUCCESS', applied: true, partialSuccess: false, created: [], spent: [], contracts: [], ...over };
}

/**
 * Runs one block whose extrinsics are all Midnight-pallet calls, with the given
 * per-extrinsic events injected at the decode seam.
 */
async function processBlock(opts: {
    hash: string;
    height: number;
    parentHash?: string;
    timestamp?: number;
    extrinsicCount?: number;
    events: Map<number, any> | null;
}): Promise<void> {
    const count = opts.extrinsicCount ?? opts.events?.size ?? 1;
    const provider = {
        getBlock: vi.fn().mockResolvedValue({
            block: {
                header: {
                    parentHash: opts.parentHash ?? '0xnoparent',
                    number: '0x' + opts.height.toString(16),
                    stateRoot: '0xstate'
                },
                extrinsics: Array.from({ length: count }, (_, i) => midnightExtrinsic(i))
            },
            justifications: null
        }),
        getRuntimeVersion: vi.fn().mockResolvedValue({ specVersion: 1000000 }),
        getStorage: vi.fn().mockResolvedValue(timestampHex(opts.timestamp ?? 1_700_000_000))
    };
    const processor = new BlockProcessor(provider as any);
    (processor as any).db = db;
    vi.spyOn(processor as any, 'getEventRegistry').mockResolvedValue({});
    vi.spyOn(processor as any, 'decodeBlockEvents').mockReturnValue(opts.events);
    await processor.processBlockByHash(opts.hash);
}

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    vi.clearAllMocks();
    await db.run(cds.ql.DELETE.from(CONTRACT_ACTIONS));
    await db.run(cds.ql.DELETE.from('midnight.TransactionFees'));
    await db.run(cds.ql.DELETE.from(TX_RESULTS));
    await db.run(cds.ql.DELETE.from(UNSHIELDED_UTXOS));
    await db.run(cds.ql.DELETE.from(TRANSACTIONS));
    await db.run(cds.ql.DELETE.from(BLOCKS));
    await db.run(cds.ql.DELETE.from(NIGHT_BALANCES));
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'stopped', lastIndexedHeight: 0 }));
});

describe('UnshieldedTokens events become UTXO rows', () => {
    it('persists created outputs with the derived owner, nonce and block ctime', async () => {
        await processBlock({
            hash: '0xb1',
            height: 10,
            timestamp: 1_789_997_496,
            events: new Map([[0, events({
                created: [
                    utxoEvent(ADDR_B, 'd1'.repeat(32), 0, 5_000_000_000n),
                    utxoEvent(ADDR_A, 'd1'.repeat(32), 1, 44_344_323_000_000n)
                ]
            })]])
        });

        const rows = (await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS)))
            .sort((a: any, b: any) => a.outputIndex - b.outputIndex);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(expect.objectContaining({
            owner: OWNER_B,
            tokenType: NIGHT,
            intentHash: 'd1'.repeat(32),
            outputIndex: 0,
            initialNonce: `nonce-${'d1'.repeat(4)}-0`,
            ctime: 1_789_997_496,
            spentAtTransaction_ID: null
        }));
        expect(String(rows[0].value)).toBe('5000000000');
        expect(String(rows[1].value)).toBe('44344323000000');
        // Bound to the transaction that produced them.
        const txRow = await db.run(cds.ql.SELECT.one.from(TRANSACTIONS));
        expect(rows.every((r: any) => r.createdAtTransaction_ID === txRow.ID)).toBe(true);
    });

    it('accepts two outputs numbered 0 in one transaction when the intents differ', async () => {
        await processBlock({
            hash: '0xb2',
            height: 11,
            events: new Map([[0, events({
                created: [
                    utxoEvent(ADDR_A, '71'.repeat(32), 0, 5_000_000_000n),
                    utxoEvent(ADDR_A, '94'.repeat(32), 0, 5_000_000_000n)
                ]
            })]])
        });

        const rows = await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS));
        expect(rows).toHaveLength(2);
        expect(rows.every((r: any) => r.outputIndex === 0)).toBe(true);
        expect(new Set(rows.map((r: any) => r.intentHash)).size).toBe(2);
    });

    it('marks a UTXO spent by (intentHash, outputIndex), including one created in the same block', async () => {
        // Block 20 creates it, block 21 spends it.
        await processBlock({
            hash: '0xb20',
            height: 20,
            events: new Map([[0, events({ created: [utxoEvent(ADDR_A, 'e1'.repeat(32), 0, 100n)] })]])
        });
        await processBlock({
            hash: '0xb21',
            height: 21,
            parentHash: '0xb20',
            events: new Map([[0, events({
                spent: [utxoEvent(ADDR_A, 'e1'.repeat(32), 0, 100n)],
                created: [utxoEvent(ADDR_B, 'e2'.repeat(32), 0, 100n)]
            })]])
        });

        const spentRow = await db.run(cds.ql.SELECT.one.from(UNSHIELDED_UTXOS).where({ intentHash: 'e1'.repeat(32) }));
        const spendingTx = await db.run(cds.ql.SELECT.one.from(TRANSACTIONS).where({ block_ID: (await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xb21' }))).ID }));
        expect(spentRow.spentAtTransaction_ID).toBe(spendingTx.ID);

        // Created and consumed inside one block still links up.
        await processBlock({
            hash: '0xb22',
            height: 22,
            parentHash: '0xb21',
            extrinsicCount: 2,
            events: new Map([
                [0, events({ created: [utxoEvent(ADDR_A, 'f1'.repeat(32), 0, 50n)] })],
                [1, events({ spent: [utxoEvent(ADDR_A, 'f1'.repeat(32), 0, 50n)] })]
            ])
        });
        const sameBlock = await db.run(cds.ql.SELECT.one.from(UNSHIELDED_UTXOS).where({ intentHash: 'f1'.repeat(32) }));
        expect(sameBlock.spentAtTransaction_ID).toBeTruthy();
    });

    it('ignores a spend whose output was never indexed', async () => {
        const warn = vi.spyOn(cds.log('nightgate:crawler'), 'debug').mockImplementation(() => {});
        try {
            await processBlock({
                hash: '0xb3',
                height: 12,
                events: new Map([[0, events({ spent: [utxoEvent(ADDR_A, 'ab'.repeat(32), 3, 100n)] })]])
            });
            expect(await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS))).toHaveLength(0);
            // The block itself still persisted.
            expect(await db.run(cds.ql.SELECT.one.from(BLOCKS).where({ hash: '0xb3' }))).toBeTruthy();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('contract events drive ContractActions and the transaction type', () => {
    it('writes one action per contract event, with the address', async () => {
        await processBlock({
            hash: '0xc1',
            height: 30,
            extrinsicCount: 3,
            events: new Map([
                [0, events({ contracts: [{ actionType: 'DEPLOY', address: CONTRACT }] })],
                [1, events({ contracts: [{ actionType: 'CALL', address: CONTRACT }] })],
                [2, events({ contracts: [{ actionType: 'UPDATE', address: CONTRACT }] })]
            ])
        });

        const actions = await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS));
        expect(actions).toHaveLength(3);
        expect(actions.every((a: any) => a.address === CONTRACT)).toBe(true);
        expect(new Set(actions.map((a: any) => a.actionType))).toEqual(new Set(['DEPLOY', 'CALL', 'UPDATE']));

        const txRows = (await db.run(cds.ql.SELECT.from(TRANSACTIONS)))
            .sort((a: any, b: any) => a.transactionId - b.transactionId);
        expect(txRows.map((t: any) => t.txType)).toEqual(['contract_deploy', 'contract_call', 'contract_update']);
        expect(txRows.every((t: any) => t.contractAddress === CONTRACT)).toBe(true);
    });

    it('writes no contract action for an applied transaction the pallet named no contract for', async () => {
        // The pallet map classifies every Midnight extrinsic as contract_call;
        // the chain's own report says this one only moved tokens.
        await processBlock({
            hash: '0xc2',
            height: 31,
            events: new Map([[0, events({ created: [utxoEvent(ADDR_A, 'a1'.repeat(32), 0, 5n)] })]])
        });
        expect(await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS))).toHaveLength(0);
        expect((await db.run(cds.ql.SELECT.one.from(TRANSACTIONS))).txType).toBe('night_transfer');
    });

    it('falls back to the pallet map when the block carried no events', async () => {
        await processBlock({ hash: '0xc3', height: 32, events: null });
        const actions = await db.run(cds.ql.SELECT.from(CONTRACT_ACTIONS));
        expect(actions).toHaveLength(1);
        expect(actions[0].actionType).toBe('CALL');
        expect(actions[0].address).toBeNull();
        expect(await db.run(cds.ql.SELECT.from(TX_RESULTS))).toHaveLength(0);
    });
});

describe('transaction results', () => {
    it('records PARTIAL_SUCCESS, SUCCESS and FAILURE', async () => {
        await processBlock({
            hash: '0xr1',
            height: 40,
            extrinsicCount: 3,
            events: new Map([
                [0, events()],
                [1, events({ partialSuccess: true })],
                [2, events({ outcome: 'FAILURE', applied: false })]
            ])
        });

        const txRows = (await db.run(cds.ql.SELECT.from(TRANSACTIONS)))
            .sort((a: any, b: any) => a.transactionId - b.transactionId);
        const results = await db.run(cds.ql.SELECT.from(TX_RESULTS));
        const byTx = new Map(results.map((r: any) => [r.transaction_ID, r.status]));
        expect(txRows.map((t: any) => byTx.get(t.ID))).toEqual(['SUCCESS', 'PARTIAL_SUCCESS', 'FAILURE']);
    });
});

describe('NightBalances', () => {
    it('projects sender, receiver and the moved NIGHT onto the transaction', async () => {
        await processBlock({
            hash: '0xn0',
            height: 50,
            events: new Map([[0, events({
                spent: [utxoEvent(ADDR_A, 'aa'.repeat(32), 0, 100n)],
                created: [utxoEvent(ADDR_B, 'bb'.repeat(32), 0, 30n), utxoEvent(ADDR_A, 'bb'.repeat(32), 1, 65n)]
            })]])
        });
        const tx = await db.run(cds.ql.SELECT.one.from(TRANSACTIONS));
        expect(tx.senderAddress).toBe(OWNER_A);
        expect(tx.receiverAddress).toBe(OWNER_B);
        expect(String(tx.nightAmount)).toBe('30');
    });

    it('counts only NIGHT, not every token an address holds', async () => {
        const FOREIGN = 'ff'.repeat(32);
        await processBlock({
            hash: '0xt1',
            height: 55,
            events: new Map([[0, events({
                created: [
                    utxoEvent(ADDR_A, 'c1'.repeat(32), 0, 777n, FOREIGN),
                    utxoEvent(ADDR_A, 'c1'.repeat(32), 1, 10n)
                ]
            })]])
        });

        // Both UTXOs are indexed; only the NIGHT one reaches the balance.
        expect(await db.run(cds.ql.SELECT.from(UNSHIELDED_UTXOS))).toHaveLength(2);
        const balance = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: OWNER_A }));
        expect(String(balance.balance)).toBe('10');
        expect(balance.utxoCount).toBe(1);
        expect(String(balance.totalReceived)).toBe('10');
    });

    it('does not credit an address that only ever held a foreign token', async () => {
        await processBlock({
            hash: '0xt2',
            height: 56,
            events: new Map([[0, events({
                created: [utxoEvent(ADDR_B, 'c2'.repeat(32), 0, 500n, 'ab'.repeat(32))]
            })]])
        });
        expect(await db.run(cds.ql.SELECT.from(NIGHT_BALANCES))).toHaveLength(0);
    });

    it('a foreign-token spend leaves the NIGHT balance alone', async () => {
        const FOREIGN = 'ff'.repeat(32);
        await processBlock({
            hash: '0xt3',
            height: 57,
            events: new Map([[0, events({
                created: [
                    utxoEvent(ADDR_A, 'd7'.repeat(32), 0, 777n, FOREIGN),
                    utxoEvent(ADDR_A, 'd7'.repeat(32), 1, 10n)
                ]
            })]])
        });
        await processBlock({
            hash: '0xt4',
            height: 58,
            parentHash: '0xt3',
            events: new Map([[0, events({
                spent: [utxoEvent(ADDR_A, 'd7'.repeat(32), 0, 777n, FOREIGN)]
            })]])
        });

        const balance = await db.run(cds.ql.SELECT.one.from(NIGHT_BALANCES).where({ address: OWNER_A }));
        expect(String(balance.balance)).toBe('10');
        expect(balance.utxoCount).toBe(1);
    });

    /**
     * The crawler folds balances in block by block; a reorg rebuilds them from
     * the surviving rows. The two rules have to land on the same figures.
     */
    it('matches what the rollback recompute rebuilds from the same rows', async () => {
        const INTENT_1 = '01'.repeat(32);
        const INTENT_2 = '02'.repeat(32);
        const INTENT_3 = '03'.repeat(32);

        // A funds itself, then sends to B, then B's output is partly spent on.
        await processBlock({
            hash: '0xn1',
            height: 60,
            events: new Map([[0, events({ created: [
                utxoEvent(ADDR_A, INTENT_1, 0, 1_000n),
                // A foreign token in the same set: both rules must skip it.
                utxoEvent(ADDR_A, INTENT_1, 2, 999n, 'ee'.repeat(32))
            ] })]])
        });
        await processBlock({
            hash: '0xn2',
            height: 61,
            parentHash: '0xn1',
            events: new Map([[0, events({
                spent: [utxoEvent(ADDR_A, INTENT_1, 0, 1_000n)],
                created: [utxoEvent(ADDR_B, INTENT_2, 0, 400n), utxoEvent(ADDR_A, INTENT_2, 1, 590n)]
            })]])
        });
        await processBlock({
            hash: '0xn3',
            height: 62,
            parentHash: '0xn2',
            events: new Map([[0, events({
                spent: [utxoEvent(ADDR_B, INTENT_2, 0, 400n)],
                created: [utxoEvent(ADDR_B, INTENT_3, 0, 390n)]
            })]])
        });

        const incremental = await db.run(cds.ql.SELECT.from(NIGHT_BALANCES));
        expect(incremental.map((r: any) => r.address).sort()).toEqual([OWNER_A, OWNER_B].sort());

        const snapshot = new Map<string, any>(incremental.map((r: any) => [r.address, r]));
        // A holds the 590 change, B holds the 390 it kept.
        expect(String(snapshot.get(OWNER_A).balance)).toBe('590');
        expect(String(snapshot.get(OWNER_B).balance)).toBe('390');

        await db.tx(async (tx: any) => {
            for (const address of [OWNER_A, OWNER_B]) await recomputeNightBalance(tx, address);
        });
        const rebuilt = await db.run(cds.ql.SELECT.from(NIGHT_BALANCES));

        const comparable = (rows: any[]) => rows
            .map((r: any) => ({
                address: r.address,
                balance: String(r.balance),
                utxoCount: r.utxoCount,
                totalReceived: String(r.totalReceived),
                txReceivedCount: r.txReceivedCount,
                totalSent: String(r.totalSent),
                txSentCount: r.txSentCount,
                firstSeenHeight: Number(r.firstSeenHeight),
                lastActivityHeight: Number(r.lastActivityHeight)
            }))
            .sort((a, b) => a.address.localeCompare(b.address));

        expect(comparable(rebuilt)).toEqual(comparable(incremental));
    });
});
