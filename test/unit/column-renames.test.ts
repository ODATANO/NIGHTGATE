/**
 * Renamed columns of an older database: which renames a schema still needs, the same renames in a stored model,
 * the start-up step that sorts values an older version kept under one name, and the one that gives stored jobs
 * and grants the current action names. The last two run against a real in-memory CAP database (cds.test boot).
 */
import cds from '@sap/cds';
import {
    CHAIN_POSITION_COLUMNS, CHAIN_POSITION_FILLS, COLUMN_RENAMES, COLUMNS_TO_TEXT, KEY_CHANGES, addToStoredModel, pendingColumnRenames, pendingDerivedColumns,
    pendingKeyChanges, pendingTextColumns, renameInStoredModel, moveKeyInStoredModel, toTextInStoredModel, viewsOfStoredModel, tableColumns
} from '../../srv/utils/db-indexes';

const cap = cds.test(__dirname + '/../..');
void cap;

const LEGACY: Record<string, string[]> = {
    midnight_Transactions: ['ID', 'transactionId', 'hash', 'ledgerTxHash', 'raw', 'circuitName'],
    midnight_TransactionIdentifiers: ['identifier', 'transaction_ID'],
    midnight_BackgroundJobs: ['ID', 'txHash', 'indexerTxHash', 'status', 'chainBlockHeight', 'chainBlockHash'],
    midnight_PendingSubmissions: ['ID', 'txHash', 'indexerTxHash', 'status', 'circuitName', 'chainBlockHeight', 'chainBlockHash'],
    midnight_Documents: ['ID', 'sha256', 'storageRef', 'compiledArtifactRef'],
    midnight_PredicateAttestations: ['ID', 'compiledArtifactRef'],
    midnight_ContractActions: ['ID', 'entryPoint', 'address'],
    midnight_ContractStates: ['address', 'height'],
    midnight_DisclosureGrants: ['ID', 'active'],
    midnight_HolderDisclosureGrants: ['ID', 'active'],
    midnight_ContractRegistrations: ['name', 'networkId'],
    midnight_SyncState: ['ID', 'networkId'],
    midnight_WalletSyncStates: ['accountId', 'networkId'],
    midnight_AgentGrants: ['ID', 'agentLabel']
};
const CURRENT: Record<string, string[]> = {
    midnight_Transactions: ['ID', 'indexInBlock', 'extrinsicHash', 'txHash', 'raw', 'circuit'],
    midnight_TransactionIdentifiers: ['txId', 'transaction_ID'],
    midnight_BackgroundJobs: ['ID', 'txId', 'txHash', 'status', 'blockHeight', 'blockHash'],
    midnight_PendingSubmissions: ['ID', 'txId', 'txHash', 'status', 'circuit', 'blockHeight', 'blockHash'],
    midnight_Documents: ['ID', 'payloadHash', 'storageRef', 'contractName'],
    midnight_PredicateAttestations: ['ID', 'contractName'],
    midnight_ContractActions: ['ID', 'circuit', 'contractAddress'],
    midnight_ContractStates: ['contractAddress', 'height'],
    midnight_DisclosureGrants: ['ID', 'isActive'],
    midnight_HolderDisclosureGrants: ['ID', 'isActive'],
    midnight_ContractRegistrations: ['name', 'network'],
    midnight_SyncState: ['ID', 'network'],
    midnight_WalletSyncStates: ['accountId', 'network'],
    midnight_AgentGrants: ['ID', 'label']
};

