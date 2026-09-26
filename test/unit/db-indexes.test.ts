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

    it('a unique index replaces the plain one it supersedes', async () => {
        await db.run('DROP INDEX IF EXISTS ng_blocks_height_unique');
        await db.run('CREATE INDEX IF NOT EXISTS ng_blocks_height ON midnight_Blocks (height)');
        await ensureIndexes(db, 'sqlite');
        const names = (await db.run("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ng_blocks_height%'")).map((r: any) => r.name);
        expect(names).toEqual(['ng_blocks_height_unique']);
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
        expect(ddl).toContain('CREATE INDEX IF NOT EXISTS ng_transactions_createdat_desc ON midnight_Transactions (createdAt DESC NULLS LAST)');
        expect(ddl.some((s: string) => s.includes('NULLS') && !s.includes('createdAt'))).toBe(false);
    });
});
