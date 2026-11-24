/**
 * Key-ring maintenance over real rows (srv/utils/encryption-rewrap.ts):
 * the boot preflight refuses a database whose ciphertexts name a key the
 * ring does not hold, and the rewrap moves every ring-sealed value to the
 * active key (wallet sessions, encrypted job commands with json-v1 rows untouched,
 * the account keys, holder disclosures). Rows under an account data key need no rewrap.
 */

import cds from '@sap/cds';
import nodeCrypto from 'node:crypto';
import { KeyRing, encrypt, decrypt, inspectCiphertext, setKeyRing, __resetKeyRingForTests } from '../../srv/utils/crypto';
import { StorageEncryption, extractEncryptedComponents } from '../../srv/utils/storage-encryption';
import { scanStoredKeyIds, assertStoredKeyIdsKnown, rewrapStoredCiphertexts, keyIdFromPrefix } from '../../srv/utils/encryption-rewrap';
import { deriveAccountId, deriveStoragePassword } from '../../srv/submission/wallet-material-factory';
import { privateStateStableSalt } from '../../srv/midnight/CapDbPrivateStateProvider';
import { loadSyncState, saveSyncState, __resetDbHandleForTests, __resetEncryptionCacheForTests } from '../../srv/submission/wallet-sync-state-store';
import {
    resolveAccountDek, privateStatePasswordFromDek, openDekByStoragePassword, openDekByViewingKey,
    clearAllAccountDeks, evictAccountDek, residentAccountDekCount, inflightAccountDekCount, DEK_SCHEME
} from '../../srv/submission/account-keys';
import { walletSessionViewingKeyBinding, walletSessionSeedBinding, accountDekBinding, accountDekViewingKeySealBinding, jobCommandBinding, holderDisclosureContentBinding } from '../../srv/utils/envelope-bindings';

cds.test(__dirname + '/../..');

const OLD_SECRET = 'old-secret-of-thirty-two-chars!!';
const NEW_SECRET = 'new-secret-of-thirty-two-chars!!';
const THIRD_SECRET = 'third-secret-of-thirty-two-chars';
const OLD_ONLY = new KeyRing({ activeId: '1', keys: [{ id: '1', secret: OLD_SECRET }] });
const BOTH = new KeyRing({ activeId: 'k2', keys: [{ id: '1', secret: OLD_SECRET }, { id: 'k2', secret: NEW_SECRET }] });
const NEW_ONLY = new KeyRing({ activeId: 'k2', keys: [{ id: 'k2', secret: NEW_SECRET }] });
const K2_K3 = new KeyRing({ activeId: 'k3', keys: [{ id: 'k2', secret: NEW_SECRET }, { id: 'k3', secret: THIRD_SECRET }] });
const K3_ONLY = new KeyRing({ activeId: 'k3', keys: [{ id: 'k3', secret: THIRD_SECRET }] });

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const VK_A = 'aa'.repeat(32);
const VK_B = 'bb'.repeat(32);
const SDK = 'wallet-sdk-facade@test';

const saltOf = (blobB64: string) => extractEncryptedComponents(Buffer.from(blobB64, 'base64')).salt;

let hdgId = '';