describe('column renames', () => {
    it('an older schema needs every rename, in the listed order', () => {
        const pending = pendingColumnRenames(table => LEGACY[table]);
        expect(pending).toEqual([...COLUMN_RENAMES]);
        const jobs = pending.filter(r => r.table === 'midnight_BackgroundJobs').map(r => `${r.from}>${r.to}`);
        expect(jobs).toEqual(['txHash>txId', 'indexerTxHash>txHash', 'chainBlockHeight>blockHeight', 'chainBlockHash>blockHash']);
    });

    it('a current schema needs none, although its tables hold a column called txHash again', () => {
        expect(pendingColumnRenames(table => CURRENT[table])).toEqual([]);
    });

    it('column names compare without case, and a missing table is left out', () => {
        const lower = (table: string) => (table === 'midnight_Transactions' ? ['id', 'transactionid', 'hash', 'ledgertxhash'] : undefined);
        expect(pendingColumnRenames(lower).map(r => r.to)).toEqual(['extrinsicHash', 'txHash', 'indexInBlock']);
    });

    it('a table renamed halfway takes only what is left', () => {
        const halfway = (table: string) => (table === 'midnight_BackgroundJobs' ? ['ID', 'txId', 'indexerTxHash'] : CURRENT[table]);
        expect(pendingColumnRenames(halfway).map(r => `${r.table}.${r.from}>${r.to}`)).toEqual(['midnight_BackgroundJobs.indexerTxHash>txHash']);
    });

    it('a stored model gets the new names in its tables, with their constraints; its views stay as stored', () => {
        const element = (name: string) => ({ type: 'cds.String', '@cds.persistence.name': name.toUpperCase() });
        const elements = (...names: string[]) => Object.fromEntries(names.map(name => [name, element(name)]));
        const csn = {
            definitions: {
                'midnight.Blocks': { elements: elements('ID', 'hash') },
                'midnight.Transactions': {
                    '@assert.unique.blockPosition': [{ '=': 'block' }, { '=': 'transactionId' }],
                    $tableConstraints: { unique: { blockPosition: { paths: [{ ref: ['block_ID'] }, { ref: ['transactionId'] }] } } },
                    elements: elements('ID', 'transactionId', 'hash', 'ledgerTxHash')
                },
                'NightgateService.Transactions': {
                    projection: { from: { ref: ['midnight.Transactions'] }, columns: [{ ref: ['Transactions_0', 'hash'] }] },
                    elements: elements('ID', 'transactionId', 'hash', 'ledgerTxHash')
                },
                'midnight.BackgroundJobs': { elements: elements('ID', 'txHash', 'indexerTxHash') }
            }
        };
        const view = JSON.stringify(csn.definitions['NightgateService.Transactions']);
        const renamed = renameInStoredModel(csn, COLUMN_RENAMES);

        const names = (name: keyof typeof csn.definitions) => Object.entries(csn.definitions[name].elements).map(([key, value]) => `${key}=${value['@cds.persistence.name']}`);
        expect(names('midnight.Transactions')).toEqual(['ID=ID', 'indexInBlock=INDEXINBLOCK', 'extrinsicHash=EXTRINSICHASH', 'txHash=TXHASH']);
        expect(names('midnight.BackgroundJobs')).toEqual(['ID=ID', 'txId=TXID', 'txHash=TXHASH']);
        expect(names('midnight.Blocks')).toEqual(['ID=ID', 'hash=HASH']);
        expect(csn.definitions['midnight.Transactions']['@assert.unique.blockPosition']).toEqual([{ '=': 'block' }, { '=': 'indexInBlock' }]);
        expect(csn.definitions['midnight.Transactions'].$tableConstraints.unique.blockPosition.paths).toEqual([{ ref: ['block_ID'] }, { ref: ['indexInBlock'] }]);
        expect(JSON.stringify(csn.definitions['NightgateService.Transactions'])).toBe(view);
        expect(renamed).toBe(5);
        expect(renameInStoredModel(csn, COLUMN_RENAMES)).toBe(0);
    });
});

