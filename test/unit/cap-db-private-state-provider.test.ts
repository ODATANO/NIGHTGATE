/**
 * Tests for srv/midnight/CapDbPrivateStateProvider.
 *
 * Uses an in-memory fake DB that implements the subset of cds.db.run() calls
 * the provider makes (SELECT.one / SELECT / INSERT / UPDATE / DELETE on
 * midnight.PrivateStates and midnight.ContractSigningKeys). This keeps the
 * suite hermetic and fast, no SQLite spin-up needed.
 */

import crypto from 'node:crypto';
import { decryptWithPassword, StorageEncryption } from '../../srv/utils/storage-encryption';
import {
    CapDbPrivateStateProvider,
    privateStateStableSalt,
    ExportDecryptionError,
    InvalidExportFormatError,
    ImportConflictError
} from '../../srv/midnight/CapDbPrivateStateProvider';
import { HEX64_ANY_CASE_RE } from '../../srv/utils/hex-patterns';

// ---- In-memory fake CAP DB --------------------------------------------------

interface Row { [k: string]: any }

function makeFakeDb() {
    const tables: Record<string, Row[]> = {
        'midnight.PrivateStates': [],
        'midnight.ContractSigningKeys': []
    };

    function matchRow(row: Row, where: Row): boolean {
        return Object.keys(where).every(k => row[k] === where[k]);
    }

    return {
        tables,
        run: vi.fn(async (q: any) => {
            // CQN-ish shape from cds.ql operators; we read it through duck typing.
            const cqn = q.cqn || q;

            if (cqn.SELECT) {
                const entity = cqn.SELECT.from.ref?.[0] || cqn.SELECT.from;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.SELECT.where);
                const filtered = where ? rows.filter(r => matchRow(r, where)) : rows;
                if (cqn.SELECT.one) return filtered[0] ?? null;
                return filtered;
            }
            if (cqn.INSERT) {
                const entity = cqn.INSERT.into.ref?.[0] || cqn.INSERT.into;
                const entries = Array.isArray(cqn.INSERT.entries) ? cqn.INSERT.entries : [cqn.INSERT.entries];
                (tables[entity] ??= []).push(...entries);
                return entries.length;
            }
            if (cqn.UPDATE) {
                const entity = cqn.UPDATE.entity.ref?.[0] || cqn.UPDATE.entity;
                const rows = tables[entity] || [];
                const where = whereFromCqn(cqn.UPDATE.where);
                let count = 0;
                for (const r of rows) {
                    if (!where || matchRow(r, where)) {
                        Object.assign(r, cqn.UPDATE.data);
                        count++;
                    }
                }
                return count;
            }
            if (cqn.DELETE) {
                const entity = cqn.DELETE.from.ref?.[0] || cqn.DELETE.from;
                const where = whereFromCqn(cqn.DELETE.where);
                const before = tables[entity]?.length ?? 0;
                tables[entity] = (tables[entity] || []).filter(r => where ? !matchRow(r, where) : false);
                return before - tables[entity].length;
            }
            throw new Error(`unsupported query: ${JSON.stringify(cqn)}`);
        })
    };
}

// Parses `cds.ql` where clauses ({ key: value, ... } objects under .where)
// into a flat key→value map. cds.ql produces an array of tokens; we walk it.
function whereFromCqn(where: any): Row | null {
    if (!where) return null;
    if (Array.isArray(where)) {
        const out: Row = {};
        for (let i = 0; i < where.length; i++) {
            const t = where[i];
            if (t?.ref && where[i + 1] === '=' && where[i + 2]?.val !== undefined) {
                out[t.ref[0]] = where[i + 2].val;
            }
        }
        return out;
    }
    return where;
}

const PASSWORD = 'a-test-passphrase-of-sufficient-length';
const ACCOUNT  = 'addr_test1q...accountA';
const ACCOUNT_B = 'addr_test1q...accountB';
const CONTRACT = 'aa'.repeat(32);
const CONTRACT_B = 'bb'.repeat(32);
const sk = (n: number) => ({ tag: 'schnorr' as const, value: n.toString(16).padStart(64, '0') });
const EXPORT_PASSWORD = 'export-pass-of-sufficient-length';

