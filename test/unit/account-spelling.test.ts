/**
 * One viewing key is one account. An account stored under another spelling of the key moves to the
 * account of the lowercase spelling, over real rows with the real encryption.
 */

import cds from '@sap/cds';
import { KeyRing, decrypt, encrypt, hashViewingKey, setKeyRing, getEncryptionKey, __resetKeyRingForTests } from '../../srv/utils/crypto';
import { walletSessionViewingKeyBinding } from '../../srv/utils/envelope-bindings';
import {
    deriveAccountId, deriveStoragePassword, moveAccountOfSpelling, adoptFormerSpellings, otherSpellings
} from '../../srv/submission/wallet-material-factory';
import { CapDbPrivateStateProvider } from '../../srv/midnight/CapDbPrivateStateProvider';
import { loadSyncState, saveSyncState, __resetDbHandleForTests, __resetEncryptionCacheForTests } from '../../srv/submission/wallet-sync-state-store';
import { resolveAccountDek, privateStatePasswordFromDek, clearAllAccountDeks } from '../../srv/submission/account-keys';
import { adoptStoredSpellings } from '../../srv/sessions/wallet-session-sweep';

cds.test(__dirname + '/../..');

const RING = new KeyRing({ activeId: 'k1', keys: [{ id: 'k1', secret: 'spelling-secret-of-32-characters' }] });
const SDK = 'wallet-sdk-facade@test';
const CONTRACT = 'c0'.repeat(32);
const TABLES = ['midnight.AccountKeys', 'midnight.PrivateStates', 'midnight.ContractSigningKeys', 'midnight.WalletSyncStates'];
const signingKey = (pair: string) => ({ tag: 'schnorr' as const, value: pair.repeat(32) });