describe('a key moved to another column', () => {
    const storedSessions = () => ({
        definitions: {
            'midnight.WalletSessions': {
                kind: 'entity',
                '@assert.unique.sessionId': [{ '=': 'sessionId' }],
                elements: {
                    ID: { key: true, type: 'cds.String', length: 36, '@cds.persistence.name': 'ID' },
                    userId: { type: 'cds.String', length: 200 },
                    sessionId: { type: 'cds.String', notNull: true, length: 36, '@cds.persistence.name': 'SESSIONID' }
                },
                $tableConstraints: { unique: { sessionId: { paths: [{ ref: ['sessionId'], isChecked: true }], parentTable: 'midnight.WalletSessions' } } },
                '@cds.persistence.name': 'MIDNIGHT_WALLETSESSIONS'
            },
            'midnight.AgentGrants': {
                kind: 'entity',
                '@assert.unique.tokenHash': [{ '=': 'tokenHash' }],
                elements: { ID: { key: true, type: 'cds.String' }, sessionId: { type: 'cds.String', notNull: true }, tokenHash: { type: 'cds.String' } },
                $tableConstraints: { unique: { tokenHash: { paths: [{ ref: ['tokenHash'] }] } } }
            },
            'NightgateService.WalletSessions': {
                kind: 'entity',
                projection: { from: { ref: ['midnight.WalletSessions'] } },
                elements: { ID: { key: true, type: 'cds.String' }, sessionId: { type: 'cds.String' } },
                '@cds.persistence.name': 'NIGHTGATESERVICE_WALLETSESSIONS'
            },
            'AnalyticsService.Daily': { kind: 'entity', query: { SELECT: { from: { ref: ['midnight.Blocks'] } } }, elements: {} },
            'NightgateService.connectWallet': { kind: 'action' }
        }
    });

    it('a table that still has its former key column needs the change, with any letter case', () => {
        const pending = (columns: Record<string, string[]>) => pendingKeyChanges(table => columns[table]).map(c => `${c.table}.${c.from}>${c.to}`);
        expect(pending({ midnight_WalletSessions: ['ID', 'sessionId', 'userId'] })).toEqual(['midnight_WalletSessions.ID>sessionId']);
        expect(pending({ midnight_WalletSessions: ['id', 'sessionid'] })).toEqual(['midnight_WalletSessions.ID>sessionId']);
        expect(pending({ midnight_WalletSessions: ['sessionId', 'userId'] })).toEqual([]);
        expect(pending({})).toEqual([]);
    });

    it('the current model keys every changed table by the new column and has no former key column', () => {
        for (const change of KEY_CHANGES) {
            const entity = cds.model!.definitions[change.entity] as cds.linked.classes.entity;
            expect(Object.keys(entity.keys), change.entity).toEqual([change.to]);
            expect(change.from in entity.elements, change.entity).toBe(false);
        }
    });

    it('a stored model gets the new key and loses the former key column and the unique constraint the key replaces', () => {
        const csn = storedSessions();
        const view = JSON.stringify(csn.definitions['NightgateService.WalletSessions']);
        const grants = JSON.stringify(csn.definitions['midnight.AgentGrants']);

        expect(moveKeyInStoredModel(csn, KEY_CHANGES)).toBe(1);

        const sessions: Record<string, unknown> = csn.definitions['midnight.WalletSessions'];
        expect(sessions.elements).toEqual({
            userId: { type: 'cds.String', length: 200 },
            sessionId: { key: true, type: 'cds.String', length: 36, '@cds.persistence.name': 'SESSIONID' }
        });
        expect('@assert.unique.sessionId' in sessions).toBe(false);
        expect('$tableConstraints' in sessions).toBe(false);
        expect(JSON.stringify(csn.definitions['midnight.AgentGrants'])).toBe(grants);
        expect(JSON.stringify(csn.definitions['NightgateService.WalletSessions'])).toBe(view);
        expect(moveKeyInStoredModel(csn, KEY_CHANGES)).toBe(0);
    });

    it('a unique constraint over more columns than the key stays', () => {
        const csn = storedSessions();
        const sessions: Record<string, unknown> = csn.definitions['midnight.WalletSessions'];
        sessions['@assert.unique.perUser'] = [{ '=': 'userId' }, { '=': 'sessionId' }];
        sessions.$tableConstraints = { unique: { perUser: { paths: [{ ref: ['userId'] }, { ref: ['sessionId'] }] } } };

        moveKeyInStoredModel(csn, KEY_CHANGES);

        expect(sessions['@assert.unique.perUser']).toEqual([{ '=': 'userId' }, { '=': 'sessionId' }]);
        expect(sessions.$tableConstraints).toEqual({ unique: { perUser: { paths: [{ ref: ['userId'] }, { ref: ['sessionId'] }] } } });
    });

    it('the views of a stored model are found under the names the database gives them', () => {
        expect([...viewsOfStoredModel(storedSessions())]).toEqual([
            ['nightgateservice_walletsessions', 'NightgateService.WalletSessions'],
            ['analyticsservice_daily', 'AnalyticsService.Daily']
        ]);
    });

    it('the columns of a table are read from the database, in lowercase; a missing table has none', async () => {
        const db = await cds.connect.to('db');
        const columns = await tableColumns(db, 'sqlite', 'midnight_WalletSessions');
        expect(columns).toContain('sessionid');
        expect(columns).not.toContain('id');
        expect(await tableColumns(db, 'sqlite', 'midnight_NoSuchTable')).toEqual([]);
        expect(await tableColumns(db, 'hana', 'midnight_WalletSessions')).toEqual([]);
    });
});