function newProvider(accountId = ACCOUNT, db = makeFakeDb()) {
    const provider = new CapDbPrivateStateProvider({
        accountId,
        privateStoragePasswordProvider: () => PASSWORD,
        db
    });
    return { provider, db };
}

// ---- Tests -----------------------------------------------------------------

describe('CapDbPrivateStateProvider: the account password', () => {
    test('every write marks the row dek1', async () => {
        const { provider, db } = newProvider();
        await provider.forContract(CONTRACT).set('ps-1', { v: 1 });
        await provider.setSigningKey(CONTRACT, sk(1));
        expect(db.tables['midnight.PrivateStates'][0].keyScheme).toBe('dek1');
        expect(db.tables['midnight.ContractSigningKeys'][0].keyScheme).toBe('dek1');
    });

    test('a row under another password does not open', async () => {
        const { provider: old, db } = newProvider();
        await old.forContract(CONTRACT).set('ps-1', { v: 1 });
        const current = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD + '-rotated', db });
        await expect(current.forContract(CONTRACT).get('ps-1')).rejects.toThrow(/Salt mismatch/);
    });
});

describe('CapDbPrivateStateProvider: CRUD', () => {
    test('set + get round-trips a JSON-serializable state', async () => {
        const { provider } = newProvider();
        await provider.forContract(CONTRACT).set('counter', { value: 42 });
        const got = await provider.forContract(CONTRACT).get('counter');
        expect(got).toEqual({ value: 42 });
    });

    // The provider runs on the server thread, once per submission. A synchronous key derivation there stalls every request.
    test('the storage key is derived off the event loop', async () => {
        const sync = vi.spyOn(crypto, 'pbkdf2Sync');
        try {
            const { provider } = newProvider();
            await provider.forContract(CONTRACT).set('counter', { value: 1 });
            expect(await provider.forContract(CONTRACT).get('counter')).toEqual({ value: 1 });
            expect(sync).not.toHaveBeenCalled();
        } finally {
            sync.mockRestore();
        }
    });

    test('get returns null for unknown id', async () => {
        const { provider } = newProvider();
        expect(await provider.forContract(CONTRACT).get('does-not-exist')).toBeNull();
    });

    test('set on an existing id overwrites (no duplicate row)', async () => {
        const { provider, db } = newProvider();
        await provider.forContract(CONTRACT).set('counter', { value: 1 });
        await provider.forContract(CONTRACT).set('counter', { value: 2 });
        expect(await provider.forContract(CONTRACT).get('counter')).toEqual({ value: 2 });
        const rows = (db.tables['midnight.PrivateStates'] || []).filter(r => r.privateStateId === 'counter');
        expect(rows.length).toBe(1);
    });

    test('remove deletes the state', async () => {
        const { provider } = newProvider();
        await provider.forContract(CONTRACT).set('counter', { value: 1 });
        await provider.forContract(CONTRACT).remove('counter');
        expect(await provider.forContract(CONTRACT).get('counter')).toBeNull();
    });

    test('clear removes the private states of the current contract only', async () => {
        const { provider, db } = newProvider();
        await provider.forContract(CONTRACT).set('a', { x: 1 });
        await provider.forContract(CONTRACT_B).set('b', { y: 2 });
        await provider.forContract(CONTRACT_B).clear();
        const left = db.tables['midnight.PrivateStates'].filter(r => r.accountId === ACCOUNT);
        expect(left.map(r => r.privateStateId)).toEqual(['a']);
        expect(await provider.forContract(CONTRACT).get('a')).toEqual({ x: 1 });
    });

    test('forContract refuses an empty contract address', () => {
        const { provider } = newProvider();
        expect(() => provider.forContract('')).toThrow(/must not be empty/);
    });

    test('clearAll removes the private states of every contract of the account', async () => {
        const { provider, db } = newProvider();
        await provider.forContract(CONTRACT).set('a', { x: 1 });
        await provider.forContract(CONTRACT_B).set('b', { y: 2 });
        await provider.clearAll();
        expect(db.tables['midnight.PrivateStates'].filter(r => r.accountId === ACCOUNT)).toEqual([]);
    });
});