describe('one account per viewing key', () => {
    let db: any;
    const { INSERT, SELECT, UPDATE, DELETE } = cds.ql;
    let n = 0;
    /** A fresh key per test, in lowercase. Its upper case spelling is `.toUpperCase()`. */
    const freshKey = (): string => `ab${(++n).toString(16).padStart(2, '0')}`.repeat(16);

    beforeAll(async () => { db = await cds.connect.to('db'); });

    beforeEach(async () => {
        __resetKeyRingForTests();
        __resetDbHandleForTests();
        __resetEncryptionCacheForTests();
        clearAllAccountDeks();
        setKeyRing(RING.toSpec());
        for (const table of [...TABLES, 'midnight.WalletSessions']) await db.run(DELETE.from(table));
    });

    async function providerFor(viewingKey: string): Promise<CapDbPrivateStateProvider<string, unknown>> {
        const accountId = deriveAccountId(viewingKey);
        const dek = await resolveAccountDek({ db, ring: RING, accountId, storagePassword: deriveStoragePassword(viewingKey) });
        const password = privateStatePasswordFromDek(dek!, accountId);
        return new CapDbPrivateStateProvider({
            accountId, db,
            privateStoragePasswordProvider: () => password
        });
    }
    const passphrase = (viewingKey: string) => deriveStoragePassword(viewingKey);
    const saveStates = (viewingKey: string, tag: string) => saveSyncState({
        accountId: deriveAccountId(viewingKey), passphrase: passphrase(viewingKey), sdkVersion: SDK,
        states: { shielded: `shielded-${tag}`, unshielded: `unshielded-${tag}`, dust: `dust-${tag}` }
    });
    const loadStates = (viewingKey: string) => loadSyncState({
        accountId: deriveAccountId(viewingKey), passphrase: passphrase(viewingKey), expectedSdkVersion: SDK
    });
    async function storedUnder(viewingKey: string): Promise<Record<string, number>> {
        const counts: Record<string, number> = {};
        for (const table of TABLES) {
            counts[table.split('.')[1]] = (await db.run(SELECT.from(table).columns('accountId').where({ accountId: deriveAccountId(viewingKey) }))).length;
        }
        return counts;
    }
    const NOTHING = { AccountKeys: 0, PrivateStates: 0, ContractSigningKeys: 0, WalletSyncStates: 0 };
    const move = (spelling: string) => db.tx((tx: any) => moveAccountOfSpelling(tx, RING, spelling));

    test('the spellings an account may still be stored under', () => {
        const key = 'ab'.repeat(32);
        expect(otherSpellings(key)).toEqual([key.toUpperCase()]);
        expect(otherSpellings(key, `0x${'Ab'.repeat(32)}`)).toEqual(['Ab'.repeat(32), key.toUpperCase()]);
        expect(otherSpellings(key, key.toUpperCase())).toEqual([key.toUpperCase()]);
        expect(otherSpellings('12'.repeat(32), `0X${'12'.repeat(32)}`)).toEqual([]);
    });

    test('private states, signing keys and the wallet state move and open under the lowercase account', async () => {
        const lower = freshKey();
        const upper = lower.toUpperCase();
        const before = await providerFor(upper);
        await before.forContract(CONTRACT).set('ps-1', { secret: 'kept' });
        await before.setSigningKey(CONTRACT, signingKey('5a'));
        await saveStates(upper, 'upper');

        expect(await move(upper)).toEqual({ moved: 2, left: 0 });
        clearAllAccountDeks();
        __resetEncryptionCacheForTests();

        const after = await providerFor(lower);
        expect(await after.forContract(CONTRACT).get('ps-1')).toEqual({ secret: 'kept' });
        expect(await after.getSigningKey(CONTRACT)).toEqual(signingKey('5a'));
        expect(await loadStates(lower)).toMatchObject({ shielded: 'shielded-upper', unshielded: 'unshielded-upper', dust: 'dust-upper' });
        expect(await storedUnder(upper)).toEqual(NOTHING);
        expect(await storedUnder(lower)).toEqual({ AccountKeys: 1, PrivateStates: 1, ContractSigningKeys: 1, WalletSyncStates: 1 });
    });

    test('nothing stored under a spelling, or the lowercase spelling itself: nothing happens', async () => {
        const lower = freshKey();
        expect(await move(lower.toUpperCase())).toBeNull();
        await (await providerFor(lower)).forContract(CONTRACT).set('ps-1', { v: 1 });
        expect(await move(lower)).toBeNull();
        expect(await storedUnder(lower)).toMatchObject({ AccountKeys: 1, PrivateStates: 1 });
    });

    test('an account that only has its key leaves nothing behind', async () => {
        const lower = freshKey();
        await providerFor(lower.toUpperCase());
        expect(await move(lower.toUpperCase())).toEqual({ moved: 0, left: 0 });
        expect(await storedUnder(lower.toUpperCase())).toEqual(NOTHING);
        expect(await storedUnder(lower)).toMatchObject({ AccountKeys: 1 });
    });

    test('a row the lowercase account already has stays where it is, with the key that opens it', async () => {
        const lower = freshKey();
        const upper = lower.toUpperCase();
        const theirs = await providerFor(upper);
        await theirs.forContract(CONTRACT).set('ps-1', { from: 'upper' });
        await theirs.forContract(CONTRACT).set('ps-2', { only: 'upper' });
        await theirs.setSigningKey(CONTRACT, signingKey('11'));
        const ours = await providerFor(lower);
        await ours.forContract(CONTRACT).set('ps-1', { from: 'lower' });
        await ours.setSigningKey(CONTRACT, signingKey('22'));

        expect(await move(upper)).toEqual({ moved: 1, left: 2 });
        clearAllAccountDeks();

        const after = await providerFor(lower);
        expect(await after.forContract(CONTRACT).get('ps-1')).toEqual({ from: 'lower' });
        expect(await after.forContract(CONTRACT).get('ps-2')).toEqual({ only: 'upper' });
        expect(await after.getSigningKey(CONTRACT)).toEqual(signingKey('22'));
        expect(await storedUnder(upper)).toEqual({ AccountKeys: 1, PrivateStates: 1, ContractSigningKeys: 1, WalletSyncStates: 0 });
        const left = await providerFor(upper);
        expect(await left.forContract(CONTRACT).get('ps-1')).toEqual({ from: 'upper' });
        expect(await left.getSigningKey(CONTRACT)).toEqual(signingKey('11'));
    });

    test('a row that cannot be read stays where it is', async () => {
        const lower = freshKey();
        const upper = lower.toUpperCase();
        await (await providerFor(upper)).forContract(CONTRACT).set('ps-good', { v: 1 });
        const now = new Date().toISOString();
        await db.run(INSERT.into('midnight.PrivateStates').entries({
            accountId: deriveAccountId(upper), contractAddress: CONTRACT, privateStateId: 'ps-bad', ciphertext: 'not-a-ciphertext',
            keyScheme: 'dek1', createdAt: now, updatedAt: now
        }));

        expect(await move(upper)).toEqual({ moved: 1, left: 1 });
        expect(await storedUnder(upper)).toMatchObject({ AccountKeys: 1, PrivateStates: 1 });
        clearAllAccountDeks();
        expect(await (await providerFor(lower)).forContract(CONTRACT).get('ps-good')).toEqual({ v: 1 });
    });

    test.each([
        ['the moved one is newer', '2026-01-02T00:00:00.000Z', 'upper'],
        ['the own one is newer', '2025-12-31T00:00:00.000Z', 'lower']
    ])('of two wallet states the newer one is kept: %s', async (_name, movedAt, kept) => {
        const lower = freshKey();
        const upper = lower.toUpperCase();
        await saveStates(lower, 'lower');
        await saveStates(upper, 'upper');
        await db.run(UPDATE.entity('midnight.WalletSyncStates').set({ updatedAt: '2026-01-01T00:00:00.000Z' }).where({ accountId: deriveAccountId(lower) }));
        await db.run(UPDATE.entity('midnight.WalletSyncStates').set({ updatedAt: movedAt }).where({ accountId: deriveAccountId(upper) }));

        expect(await move(upper)).toEqual({ moved: 0, left: 0 });
        clearAllAccountDeks();
        __resetEncryptionCacheForTests();
        expect(await loadStates(lower)).toMatchObject({ shielded: `shielded-${kept}`, dust: `dust-${kept}` });
        expect(await storedUnder(upper)).toEqual(NOTHING);
        expect(await storedUnder(lower)).toMatchObject({ WalletSyncStates: 1 });
    });

    test('a failed move changes nothing', async () => {
        const lower = freshKey();
        const upper = lower.toUpperCase();
        await (await providerFor(upper)).forContract(CONTRACT).set('ps-1', { v: 1 });
        // The row is already written under the lowercase account when the delete fails.
        await expect(db.tx((tx: any) => moveAccountOfSpelling({
            run: async (query: any) => {
                if (query?.DELETE) throw new Error('database gone');
                return tx.run(query);
            }
        }, RING, upper))).rejects.toThrow('database gone');

        clearAllAccountDeks();
        expect(await storedUnder(upper)).toMatchObject({ AccountKeys: 1, PrivateStates: 1 });
        expect(await storedUnder(lower)).toEqual(NOTHING);
        expect(await (await providerFor(upper)).forContract(CONTRACT).get('ps-1')).toEqual({ v: 1 });
    });

    describe('stored sessions at start', () => {
        async function openSession(sessionId: string, viewingKey: string): Promise<void> {
            const now = new Date().toISOString();
            await db.run(INSERT.into('midnight.WalletSessions').entries({
                sessionId, userId: 'alice', viewingKeyHash: hashViewingKey(viewingKey),
                encryptedViewingKey: encrypt(viewingKey, RING, walletSessionViewingKeyBinding(sessionId)),
                connectedAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), isActive: true
            }));
        }
        const sessionOf = async (sessionId: string) => db.run(SELECT.one.from('midnight.WalletSessions').where({ sessionId }));
        const keyOf = async (sessionId: string) => decrypt((await sessionOf(sessionId)).encryptedViewingKey, RING, walletSessionViewingKeyBinding(sessionId));

        test('a session with another spelling gets the lowercase key and its account moves', async () => {
            const lower = freshKey();
            const upper = lower.toUpperCase();
            const other = freshKey();
            await openSession('00000000-0000-4000-8000-0000000000a1', upper);
            await openSession('00000000-0000-4000-8000-0000000000a2', upper);
            await openSession('00000000-0000-4000-8000-0000000000a3', other);
            const untouched = (await sessionOf('00000000-0000-4000-8000-0000000000a3')).encryptedViewingKey;
            await (await providerFor(upper)).forContract(CONTRACT).set('ps-1', { v: 1 });

            expect(await adoptStoredSpellings(db)).toBe(1);
            clearAllAccountDeks();

            for (const id of ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2']) {
                expect(await keyOf(id)).toBe(lower);
                expect((await sessionOf(id)).viewingKeyHash).toBe(hashViewingKey(lower));
            }
            expect((await sessionOf('00000000-0000-4000-8000-0000000000a3')).encryptedViewingKey).toBe(untouched);
            expect(await (await providerFor(lower)).forContract(CONTRACT).get('ps-1')).toEqual({ v: 1 });
            expect(await storedUnder(upper)).toEqual(NOTHING);
            expect(await adoptStoredSpellings(db)).toBe(0);
        });

        test('a session whose account cannot be moved keeps its key and its account', async () => {
            const lower = freshKey();
            const upper = lower.toUpperCase();
            await openSession('00000000-0000-4000-8000-0000000000b1', upper);
            await (await providerFor(upper)).forContract(CONTRACT).set('ps-1', { v: 1 });
            await db.run(UPDATE.entity('midnight.AccountKeys').set({ wrappedDek: 'broken', wrappedDekByViewingKey: 'broken' }).where({ accountId: deriveAccountId(upper) }));
            clearAllAccountDeks();

            expect(await adoptStoredSpellings(db)).toBe(0);

            expect(await keyOf('00000000-0000-4000-8000-0000000000b1')).toBe(upper);
            expect(await storedUnder(upper)).toMatchObject({ AccountKeys: 1, PrivateStates: 1 });
            expect(await storedUnder(lower)).toEqual(NOTHING);
        });

        test('a connect is refused while an open session holds the other spelling, and moves the account once it is closed', async () => {
            const lower = freshKey();
            const upper = lower.toUpperCase();
            await openSession('00000000-0000-4000-8000-0000000000c1', upper);
            await (await providerFor(upper)).forContract(CONTRACT).set('ps-1', { v: 1 });

            await expect(adoptFormerSpellings(db, getEncryptionKey(), lower)).rejects.toMatchObject({ code: 'ACCOUNT_MOVE_BLOCKED' });
            expect(await storedUnder(upper)).toMatchObject({ PrivateStates: 1 });

            await db.run(UPDATE.entity('midnight.WalletSessions').set({ isActive: false, encryptedViewingKey: null }).where({ sessionId: '00000000-0000-4000-8000-0000000000c1' }));
            expect(await adoptFormerSpellings(db, getEncryptionKey(), lower)).toEqual({ moved: 1, left: 0 });
            clearAllAccountDeks();
            expect(await (await providerFor(lower)).forContract(CONTRACT).get('ps-1')).toEqual({ v: 1 });
            expect(await adoptFormerSpellings(db, getEncryptionKey(), lower)).toBeNull();
        });

        test('an account under the spelling the caller sent is found, not only upper case', async () => {
            const lower = freshKey();
            const mixed = lower.slice(0, 32).toUpperCase() + lower.slice(32);
            await (await providerFor(mixed)).forContract(CONTRACT).set('ps-1', { v: 'mixed' });

            expect(await adoptFormerSpellings(db, getEncryptionKey(), lower)).toBeNull();
            expect(await adoptFormerSpellings(db, getEncryptionKey(), lower, `0x${mixed}`)).toEqual({ moved: 1, left: 0 });
            clearAllAccountDeks();
            expect(await (await providerFor(lower)).forContract(CONTRACT).get('ps-1')).toEqual({ v: 'mixed' });
        });
    });
});