describe('a number column that became text', () => {
    const typed = (type: string | undefined) => pendingTextColumns(() => type).map(c => `${c.table}.${c.column}`);

    it('a column still held as a number needs the change, on either database', () => {
        expect(typed('BIGINT')).toEqual(['midnight_PredicateAttestations.threshold']);
        expect(typed('bigint')).toEqual(['midnight_PredicateAttestations.threshold']);
    });

    it('a text column and a missing table need nothing', () => {
        expect(typed('NVARCHAR(78)')).toEqual([]);
        expect(typed('character varying')).toEqual([]);
        expect(typed(undefined)).toEqual([]);
    });

    it('the current model holds every listed column as text of the listed length', () => {
        for (const change of COLUMNS_TO_TEXT) {
            const element = (cds.model!.definitions as Record<string, any>)[change.entity].elements[change.column];
            expect([change.column, element.type, element.length]).toEqual([change.column, 'cds.String', change.length]);
        }
    });

    it('a stored model gets the text type and keeps the rest of the element; a second pass changes nothing', () => {
        const csn = { definitions: { 'midnight.PredicateAttestations': { elements: {
            threshold: { type: 'cds.Integer64', '@cds.persistence.name': 'THRESHOLD' }, op: { type: 'cds.Integer' }
        } } } };
        expect(toTextInStoredModel(csn, COLUMNS_TO_TEXT)).toBe(1);
        expect(csn.definitions['midnight.PredicateAttestations'].elements).toEqual({
            threshold: { type: 'cds.String', length: 78, '@cds.persistence.name': 'THRESHOLD' }, op: { type: 'cds.Integer' }
        });
        expect(toTextInStoredModel(csn, COLUMNS_TO_TEXT)).toBe(0);
    });
});

describe('the chain position on the rows', () => {
    const OLDER: Record<string, string[]> = {
        midnight_Transactions: ['ID', 'indexInBlock', 'block_ID'],
        midnight_ContractActions: ['ID', 'actionIndex', 'transaction_ID'],
        midnight_UnshieldedUtxos: ['ID', 'outputIndex', 'createdAtTransaction_ID']
    };
    const named = (columns: readonly { table: string; column: string }[]) => columns.map(c => `${c.table}.${c.column}`);

    it('an older database lacks all five columns; a missing table needs none', () => {
        expect(named(pendingDerivedColumns(table => OLDER[table]))).toEqual(named(CHAIN_POSITION_COLUMNS));
        expect(pendingDerivedColumns(() => undefined)).toEqual([]);
        const { midnight_Transactions: _without, ...rest } = OLDER;
        expect(named(pendingDerivedColumns(table => rest[table]))).toEqual(named(CHAIN_POSITION_COLUMNS.filter(c => c.table !== 'midnight_Transactions')));
    });

    it('a database that has the columns needs none, in any letter case', () => {
        const current = (table: string) => [...OLDER[table], 'BLOCKHEIGHT', 'indexinblock'];
        expect(pendingDerivedColumns(current)).toEqual([]);
    });

    it('the current model declares every listed column with the listed type and NOT NULL', () => {
        for (const derived of CHAIN_POSITION_COLUMNS) {
            const element = (cds.model!.definitions as Record<string, any>)[derived.entity].elements[derived.column];
            expect([`${derived.entity}.${derived.column}`, element.type, element.notNull]).toEqual([`${derived.entity}.${derived.column}`, derived.type, true]);
        }
    });

    it('a stored model gets the columns as the deploy describes them; a second pass adds nothing', () => {
        const csn = { definitions: { 'midnight.Transactions': { elements: { indexInBlock: { type: 'cds.Integer', notNull: true } } } } } as any;
        expect(addToStoredModel(csn, CHAIN_POSITION_COLUMNS)).toBe(1);
        expect(csn.definitions['midnight.Transactions'].elements.blockHeight).toEqual({ type: 'cds.Integer64', notNull: true, '@cds.persistence.name': 'BLOCKHEIGHT' });
        expect(addToStoredModel(csn, CHAIN_POSITION_COLUMNS)).toBe(0);
    });

    it('the fill statements run on the current tables and leave rows that have a position alone', async () => {
        const db = await cds.connect.to('db');
        for (const fill of CHAIN_POSITION_FILLS) await expect(db.run(fill.sql)).resolves.toBeDefined();
        expect(CHAIN_POSITION_FILLS.map(f => f.table)).toEqual(['midnight_Transactions', 'midnight_ContractActions', 'midnight_UnshieldedUtxos']);
    });
});

