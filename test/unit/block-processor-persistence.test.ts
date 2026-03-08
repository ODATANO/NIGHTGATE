const connectToSpy = jest.fn();
const uuidSpy = jest.fn();

jest.mock('@sap/cds', () => {
    const SELECT = {
        one: {
            from: jest.fn((entity: string) => ({
                columns: jest.fn((...columns: string[]) => ({
                    where: jest.fn((where: Record<string, unknown>) => ({
                        kind: 'selectOne',
                        entity,
                        columns,
                        where
                    }))
                }))
            }))
        }
    };

    const INSERT = {
        into: jest.fn((entity: string) => ({
            entries: jest.fn((entry: Record<string, unknown>) => ({
                kind: 'insert',
                entity,
                entry
            }))
        }))
    };

    const UPDATE = {
        entity: jest.fn((entity: string) => ({
            set: jest.fn((set: Record<string, unknown>) => ({
                where: jest.fn((where: Record<string, unknown>) => ({
                    kind: 'update',
                    entity,
                    set,
                    where
                }))
            }))
        }))
    };

    const cds: any = {
        env: {
            requires: {
                nightgate: {
                    palletMap: {
                        15: { name: 'Zswap', txType: 'shielded_transfer', isShielded: true }
                    }
                }
            }
        },
        ql: { SELECT, INSERT, UPDATE },
        connect: {
            to: connectToSpy
        },
        utils: {
            uuid: uuidSpy
        }
    };
    cds.default = cds;
    return cds;
});

import cds from '@sap/cds';
import { BlockProcessor } from '../../srv/crawler/BlockProcessor';

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