describe('encryption key rewrap', () => {
    let db: any;
    const { INSERT, SELECT, DELETE } = cds.ql;

    beforeAll(async () => { db = await cds.connect.to('db'); });

    /** The account's DEK under `ring`, opened the way the material factory opens it. */
    async function dekOf(vk: string, ring: KeyRing): Promise<Buffer> {
        clearAllAccountDeks();
        const dek = await resolveAccountDek({ db, ring, accountId: deriveAccountId(vk), storagePassword: deriveStoragePassword(vk), create: false });
        if (!dek) throw new Error('no account key');
        return dek;
    }

    test('an eviction during an in-flight resolution wins: the completed resolution does not repopulate the cache', async () => {
        const ring = NEW_ONLY;
        const vk = 'ee'.repeat(32);
        const accountId = deriveAccountId(vk);
        clearAllAccountDeks();
        const created = await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk) });
        expect(created).not.toBeNull();
        expect(residentAccountDekCount()).toBe(1);
        evictAccountDek(accountId);
        expect(residentAccountDekCount()).toBe(0);
        const pending = resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk), create: false });
        evictAccountDek(accountId);
        const dek = await pending;
        expect(dek).not.toBeNull();
        expect(residentAccountDekCount()).toBe(0);
        await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk), create: false });
        expect(residentAccountDekCount()).toBe(1);
        for (let i = 0; i < 1000; i++) evictAccountDek(`never-seen-${i}`);
        expect(inflightAccountDekCount()).toBe(0);
        clearAllAccountDeks();
        expect(residentAccountDekCount()).toBe(0);
    });

    test('concurrent resolutions of one account each get their own buffer: zeroing one leaves the others intact', async () => {
        const ring = NEW_ONLY;
        const vk = 'ef'.repeat(32);
        const accountId = deriveAccountId(vk);
        clearAllAccountDeks();
        await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk) });
        clearAllAccountDeks();
        const [a, b, c] = await Promise.all([1, 2, 3].map(() =>
            resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk), create: false })));
        const key = Buffer.from(a!);
        a!.fill(0);
        expect(b!.equals(key)).toBe(true);
        expect(c!.equals(key)).toBe(true);
        expect(b).not.toBe(c);
        clearAllAccountDeks();
    });

    beforeEach(async () => {
        __resetKeyRingForTests();
        __resetDbHandleForTests();
        __resetEncryptionCacheForTests();
        clearAllAccountDeks();
        for (const table of ['WalletSessions', 'BackgroundJobs', 'WalletSyncStates', 'PrivateStates', 'ContractSigningKeys', 'AccountKeys', 'HolderDisclosureGrants']) {
            await db.run(DELETE.from(`midnight.${table}`));
        }
        const now = new Date().toISOString();
        // Two sessions under the old key; A has a seed, B none.
        await db.run(INSERT.into('midnight.WalletSessions').entries([
            {
                sessionId: SESSION_A, userId: 'u', connectedAt: now, isActive: true, viewingKeyHash: 'ha',
                encryptedViewingKey: encrypt(VK_A, OLD_ONLY, walletSessionViewingKeyBinding(SESSION_A)),
                encryptedSeedKey: encrypt('seed-a', OLD_ONLY, walletSessionSeedBinding(SESSION_A))
            },
            {
                sessionId: SESSION_B, userId: 'u', connectedAt: now, isActive: true, viewingKeyHash: 'hb',
                encryptedViewingKey: encrypt(VK_B, OLD_ONLY, walletSessionViewingKeyBinding(SESSION_B)), encryptedSeedKey: null
            }
        ]));
        // Account A: data key under the old key, private state and a sync snapshot under the data key.
        __resetKeyRingForTests();
        setKeyRing(OLD_ONLY.toSpec());
        const accountA = deriveAccountId(VK_A);
        const dekA = await resolveAccountDek({ db, ring: OLD_ONLY, accountId: accountA, storagePassword: deriveStoragePassword(VK_A) });
        const passwordA = privateStatePasswordFromDek(dekA!, accountA);
        const psA = new StorageEncryption(passwordA, privateStateStableSalt(accountA, passwordA));
        await db.run(INSERT.into('midnight.PrivateStates').entries({ accountId: accountA, contractAddress: 'c1', privateStateId: 'ps', ciphertext: psA.encrypt('{"a":1}'), keyScheme: DEK_SCHEME, createdAt: now, updatedAt: now }));
        await saveSyncState({ accountId: accountA, passphrase: deriveStoragePassword(VK_A), sdkVersion: SDK, states: { shielded: 'sh-a', dust: 'du-a' } });
        setKeyRing(undefined);
        clearAllAccountDeks();
        // Jobs: one encrypted command, one plain json command.
        await db.run(INSERT.into('midnight.BackgroundJobs').entries([
            { ID: 'job-enc', kind: 'contractCall', status: 'succeeded', commandVersion: 1, commandEncoding: 'aes-gcm-v1', command: encrypt('{"secret":true}', OLD_ONLY, jobCommandBinding('job-enc')), createdAt: now },
            { ID: 'job-plain', kind: 'sendToken', status: 'succeeded', commandVersion: 1, commandEncoding: 'json-v1', command: '{"plain":true}', createdAt: now }
        ]));
        hdgId = cds.utils.uuid();
        await db.run(INSERT.into('midnight.HolderDisclosureGrants').entries({
            ID: hdgId, payloadHash: 'aa'.repeat(32), tokenType: 'bb'.repeat(32), registryAddress: 'cc'.repeat(32), grantorUserId: 'issuer',
            contentHashKind: 'sha256', content: encrypt('{"certificate":"copper-A"}', OLD_ONLY, holderDisclosureContentBinding(hdgId)), active: true, createdAt: now, modifiedAt: now
        }));
    });

    it('keyIdFromPrefix reads the key id of a v3 value and nothing else', () => {
        expect(keyIdFromPrefix('v3:k2:AAAA')).toBe('k2');
        expect(keyIdFromPrefix('v3:abcdefghijklmnop:')).toBe('abcdefghijklmnop');
        expect(keyIdFromPrefix('v2:k2:AAAA')).toBeNull();
        expect(keyIdFromPrefix('Zm9v:YmFy:YmF6')).toBeNull();
    });

    it('scans the stored key ids without reading payloads, the account keys included', async () => {
        const scan = await scanStoredKeyIds(db);
        const byColumn = Object.fromEntries(scan.map(s => [`${s.column.entity}.${s.column.column}`, s.keyIds]));
        expect(byColumn['midnight.WalletSessions.encryptedViewingKey']).toEqual(['1']);
        expect(byColumn['midnight.WalletSessions.encryptedSeedKey']).toEqual(['1']);
        expect(byColumn['midnight.BackgroundJobs.command']).toEqual(['1']);
        expect(byColumn['midnight.AccountKeys.wrappedDek']).toEqual(['1']);
    });

    it('the preflight passes with the old key in the ring and refuses without it', async () => {
        await expect(assertStoredKeyIdsKnown(db, BOTH)).resolves.toBeUndefined();
        await expect(assertStoredKeyIdsKnown(db, NEW_ONLY)).rejects.toThrow(/key id\(s\) not in the ring: '1' \(midnight\.WalletSessions\.encryptedViewingKey, .*scripts\/rewrap-encryption-keys\.mjs/);
    });

    it('the preflight refuses an account key sealed under a key outside the ring', async () => {
        const foreign = new KeyRing({ activeId: 'x', keys: [{ id: 'x', secret: 'foreign-secret-of-32-characters!' }] });
        const dek = nodeCrypto.randomBytes(32);
        await db.run(INSERT.into('midnight.AccountKeys').entries({
            accountId: 'acct-foreign', wrappedDek: encrypt(dek.toString('hex'), foreign, accountDekBinding('acct-foreign')),
            wrappedDekByViewingKey: encrypt('sealed', foreign, accountDekViewingKeySealBinding('acct-foreign')), createdAt: new Date().toISOString()
        }));
        await expect(assertStoredKeyIdsKnown(db, BOTH)).rejects.toThrow(/'x' \(midnight\.AccountKeys\.wrappedDek, midnight\.AccountKeys\.wrappedDekByViewingKey\)/);
    });

    it('the account key is sealed both ways: the ring opens it, the viewing key opens it, a wrong viewing key is refused', async () => {
        const accountId = deriveAccountId(VK_B);
        const pass = deriveStoragePassword(VK_B);
        const created = await resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: pass });
        expect(created).toHaveLength(32);
        const row = await db.run(SELECT.one.from('midnight.AccountKeys').where({ accountId }));
        expect(inspectCiphertext(row.wrappedDek)).toEqual({ keyId: 'k2' });
        expect(Buffer.from(decrypt(row.wrappedDek, NEW_ONLY, accountDekBinding(accountId)), 'hex').equals(created!)).toBe(true);
        expect(inspectCiphertext(row.wrappedDekByViewingKey)).toEqual({ keyId: 'k2' });
        expect(openDekByViewingKey(row.wrappedDekByViewingKey, pass, NEW_ONLY, accountId).equals(created!)).toBe(true);
        expect(() => openDekByViewingKey(row.wrappedDekByViewingKey, 'not-the-password', NEW_ONLY, accountId)).toThrow();
        expect(() => openDekByViewingKey(row.wrappedDekByViewingKey, pass, K3_ONLY, accountId)).toThrow();
        expect(() => openDekByStoragePassword(row.wrappedDekByViewingKey, pass)).toThrow(/expected vk1/);
        clearAllAccountDeks();
        expect((await resolveAccountDek({ db, ring: BOTH, accountId, create: false }))!.equals(created!)).toBe(true);
        clearAllAccountDeks();
        await expect(resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: 'not-the-password', create: false })).rejects.toThrow(/viewing key does not match/);
        clearAllAccountDeks();
        expect((await resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: pass }))!.equals(created!)).toBe(true);
    });

    it('refuses to rewrap when a stored key id is missing from the ring; a dry run changes nothing', async () => {
        await expect(rewrapStoredCiphertexts(db, { ring: NEW_ONLY })).rejects.toThrow(/not in the ring/);
        const before = await db.run(SELECT.from('midnight.WalletSessions').columns('sessionId', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('sessionId'));
        const keysBefore = await db.run(SELECT.from('midnight.AccountKeys'));
        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, dryRun: true });
        expect(report.dryRun).toBe(true);
        expect(report.envelope.map(e => e.rewrapped)).toEqual([2, 1, 1, 1, 1, 1]);
        expect(await db.run(SELECT.from('midnight.WalletSessions').columns('sessionId', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('sessionId'))).toEqual(before);
        expect(await db.run(SELECT.from('midnight.AccountKeys'))).toEqual(keysBefore);
    });

    it('moves every ciphertext to the active key; the old key can then leave the ring', async () => {
        const messages: string[] = [];
        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, batchSize: 1, log: m => messages.push(m) });
        expect(report.activeId).toBe('k2');
        expect(report.envelope.map(e => [e.column, e.scanned, e.rewrapped, e.bySourceKey])).toEqual([
            ['midnight.WalletSessions.encryptedViewingKey', 2, 2, { '1': 2 }],
            ['midnight.WalletSessions.encryptedSeedKey', 1, 1, { '1': 1 }],
            ['midnight.BackgroundJobs.command', 1, 1, { '1': 1 }],
            ['midnight.AccountKeys.wrappedDek', 1, 1, { '1': 1 }],
            ['midnight.AccountKeys.wrappedDekByViewingKey', 1, 1, { '1': 1 }],
            ['midnight.HolderDisclosureGrants.content', 1, 1, { '1': 1 }]
        ]);
        expect(messages.some(m => /encryptedViewingKey: 2 ciphertext\(s\), 2 rewrapped from '1'x2/.test(m))).toBe(true);

        const sessions = await db.run(SELECT.from('midnight.WalletSessions').columns('sessionId', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('sessionId'));
        expect(sessions.map((r: any) => inspectCiphertext(r.encryptedViewingKey))).toEqual([{ keyId: 'k2' }, { keyId: 'k2' }]);
        expect(decrypt(sessions[0].encryptedViewingKey, NEW_ONLY, walletSessionViewingKeyBinding(SESSION_A))).toBe(VK_A);
        expect(decrypt(sessions[0].encryptedSeedKey, NEW_ONLY, walletSessionSeedBinding(SESSION_A))).toBe('seed-a');
        expect(sessions[1].encryptedSeedKey).toBeNull();
        expect(decrypt(sessions[1].encryptedViewingKey, NEW_ONLY, walletSessionViewingKeyBinding(SESSION_B))).toBe(VK_B);
        // Bound to its row: the same value under another session id does not open.
        expect(() => decrypt(sessions[0].encryptedViewingKey, NEW_ONLY, walletSessionViewingKeyBinding(SESSION_B))).toThrow();

        const jobs = await db.run(SELECT.from('midnight.BackgroundJobs').columns('ID', 'command', 'commandEncoding').orderBy('ID'));
        expect(decrypt(jobs[0].command, NEW_ONLY, jobCommandBinding(jobs[0].ID))).toBe('{"secret":true}');
        expect(jobs[1]).toMatchObject({ commandEncoding: 'json-v1', command: '{"plain":true}' });
        const hdg = await db.run(SELECT.one.from('midnight.HolderDisclosureGrants').where({ ID: hdgId }));
        expect(decrypt(hdg.content, NEW_ONLY, holderDisclosureContentBinding(hdgId))).toBe('{"certificate":"copper-A"}');

        // The rows under the data key are untouched and open with the new ring alone.
        await expect(assertStoredKeyIdsKnown(db, NEW_ONLY)).resolves.toBeUndefined();
        setKeyRing(NEW_ONLY.toSpec());
        const accountA = deriveAccountId(VK_A);
        const password = privateStatePasswordFromDek(await dekOf(VK_A, NEW_ONLY), accountA);
        const row = await db.run(SELECT.one.from('midnight.PrivateStates').where({ accountId: accountA }));
        expect(saltOf(row.ciphertext).equals(privateStateStableSalt(accountA, password))).toBe(true);
        expect(new StorageEncryption(password, privateStateStableSalt(accountA, password)).decrypt(row.ciphertext)).toBe('{"a":1}');
        expect(await loadSyncState({ accountId: accountA, passphrase: deriveStoragePassword(VK_A), expectedSdkVersion: SDK })).toMatchObject({ shielded: 'sh-a', dust: 'du-a' });

        const again = await rewrapStoredCiphertexts(db, { ring: NEW_ONLY });
        expect(again.envelope.map(e => [e.scanned, e.rewrapped])).toEqual([[2, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0]]);
    });

    it('rotates the account keys of disconnected wallets without their viewing keys', async () => {
        await rewrapStoredCiphertexts(db, { ring: BOTH });
        const dekA = await dekOf(VK_A, NEW_ONLY);
        await db.run(DELETE.from('midnight.WalletSessions'));
        clearAllAccountDeks();

        const report = await rewrapStoredCiphertexts(db, { ring: K2_K3 });
        expect(report.envelope.find(e => e.column === 'midnight.AccountKeys.wrappedDek')).toMatchObject({ scanned: 1, rewrapped: 1, bySourceKey: { k2: 1 } });
        const keys = await db.run(SELECT.from('midnight.AccountKeys').columns('accountId', 'wrappedDek', 'rotatedAt'));
        expect(keys.map((k: any) => inspectCiphertext(k.wrappedDek).keyId)).toEqual(['k3']);
        expect(keys.every((k: any) => k.rotatedAt)).toBe(true);
        await expect(assertStoredKeyIdsKnown(db, K3_ONLY)).resolves.toBeUndefined();

        const accountA = deriveAccountId(VK_A);
        const reopened = await dekOf(VK_A, K3_ONLY);
        expect(reopened.equals(dekA)).toBe(true);
        setKeyRing(K3_ONLY.toSpec());
        expect(await loadSyncState({ accountId: accountA, passphrase: deriveStoragePassword(VK_A), expectedSdkVersion: SDK })).toMatchObject({ shielded: 'sh-a', dust: 'du-a' });
    });

    it('leaves a value the ring cannot open as it is and counts it', async () => {
        const foreign = new KeyRing({ activeId: 'x', keys: [{ id: 'x', secret: 'foreign-secret-of-32-characters!' }] });
        const sessionC = '33333333-3333-4333-8333-333333333333';
        // Under a foreign key whose id the ring holds: unreadable, counted, never overwritten.
        const sealed = encrypt('vk-c', foreign, walletSessionViewingKeyBinding(sessionC)).replace(/^v3:x:/, 'v3:k2:');
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            sessionId: sessionC, userId: 'u', connectedAt: new Date().toISOString(), isActive: true, viewingKeyHash: 'hc', encryptedViewingKey: sealed, encryptedSeedKey: null
        }));
        const all = new KeyRing({ activeId: 'k3', keys: [{ id: '1', secret: OLD_SECRET }, { id: 'k2', secret: NEW_SECRET }, { id: 'k3', secret: THIRD_SECRET }] });
        const report = await rewrapStoredCiphertexts(db, { ring: all });
        expect(report.envelope.find(e => e.column === 'midnight.WalletSessions.encryptedViewingKey')!.unreadable).toBe(1);
        const row = await db.run(SELECT.one.from('midnight.WalletSessions').where({ sessionId: sessionC }));
        expect(row.encryptedViewingKey).toBe(sealed);
    });
});
