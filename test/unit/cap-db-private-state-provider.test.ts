/**
 * Tests for srv/midnight/CapDbPrivateStateProvider.
 *
 * Uses an in-memory fake DB that implements the subset of cds.db.run() calls
 * the provider makes (SELECT.one / SELECT / INSERT / UPDATE / DELETE on
 * midnight.PrivateStates and midnight.ContractSigningKeys). This keeps the
 * suite hermetic and fast, no SQLite spin-up needed.
 */

import {
    CapDbPrivateStateProvider,
    ExportDecryptionError,
    InvalidExportFormatError,
    ImportConflictError
} from '../../srv/midnight/CapDbPrivateStateProvider';

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
        run: jest.fn(async (q: any) => {
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
const CONTRACT = '0xcontract-1';
const CONTRACT_B = '0xcontract-2';

function newProvider(accountId = ACCOUNT, db = makeFakeDb()) {
    const provider = new CapDbPrivateStateProvider({
        accountId,
        privateStoragePasswordProvider: () => PASSWORD,
        db
    });
    return { provider, db };
}

// ---- Tests -----------------------------------------------------------------

describe('CapDbPrivateStateProvider: CRUD', () => {
    test('set + get round-trips a JSON-serializable state', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('counter', { value: 42 });
        const got = await provider.get('counter');
        expect(got).toEqual({ value: 42 });
    });

    test('get returns null for unknown id', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        expect(await provider.get('does-not-exist')).toBeNull();
    });

    test('set on an existing id overwrites (no duplicate row)', async () => {
        const { provider, db } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('counter', { value: 1 });
        await provider.set('counter', { value: 2 });
        expect(await provider.get('counter')).toEqual({ value: 2 });
        const rows = (db.tables['midnight.PrivateStates'] || []).filter(r => r.privateStateId === 'counter');
        expect(rows.length).toBe(1);
    });

    test('remove deletes the state', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('counter', { value: 1 });
        await provider.remove('counter');
        expect(await provider.get('counter')).toBeNull();
    });

    test('clear removes all private states for the account', async () => {
        const { provider, db } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('a', { x: 1 });
        provider.setContractAddress(CONTRACT_B);
        await provider.set('b', { y: 2 });
        await provider.clear();
        expect(db.tables['midnight.PrivateStates'].filter(r => r.accountId === ACCOUNT)).toEqual([]);
    });

    test('throws when contract address is not set before state operations', async () => {
        const { provider } = newProvider();
        await expect(provider.set('x', { v: 1 })).rejects.toThrow(/setContractAddress/);
        await expect(provider.get('x')).rejects.toThrow(/setContractAddress/);
        await expect(provider.remove('x')).rejects.toThrow(/setContractAddress/);
    });
});

describe('CapDbPrivateStateProvider: account isolation', () => {
    test('account B cannot read account A keys (same DB)', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        a.setContractAddress(CONTRACT);
        b.setContractAddress(CONTRACT);
        await a.set('alice-key', { v: 'alice' });
        expect(await b.get('alice-key')).toBeNull();
    });

    test('clear is account-scoped: A.clear() leaves B intact', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        a.setContractAddress(CONTRACT); await a.set('k', { v: 1 });
        b.setContractAddress(CONTRACT); await b.set('k', { v: 2 });
        await a.clear();
        expect(await b.get('k')).toEqual({ v: 2 });
    });
});

describe('CapDbPrivateStateProvider: signing keys', () => {
    test('set + get signing key round-trip', async () => {
        const { provider } = newProvider();
        await provider.setSigningKey(CONTRACT, 'deadbeef-signing-key');
        expect(await provider.getSigningKey(CONTRACT)).toBe('deadbeef-signing-key');
    });

    test('setSigningKey overwrites', async () => {
        const { provider, db } = newProvider();
        await provider.setSigningKey(CONTRACT, 'first');
        await provider.setSigningKey(CONTRACT, 'second');
        expect(await provider.getSigningKey(CONTRACT)).toBe('second');
        expect(db.tables['midnight.ContractSigningKeys'].length).toBe(1);
    });

    test('removeSigningKey + clearSigningKeys', async () => {
        const { provider } = newProvider();
        await provider.setSigningKey(CONTRACT, 'k1');
        await provider.setSigningKey(CONTRACT_B, 'k2');
        await provider.removeSigningKey(CONTRACT);
        expect(await provider.getSigningKey(CONTRACT)).toBeNull();
        expect(await provider.getSigningKey(CONTRACT_B)).toBe('k2');
        await provider.clearSigningKeys();
        expect(await provider.getSigningKey(CONTRACT_B)).toBeNull();
    });
});

