/**
 * Key-ring maintenance over real rows (srv/utils/encryption-rewrap.ts):
 * the boot preflight refuses a database whose ciphertexts name a key the
 * ring does not hold, and the rewrap moves every ring-sealed value to the
 * active key (legacy v1 rows, v2 rows under a previous key, encrypted job
 * commands with json-v1 rows untouched, the account keys) and migrates the
 * pre-account-key rows it can reach through a session's viewing key. What it
 * cannot reach is reported, and the old key has to stay for it.
 */

import cds from '@sap/cds';
import nodeCrypto from 'node:crypto';
import {
    KeyRing, encrypt, decrypt, inspectCiphertext, legacyFold, setKeyRing, __resetKeyRingForTests
} from '../../srv/utils/crypto';
import { StorageEncryption, extractEncryptedComponents } from '../../srv/utils/storage-encryption';
import {
    scanStoredKeyIds, assertStoredKeyIdsKnown, rewrapStoredCiphertexts, keyIdFromPrefix, countLegacyRows
} from '../../srv/utils/encryption-rewrap';
import { deriveAccountId, deriveStoragePassword, privateStatePasswordCandidates } from '../../srv/submission/wallet-material-factory';
import { privateStateStableSalt } from '../../srv/midnight/CapDbPrivateStateProvider';
import {
    loadSyncState, saveSyncState, deriveStableSalt, syncStatePassphraseCandidates, SALT_LABEL_DEK,
    __resetDbHandleForTests, __resetEncryptionCacheForTests
} from '../../srv/submission/wallet-sync-state-store';
import {
    resolveAccountDek, privateStatePasswordFromDek, syncStatePassphraseFromDek, sealDekByStoragePassword,
    openDekByStoragePassword, clearAllAccountDeks, evictAccountDek, residentAccountDekCount, inflightAccountDekCount, DEK_SCHEME
} from '../../srv/submission/account-keys';

cds.test(__dirname + '/../..');

const OLD_SECRET = 'old-secret-of-thirty-two-chars!!';
const NEW_SECRET = 'new-secret-of-thirty-two-chars!!';
const THIRD_SECRET = 'third-secret-of-thirty-two-chars';
const OLD_ONLY = new KeyRing({ activeId: '1', keys: [{ id: '1', secret: OLD_SECRET }] });
const BOTH = new KeyRing({ activeId: 'k2', keys: [{ id: '1', secret: OLD_SECRET }, { id: 'k2', secret: NEW_SECRET }] });
const NEW_ONLY = new KeyRing({ activeId: 'k2', keys: [{ id: 'k2', secret: NEW_SECRET }] });
const K2_K3 = new KeyRing({ activeId: 'k3', keys: [{ id: 'k2', secret: NEW_SECRET }, { id: 'k3', secret: THIRD_SECRET }] });
const K3_ONLY = new KeyRing({ activeId: 'k3', keys: [{ id: 'k3', secret: THIRD_SECRET }] });

const VK_A = 'vk-alpha-'.padEnd(64, 'a');
const VK_B = 'vk-beta-'.padEnd(64, 'b');
const SDK = 'wallet-sdk-facade@test';