describe('CapDbPrivateStateProvider: account isolation', () => {
    test('account B cannot read account A keys (same DB)', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await a.forContract(CONTRACT).set('alice-key', { v: 'alice' });
        expect(await b.forContract(CONTRACT).get('alice-key')).toBeNull();
    });

    test('clear is account-scoped: A.clear() leaves B intact', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await a.forContract(CONTRACT).set('k', { v: 1 });
        await b.forContract(CONTRACT).set('k', { v: 2 });
        await a.forContract(CONTRACT).clear();
        expect(await b.forContract(CONTRACT).get('k')).toEqual({ v: 2 });
    });
});

describe('CapDbPrivateStateProvider: signing keys', () => {
    test('a row holding a bare hex key reads as a Schnorr key', async () => {
        const { provider, db } = newProvider();
        await provider.setSigningKey(CONTRACT, sk(1));
        const enc = new StorageEncryption(PASSWORD, privateStateStableSalt(ACCOUNT, PASSWORD));
        db.tables['midnight.ContractSigningKeys'][0].ciphertext = enc.encrypt('ab'.repeat(32));
        expect(await provider.getSigningKey(CONTRACT)).toEqual({ tag: 'schnorr', value: 'ab'.repeat(32) });
    });

    test('set + get signing key round-trip', async () => {
        const { provider } = newProvider();
        await provider.setSigningKey(CONTRACT, sk(3));
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(3));
    });

    test('setSigningKey overwrites', async () => {
        const { provider, db } = newProvider();
        await provider.setSigningKey(CONTRACT, sk(4));
        await provider.setSigningKey(CONTRACT, sk(5));
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(5));
        expect(db.tables['midnight.ContractSigningKeys'].length).toBe(1);
    });

    test('removeSigningKey + clearSigningKeys', async () => {
        const { provider } = newProvider();
        await provider.setSigningKey(CONTRACT, sk(6));
        await provider.setSigningKey(CONTRACT_B, sk(7));
        await provider.removeSigningKey(CONTRACT);
        expect(await provider.getSigningKey(CONTRACT)).toBeNull();
        expect(await provider.getSigningKey(CONTRACT_B)).toEqual(sk(7));
        await provider.clearSigningKeys();
        expect(await provider.getSigningKey(CONTRACT_B)).toBeNull();
    });
});