describe('the k of a document diff stored by an older version', () => {
    const id = (n: number) => `d1000000-0000-4000-8000-00000000000${n}`;
    const OLD = '2026-01-10T10:00:00.000Z';

    it('moves from threshold to its own column and leaves every other proof alone', async () => {
        const db = await cds.connect.to('db');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { moveStoredDiffCounts } = require('../../srv/submission/job-store');
        const { INSERT, SELECT, DELETE } = cds.ql;
        await db.run(DELETE.from('midnight.PredicateAttestations'));
        const row = (n: number, predicate: string, threshold: string | null, k: number | null) => ({
            ID: id(n), payloadHash: 'aa', contractAddress: 'cc', predicate, threshold, k, createdAt: OLD, modifiedAt: OLD
        });
        await db.run(INSERT.into('midnight.PredicateAttestations').entries([
            row(1, 'documentDiff', '3', null), row(2, 'greaterOrEqual', '50000', null), row(3, 'documentDiff', null, 4), row(4, 'bytesEquality', null, null)
        ]));

        expect(await moveStoredDiffCounts(db)).toBe(1);
        expect(await moveStoredDiffCounts(db)).toBe(0);

        const rows: Array<Record<string, unknown>> = await db.run(SELECT.from('midnight.PredicateAttestations').columns('ID', 'threshold', 'k', 'modifiedAt').orderBy('ID'));
        expect(rows.map(r => [r.threshold, r.k])).toEqual([[null, 3], ['50000', null], [null, 4], [null, null]]);
        // Moving a value between columns is no change a reader should see.
        expect(rows[0].modifiedAt).toBe(OLD);
        await db.run(DELETE.from('midnight.PredicateAttestations'));
    });
});

