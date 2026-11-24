/**
 * Secondary indexes (srv/utils/db-indexes.ts): every statement applies to the
 * real in-memory CAP SQLite schema, twice (idempotent), and the columns it
 * names exist. A renamed column or association would fail here, not at boot.
 */

import cds from '@sap/cds';
import { NIGHTGATE_INDEXES, ensureIndexes, indexStatement } from '../../srv/utils/db-indexes';

cds.test(__dirname + '/../..');

describe('db-indexes', () => {
    let db: any;
    beforeAll(async () => { db = await cds.connect.to('db'); });

    it('creates every index on the deployed schema and is idempotent', async () => {
        const warnings: string[] = [];
        const first = await ensureIndexes(db, 'sqlite', m => warnings.push(m));
        expect(warnings).toEqual([]);
        expect(first).toBe(NIGHTGATE_INDEXES.length);
        const again = await ensureIndexes(db, 'sqlite', m => warnings.push(m));
        expect(again).toBe(NIGHTGATE_INDEXES.length);
        expect(warnings).toEqual([]);
        const names = (await db.run("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ng_%'")).map((r: any) => r.name).sort();
        expect(names).toEqual(NIGHTGATE_INDEXES.map(i => i.name).sort());
    });

    it('the createdAt index of ContractActions gives way to the position index', async () => {
        await db.run('DROP INDEX IF EXISTS ng_contractactions_address_position');
        await db.run('CREATE INDEX IF NOT EXISTS ng_contractactions_address_createdat ON midnight_ContractActions (contractAddress, createdAt)');
        await ensureIndexes(db, 'sqlite');
        const names = (await db.run("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ng_contractactions_address%'")).map((r: any) => r.name);
        expect(names).toEqual(['ng_contractactions_address_position']);
    });

    it('the index of the unspent UTXOs holds only those rows', async () => {
        const [index] = await db.run("SELECT sql FROM sqlite_master WHERE type='index' AND name = 'ng_unshieldedutxos_unspent_position'");
        expect(index.sql).toMatch(/\(blockHeight DESC, indexInBlock DESC, outputIndex DESC\) WHERE spentAtTransaction_ID IS NULL$/);
    });

    it('no index sorts a chain table by its insert time, and every position index ends in the order of the chain', () => {
        const chain = NIGHTGATE_INDEXES.filter(i => ['midnight_Transactions', 'midnight_ContractActions', 'midnight_UnshieldedUtxos'].includes(i.table));
        expect(chain.filter(i => i.columns.some(c => /^createdAt( |$)/i.test(c))).map(i => i.name)).toEqual([]);
        const own: Record<string, string[]> = { midnight_Transactions: [], midnight_ContractActions: ['actionIndex DESC'], midnight_UnshieldedUtxos: ['outputIndex DESC'] };
        const positions = chain.filter(i => i.name.endsWith('_position'));
        expect(positions).toHaveLength(8);
        for (const index of positions) {
            const order = ['blockHeight DESC', 'indexInBlock DESC', ...own[index.table]];
            expect(index.columns.slice(-order.length), index.name).toEqual(order);
            // The columns are NOT NULL, so PostgreSQL needs no NULLS clause to read the index in both directions.
            expect(index.postgres, index.name).toBeUndefined();
        }
    });

    it('keeps the plain index and warns when duplicates refuse the unique one', async () => {
        const warnings: string[] = [];
        const run = vi.fn(async (q: unknown) => {
            if (String(q).includes('ng_blocks_height_unique')) throw new Error('UNIQUE constraint failed');
        });
        await ensureIndexes({ run }, 'sqlite', m => warnings.push(m));
        expect(run.mock.calls.map((c: any[]) => String(c[0]))).not.toContain('DROP INDEX IF EXISTS ng_blocks_height');
        expect(warnings.join('; ')).toContain('duplicate height values in midnight_Blocks');
    });

    it('is a no-op on HANA (its deployer owns indexes)', async () => {
        const run = vi.fn();
        expect(await ensureIndexes({ run }, 'hana')).toBe(0);
        expect(run).not.toHaveBeenCalled();
    });

    it('emits dialect-neutral DDL', () => {
        expect(indexStatement({ name: 'x', table: 't', columns: ['a', 'b'] })).toBe('CREATE INDEX IF NOT EXISTS x ON t (a, b)');
        expect(indexStatement({ name: 'x', table: 't', columns: ['a', 'b'] }, 'postgres')).toBe('CREATE INDEX IF NOT EXISTS x ON t (a, b)');
        expect(indexStatement({ name: 'x', table: 't', columns: ['a'], unique: true })).toBe('CREATE UNIQUE INDEX IF NOT EXISTS x ON t (a)');
        expect(indexStatement({ name: 'x', table: 't', columns: ['a'], where: 'b IS NULL' })).toBe('CREATE INDEX IF NOT EXISTS x ON t (a) WHERE b IS NULL');
    });

    it('uses the PostgreSQL spelling only there', () => {
        const spec = { name: 'x', table: 't', columns: ['a DESC'], postgres: 'a DESC NULLS LAST' };
        expect(indexStatement(spec, 'postgres')).toBe('CREATE INDEX IF NOT EXISTS x ON t (a DESC NULLS LAST)');
        expect(indexStatement(spec, 'sqlite')).toBe('CREATE INDEX IF NOT EXISTS x ON t (a DESC)');
        expect(indexStatement(spec)).toBe('CREATE INDEX IF NOT EXISTS x ON t (a DESC)');
    });

    it('passes the db kind through to every statement', async () => {
        const run = vi.fn(async () => undefined);
        await ensureIndexes({ run }, 'postgres');
        const ddl = run.mock.calls.map((c: any[]) => String(c[0]));
        expect(ddl).toContain('CREATE INDEX IF NOT EXISTS ng_blocks_createdat_desc ON midnight_Blocks (createdAt DESC NULLS LAST)');
        expect(ddl).toContain('CREATE INDEX IF NOT EXISTS ng_transactions_position ON midnight_Transactions (blockHeight DESC, indexInBlock DESC)');
        expect(ddl.some((s: string) => s.includes('NULLS') && !s.includes('DESC'))).toBe(false);
    });
});
