/**
 * A read of a large chain table filters and sorts by indexed columns only, so
 * the database never reads the whole table for it. Runs against the booted
 * services and a real in-memory database.
 */
import cds from '@sap/cds';
import { indexedColumns, unindexedReason, whereUsesIndex } from '../../srv/utils/indexed-reads';

const cap = cds.test(__dirname + '/../..') as any;

const API = '/odata/v4/midnight';
const ANALYTICS = '/odata/v4/midnight-analytics';
const ANY = { validateStatus: () => true };

const get = (path: string) => cap.axios.get(path, ANY);
const read = (entity: string, options: string) => get(`${API}/${entity}?${options}`);

let blockId: string;

beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { INSERT, DELETE } = cds.ql;
    for (const entity of ['ContractActions', 'TransactionIdentifiers', 'Transactions', 'Blocks']) await db.run(DELETE.from(`midnight.${entity}`));
    blockId = cds.utils.uuid();
    await db.run(INSERT.into('midnight.Blocks').entries({ ID: blockId, hash: 'ab'.repeat(32), height: 7, protocolVersion: 1, timestamp: 1_700_000_000 }));
    await db.run(INSERT.into('midnight.Transactions').entries({
        ID: cds.utils.uuid(), blockHeight: 7, indexInBlock: 0, extrinsicHash: '1a'.repeat(32), txHash: '2b'.repeat(32), protocolVersion: 1,
        transactionType: 'REGULAR', txType: 'system', size: 10, block_ID: blockId
    }));
});

describe('the indexed columns of a table', () => {
    test('are the key, the unique constraints and the first column of each index', () => {
        const columns = indexedColumns(cds.model!.definitions['midnight.Transactions'] as cds.entity);
        expect([...columns].sort()).toEqual(['block_id', 'blockheight', 'extrinsichash', 'id', 'receiveraddress', 'senderaddress', 'txhash', 'txtype']);
    });

    test('leave out a partial index', () => {
        const columns = indexedColumns(cds.model!.definitions['midnight.UnshieldedUtxos'] as cds.entity);
        expect(columns.has('blockheight')).toBe(false);
    });
});

describe('a filter', () => {
    const indexed = new Set(['height', 'hash']);
    const ref = (name: string) => ({ ref: [name] });
    const val = (v: unknown) => ({ val: v });

    test.each([
        ['one indexed condition', [ref('height'), '=', val(1)]],
        ['an indexed condition next to another', [ref('timestamp'), '>', val(1), 'and', ref('height'), '>=', val(1)]],
        ['every branch of an or indexed', [ref('hash'), '=', val('a'), 'or', ref('height'), '=', val(1)]],
        ['an indexed group', [{ xpr: [ref('height'), '<', val(5)] }, 'and', ref('timestamp'), '=', val(1)]],
        ['a list', [ref('height'), 'in', { list: [val(1), val(2)] }]]
    ])('uses an index with %s', (_name, where) => {
        expect(whereUsesIndex(where as never, indexed)).toBe(true);
    });

    test.each([
        ['a column without an index', [ref('timestamp'), '=', val(1)]],
        ['an or with one branch unindexed', [ref('height'), '=', val(1), 'or', ref('timestamp'), '=', val(1)]],
        ['not equal', [ref('height'), '!=', val(1)]],
        ['a negation', ['not', { xpr: [ref('height'), '=', val(1)] }]],
        ['a function', [{ func: 'contains', args: [ref('hash'), val('a')] }]]
    ])('reads the whole table with %s', (_name, where) => {
        expect(whereUsesIndex(where as never, indexed)).toBe(false);
    });

    test('along a key or an association is narrowed by its path', () => {
        const from = { ref: [{ id: 'NightgateService.Blocks', where: [ref('ID'), '=', val('x')] }, 'transactions'] };
        expect(unindexedReason({ SELECT: { from, where: [ref('size'), '>', val(0)] as never } }, indexed)).toBeNull();
    });
});

describe('a read of a large table', () => {
    test.each([
        ['an indexed filter and sort', 'Transactions', "$filter=txType eq 'system'&$orderby=blockHeight desc,indexInBlock desc"],
        ['the documented height range', 'Blocks', '$filter=height ge 1 and height le 9&$orderby=height'],
        ['an indexed condition next to another', 'Transactions', "$filter=blockHeight eq 7 and size gt 1"],
        ['a hash in either column', 'Transactions', `$filter=extrinsicHash eq '${'1a'.repeat(32)}' or txHash eq '${'1a'.repeat(32)}'`],
        ['a count without a filter', 'Transactions', '$count=true&$top=1'],
        ['no filter and no sort', 'TransactionFees', '$top=5'],
        ['a deploy lookup of the client', 'ContractActions', `$filter=contractAddress eq '${'ab'.repeat(32)}' and actionType eq 'DEPLOY'`]
    ])('answers with %s', async (_name, entity, options) => {
        const r = await read(entity, options);
        expect(r.status, JSON.stringify(r.data)).toBe(200);
    });

    test('answers along a navigation with any filter', async () => {
        const r = await get(`${API}/Blocks(${blockId})/transactions?$filter=size gt 1&$orderby=size`);
        expect(r.status, JSON.stringify(r.data)).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });

    test.each([
        ['a filter on a column without an index', 'Transactions', '$filter=size gt 1', /\$filter needs/],
        ['an or with an unindexed branch', 'Transactions', '$filter=blockHeight eq 7 or size gt 1', /\$filter needs/],
        ['a substring search', 'Transactions', "$filter=contains(senderAddress,'x')", /\$filter needs/],
        ['a sort by a column without an index', 'Transactions', '$orderby=size desc', /\$orderby must start/],
        ['a sort that starts with the second index column', 'ContractActions', '$orderby=indexInBlock', /\$orderby must start/],
        ['a filter on results without the transaction', 'TransactionResults', "$filter=status eq 'SUCCESS'", /\$filter needs/],
        ['a filter on dust events by type', 'DustLedgerEvents', "$filter=eventType eq 'INITIAL_UTXO'", /\$filter needs/]
    ])('is refused with %s', async (_name, entity, options, reason) => {
        const r = await read(entity, options);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe('QUERY_NOT_INDEXED');
        expect(r.data.error.message).toMatch(reason);
        expect(r.data.error.message).toMatch(/Indexed columns: .*ID/);
    });

    test('of the block statistics is checked against the blocks table', async () => {
        expect((await get(`${ANALYTICS}/BlockStatistics?$orderby=height desc`)).status).toBe(200);
        const refused = await get(`${ANALYTICS}/BlockStatistics?$filter=timestamp gt 0`);
        expect(refused.status).toBe(400);
        expect(refused.data.error.code).toBe('QUERY_NOT_INDEXED');
    });
});