describe('CapDbPrivateStateProvider: export / import', () => {
    test('exportPrivateStates produces SDK-format blob', async () => {
        const { provider } = newProvider();
        await provider.forContract(CONTRACT).set('a', { v: 1 });
        await provider.forContract(CONTRACT).set('b', { v: 2 });

        const exported = await provider.forContract(CONTRACT).exportPrivateStates();
        expect(exported.format).toBe('midnight-private-state-export');
        expect(exported.encryptedPayload).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(exported.salt).toMatch(HEX64_ANY_CASE_RE);
    });

    test('export → import round-trip into a fresh provider (different account)', async () => {
        // Export from A
        const sourceDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sourceDb });
        await a.forContract(CONTRACT).set('a', { v: 1 });
        await a.forContract(CONTRACT).set('b', { v: 2 });
        const exported = await a.forContract(CONTRACT).exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        // Import into B (fresh DB, fresh password)
        const targetDb = makeFakeDb();
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'b-pass-of-sufficient-length', db: targetDb });
        const result = await b.forContract(CONTRACT).importPrivateStates(exported, { password: 'export-pass-of-sufficient-length' });
        expect(result).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await b.forContract(CONTRACT).get('a')).toEqual({ v: 1 });
        expect(await b.forContract(CONTRACT).get('b')).toEqual({ v: 2 });
    });

    test('import with wrong password → ExportDecryptionError', async () => {
        const { provider } = newProvider();
        await provider.forContract(CONTRACT).set('a', { v: 1 });
        const exported = await provider.forContract(CONTRACT).exportPrivateStates({ password: 'correct-pass-of-sufficient-length' });
        // fresh provider, same contract address
        const targetDb = makeFakeDb();
        const fresh = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'unused-pass-of-sufficient-length', db: targetDb });
        await expect(fresh.forContract(CONTRACT).importPrivateStates(exported, { password: 'wrong-pass-of-sufficient-length' }))
            .rejects.toBeInstanceOf(ExportDecryptionError);
    });

    test('import with conflictStrategy=error throws ImportConflictError on overlap', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await a.forContract(CONTRACT).set('a', { v: 1 });
        const exported = await a.forContract(CONTRACT).exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        // import back into same account/contract, every id will conflict
        await expect(a.forContract(CONTRACT).importPrivateStates(exported, { password: 'export-pass-of-sufficient-length' }))
            .rejects.toBeInstanceOf(ImportConflictError);
    });

    test('import with conflictStrategy=skip preserves existing values', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await a.forContract(CONTRACT).set('a', { v: 1 });
        const exported = await a.forContract(CONTRACT).exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        await a.forContract(CONTRACT).set('a', { v: 'newer' }); // existing differs from export
        const result = await a.forContract(CONTRACT).importPrivateStates(exported, { password: 'export-pass-of-sufficient-length', conflictStrategy: 'skip' });
        expect(result).toEqual({ imported: 0, skipped: 1, overwritten: 0 });
        expect(await a.forContract(CONTRACT).get('a')).toEqual({ v: 'newer' });
    });

    test('import with conflictStrategy=overwrite replaces existing values', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await a.forContract(CONTRACT).set('a', { v: 'original' });
        const exported = await a.forContract(CONTRACT).exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        await a.forContract(CONTRACT).set('a', { v: 'newer' });
        const result = await a.forContract(CONTRACT).importPrivateStates(exported, { password: 'export-pass-of-sufficient-length', conflictStrategy: 'overwrite' });
        expect(result).toEqual({ imported: 0, skipped: 0, overwritten: 1 });
        expect(await a.forContract(CONTRACT).get('a')).toEqual({ v: 'original' });
    });

    test('rejects export blob with wrong format identifier', async () => {
        const { provider } = newProvider();
        await expect(provider.forContract(CONTRACT).importPrivateStates(
            { format: 'something-else' as any, encryptedPayload: 'AAA', salt: '00'.repeat(32) }
        )).rejects.toBeInstanceOf(InvalidExportFormatError);
    });

    test('rejects export blob with invalid salt format', async () => {
        const { provider } = newProvider();
        await expect(provider.forContract(CONTRACT).importPrivateStates(
            { format: 'midnight-private-state-export', encryptedPayload: 'AAA', salt: 'not-hex' }
        )).rejects.toBeInstanceOf(InvalidExportFormatError);
    });

    test('a state with a big integer and bytes survives storing, and plain JSON from an older version still reads', async () => {
        const { provider, db } = newProvider();
        const state = { counter: 2n ** 70n, secret: new Uint8Array([1, 2, 255]), raw: Buffer.from('abcd', 'hex'), nested: { when: new Date(0), tags: new Set(['a']) } };
        await provider.forContract(CONTRACT).set('rich', state);
        const back = await provider.forContract(CONTRACT).get('rich') as typeof state;
        expect(back.counter).toBe(2n ** 70n);
        expect(back.secret).toBeInstanceOf(Uint8Array);
        expect([...back.secret]).toEqual([1, 2, 255]);
        expect(Buffer.isBuffer(back.raw)).toBe(true);
        expect(back.raw.toString('hex')).toBe('abcd');
        expect(back.nested.when).toEqual(new Date(0));
        expect([...back.nested.tags]).toEqual(['a']);

        // A row written before: plain JSON without the marker.
        const enc = new StorageEncryption(PASSWORD, privateStateStableSalt(ACCOUNT, PASSWORD));
        db.tables['midnight.PrivateStates'].push({ ...db.tables['midnight.PrivateStates'][0], privateStateId: 'older', ciphertext: enc.encrypt(JSON.stringify({ v: 7, json: 'not a marker' })) });
        expect(await provider.forContract(CONTRACT).get('older')).toEqual({ v: 7, json: 'not a marker' });
    });

    test('the address is stored in lowercase hex without 0x, so every spelling reaches the same rows', async () => {
        const { provider } = newProvider();
        await provider.forContract('0x' + CONTRACT.toUpperCase()).set('a', { n: 1 });
        await provider.setSigningKey('0x' + CONTRACT.toUpperCase(), sk(1));
        expect(provider.forContract('0x' + CONTRACT.toUpperCase()).contractAddress).toBe(CONTRACT);
        expect(await provider.forContract(CONTRACT).get('a')).toEqual({ n: 1 });
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(1));
    });

    test('an export holds what midnight-js writes: each state as the serializer\'s text, each key as an object', async () => {
        const { provider } = newProvider();
        await provider.forContract(CONTRACT).set('a', { n: 5n });
        await provider.setSigningKey(CONTRACT, sk(1));
        const open = (blob: { encryptedPayload: string }) => JSON.parse(decryptWithPassword(blob.encryptedPayload, EXPORT_PASSWORD));

        const states = open(await provider.forContract(CONTRACT).exportPrivateStates({ password: EXPORT_PASSWORD }));
        expect(states).toMatchObject({ version: 1, stateCount: 1, exportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
        expect(typeof states.states.a).toBe('string');
        expect(JSON.parse(states.states.a)).toEqual({ json: { n: '5' }, meta: { values: { n: ['bigint'] }, v: 1 } });

        const keys = open(await provider.exportSigningKeys({ password: EXPORT_PASSWORD }));
        expect(keys).toMatchObject({ version: 1, keyCount: 1, keys: { [CONTRACT]: sk(1) } });
    });

    test('imports what midnight-js exports, and what an older version of this store exported', async () => {
        const seal = (format: string, payload: object) => {
            const enc = new StorageEncryption(EXPORT_PASSWORD);
            return { format, encryptedPayload: enc.encrypt(JSON.stringify(payload)), salt: enc.salt.toString('hex') } as never;
        };
        const { provider } = newProvider();
        const fromSdk = seal('midnight-private-state-export', { version: 1, exportedAt: '2026-11-01T00:00:00.000Z', stateCount: 2, states: { big: '{"json":{"n":"9"},"meta":{"values":{"n":["bigint"]}}}', plain: '{"json":{"v":1}}' } });
        expect(await provider.forContract(CONTRACT).importPrivateStates(fromSdk, { password: EXPORT_PASSWORD })).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await provider.forContract(CONTRACT).get('big')).toEqual({ n: 9n });
        expect(await provider.forContract(CONTRACT).get('plain')).toEqual({ v: 1 });

        // An older export has no time and holds each state itself, also a state that is a string.
        const older = seal('midnight-private-state-export', { version: 1, stateCount: 2, states: { old: { v: 3 }, text: 'a plain string' } });
        expect(await provider.forContract(CONTRACT_B).importPrivateStates(older, { password: EXPORT_PASSWORD })).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await provider.forContract(CONTRACT_B).get('old')).toEqual({ v: 3 });
        expect(await provider.forContract(CONTRACT_B).get('text')).toBe('a plain string');

        // Text that is no serializer output stops the import before anything is written.
        const broken = seal('midnight-private-state-export', { version: 1, exportedAt: '2026-11-01T00:00:00.000Z', stateCount: 2, states: { fine: '{"json":{}}', bad: 'not json' } });
        await expect(provider.forContract(CONTRACT_B).importPrivateStates(broken, { password: EXPORT_PASSWORD, conflictStrategy: 'overwrite' })).rejects.toThrow('Invalid private state value');
        expect(await provider.forContract(CONTRACT_B).get('fine')).toBeNull();

        const keysFromSdk = seal('midnight-signing-key-export', { version: 1, keyCount: 1, keys: { [CONTRACT]: sk(4) } });
        expect(await provider.importSigningKeys(keysFromSdk, { password: EXPORT_PASSWORD })).toEqual({ imported: 1, skipped: 0, overwritten: 0 });
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(4));
        const olderKeys = seal('midnight-signing-key-export', { version: 1, keyCount: 2, keys: { [CONTRACT]: JSON.stringify(sk(5)), [CONTRACT_B]: '0b'.repeat(32) } });
        expect(await provider.importSigningKeys(olderKeys, { password: EXPORT_PASSWORD, conflictStrategy: 'overwrite' })).toEqual({ imported: 1, skipped: 0, overwritten: 1 });
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(5));
        expect(await provider.getSigningKey(CONTRACT_B)).toEqual({ tag: 'schnorr', value: '0b'.repeat(32) });

        for (const bad of [{ tag: 'schnorr', value: 'zz' }, { tag: 'other', value: '0c'.repeat(32) }, 'no key', 42, null]) {
            const refused = seal('midnight-signing-key-export', { version: 1, keyCount: 1, keys: { [CONTRACT]: bad } });
            await expect(provider.importSigningKeys(refused, { password: EXPORT_PASSWORD, conflictStrategy: 'overwrite' })).rejects.toThrow('Invalid signing key value');
        }
        expect(await provider.getSigningKey(CONTRACT)).toEqual(sk(5));
    });

    test('signing keys export/import round-trip', async () => {
        const sourceDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sourceDb });
        await a.setSigningKey(CONTRACT, sk(1));
        await a.setSigningKey(CONTRACT_B, sk(2));
        const exported = await a.exportSigningKeys({ password: 'export-pass-of-sufficient-length' });

        const targetDb = makeFakeDb();
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'b-pass-of-sufficient-length', db: targetDb });
        const result = await b.importSigningKeys(exported, { password: 'export-pass-of-sufficient-length' });
        expect(result).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await b.getSigningKey(CONTRACT)).toEqual(sk(1));
        expect(await b.getSigningKey(CONTRACT_B)).toEqual(sk(2));
    });
});

