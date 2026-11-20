/**
 * Hex is stored lowercase without `0x`. A read finds a stored value by either
 * spelling and letter case, an action or function takes its hex parameters the
 * same way, and a value that is not hex is refused. Runs against the booted
 * services and a real in-memory database.
 */
import cds from '@sap/cds';
import { normalizeHexParams } from '../../srv/utils/hex-input';
import { deriveAccountId } from '../../srv/submission/wallet-material-factory';

const cap = cds.test(__dirname + '/../..') as any;

const API = '/odata/v4/midnight';
const INDEXER = '/odata/v4/midnight-indexer';
const ADMIN = '/odata/v4/midnight-admin';
const ANY = { validateStatus: () => true };

const hex = (pair: string) => pair.repeat(32);
const BLOCK_HASH = hex('ab');
const AUTHOR = hex('cd');
const TX_HASH = hex('1a');
const LEDGER_HASH = hex('2b');
const CONTRACT = hex('3c');
const TOKEN_TYPE = hex('4d');
const IDENTIFIER = hex('5e');
const TIP = hex('6f');

/** The spellings a caller may send for one stored value. */
const SPELLINGS = (stored: string): Array<[string, string]> => [
    ['as stored', stored],
    ['with 0x', `0x${stored}`],
    ['uppercase with 0X', `0X${stored.toUpperCase()}`]
];

const filter = (entity: string, expression: string, rest = '') =>
    cap.axios.get(`${API}/${entity}?$filter=${encodeURIComponent(expression)}${rest}`, ANY);

let blockId: string;
let txId: string;

beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { INSERT, DELETE } = cds.ql;
    for (const entity of ['ContractStates', 'ContractActions', 'TransactionIdentifiers', 'Transactions', 'Blocks', 'ReorgLog', 'LearnedTokenTypes']) {
        await db.run(DELETE.from(`midnight.${entity}`));
    }
    blockId = cds.utils.uuid();
    txId = cds.utils.uuid();
    await db.run(INSERT.into('midnight.Blocks').entries({
        ID: blockId, hash: BLOCK_HASH, height: 7, protocolVersion: 1, timestamp: 1_700_000_000, author: AUTHOR
    }));
    await db.run(INSERT.into('midnight.Transactions').entries({
        ID: txId, transactionId: 0, hash: TX_HASH, ledgerTxHash: LEDGER_HASH, protocolVersion: 1,
        transactionType: 'REGULAR', circuitName: '0xAB', contractAddress: CONTRACT, block_ID: blockId
    }));
    await db.run(INSERT.into('midnight.TransactionIdentifiers').entries({ identifier: IDENTIFIER, transaction_ID: txId }));
    await db.run(INSERT.into('midnight.ContractActions').entries({
        ID: cds.utils.uuid(), actionIndex: 0, address: CONTRACT, actionType: 'CALL', transaction_ID: txId
    }));
    await db.run(INSERT.into('midnight.ContractStates').entries({ address: CONTRACT, height: 7 }));
    await db.run(INSERT.into('midnight.ReorgLog').entries({
        ID: cds.utils.uuid(), detectedAt: new Date().toISOString(), forkHeight: 7, oldTipHash: TIP, newTipHash: BLOCK_HASH
    }));
    await db.run(INSERT.into('midnight.LearnedTokenTypes').entries({ tokenType: TOKEN_TYPE }));
});