describe('CapDbPrivateStateProvider: export / import', () => {
    test('exportPrivateStates produces SDK-format blob', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('a', { v: 1 });
        await provider.set('b', { v: 2 });

        const exported = await provider.exportPrivateStates();
        expect(exported.format).toBe('midnight-private-state-export');
        expect(exported.encryptedPayload).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(exported.salt).toMatch(/^[0-9a-fA-F]{64}$/);
    });

    test('export → import round-trip into a fresh provider (different account)', async () => {
        // Export from A
        const sourceDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sourceDb });
        a.setContractAddress(CONTRACT);
        await a.set('a', { v: 1 });
        await a.set('b', { v: 2 });
        const exported = await a.exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        // Import into B (fresh DB, fresh password)
        const targetDb = makeFakeDb();
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'b-pass-of-sufficient-length', db: targetDb });
        b.setContractAddress(CONTRACT);
        const result = await b.importPrivateStates(exported, { password: 'export-pass-of-sufficient-length' });
        expect(result).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await b.get('a')).toEqual({ v: 1 });
        expect(await b.get('b')).toEqual({ v: 2 });
    });

    test('import with wrong password → ExportDecryptionError', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await provider.set('a', { v: 1 });
        const exported = await provider.exportPrivateStates({ password: 'correct-pass-of-sufficient-length' });
        // fresh provider, same contract address
        const targetDb = makeFakeDb();
        const fresh = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'unused-pass-of-sufficient-length', db: targetDb });
        fresh.setContractAddress(CONTRACT);
        await expect(fresh.importPrivateStates(exported, { password: 'wrong-pass-of-sufficient-length' }))
            .rejects.toBeInstanceOf(ExportDecryptionError);
    });

    test('import with conflictStrategy=error throws ImportConflictError on overlap', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        a.setContractAddress(CONTRACT);
        await a.set('a', { v: 1 });
        const exported = await a.exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        // import back into same account/contract, every id will conflict
        await expect(a.importPrivateStates(exported, { password: 'export-pass-of-sufficient-length' }))
            .rejects.toBeInstanceOf(ImportConflictError);
    });

    test('import with conflictStrategy=skip preserves existing values', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        a.setContractAddress(CONTRACT);
        await a.set('a', { v: 1 });
        const exported = await a.exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        await a.set('a', { v: 'newer' }); // existing differs from export
        const result = await a.importPrivateStates(exported, { password: 'export-pass-of-sufficient-length', conflictStrategy: 'skip' });
        expect(result).toEqual({ imported: 0, skipped: 1, overwritten: 0 });
        expect(await a.get('a')).toEqual({ v: 'newer' });
    });

    test('import with conflictStrategy=overwrite replaces existing values', async () => {
        const sharedDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sharedDb });
        a.setContractAddress(CONTRACT);
        await a.set('a', { v: 'original' });
        const exported = await a.exportPrivateStates({ password: 'export-pass-of-sufficient-length' });

        await a.set('a', { v: 'newer' });
        const result = await a.importPrivateStates(exported, { password: 'export-pass-of-sufficient-length', conflictStrategy: 'overwrite' });
        expect(result).toEqual({ imported: 0, skipped: 0, overwritten: 1 });
        expect(await a.get('a')).toEqual({ v: 'original' });
    });

    test('rejects export blob with wrong format identifier', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await expect(provider.importPrivateStates(
            { format: 'something-else' as any, encryptedPayload: 'AAA', salt: '00'.repeat(32) }
        )).rejects.toBeInstanceOf(InvalidExportFormatError);
    });

    test('rejects export blob with invalid salt format', async () => {
        const { provider } = newProvider();
        provider.setContractAddress(CONTRACT);
        await expect(provider.importPrivateStates(
            { format: 'midnight-private-state-export', encryptedPayload: 'AAA', salt: 'not-hex' }
        )).rejects.toBeInstanceOf(InvalidExportFormatError);
    });

    test('signing keys export/import round-trip', async () => {
        const sourceDb = makeFakeDb();
        const a = new CapDbPrivateStateProvider({ accountId: ACCOUNT, privateStoragePasswordProvider: () => PASSWORD, db: sourceDb });
        await a.setSigningKey(CONTRACT, 'sk-1');
        await a.setSigningKey(CONTRACT_B, 'sk-2');
        const exported = await a.exportSigningKeys({ password: 'export-pass-of-sufficient-length' });

        const targetDb = makeFakeDb();
        const b = new CapDbPrivateStateProvider({ accountId: ACCOUNT_B, privateStoragePasswordProvider: () => 'b-pass-of-sufficient-length', db: targetDb });
        const result = await b.importSigningKeys(exported, { password: 'export-pass-of-sufficient-length' });
        expect(result).toEqual({ imported: 2, skipped: 0, overwritten: 0 });
        expect(await b.getSigningKey(CONTRACT)).toBe('sk-1');
        expect(await b.getSigningKey(CONTRACT_B)).toBe('sk-2');
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
        provider.setContractAddress(CONTRACT);
        await expect(provider.set('x', { v: 1 })).rejects.toThrow(/at least 16 characters/);
    });
});