describe('values stored by an older version', () => {
    const HASH_A = 'a1'.repeat(32);
    const HASH_B = 'b2'.repeat(32);
    const HASH_C = 'c3'.repeat(32);
    const ID_A = `00${'d4'.repeat(32)}`;
    const ID_B = `00${'e5'.repeat(32)}`;
    const ID_C = `00${'f6'.repeat(32)}`;
    const ID_UNKNOWN = `00${'07'.repeat(32)}`;
    const OLD = '2026-01-10T10:00:00.000Z';
    const id = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;
    let db: any;
    let sortStoredTxValues: (db: unknown) => Promise<number>;

    beforeAll(async () => {
        db = await cds.connect.to('db');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ({ sortStoredTxValues } = require('../../srv/submission/job-store'));
    });

    it('a ledger hash kept as the identifier moves to txHash; an identifier kept as evidence becomes the hash a job or the index knows', async () => {
        const { INSERT, SELECT, DELETE } = cds.ql;
        for (const entity of ['midnight.BackgroundJobs', 'midnight.PendingSubmissions', 'midnight.Documents', 'midnight.SwapOffers',
            'midnight.TransactionIdentifiers', 'midnight.Transactions', 'midnight.Blocks']) await db.run(DELETE.from(entity));

        const job = (n: number, txId: string | null, txHash: string | null) => ({
            ID: id(n), kind: 'submitContractCall', status: 'succeeded', txId, txHash, createdAt: OLD, modifiedAt: OLD
        });
        await db.run(INSERT.into('midnight.BackgroundJobs').entries([
            job(1, HASH_A, null), job(2, HASH_B, HASH_C), job(3, ID_A, HASH_A), job(4, ID_B, null), job(5, null, null)
        ]));
        await db.run(INSERT.into('midnight.PendingSubmissions').entries([
            { ID: id(1), txId: HASH_A, txHash: null, actionType: 'CALL', submittedAt: OLD, status: 'finalized', createdAt: OLD, modifiedAt: OLD },
            { ID: id(2), txId: ID_A, txHash: null, actionType: 'CALL', submittedAt: OLD, status: 'pending', createdAt: OLD, modifiedAt: OLD }
        ]));
        // The index knows ID_C, a job knows ID_A.
        await db.run(INSERT.into('midnight.Blocks').entries({ ID: id(7), hash: 'aa'.repeat(32), height: 5, protocolVersion: 1, timestamp: 1700000000 }));
        await db.run(INSERT.into('midnight.Transactions').entries({
            ID: id(8), blockHeight: 5, indexInBlock: 0, extrinsicHash: 'bb'.repeat(32), txHash: HASH_B, protocolVersion: 1, transactionType: 'REGULAR', block_ID: id(7)
        }));
        await db.run(INSERT.into('midnight.TransactionIdentifiers').entries({ txId: ID_C, transaction_ID: id(8) }));

        const doc = (n: number, anchoredTxHash: string | null) => ({ ID: id(n), payloadHash: String(n).repeat(64), anchoredTxHash, createdAt: OLD, modifiedAt: OLD });
        await db.run(INSERT.into('midnight.Documents').entries([doc(1, ID_A), doc(2, ID_UNKNOWN), doc(3, HASH_C), doc(4, null)]));
        await db.run(INSERT.into('midnight.SwapOffers').entries({
            ID: id(1), offer: 'AA==', givesType: 'ab'.repeat(32), givesAmount: '1', wantsType: 'cd'.repeat(32), wantsAmount: '2', bound: true,
            nullifiers: '[]', status: 'filled', posterUserId: 'someone', filledTxHash: ID_C, createdAt: OLD, modifiedAt: OLD
        }));

        // Two jobs, one submission, one document and one offer change.
        expect(await sortStoredTxValues(db)).toBe(5);

        const jobs = Object.fromEntries((await db.run(SELECT.from('midnight.BackgroundJobs').columns('ID', 'txId', 'txHash', 'modifiedAt')))
            .map((r: any) => [r.ID.slice(-1), [r.txId, r.txHash, r.modifiedAt]]));
        expect(jobs).toEqual({
            1: [null, HASH_A, OLD], 2: [null, HASH_C, OLD], 3: [ID_A, HASH_A, OLD], 4: [ID_B, null, OLD], 5: [null, null, OLD]
        });
        const submissions = Object.fromEntries((await db.run(SELECT.from('midnight.PendingSubmissions').columns('ID', 'txId', 'txHash')))
            .map((r: any) => [r.ID.slice(-1), [r.txId, r.txHash]]));
        expect(submissions).toEqual({ 1: [null, HASH_A], 2: [ID_A, null] });
        const docs = Object.fromEntries((await db.run(SELECT.from('midnight.Documents').columns('ID', 'anchoredTxHash', 'modifiedAt')))
            .map((r: any) => [r.ID.slice(-1), [r.anchoredTxHash, r.modifiedAt]]));
        expect(docs).toEqual({ 1: [HASH_A, OLD], 2: [ID_UNKNOWN, OLD], 3: [HASH_C, OLD], 4: [null, OLD] });
        const offer = await db.run(SELECT.one.from('midnight.SwapOffers').columns('filledTxHash', 'modifiedAt').where({ ID: id(1) }));
        expect([offer.filledTxHash, offer.modifiedAt]).toEqual([HASH_B, OLD]);

        expect(await sortStoredTxValues(db)).toBe(0);
        for (const entity of ['midnight.BackgroundJobs', 'midnight.PendingSubmissions', 'midnight.Documents', 'midnight.SwapOffers',
            'midnight.TransactionIdentifiers', 'midnight.Transactions', 'midnight.Blocks']) await db.run(DELETE.from(entity));
    });
});