describe('a filter finds a stored hex value in either spelling', () => {
    test.each(SPELLINGS(BLOCK_HASH))('eq, %s', async (_name, value) => {
        const r = await filter('Blocks', `hash eq '${value}'`);
        expect(r.status).toBe(200);
        expect(r.data.value.map((b: { hash: string }) => b.hash)).toEqual([BLOCK_HASH]);
    });

    test.each([
        ['the operand left of the operator', 'Blocks', `'0x${BLOCK_HASH.toUpperCase()}' eq hash`],
        ['a second hex field', 'Blocks', `author eq '0x${AUTHOR}'`],
        ['a list', 'Blocks', `hash in ('0x${BLOCK_HASH}','0x${TIP}')`],
        ['a negated group', 'Blocks', `not (hash ne '0x${BLOCK_HASH}')`],
        ['startswith', 'Blocks', `startswith(hash,'0xABAB')`],
        ['contains', 'Blocks', `contains(hash,'ABAB')`],
        ['a field behind an association', 'Transactions', `block/hash eq '0x${BLOCK_HASH}'`],
        ['a field inside any()', 'Blocks', `transactions/any(t:t/hash eq '0x${TX_HASH.toUpperCase()}')`],
        ['the ledger hash', 'Transactions', `ledgerTxHash eq '0x${LEDGER_HASH}'`],
        ['a contract address', 'Transactions', `contractAddress eq '0x${CONTRACT.toUpperCase()}'`]
    ])('%s', async (_name, entity, expression) => {
        const r = await filter(entity, expression);
        expect(r.status).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });

    test('a filter inside $expand', async () => {
        const r = await cap.axios.get(
            `${API}/Blocks?$expand=transactions($filter=${encodeURIComponent(`hash eq '0x${TX_HASH.toUpperCase()}'`)})`, ANY
        );
        expect(r.status).toBe(200);
        expect(r.data.value[0].transactions.map((t: { hash: string }) => t.hash)).toEqual([TX_HASH]);
    });

    test.each(SPELLINGS(CONTRACT))('a key, %s', async (_name, value) => {
        const r = await cap.axios.get(`${API}/ContractStates('${value}')`, ANY);
        expect(r.status).toBe(200);
        expect(r.data.address).toBe(CONTRACT);
    });

    test('a filter after a key', async () => {
        const r = await cap.axios.get(
            `${API}/Blocks(${blockId})/transactions?$filter=${encodeURIComponent(`hash eq '0x${TX_HASH}'`)}`, ANY
        );
        expect(r.status).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });

    test('the indexer service', async () => {
        const r = await cap.axios.get(`${INDEXER}/ReorgLog?$filter=${encodeURIComponent(`oldTipHash eq '0x${TIP.toUpperCase()}'`)}`, ANY);
        expect(r.status).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });

    test('the admin service', async () => {
        const r = await cap.axios.get(`${ADMIN}/LearnedTokenTypes('0x${TOKEN_TYPE.toUpperCase()}')`, ANY);
        expect(r.status).toBe(200);
        expect(r.data.tokenType).toBe(TOKEN_TYPE);
    });
});

describe('an operand that is not hex', () => {
    test.each([
        ['eq', `hash eq 'not-hex'`],
        ['one item of a list', `hash in ('0x${BLOCK_HASH}','0xzz')`],
        ['startswith', `startswith(hash,'0xg')`]
    ])('is refused in %s', async (_name, expression) => {
        const r = await filter('Blocks', expression);
        expect(r.status).toBe(400);
        expect(r.data.error.message).toBe('hash must be hex');
    });

    test('is left alone on a field that is not hex', async () => {
        const r = await filter('Transactions', `circuitName eq '0xAB'`);
        expect(r.status).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });

    test('null still compares', async () => {
        const r = await filter('Blocks', 'stateRoot eq null');
        expect(r.status).toBe(200);
        expect(r.data.value).toHaveLength(1);
    });
});

