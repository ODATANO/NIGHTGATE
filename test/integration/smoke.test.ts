/**
 * Harness smoke test: cds.test() boots the NIGHTGATE plugin against an
 * in-memory SQLite DB, deploys the schema, and serves the OData services,
 * with the crawler + wallet worker skipped via SKIP_AUTO_INIT (vitest.setup.ts).
 */
import cds from '@sap/cds';

const test = cds.test(__dirname + '/../..');

describe('cds.test harness boots', () => {
    it('serves NightgateService.Blocks against the in-memory DB (empty)', async () => {
        const { status, data } = await test.get('/api/v1/nightgate/Blocks');
        expect(status).toBe(200);
        expect(Array.isArray(data.value)).toBe(true);
        expect(data.value).toHaveLength(0);
    });

    it('can INSERT + SELECT a Block row through the real db service', async () => {
        const { INSERT, SELECT } = cds.ql;
        const db = await cds.connect.to('db');
        await db.run(INSERT.into('midnight.Blocks').entries({
            ID: cds.utils.uuid(),
            hash: '0x' + 'ab'.repeat(32),
            height: 42,
            protocolVersion: 1,
            timestamp: 1_700_000_000,
            stateRoot: '0x' + '00'.repeat(8)
        }));
        const row = await db.run(SELECT.one.from('midnight.Blocks').where({ height: 42 }));
        expect(row?.hash).toBe('0x' + 'ab'.repeat(32));
    });
});