describe('error codes stored by an older version', () => {
    const id = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
    const OLD = '2026-01-10T10:00:00.000Z';

    it('take the current names; a code outside the table becomes UNKNOWN_ERROR with the code in the message', async () => {
        const db = await cds.connect.to('db');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { renameStoredErrorCodes, RENAMED_JOB_CODES } = require('../../srv/submission/job-store');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isJobErrorCode } = require('../../srv/utils/errors');
        expect(Object.values(RENAMED_JOB_CODES).every(isJobErrorCode)).toBe(true);

        const { INSERT, SELECT, DELETE } = cds.ql;
        await db.run(DELETE.from('midnight.BackgroundJobs'));
        await db.run(DELETE.from('midnight.PendingSubmissions'));
        const job = (n: number, errorCode: string | null, errorMessage: string | null) => ({
            ID: id(n), kind: 'callContract', status: 'failed', errorCode, errorMessage, createdAt: OLD, modifiedAt: OLD
        });
        await db.run(INSERT.into('midnight.BackgroundJobs').entries([
            job(1, 'TxFailed', 'failed on chain'), job(2, 'SponsorPolicyRefused', 'not allowed'), job(3, 'OnChainStatus:FailEntirely', 'status'),
            job(4, 'TypeError', 'x is not a function'), job(5, 'CoercionError', null), job(6, '1010/104', 'stale'), job(7, 'CHAIN_EXECUTION_FAILED', 'call'),
            job(8, 'WALLET_NOT_SYNCED', 'not synced'), job(0, null, null)
        ]));
        await db.run(INSERT.into('midnight.PendingSubmissions').entries({
            ID: id(9), sessionId: id(0), actionType: 'CALL', submittedAt: OLD, status: 'failed', errorCode: 'NetworkOrTimeout', errorMessage: 'socket'
        }));

        expect(await renameStoredErrorCodes(db)).toBe(6);
        expect(await renameStoredErrorCodes(db)).toBe(0);

        const jobs: Array<Record<string, unknown>> = await db.run(SELECT.from('midnight.BackgroundJobs').columns('errorCode', 'errorMessage', 'modifiedAt').orderBy('ID'));
        // A code of the table stays, also one not made for jobs.
        expect(jobs.map(j => [j.errorCode, j.errorMessage])).toEqual([
            [null, null],
            ['TX_FAILED', 'failed on chain'], ['SPONSOR_REFUSED', 'not allowed'], ['TX_FAILED', 'status'],
            ['UNKNOWN_ERROR', 'TypeError: x is not a function'], ['UNKNOWN_ERROR', 'CoercionError: '], ['1010/104', 'stale'], ['CHAIN_EXECUTION_FAILED', 'call'],
            ['WALLET_NOT_SYNCED', 'not synced']
        ]);
        expect(jobs.every(j => j.modifiedAt === OLD)).toBe(true);
        const attempt = await db.run(SELECT.one.from('midnight.PendingSubmissions').columns('errorCode').where({ ID: id(9) }));
        expect(attempt.errorCode).toBe('NETWORK_OR_TIMEOUT');
        await db.run(DELETE.from('midnight.BackgroundJobs'));
        await db.run(DELETE.from('midnight.PendingSubmissions'));
    });
});

