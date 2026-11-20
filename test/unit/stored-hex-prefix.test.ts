/**
 * Tests for srv/crawler/stored-hex-prefix.ts against a real in-memory CAP DB:
 * hashes an older version stored with `0x` lose the prefix, everything else stays.
 */
import cds from '@sap/cds';
import { dropStoredHexPrefix } from '../../srv/crawler/stored-hex-prefix';
import { ensureIndexes } from '../../srv/utils/db-indexes';

cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TRANSACTIONS = 'midnight.Transactions';
const REORG_LOG = 'midnight.ReorgLog';
const SYNC_STATE = 'midnight.SyncState';

const hex = (pair: string) => pair.repeat(32);
const old = (pair: string) => `0x${hex(pair)}`;

let db: any;

async function seedBlock(height: number, hash: string, fields: Record<string, unknown> = {}): Promise<string> {
    const ID = cds.utils.uuid();
    await db.run(cds.ql.INSERT.into(BLOCKS).entries({ ID, hash, height, protocolVersion: 1, timestamp: 1_700_000_000 + height, ...fields }));
    return ID;
}

async function seedTransaction(blockId: string, position: number, hash: string, fields: Record<string, unknown> = {}): Promise<void> {
    await db.run(cds.ql.INSERT.into(TRANSACTIONS).entries({
        ID: cds.utils.uuid(), transactionId: position, hash, protocolVersion: 1, transactionType: 'REGULAR', block_ID: blockId, ...fields
    }));
}

async function setSync(fields: Record<string, unknown>): Promise<void> {
    await db.run(cds.ql.DELETE.from(SYNC_STATE));
    await db.run(cds.ql.INSERT.into(SYNC_STATE).entries({ ID: 'SINGLETON', syncStatus: 'syncing', ...fields }));
}

const blocks = (): Promise<any[]> => db.run(cds.ql.SELECT.from(BLOCKS).columns('height', 'hash', 'stateRoot', 'author').orderBy('height'));
const transactions = (): Promise<any[]> => db.run(cds.ql.SELECT.from(TRANSACTIONS).columns('hash', 'ledgerTxHash', 'contractAddress').orderBy('hash'));
const sync = (): Promise<any> => db.run(cds.ql.SELECT.one.from(SYNC_STATE).where({ ID: 'SINGLETON' }));

beforeAll(async () => {
    db = await cds.connect.to('db');
});

beforeEach(async () => {
    for (const entity of [TRANSACTIONS, BLOCKS, REORG_LOG]) await db.run(cds.ql.DELETE.from(entity));
    await setSync({});
});

