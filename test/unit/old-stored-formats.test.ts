/**
 * The start-up check for stored rows in formats this version does not read (`srv/utils/old-stored-formats.ts`),
 * against the real in-memory database.
 */

import cds from '@sap/cds';
import { findOldStoredFormats } from '../../srv/utils/old-stored-formats';

cds.test(__dirname + '/../..');

const TABLES = ['midnight.WalletSessions', 'midnight.PrivateStates', 'midnight.ContractActions'];

describe('old stored formats', () => {
    let db: any;
    const { INSERT, DELETE } = cds.ql;

    beforeAll(async () => { db = await cds.connect.to('db'); });
    beforeEach(async () => {
        for (const table of TABLES) await db.run(DELETE.from(table));
    });

    it('a database in the current formats has none', async () => {
        await db.run(INSERT.into('midnight.WalletSessions').entries({ sessionId: 's1', connectedAt: new Date().toISOString(), encryptedViewingKey: 'v3:1:aa:bb:cc' }));
        await db.run(INSERT.into('midnight.PrivateStates').entries({ accountId: 'a1', contractAddress: 'c1', privateStateId: 'p', ciphertext: 'x', keyScheme: 'dek1' }));
        expect(await findOldStoredFormats(db, 'sqlite')).toEqual([]);
    });

    it('counts every old format with its fix', async () => {
        const now = new Date().toISOString();
        await db.run(INSERT.into('midnight.WalletSessions').entries([
            { sessionId: 's1', connectedAt: now, encryptedViewingKey: 'v3:1:aa:bb:cc', encryptedSeedKey: 'v2:1:aa:bb:cc' },
            { sessionId: 's2', connectedAt: now, encryptedViewingKey: 'aa:bb:cc' }
        ]));
        await db.run(INSERT.into('midnight.PrivateStates').entries([
            { accountId: 'a1', contractAddress: 'c1', privateStateId: 'p', ciphertext: 'x', keyScheme: null },
            { accountId: 'a1', contractAddress: '0xC2', privateStateId: 'p', ciphertext: 'x', keyScheme: 'dek1' }
        ]));
        await db.run(INSERT.into('midnight.ContractActions').entries([
            { ID: cds.utils.uuid(), blockHeight: 5, indexInBlock: 0, actionIndex: 0, actionType: 'CALL', transaction_ID: cds.utils.uuid(), state: Buffer.from('aa', 'hex') },
            { ID: cds.utils.uuid(), blockHeight: 6, indexInBlock: 0, actionIndex: 0, actionType: 'CALL', transaction_ID: cds.utils.uuid(), state: Buffer.from('bb', 'hex'), stateHash: 'ab' }
        ]));

        const found = await findOldStoredFormats(db, 'sqlite');
        expect(found.map(f => [f.name, f.rows])).toEqual([
            ['account-key-scheme', 1], ['unbound-envelope', 2], ['contract-address-spelling', 1], ['per-action-contract-state', 1]
        ]);
        expect(found.every(f => f.fix.length > 0)).toBe(true);
    });
});
