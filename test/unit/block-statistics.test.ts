/**
 * BlockStatistics on a booted server: the per-block transaction count and the
 * default page, against the real SQL view.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const cap = cds.test(__dirname + '/../..');

const BLOCKS = 'midnight.Blocks';
const TXS = 'midnight.Transactions';

const block = (n: number) => ({
    ID: cds.utils.uuid(), hash: n.toString(16).padStart(64, '0'), height: n, protocolVersion: 1, timestamp: 1_700_000_000 + n
});
const tx = (blockId: string, n: number) => ({
    ID: cds.utils.uuid(), block_ID: blockId, transactionId: n, hash: cds.utils.uuid().replace(/-/g, '').padEnd(64, '0'),
    protocolVersion: 1, transactionType: 'REGULAR'
});

describe('BlockStatistics', () => {
    const blocks = Array.from({ length: 105 }, (_, i) => block(i + 1));

    beforeAll(async () => {
        const db = await cds.connect.to('db');
        await db.run(cds.ql.DELETE.from(TXS));
        await db.run(cds.ql.DELETE.from(BLOCKS));
        await db.run(cds.ql.INSERT.into(BLOCKS).entries(blocks));
        await db.run(cds.ql.INSERT.into(TXS).entries([tx(blocks[1].ID, 0), tx(blocks[1].ID, 1), tx(blocks[2].ID, 0)]));
    });

    it('counts the transactions of each block, zero included', async () => {
        const { data } = await cap.GET('/api/v1/analytics/BlockStatistics?$filter=height le 3&$orderby=height asc');
        expect(data.value.map((r: any) => [Number(r.height), r.transactionCount])).toEqual([[1, 0], [2, 2], [3, 1]]);
    });

    it('answers one page by default and links the next', async () => {
        const { data } = await cap.GET('/api/v1/analytics/BlockStatistics?$orderby=height desc');
        expect(data.value).toHaveLength(100);
        expect(Number(data.value[0].height)).toBe(105);
        expect(data['@odata.nextLink']).toBeTruthy();
    });
});