describe('the read functions take either spelling', () => {
    test.each([...SPELLINGS(TX_HASH), ...SPELLINGS(LEDGER_HASH)])('byHash, %s', async (_name, value) => {
        const r = await cap.axios.get(`${API}/Transactions/byHash(hash='${value}')`, ANY);
        expect(r.status).toBe(200);
        expect(r.data.value.map((t: { ID: string }) => t.ID)).toEqual([txId]);
    });

    test.each(SPELLINGS(CONTRACT))('byAddress and history, %s', async (_name, value) => {
        for (const fn of ['byAddress', 'history']) {
            const r = await cap.axios.get(`${API}/ContractActions/${fn}(address='${value}')`, ANY);
            expect(r.status).toBe(200);
            expect(r.data.value).toHaveLength(1);
        }
    });

    test.each(SPELLINGS(IDENTIFIER))('byIdentifier, %s', async (_name, value) => {
        const r = await cap.axios.get(`${API}/Transactions/byIdentifier(identifier='${value}')`, ANY);
        expect(r.status).toBe(200);
        expect(r.data).toMatchObject({ identifier: IDENTIFIER, hash: TX_HASH, ledgerTxHash: LEDGER_HASH, blockHash: BLOCK_HASH });
    });

    test.each([
        ['byHash', `Transactions/byHash(hash='0xnot-hex')`, 'hash'],
        ['ledgerTransaction', `Transactions/ledgerTransaction(hash='zz')`, 'hash'],
        ['byIdentifier', `Transactions/byIdentifier(identifier='not-hex')`, 'identifier'],
        ['byAddress', `ContractActions/byAddress(address='0xcontract-1')`, 'address'],
        ['stateAt', `ContractStates/stateAt(address='mn_addr_x',height=null)`, 'address']
    ])('%s refuses a value that is not hex', async (_name, path, target) => {
        const r = await cap.axios.get(`${API}/${path}`, ANY);
        expect(r.status).toBe(400);
        expect(r.data.error).toMatchObject({ code: 'ASSERT_FORMAT', target });
    });
});

describe('the hex parameters of an action or function take either spelling', () => {
    const X = (pair: string) => `0X${hex(pair).toUpperCase()}`;
    const SESSION = '00000000-0000-4000-8000-000000000001';
    const post = (action: string, body: object) => cap.axios.post(`${API}/${action}`, body, ANY);

    test.each(SPELLINGS(CONTRACT))('a contract address, %s', async (_name, value) => {
        const r = await cap.axios.get(`${API}/deriveTokenType(contractAddress='${value}')`, ANY);
        expect(r.status).toBe(200);
        expect(r.data.contractAddress).toBe(CONTRACT);
    });

    test('a seed', async () => {
        const seed = 'ab'.repeat(64);
        const stored = await post('deriveWalletInfo', { seedHex: seed });
        const spelled = await post('deriveWalletInfo', { seedHex: `0X${seed.toUpperCase()}` });
        expect(stored.status).toBe(200);
        expect(spelled.data.viewingKey).toBe(stored.data.viewingKey);
    });

    // The account of a wallet is derived from the text of its viewing key, so the server must not change that text.
    test('a viewing key is taken exactly as sent', async () => {
        const sent = hex('9e').toUpperCase();
        expect((await post('connectWallet', { viewingKey: sent })).status).toBe(200);
        const db = await cds.connect.to('db');
        const accounts = (id: string) => db.run(cds.ql.SELECT.from('midnight.AccountKeys').columns('accountId').where({ accountId: id }));
        expect(await accounts(deriveAccountId(sent))).toHaveLength(1);
        expect(await accounts(deriveAccountId(sent.toLowerCase()))).toHaveLength(0);

        const prefixed = await post('connectWallet', { viewingKey: `0x${sent}` });
        expect(prefixed.status).toBe(400);
        expect(prefixed.data.error.message).toBe('viewingKey must be hex-encoded');
    });

    // Each handler below refuses a 64-character value with `0x` itself. Past that check it stops at the unknown session.
    test.each([
        ['a list', 'issueFieldPredicateAttestation', (h: (pair: string) => string) => ({
            payloadHash: h('a1'), fieldKey: h('b2'), value: '1', fieldSalt: h('c3'), threshold: 5, predicate: 'lessOrEqual',
            siblings: [h('01'), h('02'), h('03'), h('04')], dirs: [true, false, true, false]
        })],
        ['a list inside a list of structures', 'issueFieldPredicateAttestationBatch', (h: (pair: string) => string) => ({
            payloadHash: h('a1'),
            claims: [{
                predicate: 'lessOrEqual', fieldKey: h('b2'), value: '1', salt: h('c3'), threshold: 5,
                siblings: [h('01'), h('02'), h('03'), h('04')], dirs: [true, false, true, false]
            }]
        })],
        ['a structure', 'issueDocumentIntegrityAttestation', (h: (pair: string) => string) => {
            const slots = Array.from({ length: 16 }, () => ({ present: true, value: '1', valueDigest: h('e5') }));
            return {
                payloadHashA: h('a1'), payloadHashB: h('b2'), allowedMask: 1,
                schema: Array.from({ length: 16 }, () => ({ fieldKey: h('f6'), kind: 0, scale: '0' })),
                openingA: { saltSeed: h('07'), slots }, openingB: { saltSeed: h('08'), slots }
            };
        }]
    ])('%s reaches the handler in the stored spelling', async (_name, action, body) => {
        const stored = await post(action, { ...body(hex), sessionId: SESSION, contractAddress: CONTRACT });
        const spelled = await post(action, { ...body(X), sessionId: SESSION, contractAddress: X('3c') });
        expect(stored.status).not.toBe(400);
        expect(spelled.status).toBe(stored.status);
        expect(spelled.data.error).toEqual(stored.data.error);
    });

    test.each([
        ['a 64-character parameter', 'issueFieldPredicateAttestation', { payloadHash: `0x${'a'.repeat(63)}` }, 'payloadHash', 'must be 64 hex characters'],
        ['a seed', 'deriveWalletInfo', { seedHex: 'zz' }, 'seedHex', 'must be 128 hex characters'],
        ['a contract address', 'submitContractCall', { contractAddress: '0xVAULT', circuit: 'c' }, 'contractAddress', 'must be hex']
    ])('%s that is not hex is refused', async (_name, action, body, target, message) => {
        const r = await post(action, body);
        expect(r.status).toBe(400);
        expect(r.data.error).toMatchObject({ code: 'ASSERT_FORMAT', target, message });
    });
});