describe('dropStoredHexPrefix', () => {
    it('rewrites the hashes the node spelling reached and nothing else', async () => {
        const first = await seedBlock(5, old('a1'), { stateRoot: old('b1'), author: old('c1') });
        // An author stored before the validator was resolved, and one not known.
        const second = await seedBlock(45_000, old('a2'), { stateRoot: old('b2'), author: 'aura:0x2001' });
        await seedBlock(45_001, old('a3'), { stateRoot: null, author: null });
        await seedTransaction(first, 0, old('d1'), { ledgerTxHash: hex('e1'), contractAddress: hex('f1') });
        await seedTransaction(second, 0, old('d2'));
        await db.run(cds.ql.INSERT.into(REORG_LOG).entries({
            ID: cds.utils.uuid(), detectedAt: new Date().toISOString(), forkHeight: 5, oldTipHash: old('a9'), newTipHash: old('a1')
        }));
        await setSync({ lastIndexedHeight: 45_001, lastIndexedHash: old('a3'), lastFinalizedHash: old('a2') });

        const report = await dropStoredHexPrefix(db);

        expect(report).toEqual({ blocks: 3, transactions: 2 });
        expect(await blocks()).toEqual([
            { height: expect.anything(), hash: hex('a1'), stateRoot: hex('b1'), author: hex('c1') },
            { height: expect.anything(), hash: hex('a2'), stateRoot: hex('b2'), author: 'aura:0x2001' },
            { height: expect.anything(), hash: hex('a3'), stateRoot: null, author: null }
        ]);
        expect(await transactions()).toEqual([
            { hash: hex('d1'), ledgerTxHash: hex('e1'), contractAddress: hex('f1') },
            { hash: hex('d2'), ledgerTxHash: null, contractAddress: null }
        ]);
        expect(await db.run(cds.ql.SELECT.one.from(REORG_LOG).columns('oldTipHash', 'newTipHash')))
            .toEqual({ oldTipHash: hex('a9'), newTipHash: hex('a1') });
        expect(await sync()).toMatchObject({ lastIndexedHash: hex('a3'), lastFinalizedHash: hex('a2') });
    });

    it('changes nothing on the second run', async () => {
        const block = await seedBlock(1, old('a1'), { stateRoot: old('b1') });
        await seedTransaction(block, 0, old('d1'));
        await setSync({ lastIndexedHeight: 1, lastIndexedHash: old('a1') });
        await dropStoredHexPrefix(db);
        const before = await db.run(cds.ql.SELECT.from(BLOCKS).columns('hash', 'modifiedAt'));

        expect(await dropStoredHexPrefix(db)).toEqual({ blocks: 0, transactions: 0 });
        expect(await db.run(cds.ql.SELECT.from(BLOCKS).columns('hash', 'modifiedAt'))).toEqual(before);
    });

    it('counts only the rows that had the prefix', async () => {
        const done = await seedBlock(1, hex('a1'));
        await seedTransaction(done, 0, hex('d1'));
        const open = await seedBlock(2, old('a2'));
        await seedTransaction(open, 0, old('d2'));
        await setSync({ lastIndexedHeight: 2, lastIndexedHash: old('a2') });

        expect(await dropStoredHexPrefix(db)).toEqual({ blocks: 1, transactions: 1 });
        expect((await blocks()).map(b => b.hash)).toEqual([hex('a1'), hex('a2')]);
        expect((await transactions()).map(t => t.hash)).toEqual([hex('d1'), hex('d2')]);
        expect((await sync()).lastIndexedHash).toBe(hex('a2'));
    });

    describe('with the secondary indexes', () => {
        const HASH_INDEX = 'ng_transactions_hash_createdat';
        const indexes = (): Promise<any[]> => db.run(
            `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND lower(tbl_name) IN ('midnight_blocks', 'midnight_transactions') ORDER BY name`
        );
        // Plain SQL the rewrite sends inside its transaction. `failOn` makes the first statement that matches throw.
        function watchTransaction(failOn?: RegExp): string[] {
            const sent: string[] = [];
            const open = db.tx.bind(db);
            vi.spyOn(db, 'tx').mockImplementation((fn: any) => open((tx: any) => {
                const run = tx.run.bind(tx);
                tx.run = (query: unknown, ...rest: unknown[]) => {
                    if (typeof query === 'string') {
                        sent.push(query.trim());
                        if (failOn?.test(query)) throw new Error('refused on purpose');
                    }
                    return run(query, ...rest);
                };
                return fn(tx);
            }));
            return sent;
        }

        beforeAll(async () => {
            await ensureIndexes(db, 'sqlite');
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('drops the index on the rewritten column on SQLite and builds it again as it was', async () => {
            const block = await seedBlock(1, old('a1'));
            await seedTransaction(block, 0, old('d1'));
            await setSync({ lastIndexedHeight: 1, lastIndexedHash: old('a1') });
            const before = await indexes();
            const sent = watchTransaction();

            expect(await dropStoredHexPrefix(db)).toEqual({ blocks: 1, transactions: 1 });

            const definition = before.find(index => index.name === HASH_INDEX).sql;
            expect(sent.slice(1)).toEqual([`DROP INDEX "${HASH_INDEX}"`, definition]);
            expect(await indexes()).toEqual(before);
            expect(before.length).toBeGreaterThan(1);
        });

        it('leaves rows and indexes as they were when a statement fails', async () => {
            const block = await seedBlock(1, old('a1'));
            await seedTransaction(block, 0, old('d1'));
            await setSync({ lastIndexedHeight: 1, lastIndexedHash: old('a1') });
            const before = await indexes();
            watchTransaction(/^\s*CREATE INDEX/);

            await expect(dropStoredHexPrefix(db)).rejects.toThrow('refused on purpose');

            expect(await indexes()).toEqual(before);
            expect((await blocks()).map(b => b.hash)).toEqual([old('a1')]);
            expect((await transactions()).map(t => t.hash)).toEqual([old('d1')]);
            expect((await sync()).lastIndexedHash).toBe(old('a1'));
        });
    });

    it('rewrites a sync state whose blocks are already done', async () => {
        await seedBlock(1, hex('a1'));
        await setSync({ lastIndexedHeight: 1, lastIndexedHash: old('a1'), lastFinalizedHash: old('a1') });

        expect(await dropStoredHexPrefix(db)).toEqual({ blocks: 0, transactions: 0 });
        expect(await sync()).toMatchObject({ lastIndexedHash: hex('a1'), lastFinalizedHash: hex('a1') });
    });

    it('rewrites all rows in one transaction on PostgreSQL, between dropping the indexes and building them again', async () => {
        const indexes = [
            { dropping: 'ALTER TABLE midnight_blocks DROP CONSTRAINT midnight_blocks_pkey', creating: 'ALTER TABLE midnight_blocks ADD CONSTRAINT midnight_blocks_pkey PRIMARY KEY (id)' },
            { dropping: 'DROP INDEX ng_transactions_block', creating: 'CREATE INDEX ng_transactions_block ON public.midnight_transactions USING btree (block_id)' }
        ];
        // A database that says the newest block has the prefix, lists two indexes and records what it is sent.
        const statements: any[] = [];
        let opened = 0;
        const fakeDb = {
            run: vi.fn().mockResolvedValueOnce({ hash: old('a1') }),
            tx: async (fn: (tx: { run: (q: unknown) => Promise<unknown> }) => Promise<void>) => {
                opened++;
                return fn({ run: async (q) => { statements.push(q); return typeof q === 'string' && q.includes('pg_constraint') ? indexes : 7; } });
            }
        };
        const kind = (cds.env.requires as any).db.kind;
        const info = vi.spyOn(cds.log('nightgate:crawler'), 'info').mockImplementation(() => {});
        try {
            (cds.env.requires as any).db.kind = 'postgres';
            expect(await dropStoredHexPrefix(fakeDb as any)).toEqual({ blocks: 7, transactions: 7 });
        } finally {
            (cds.env.requires as any).db.kind = kind;
            info.mockRestore();
        }

        expect(opened).toBe(1);
        const sent = statements.map(q => typeof q !== 'string' ? q.UPDATE.entity.ref[0]
            : q.includes('pg_constraint') ? 'read the indexes' : q.includes('maintenance_work_mem') ? 'sort memory' : q);
        expect(sent).toEqual([
            'read the indexes', indexes[0].dropping, indexes[1].dropping,
            'midnight.Transactions', 'midnight.Blocks', 'midnight.ReorgLog', 'midnight.SyncState',
            'sort memory', indexes[0].creating, indexes[1].creating
        ]);
        // One statement per table, not one per range of heights.
        expect(JSON.stringify([statements[3].UPDATE.where, statements[4].UPDATE.where])).not.toContain('height');
    });

    it('does nothing on an empty database', async () => {
        expect(await dropStoredHexPrefix(db)).toEqual({ blocks: 0, transactions: 0 });
        expect((await sync()).lastIndexedHash ?? null).toBeNull();
    });
});