function legacyEncrypt(plaintext: string, secret: string): string {
    const key = legacyFold(secret);
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

const saltOf = (blobB64: string) => extractEncryptedComponents(Buffer.from(blobB64, 'base64')).salt;

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
        // First resolution creates the key and caches it.
        const created = await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk) });
        expect(created).not.toBeNull();
        expect(residentAccountDekCount()).toBe(1);
        // Drop it, then start a resolution and evict WHILE it is in flight.
        evictAccountDek(accountId);
        expect(residentAccountDekCount()).toBe(0);
        const pending = resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk), create: false });
        evictAccountDek(accountId);
        const dek = await pending;
        expect(dek).not.toBeNull();                 // the caller still gets its copy
        expect(residentAccountDekCount()).toBe(0);  // nothing stays resident after the eviction
        // A resolution started AFTER the eviction caches again.
        await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(vk), create: false });
        expect(residentAccountDekCount()).toBe(1);
        // The bookkeeping is bounded by the resolutions in flight: evicting a
        // thousand never-resolving accounts leaves nothing behind.
        for (let i = 0; i < 1000; i++) evictAccountDek(`never-seen-${i}`);
        expect(inflightAccountDekCount()).toBe(0);
        clearAllAccountDeks();
        expect(residentAccountDekCount()).toBe(0);
    });

    beforeEach(async () => {
        __resetKeyRingForTests();
        __resetDbHandleForTests();
        __resetEncryptionCacheForTests();
        clearAllAccountDeks();
        await db.run(DELETE.from('midnight.WalletSessions'));
        await db.run(DELETE.from('midnight.BackgroundJobs'));
        await db.run(DELETE.from('midnight.WalletSyncStates'));
        await db.run(DELETE.from('midnight.PrivateStates'));
        await db.run(DELETE.from('midnight.ContractSigningKeys'));
        await db.run(DELETE.from('midnight.AccountKeys'));
        const now = new Date().toISOString();
        // Session A: legacy v1 ciphertexts, sync-state blobs under the pre-ring derivation.
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            ID: 'sess-a', sessionId: '11111111-1111-4111-8111-111111111111', userId: 'u', connectedAt: now, isActive: true,
            viewingKeyHash: 'ha', encryptedViewingKey: legacyEncrypt(VK_A, OLD_SECRET), encryptedSeedKey: legacyEncrypt('seed-a', OLD_SECRET)
        }));
        const accountA = deriveAccountId(VK_A);
        const passA = deriveStoragePassword(VK_A);
        const legacyEnc = new StorageEncryption(passA, deriveStableSalt(accountA, passA, 'nightgate-wallet-sync-salt-v1'));
        await db.run(INSERT.into('midnight.WalletSyncStates').entries({
            accountId: accountA, sdkVersion: SDK, shieldedStateBlob: legacyEnc.encrypt('sh-a'), unshieldedStateBlob: null, dustStateBlob: legacyEnc.encrypt('du-a')
        }));
        // Session B: v2 under key 1, no seed, sync-state blob under key 1's ring-bound (pre-account-key) form.
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            ID: 'sess-b', sessionId: '22222222-2222-4222-8222-222222222222', userId: 'u', connectedAt: now, isActive: true,
            viewingKeyHash: 'hb', encryptedViewingKey: encrypt(VK_B, OLD_ONLY), encryptedSeedKey: null
        }));
        const accountB = deriveAccountId(VK_B);
        const k1 = syncStatePassphraseCandidates(BOTH, deriveStoragePassword(VK_B)).find(c => c.keyId === '1')!;
        const k1Enc = new StorageEncryption(k1.passphrase, deriveStableSalt(accountB, k1.passphrase));
        await db.run(INSERT.into('midnight.WalletSyncStates').entries({
            accountId: accountB, sdkVersion: SDK, shieldedStateBlob: null, unshieldedStateBlob: null, dustStateBlob: k1Enc.encrypt('du-b')
        }));
        // Private state: A under the pre-ring password, B under key 1's bound password. No keyScheme: legacy rows.
        const psA = new StorageEncryption(passA, privateStateStableSalt(accountA, passA));
        await db.run(INSERT.into('midnight.PrivateStates').entries({ accountId: accountA, contractAddress: 'c1', privateStateId: 'ps', ciphertext: psA.encrypt('{"a":1}'), createdAt: now, updatedAt: now }));
        await db.run(INSERT.into('midnight.ContractSigningKeys').entries({ accountId: accountA, contractAddress: 'c1', ciphertext: psA.encrypt('sk-a'), createdAt: now, updatedAt: now }));
        const psK1 = privateStatePasswordCandidates(BOTH, VK_B).find(c => c.keyId === '1')!;
        const psB = new StorageEncryption(psK1.password, privateStateStableSalt(accountB, psK1.password));
        await db.run(INSERT.into('midnight.PrivateStates').entries({ accountId: accountB, contractAddress: 'c2', privateStateId: 'ps', ciphertext: psB.encrypt('{"b":2}'), createdAt: now, updatedAt: now }));
        // Jobs: one encrypted command (v1), one plain json command.
        await db.run(INSERT.into('midnight.BackgroundJobs').entries([
            { ID: 'job-enc', kind: 'contractCall', status: 'succeeded', commandVersion: 1, commandEncoding: 'aes-gcm-v1', command: legacyEncrypt('{"secret":true}', OLD_SECRET), createdAt: now },
            { ID: 'job-plain', kind: 'sendNight', status: 'succeeded', commandVersion: 1, commandEncoding: 'json-v1', command: '{"plain":true}', createdAt: now }
        ]));
    });

    it('keyIdFromPrefix reads v2 ids and treats everything else as key 1', () => {
        expect(keyIdFromPrefix('v2:k2:AAAA')).toBe('k2');
        expect(keyIdFromPrefix('v2:abcdefghijklmnop:')).toBe('abcdefghijklmnop');
        expect(keyIdFromPrefix('Zm9v:YmFy:YmF6')).toBe('1');
    });

    it('scans the stored key ids without reading payloads, the account keys included', async () => {
        const scan = await scanStoredKeyIds(db);
        const byColumn = Object.fromEntries(scan.map(s => [`${s.column.entity}.${s.column.column}`, s.keyIds]));
        expect(byColumn['midnight.WalletSessions.encryptedViewingKey']).toEqual(['1']);
        expect(byColumn['midnight.WalletSessions.encryptedSeedKey']).toEqual(['1']);
        expect(byColumn['midnight.BackgroundJobs.command']).toEqual(['1']);
        expect(byColumn['midnight.AccountKeys.wrappedDek']).toEqual([]);
    });

    it('the preflight passes with the old key in the ring and refuses without it', async () => {
        await expect(assertStoredKeyIdsKnown(db, BOTH)).resolves.toBeUndefined();
        await expect(assertStoredKeyIdsKnown(db, NEW_ONLY)).rejects.toThrow(/key id\(s\) not in the ring: '1' \(midnight\.WalletSessions\.encryptedViewingKey, .*nightgate-rewrap-keys/);
    });

    it('the preflight refuses an account key sealed under a key outside the ring', async () => {
        const foreign = new KeyRing({ activeId: 'x', keys: [{ id: 'x', secret: 'foreign-secret-of-32-characters!' }] });
        const dek = nodeCrypto.randomBytes(32);
        await db.run(INSERT.into('midnight.AccountKeys').entries({
            accountId: 'acct-foreign', wrappedDek: encrypt(dek.toString('hex'), foreign),
            wrappedDekByViewingKey: sealDekByStoragePassword(dek, 'pw'), createdAt: new Date().toISOString()
        }));
        await expect(assertStoredKeyIdsKnown(db, BOTH)).rejects.toThrow(/'x' \(midnight\.AccountKeys\.wrappedDek\)/);
    });

    it('the account key is sealed both ways: the ring opens it, the viewing key opens it, a wrong viewing key is refused', async () => {
        const accountId = deriveAccountId(VK_A);
        const pass = deriveStoragePassword(VK_A);
        const created = await resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: pass });
        expect(created).toHaveLength(32);
        const row = await db.run(SELECT.one.from('midnight.AccountKeys').where({ accountId }));
        expect(inspectCiphertext(row.wrappedDek)).toEqual({ version: 2, keyId: 'k2' });
        expect(Buffer.from(decrypt(row.wrappedDek, NEW_ONLY), 'hex').equals(created!)).toBe(true);
        expect(openDekByStoragePassword(row.wrappedDekByViewingKey, pass).equals(created!)).toBe(true);
        expect(() => openDekByStoragePassword(row.wrappedDekByViewingKey, 'not-the-password')).toThrow();
        // Without the viewing key the operator's ring opens it (rewrap); a session with the wrong viewing key does not.
        clearAllAccountDeks();
        expect((await resolveAccountDek({ db, ring: BOTH, accountId, create: false }))!.equals(created!)).toBe(true);
        clearAllAccountDeks();
        await expect(resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: 'not-the-password', create: false })).rejects.toThrow(/viewing key does not match/);
        // A second resolve of the same account returns the same key, never a second one.
        clearAllAccountDeks();
        expect((await resolveAccountDek({ db, ring: BOTH, accountId, storagePassword: pass }))!.equals(created!)).toBe(true);
    });

    it('refuses to rewrap when a stored key id is missing from the ring; a dry run changes nothing', async () => {
        await expect(rewrapStoredCiphertexts(db, { ring: NEW_ONLY })).rejects.toThrow(/not in the ring/);
        const before = await db.run(SELECT.from('midnight.WalletSessions').columns('ID', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('ID'));
        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, dryRun: true });
        expect(report.dryRun).toBe(true);
        expect(report.envelope.map(e => e.rewrapped)).toEqual([2, 1, 1, 0]);
        expect(report.syncState).toEqual({ accounts: 2, blobsRewrapped: 3, blobsDropped: 0, sessionsUnreadable: 0 });
        expect(report.privateState).toEqual({ accounts: 2, rowsRewrapped: 3, rowsUnreadable: 0 });
        expect(report.legacy.total).toBe(5);
        expect(report.migratableAccounts).toEqual([deriveAccountId(VK_A), deriveAccountId(VK_B)].sort());
        const after = await db.run(SELECT.from('midnight.WalletSessions').columns('ID', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('ID'));
        expect(after).toEqual(before);
        expect(await db.run(SELECT.from('midnight.AccountKeys'))).toEqual([]);
        expect((await countLegacyRows(db)).total).toBe(5);
    });

    it('moves every ciphertext to the active key and every legacy row under its account key; the old key can then leave the ring', async () => {
        const messages: string[] = [];
        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, batchSize: 1, log: m => messages.push(m) });
        expect(report.activeId).toBe('k2');
        expect(report.envelope.map(e => [e.column, e.scanned, e.rewrapped, e.bySourceKey])).toEqual([
            ['midnight.WalletSessions.encryptedViewingKey', 2, 2, { '1': 2 }],
            ['midnight.WalletSessions.encryptedSeedKey', 1, 1, { '1': 1 }],
            ['midnight.BackgroundJobs.command', 1, 1, { '1': 1 }],
            ['midnight.AccountKeys.wrappedDek', 0, 0, {}]
        ]);
        expect(report.syncState).toEqual({ accounts: 2, blobsRewrapped: 3, blobsDropped: 0, sessionsUnreadable: 0 });
        expect(report.privateState).toEqual({ accounts: 2, rowsRewrapped: 3, rowsUnreadable: 0 });
        expect(report.legacy.total).toBe(0);
        expect(messages.some(m => /encryptedViewingKey: 2 ciphertext\(s\), 2 rewrapped from '1'x2/.test(m))).toBe(true);
        expect(messages.some(m => /no legacy rows remain/.test(m))).toBe(true);

        const sessions = await db.run(SELECT.from('midnight.WalletSessions').columns('ID', 'encryptedViewingKey', 'encryptedSeedKey').orderBy('ID'));
        expect(sessions.map((r: any) => inspectCiphertext(r.encryptedViewingKey))).toEqual([{ version: 2, keyId: 'k2' }, { version: 2, keyId: 'k2' }]);
        expect(decrypt(sessions[0].encryptedViewingKey, NEW_ONLY)).toBe(VK_A);
        expect(decrypt(sessions[0].encryptedSeedKey, NEW_ONLY)).toBe('seed-a');
        expect(sessions[1].encryptedSeedKey).toBeNull();
        expect(decrypt(sessions[1].encryptedViewingKey, NEW_ONLY)).toBe(VK_B);

        const jobs = await db.run(SELECT.from('midnight.BackgroundJobs').columns('ID', 'command', 'commandEncoding').orderBy('ID'));
        expect(jobs[0].commandEncoding).toBe('aes-gcm-v1');
        expect(decrypt(jobs[0].command, NEW_ONLY)).toBe('{"secret":true}');
        expect(jobs[1]).toMatchObject({ commandEncoding: 'json-v1', command: '{"plain":true}' });

        // Account keys exist for both wallets, sealed under k2; the sync-state blobs sit under
        // the DEK passphrase and the store opens them with the new ring only.
        setKeyRing(NEW_ONLY.toSpec());
        for (const [vk, expected] of [[VK_A, { shielded: 'sh-a', dust: 'du-a' }], [VK_B, { dust: 'du-b' }]] as const) {
            const accountId = deriveAccountId(vk);
            const pass = deriveStoragePassword(vk);
            const dek = await dekOf(vk, NEW_ONLY);
            const dekPass = syncStatePassphraseFromDek(dek, accountId);
            const row = await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId }));
            expect(row.keyScheme).toBe(DEK_SCHEME);
            for (const col of ['shieldedStateBlob', 'dustStateBlob'] as const) {
                if (row[col]) expect(saltOf(row[col]).equals(deriveStableSalt(accountId, dekPass, SALT_LABEL_DEK))).toBe(true);
            }
            const loaded = await loadSyncState({ accountId, passphrase: pass, expectedSdkVersion: SDK });
            expect(loaded).toMatchObject(expected);
        }
        await expect(assertStoredKeyIdsKnown(db, NEW_ONLY)).resolves.toBeUndefined();

        // Private-state rows under the DEK password, marked dek1.
        for (const [vk, address, expected] of [[VK_A, 'c1', '{"a":1}'], [VK_B, 'c2', '{"b":2}']] as const) {
            const accountId = deriveAccountId(vk);
            const password = privateStatePasswordFromDek(await dekOf(vk, NEW_ONLY), accountId);
            const row = await db.run(SELECT.one.from('midnight.PrivateStates').where({ accountId, contractAddress: address }));
            expect(row.keyScheme).toBe(DEK_SCHEME);
            expect(saltOf(row.ciphertext).equals(privateStateStableSalt(accountId, password))).toBe(true);
            expect(new StorageEncryption(password, privateStateStableSalt(accountId, password)).decrypt(row.ciphertext)).toBe(expected);
        }
        const accountA = deriveAccountId(VK_A);
        const sk = await db.run(SELECT.one.from('midnight.ContractSigningKeys').where({ accountId: accountA }));
        const passwordA = privateStatePasswordFromDek(await dekOf(VK_A, NEW_ONLY), accountA);
        expect(sk.keyScheme).toBe(DEK_SCHEME);
        expect(new StorageEncryption(passwordA, privateStateStableSalt(accountA, passwordA)).decrypt(sk.ciphertext)).toBe('sk-a');

        // Idempotent: a second run has nothing left to do.
        const again = await rewrapStoredCiphertexts(db, { ring: NEW_ONLY });
        expect(again.envelope.map(e => [e.scanned, e.rewrapped])).toEqual([[2, 0], [1, 0], [1, 0], [2, 0]]);
        expect(again.syncState).toEqual({ accounts: 0, blobsRewrapped: 0, blobsDropped: 0, sessionsUnreadable: 0 });
        expect(again.privateState).toEqual({ accounts: 0, rowsRewrapped: 0, rowsUnreadable: 0 });
        expect(again.legacy.total).toBe(0);
    });

    it('rotates the account keys of DISCONNECTED wallets without their viewing keys, and the private state opens under the new ring', async () => {
        await rewrapStoredCiphertexts(db, { ring: BOTH });
        const dekA = await dekOf(VK_A, NEW_ONLY);
        // Every session disconnects: the viewing keys are gone from the database.
        await db.run(DELETE.from('midnight.WalletSessions'));
        clearAllAccountDeks();

        const report = await rewrapStoredCiphertexts(db, { ring: K2_K3 });
        expect(report.envelope.find(e => e.column === 'midnight.AccountKeys.wrappedDek')).toMatchObject({ scanned: 2, rewrapped: 2, bySourceKey: { k2: 2 } });
        expect(report.syncState).toEqual({ accounts: 0, blobsRewrapped: 0, blobsDropped: 0, sessionsUnreadable: 0 });
        expect(report.legacy.total).toBe(0);
        const keys = await db.run(SELECT.from('midnight.AccountKeys').columns('accountId', 'wrappedDek', 'rotatedAt'));
        expect(keys.map((k: any) => inspectCiphertext(k.wrappedDek).keyId)).toEqual(['k3', 'k3']);
        expect(keys.every((k: any) => k.rotatedAt)).toBe(true);
        await expect(assertStoredKeyIdsKnown(db, K3_ONLY)).resolves.toBeUndefined();

        // The wallet reconnects later with k3 alone in the ring: same key, rows readable.
        const accountA = deriveAccountId(VK_A);
        const reopened = await dekOf(VK_A, K3_ONLY);
        expect(reopened.equals(dekA)).toBe(true);
        const password = privateStatePasswordFromDek(reopened, accountA);
        const row = await db.run(SELECT.one.from('midnight.PrivateStates').where({ accountId: accountA }));
        expect(new StorageEncryption(password, privateStateStableSalt(accountA, password)).decrypt(row.ciphertext)).toBe('{"a":1}');
        setKeyRing(K3_ONLY.toSpec());
        const loaded = await loadSyncState({ accountId: accountA, passphrase: deriveStoragePassword(VK_A), expectedSdkVersion: SDK });
        expect(loaded).toMatchObject({ shielded: 'sh-a', dust: 'du-a' });
    });

    it('legacy rows of a wallet without a session are reported and stay until the wallet reconnects', async () => {
        // Wallet A disconnected before the account key existed: its rows need its viewing key.
        await db.run(DELETE.from('midnight.WalletSessions').where({ ID: 'sess-a' }));
        const accountA = deriveAccountId(VK_A);
        const messages: string[] = [];
        const dry = await rewrapStoredCiphertexts(db, { ring: BOTH, dryRun: true, log: m => messages.push(m) });
        expect(dry.legacy.accounts).toEqual([accountA, deriveAccountId(VK_B)].sort());
        expect(dry.migratableAccounts).toEqual([deriveAccountId(VK_B)]);

        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, log: m => messages.push(m) });
        expect(report.legacy.total).toBe(3);   // A: private state, signing key, sync-state row
        expect(report.legacy.accounts).toEqual([accountA]);
        expect(report.legacy.tables.map(t => [t.entity, t.rows])).toEqual([
            ['midnight.PrivateStates', 1], ['midnight.ContractSigningKeys', 1], ['midnight.WalletSyncStates', 1]
        ]);
        expect(messages.some(m => /3 legacy row\(s\) of 1 account\(s\) remain/.test(m))).toBe(true);
        // Nothing of A was touched, no account key was invented for it.
        const ps = await db.run(SELECT.one.from('midnight.PrivateStates').where({ accountId: accountA }));
        expect(ps.keyScheme).toBeNull();
        expect(await db.run(SELECT.one.from('midnight.AccountKeys').where({ accountId: accountA }))).toBeFalsy();
        // The old key must stay: without it the preflight refuses (session B's rows moved, A's rows are not ring-sealed,
        // so the refusal comes from nothing; the census is what the CLI exits non-zero on).
        expect((await countLegacyRows(db)).accounts).toEqual([accountA]);

        // A reconnects (its viewing key is stored again, under the new ring): the next rewrap migrates it.
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            ID: 'sess-a2', sessionId: '44444444-4444-4444-8444-444444444444', userId: 'u', connectedAt: new Date().toISOString(), isActive: true,
            viewingKeyHash: 'ha', encryptedViewingKey: encrypt(VK_A, BOTH), encryptedSeedKey: null
        }));
        const after = await rewrapStoredCiphertexts(db, { ring: BOTH });
        expect(after.legacy.total).toBe(0);
        expect(after.privateState).toEqual({ accounts: 1, rowsRewrapped: 2, rowsUnreadable: 0 });
        expect(after.syncState).toMatchObject({ accounts: 1, blobsRewrapped: 2, blobsDropped: 0 });
        // A session read migrates too: a save under the DEK marks the row (the store path).
        setKeyRing(BOTH.toSpec());
        const loaded = await loadSyncState({ accountId: accountA, passphrase: deriveStoragePassword(VK_A), expectedSdkVersion: SDK });
        expect(loaded).toMatchObject({ shielded: 'sh-a', dust: 'du-a' });
    });

    it('a session read migrates legacy rows on its own: the save marks the row dek1', async () => {
        const accountB = deriveAccountId(VK_B);
        setKeyRing(BOTH.toSpec());
        const loaded = await loadSyncState({ accountId: accountB, passphrase: deriveStoragePassword(VK_B), expectedSdkVersion: SDK });
        expect(loaded).toMatchObject({ dust: 'du-b' });
        await saveSyncState({ accountId: accountB, passphrase: deriveStoragePassword(VK_B), sdkVersion: SDK, states: { shielded: 'sh-b-new' } });
        const row = await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId: accountB }));
        expect(row.keyScheme).toBe(DEK_SCHEME);
        const dekPass = syncStatePassphraseFromDek(await dekOf(VK_B, BOTH), accountB);
        expect(saltOf(row.dustStateBlob).equals(deriveStableSalt(accountB, dekPass, SALT_LABEL_DEK))).toBe(true);
        expect((await countLegacyRows(db)).tables.find(t => t.entity === 'midnight.WalletSyncStates')!.accounts).toBe(1); // only A left
    });

    it('drops a sync-state blob no ring key opens and counts a session whose viewing key it cannot read', async () => {
        const now = new Date().toISOString();
        const foreign = new KeyRing({ activeId: 'x', keys: [{ id: 'x', secret: 'foreign-secret-of-32-characters!' }] });
        // Session C under a key not in the ring but whose id the ring holds: undecryptable, counted, skipped.
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            ID: 'sess-c', sessionId: '33333333-3333-4333-8333-333333333333', userId: 'u', connectedAt: now, isActive: true,
            viewingKeyHash: 'hc', encryptedViewingKey: encrypt('vk-c', foreign).replace(/^v2:x:/, 'v2:k2:'), encryptedSeedKey: null
        }));
        // Session A's dust blob rewritten under a derivation nobody has.
        const accountA = deriveAccountId(VK_A);
        const stranger = new StorageEncryption('stranger-passphrase-of-32-chars!!', nodeCrypto.randomBytes(32));
        await db.run(cds.ql.UPDATE.entity('midnight.WalletSyncStates').set({ dustStateBlob: stranger.encrypt('lost') }).where({ accountId: accountA }));

        const report = await rewrapStoredCiphertexts(db, { ring: BOTH });
        expect(report.syncState).toEqual({ accounts: 2, blobsRewrapped: 2, blobsDropped: 1, sessionsUnreadable: 1 });
        const row = await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId: accountA }));
        expect(row.dustStateBlob).toBeNull();
        expect(row.shieldedStateBlob).not.toBeNull();
        expect(row.keyScheme).toBe(DEK_SCHEME);
    });

    it('--drop-legacy-sync-state deletes the legacy sync rows of unreachable accounts only; private state and signing keys stay', async () => {
        await db.run(DELETE.from('midnight.WalletSessions').where({ ID: 'sess-a' }));
        const accountA = deriveAccountId(VK_A);
        const report = await rewrapStoredCiphertexts(db, { ring: BOTH, dropLegacySyncState: true });
        expect(await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId: accountA }))).toBeFalsy();
        expect(await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId: deriveAccountId(VK_B) }))).toMatchObject({ keyScheme: DEK_SCHEME });
        expect(await db.run(SELECT.one.from('midnight.PrivateStates').where({ accountId: accountA }))).toMatchObject({ keyScheme: null });
        expect(await db.run(SELECT.one.from('midnight.ContractSigningKeys').where({ accountId: accountA }))).toMatchObject({ keyScheme: null });
        expect(report.legacy.total).toBe(2);
        expect(report.legacy.accounts).toEqual([accountA]);
    });
});
