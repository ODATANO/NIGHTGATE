/**
 * Custody export of a contract's signing key through the deploying session
 * (srv/submission/signing-key-export.ts): the ring opens the session, the
 * account key opens the row, the export is sealed under the caller's
 * password in the format importSigningKeys reads back.
 */

import cds from '@sap/cds';
import { KeyRing, encrypt } from '../../srv/utils/crypto';
import { walletSessionViewingKeyBinding } from '../../srv/utils/envelope-bindings';
import { StorageEncryption, decryptWithPassword } from '../../srv/utils/storage-encryption';
import { privateStateStableSalt } from '../../srv/midnight/CapDbPrivateStateProvider';
import { deriveAccountId, deriveStoragePassword } from '../../srv/submission/wallet-material-factory';
import { resolveAccountDek, privateStatePasswordFromDek, clearAllAccountDeks, DEK_SCHEME } from '../../srv/submission/account-keys';
import { exportContractSigningKeyForSession, SigningKeyExportError } from '../../srv/submission/signing-key-export';

cds.test(__dirname + '/../..');

const RING = new KeyRing({ activeId: 'k', keys: [{ id: 'k', secret: 'export-test-secret-of-32-chars!!' }] });
const OTHER_RING = new KeyRing({ activeId: 'z', keys: [{ id: 'z', secret: 'another-ring-secret-of-32-chars!' }] });
const VK = 'vk-export-'.padEnd(64, 'e');
const SESSION = '33333333-3333-4333-8333-333333333333';
const CONTRACT = 'c'.repeat(64);
const SIGNING_KEY = 'synthetic-signing-key-material';
const PASSWORD = 'custody-password-of-sixteen+';

describe('contract signing key export', () => {
    let db: any;
    let accountId: string;
    const { INSERT, DELETE, UPDATE } = cds.ql;

    beforeAll(async () => { db = await cds.connect.to('db'); });

    beforeEach(async () => {
        clearAllAccountDeks();
        await db.run(DELETE.from('midnight.WalletSessions'));
        await db.run(DELETE.from('midnight.ContractSigningKeys'));
        await db.run(DELETE.from('midnight.AccountKeys'));
        await db.run(INSERT.into('midnight.WalletSessions').entries({
            ID: 'sess-export', sessionId: SESSION, userId: 'operator', connectedAt: new Date().toISOString(), isActive: true,
            viewingKeyHash: 'hx', encryptedViewingKey: encrypt(VK, RING, walletSessionViewingKeyBinding(SESSION)), encryptedSeedKey: null
        }));
        accountId = deriveAccountId(VK);
        const dek = await resolveAccountDek({ db, ring: RING, accountId, storagePassword: deriveStoragePassword(VK) });
        const password = privateStatePasswordFromDek(dek!, accountId);
        const enc = new StorageEncryption(password, privateStateStableSalt(accountId, password));
        await db.run(INSERT.into('midnight.ContractSigningKeys').entries({
            accountId, contractAddress: CONTRACT, ciphertext: enc.encrypt(SIGNING_KEY), keyScheme: DEK_SCHEME,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }));
        clearAllAccountDeks();
    });

    test('exports the key sealed under the export password in the import format', async () => {
        const out = await exportContractSigningKeyForSession(db, RING, SESSION, CONTRACT.toUpperCase(), PASSWORD);
        expect(out.format).toBe('midnight-signing-key-export');
        expect(out.contractAddress).toBe(CONTRACT);
        expect(out.accountId).toBe(accountId);
        expect(out.salt).toMatch(/^[0-9a-f]{64}$/);
        const payload = JSON.parse(decryptWithPassword(out.encryptedPayload, PASSWORD));
        expect(payload).toEqual({ version: 1, keyCount: 1, keys: { [CONTRACT]: SIGNING_KEY } });
        expect(() => decryptWithPassword(out.encryptedPayload, 'not-the-export-password')).toThrow();
    });

    test('refuses a short password, an unknown session, an unknown contract and a foreign ring', async () => {
        await expect(exportContractSigningKeyForSession(db, RING, SESSION, CONTRACT, 'short')).rejects.toMatchObject({ status: 400 });
        await expect(exportContractSigningKeyForSession(db, RING, '44444444-4444-4444-8444-444444444444', CONTRACT, PASSWORD)).rejects.toMatchObject({ status: 404 });
        await expect(exportContractSigningKeyForSession(db, RING, SESSION, 'd'.repeat(64), PASSWORD)).rejects.toMatchObject({ status: 404 });
        const foreign = exportContractSigningKeyForSession(db, OTHER_RING, SESSION, CONTRACT, PASSWORD);
        await expect(foreign).rejects.toBeInstanceOf(SigningKeyExportError);
        await expect(foreign).rejects.toMatchObject({ status: 500 });
    });

    test('refuses an inactive session and a row still under a pre-account-key derivation', async () => {
        await db.run(UPDATE.entity('midnight.ContractSigningKeys').set({ keyScheme: null }).where({ accountId, contractAddress: CONTRACT }));
        await expect(exportContractSigningKeyForSession(db, RING, SESSION, CONTRACT, PASSWORD)).rejects.toMatchObject({ status: 409 });
        await db.run(UPDATE.entity('midnight.WalletSessions').set({ isActive: false }).where({ sessionId: SESSION }));
        await expect(exportContractSigningKeyForSession(db, RING, SESSION, CONTRACT, PASSWORD)).rejects.toMatchObject({ status: 404 });
    });
});
