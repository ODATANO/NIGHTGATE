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

    it('is a no-op on HANA (its deployer owns indexes)', async () => {
        const run = vi.fn();
        expect(await ensureIndexes({ run }, 'hana')).toBe(0);
        expect(run).not.toHaveBeenCalled();
    });

    it('emits dialect-neutral DDL', () => {
        expect(indexStatement({ name: 'x', table: 't', columns: ['a', 'b'] })).toBe('CREATE INDEX IF NOT EXISTS x ON t (a, b)');
    });
});