describe('CapDbPrivateStateProvider: config validation', () => {
    test('rejects construction without accountId', () => {
        expect(() => new CapDbPrivateStateProvider({
            accountId: '',
            privateStoragePasswordProvider: () => PASSWORD
        })).toThrow(/accountId/);
    });

    test('rejects construction without password provider', () => {
        expect(() => new CapDbPrivateStateProvider({
            accountId: ACCOUNT,
            privateStoragePasswordProvider: undefined as any
        })).toThrow(/privateStoragePasswordProvider/);
    });

    test('rejects passwords shorter than 16 chars at use time', async () => {
        const provider = new CapDbPrivateStateProvider({
            accountId: ACCOUNT,
            privateStoragePasswordProvider: () => 'too-short',
            db: makeFakeDb()
        });
        await expect(provider.forContract(CONTRACT).set('x', { v: 1 })).rejects.toThrow(/at least 16 characters/);
    });
});

describe('CapDbPrivateStateProvider: cross-instance reads', () => {
    // Each submission builds its OWN provider instance. A deploy writes private
    // state with one instance; a later call reads it with a DIFFERENT instance
    // (same account + password). The salt is deterministic per (account,
    // password), so the rows round-trip across instances.
    test('a second provider instance reads what the first wrote', async () => {
        const sharedDb = makeFakeDb();
        const writer = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await writer.forContract(CONTRACT).set('demo', { count: 7, nested: { ok: true } });

        const reader = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await expect(reader.forContract(CONTRACT).get('demo')).resolves.toEqual({ count: 7, nested: { ok: true } });
    });

    test('cross-instance signing-key read round-trips too', async () => {
        const sharedDb = makeFakeDb();
        const writer = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await writer.setSigningKey(CONTRACT, sk(8));

        const reader = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await expect(reader.getSigningKey(CONTRACT)).resolves.toEqual(sk(8));
    });

    test('a different account/password still cannot read (integrity preserved)', async () => {
        const sharedDb = makeFakeDb();
        const writer = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await writer.forContract(CONTRACT).set('demo', { secret: 1 });

        // Different account → row is account-scoped, so get returns null (no row).
        const other = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        await expect(other.forContract(CONTRACT).get('demo')).resolves.toBeNull();
    });
});