describe('BlockProcessor persistence paths', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        connectToSpy.mockReset();
        uuidSpy.mockReset();
    });

    it('initializes the database connection through cds.connect', async () => {
        const db = { run: jest.fn(), tx: jest.fn() };
        connectToSpy.mockResolvedValueOnce(db);

        const processor = new BlockProcessor({} as any);

        await processor.init();

        expect(connectToSpy).toHaveBeenCalledWith('db');
        expect((processor as any).db).toBe(db);
    });

    it('returns early for blocks that are already indexed', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ ID: 'existing-block' }),
            tx: jest.fn()
        };
        const provider = {
            getHeader: jest.fn().mockResolvedValue({ number: '0x2a' }),
            getBlock: jest.fn()
        };
        const processor = new BlockProcessor(provider as any);
        (processor as any).db = db;

        const nowSpy = jest.spyOn(Date, 'now')
            .mockReturnValueOnce(1_000)
            .mockReturnValueOnce(1_012);

        try {
            await expect(processor.processBlockByHash('0xknown')).resolves.toEqual({
                blockHeight: 42,
                blockHash: '0xknown',
                transactionCount: 0,
                contractActionCount: 0,
                processingTimeMs: 12
            });

            expect(provider.getHeader).toHaveBeenCalledWith('0xknown');
            expect(provider.getBlock).not.toHaveBeenCalled();
            expect(db.tx).not.toHaveBeenCalled();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('persists a new block, transactions, and sync state in one DB transaction', async () => {
        const extrinsics = [
            buildUnsignedExtrinsic(0, 0),
            buildUnsignedExtrinsic(10, 0),
            buildUnsignedExtrinsic(10, 1),
            buildUnsignedExtrinsic(10, 2),
            buildUnsignedExtrinsic(15, 0)
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
        const tx = {
            run: jest.fn(async (query: any) => {
                if (query?.kind === 'selectOne' && query.entity === 'midnight.Blocks' && query.where?.hash === '0xparent') {
                    return { ID: 'parent-1' };
                }
                return null;
            })
        };
        const db = {
            run: jest.fn().mockResolvedValue(null),
            tx: jest.fn(async (callback: (transaction: any) => Promise<void>) => callback(tx))
        };

        let uuidIndex = 0;
        uuidSpy.mockImplementation(() => {
            uuidIndex += 1;
            return uuidIndex === 1 ? 'block-1' : `uuid-${uuidIndex}`;
        });

        const processor = new BlockProcessor(provider as any);
        (processor as any).db = db;

        const result = await processor.processBlockByHash('0xnew');
        const txQueries = tx.run.mock.calls.map(([query]) => query);
        const blockInsert = txQueries.find((query) => query?.kind === 'insert' && query.entity === 'midnight.Blocks');
        const txInserts = txQueries.filter((query) => query?.kind === 'insert' && query.entity === 'midnight.Transactions');
        const txResultInserts = txQueries.filter((query) => query?.kind === 'insert' && query.entity === 'midnight.TransactionResults');
        const txFeeInserts = txQueries.filter((query) => query?.kind === 'insert' && query.entity === 'midnight.TransactionFees');
        const contractActionInserts = txQueries.filter((query) => query?.kind === 'insert' && query.entity === 'midnight.ContractActions');
        const syncUpdate = txQueries.find((query) => query?.kind === 'update' && query.entity === 'midnight.SyncState');

        expect(result).toEqual(expect.objectContaining({
            blockHeight: 5,
            blockHash: '0xnew',
            transactionCount: 5,
            contractActionCount: 3
        }));
        expect(db.run).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'selectOne',
            entity: 'midnight.Blocks',
            where: { hash: '0xnew' }
        }));
        expect(db.tx).toHaveBeenCalledTimes(1);
        expect(blockInsert?.entry).toEqual(expect.objectContaining({
            ID: 'block-1',
            hash: '0xnew',
            height: 5,
            protocolVersion: 77,
            timestamp: 1_700_000_000,
            author: 'BABE:0xdeadbeef',
            ledgerParameters: '0xstate',
            parent_ID: 'parent-1'
        }));
        expect(txInserts).toHaveLength(5);
        expect(txResultInserts).toHaveLength(5);
        expect(txFeeInserts).toHaveLength(5);
        expect(contractActionInserts).toHaveLength(3);
        expect(txInserts.map((query) => query.entry.txType)).toEqual([
            'system',
            'contract_call',
            'contract_deploy',
            'contract_update',
            'shielded_transfer'
        ]);
        expect(txInserts.map((query) => query.entry.transactionType)).toEqual([
            'SYSTEM',
            'REGULAR',
            'REGULAR',
            'REGULAR',
            'REGULAR'
        ]);
        expect(txInserts[4].entry.isShielded).toBe(true);
        expect(txInserts.map((query) => query.entry.size)).toEqual([4, 4, 4, 4, 4]);
        expect(txInserts.map((query) => query.entry.hasProof)).toEqual([false, false, false, false, true]);
        expect(txInserts.map((query) => query.entry.circuitName)).toEqual(['0:0', '10:0', '10:1', '10:2', '15:0']);
        expect(txInserts.slice(1, 4).every((query) => /^0x[0-9a-f]{56}$/.test(query.entry.contractAddress))).toBe(true);
        expect(txInserts[0].entry.contractAddress).toBeNull();
        expect(txInserts[4].entry.contractAddress).toBeNull();
        expect(txInserts.every((query) => query.entry.block_ID === 'block-1')).toBe(true);
        expect(txInserts.every((query) => /^0x[0-9a-f]{64}$/.test(query.entry.hash))).toBe(true);
        expect(txResultInserts.every((query) => query.entry.status === 'SUCCESS')).toBe(true);
        expect(txResultInserts.every((query) => /^uuid-\d+$/.test(query.entry.transaction_ID))).toBe(true);
        expect(txFeeInserts.every((query) => query.entry.paidFees === '0' && query.entry.estimatedFees === '0')).toBe(true);
        expect(contractActionInserts.map((query) => query.entry.actionType)).toEqual(['CALL', 'DEPLOY', 'UPDATE']);
        expect(contractActionInserts.map((query) => query.entry.entryPoint)).toEqual(['10:0', '10:1', '10:2']);
        expect(contractActionInserts.every((query) => /^0x[0-9a-f]{56}$/.test(query.entry.address))).toBe(true);
        expect(syncUpdate).toEqual(expect.objectContaining({
            kind: 'update',
            entity: 'midnight.SyncState',
            set: expect.objectContaining({
                lastIndexedHeight: 5,
                lastIndexedHash: '0xnew',
                lastIndexedAt: expect.any(String),
                syncStatus: 'syncing'
            }),
            where: { ID: 'SINGLETON' }
        }));
    });

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
        const tx = {
            run: jest.fn().mockResolvedValue(null)
        };
        const db = {
            run: jest.fn().mockResolvedValue(null),
            tx: jest.fn(async (callback: (transaction: any) => Promise<void>) => callback(tx))
        };

        uuidSpy
            .mockReturnValueOnce('block-2')
            .mockReturnValueOnce('tx-6')
            .mockReturnValueOnce('txr-6')
            .mockReturnValueOnce('txf-6');

        const processor = new BlockProcessor(provider as any);
        (processor as any).db = db;

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        const nowSpy = jest.spyOn(Date, 'now')
            .mockReturnValueOnce(2_000)
            .mockReturnValueOnce(1_700_000_000_000)
            .mockReturnValueOnce(2_050);

        try {
            const result = await processor.processBlockByHash('0xfallback');
            const txQueries = tx.run.mock.calls.map(([query]) => query);
            const blockInsert = txQueries.find((query) => query?.kind === 'insert' && query.entity === 'midnight.Blocks');
            const txInsert = txQueries.find((query) => query?.kind === 'insert' && query.entity === 'midnight.Transactions');

            expect(result).toEqual(expect.objectContaining({
                blockHeight: 6,
                blockHash: '0xfallback',
                transactionCount: 1,
                contractActionCount: 0,
                processingTimeMs: 50
            }));
            expect(blockInsert?.entry).toEqual(expect.objectContaining({
                protocolVersion: 0,
                timestamp: 1_700_000_000,
                author: null,
                parent_ID: null
            }));
            expect(txInsert?.entry).toEqual(expect.objectContaining({
                txType: 'unknown',
                transactionType: 'REGULAR',
                isShielded: false,
                hasProof: false,
                size: 60,
                protocolVersion: 0,
                block_ID: 'block-2'
            }));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get runtime version'));
        } finally {
            warnSpy.mockRestore();
            nowSpy.mockRestore();
        }
    });

    it('projects signed night transfers into addresses, UTXOs, and NightBalances', async () => {
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

        const tx = {
            run: jest.fn(async (query: any) => {
                if (query?.kind === 'selectOne' && query.entity === 'midnight.Blocks' && query.where?.hash === '0xparent-3') {
                    return { ID: 'parent-3' };
                }

                return null;
            })
        };

        const db = {
            run: jest.fn().mockResolvedValue(null),
            tx: jest.fn(async (callback: (transaction: any) => Promise<void>) => callback(tx))
        };

        let uuidIndex = 0;
        uuidSpy.mockImplementation(() => {
            uuidIndex += 1;
            return `uuid-${uuidIndex}`;
        });

        const processor = new BlockProcessor(provider as any);
        (processor as any).db = db;

        await expect(processor.processBlockByHash('0xtransfer')).resolves.toEqual(expect.objectContaining({
            blockHeight: 9,
            transactionCount: 1,
            contractActionCount: 0
        }));

        const txQueries = tx.run.mock.calls.map(([query]) => query);
        const txInsert = txQueries.find((query) => query?.kind === 'insert' && query.entity === 'midnight.Transactions');
        const utxoInsert = txQueries.find((query) => query?.kind === 'insert' && query.entity === 'midnight.UnshieldedUtxos');
        const nightBalanceInserts = txQueries.filter((query) => query?.kind === 'insert' && query.entity === 'midnight.NightBalances');

        expect(txInsert?.entry).toEqual(expect.objectContaining({
            txType: 'night_transfer',
            senderAddress: `0x${'11'.repeat(32)}`,
            receiverAddress: `0x${'22'.repeat(32)}`,
            nightAmount: '100'
        }));

        expect(utxoInsert?.entry).toEqual(expect.objectContaining({
            owner: `0x${'22'.repeat(32)}`,
            tokenType: '0x4e49474854',
            value: '100',
            intentHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            outputIndex: 0,
            ctime: 1_700_100_000,
            createdAtTransaction_ID: txInsert?.entry?.ID
        }));

        expect(nightBalanceInserts).toHaveLength(2);

        const receiverBalance = nightBalanceInserts.find((query) => query.entry.address === `0x${'22'.repeat(32)}`);
        expect(receiverBalance?.entry).toEqual(expect.objectContaining({
            balance: '100',
            utxoCount: 1,
            txReceivedCount: 1,
            totalReceived: '100',
            txSentCount: 0,
            totalSent: '0'
        }));

        const senderBalance = nightBalanceInserts.find((query) => query.entry.address === `0x${'11'.repeat(32)}`);
        expect(senderBalance?.entry).toEqual(expect.objectContaining({
            balance: '0',
            txSentCount: 1,
            totalSent: '100',
            txReceivedCount: 0,
            totalReceived: '0'
        }));
    });
});