describe('stored action names', () => {
    const OLD = '2026-01-10T10:00:00.000Z';
    const id = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
    let db: any;
    let renameStoredActions: (db: unknown) => Promise<number>;

    beforeAll(async () => {
        db = await cds.connect.to('db');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        ({ renameStoredActions } = require('../../srv/submission/job-store'));
    });

    it('every former name leads to a job kind or an action the model has', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { RENAMED_ACTIONS, RENAMED_JOB_KINDS, JOB_KINDS } = require('../../srv/submission/job-kinds');
        const operations = Object.keys((cds.model as any).definitions)
            .filter(name => name.startsWith('NightgateService.') || name.startsWith('NightgateVerifyService.'))
            .map(name => name.split('.').pop());
        for (const [from, to] of Object.entries(RENAMED_ACTIONS)) {
            expect(operations, from).not.toContain(from);
            expect(operations, `${from} -> ${to}`).toContain(to);
        }
        for (const [from, to] of Object.entries(RENAMED_JOB_KINDS)) {
            expect(JOB_KINDS[from], from).toBeUndefined();
            expect(JOB_KINDS[to as string] !== undefined || operations.includes(to as string), `${from} -> ${to}`).toBe(true);
        }
    });

    it('jobs and grants take the current names, a retract job the name of the action its mode says', async () => {
        const { INSERT, SELECT, DELETE } = cds.ql;
        for (const entity of ['midnight.BackgroundJobs', 'midnight.AgentGrants']) await db.run(DELETE.from(entity));

        const job = (n: number, kind: string, request: string | null = null) => ({
            ID: id(n), kind, status: 'succeeded', request, createdAt: OLD, modifiedAt: OLD
        });
        await db.run(INSERT.into('midnight.BackgroundJobs').entries([
            job(1, 'issueFieldPredicateAttestationBatch'), job(2, 'registerPassport'), job(3, 'buildSponsorableTx'),
            job(4, 'retract', JSON.stringify({ mode: 1, key: 'ab' })), job(5, 'retract', JSON.stringify({ mode: 0, key: 'cd' })),
            job(6, 'retract', 'not json'), job(7, 'sponsorUnbound'), job(8, 'fieldPredicateProof')
        ]));
        const grant = (n: number, actions: string[]) => ({
            ID: id(n), userId: 'someone', sessionId: id(9), tokenHash: String(n).repeat(64), allowedActions: JSON.stringify(actions),
            createdAt: OLD, modifiedAt: OLD
        });
        await db.run(INSERT.into('midnight.AgentGrants').entries([
            grant(1, ['sponsorUnboundTransaction', 'sponsorFinalizedTransaction', 'sponsorSwap']),
            grant(2, ['issueFieldPredicateAttestation', 'proveFieldPredicate', 'anchorDocument']),
            grant(3, ['sponsorSwap', 'sponsorTransfer'])
        ]));

        // Six jobs and two grants change.
        expect(await renameStoredActions(db)).toBe(8);

        const jobs = Object.fromEntries((await db.run(SELECT.from('midnight.BackgroundJobs').columns('ID', 'kind', 'modifiedAt')))
            .map((r: any) => [r.ID.slice(-1), r.kind]));
        expect(jobs).toEqual({
            1: 'proveClaims', 2: 'registerDocument', 3: 'buildSponsorable', 4: 'purgeExpired', 5: 'retractAttestation',
            6: 'retractAttestation', 7: 'sponsorUnbound', 8: 'fieldPredicateProof'
        });
        const grants = Object.fromEntries((await db.run(SELECT.from('midnight.AgentGrants').columns('ID', 'allowedActions', 'modifiedAt')))
            .map((r: any) => [r.ID.slice(-1), [JSON.parse(r.allowedActions), r.modifiedAt]]));
        expect(grants).toEqual({
            1: [['sponsorUnbound', 'sponsorFinalized', 'sponsorSwap'], OLD],
            2: [['proveFieldPredicate', 'anchorDocument'], OLD],
            3: [['sponsorSwap', 'sponsorTransfer'], OLD]
        });

        expect(await renameStoredActions(db)).toBe(0);
        for (const entity of ['midnight.BackgroundJobs', 'midnight.AgentGrants']) await db.run(DELETE.from(entity));
    });
});