describe('normalizeHexParams', () => {
    const operation = (name: string) => (cds.services.NightgateService as any).actions[name];
    const UPPER = `0X${hex('ab').toUpperCase()}`;
    const BARE = hex('ab');

    test('rewrites a value, a list and the fields of structures, however deep', () => {
        const data = {
            payloadHash: UPPER,
            contractAddress: '0xAB',
            claims: [{ fieldKey: UPPER, siblings: [UPPER, BARE], schema: [{ fieldKey: UPPER }], openingA: { saltSeed: UPPER, slots: [{ valueDigest: UPPER }] } }]
        };
        normalizeHexParams(data, operation('issueFieldPredicateAttestationBatch'));
        expect(data).toEqual({
            payloadHash: BARE,
            contractAddress: 'ab',
            claims: [{ fieldKey: BARE, siblings: [BARE, BARE], schema: [{ fieldKey: BARE }], openingA: { saltSeed: BARE, slots: [{ valueDigest: BARE }] } }]
        });
    });

    test('leaves everything else as it is', () => {
        const data = {
            idempotencyKey: '0xKEY', compiledArtifactRef: '0xRef', validUntil: 5, payloadHash: null,
            claims: [{ value: '0xAB', predicate: '0xP', siblings: [7, null], dirs: [true], unknown: UPPER }, null, 'text']
        };
        const before = structuredClone(data);
        normalizeHexParams(data, operation('issueFieldPredicateAttestationBatch'));
        expect(data).toEqual(before);
    });

    test('every list of hex values in the model carries the mark', async () => {
        const unmarked: string[] = [];
        const walk = (node: unknown, path: string): void => {
            if (!node || typeof node !== 'object') return;
            const def = node as { items?: { type?: unknown }; '@nightgate.hex'?: boolean };
            if (['Hex64', 'HexEncoded'].includes(String(def.items?.type)) && !def['@nightgate.hex']) unmarked.push(path);
            for (const [key, child] of Object.entries(node)) walk(child, `${path}/${key}`);
        };
        walk((await cds.load('*')).definitions, '');
        expect(unmarked).toEqual([]);
    });
});
