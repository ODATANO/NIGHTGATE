/**
 * The fee sum of a grant's usage finds the transaction of a job by its
 * ledger hash or by one of its identifiers, and counts each transaction
 * once. Runs against a real in-memory database.
 */
import cds from '@sap/cds';
import { sumIndexedFees } from '../../srv/sessions/agent-grants';
import type { DbRunner } from '../../srv/utils/db-types';

cds.test(__dirname + '/../..');

const hex = (pair: string) => pair.repeat(32);
const EXTRINSIC = [hex('e1'), hex('e2'), hex('e3')];
const LEDGER = [hex('d1'), hex('d2'), hex('d3')];
const IDENTIFIER = hex('1d');

describe('sumIndexedFees', () => {
    let db: DbRunner;

    beforeAll(async () => {
        db = await cds.connect.to('db') as unknown as DbRunner;
        const { INSERT, DELETE } = cds.ql;
        for (const entity of ['TransactionFees', 'TransactionIdentifiers', 'Transactions', 'Blocks']) {
            await db.run(DELETE.from(`midnight.${entity}`));
        }
        const blockId = cds.utils.uuid();
        await db.run(INSERT.into('midnight.Blocks').entries({
            ID: blockId, hash: hex('b0'), height: 1, protocolVersion: 1, timestamp: 1_700_000_000, author: hex('a0')
        }));
        const fees = [['100'], ['50'], ['7', '3']];
        for (const [i, paid] of fees.entries()) {
            const ID = cds.utils.uuid();
            await db.run(INSERT.into('midnight.Transactions').entries({
                ID, blockHeight: 1, indexInBlock: i, extrinsicHash: EXTRINSIC[i], txHash: LEDGER[i], protocolVersion: 1, transactionType: 'REGULAR', block_ID: blockId
            }));
            for (const paidFees of paid) {
                await db.run(INSERT.into('midnight.TransactionFees').entries({ ID: cds.utils.uuid(), paidFees, estimatedFees: paidFees, transaction_ID: ID }));
            }
            if (i === 2) await db.run(INSERT.into('midnight.TransactionIdentifiers').entries({ txId: IDENTIFIER, transaction_ID: ID }));
        }
    });

    test.each([
        ['the ledger hash', [LEDGER[1]], [], '50'],
        ['an identifier', [], [IDENTIFIER], '10'],
        ['hashes and an identifier', [LEDGER[0], LEDGER[1]], [IDENTIFIER], '160'],
        ['a hash nothing has', [hex('ff')], [], '0'],
        ['nothing', [], [], '0']
    ])('finds the fee by %s', async (_name, txHashes, txIds, total) => {
        expect(await sumIndexedFees(db, txHashes, txIds)).toBe(total);
    });

    test('an extrinsic hash names no transaction of a job', async () => {
        expect(await sumIndexedFees(db, [EXTRINSIC[0]], [EXTRINSIC[0]])).toBe('0');
    });

    test('counts a transaction once when a job names it by hash and by identifier', async () => {
        expect(await sumIndexedFees(db, [LEDGER[2]], [IDENTIFIER])).toBe('10');
    });

    test('counts a transaction once across two chunks of hashes', async () => {
        const filler = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(64, '0'));
        expect(await sumIndexedFees(db, [LEDGER[0], ...filler, LEDGER[0]])).toBe('100');
    });
});
