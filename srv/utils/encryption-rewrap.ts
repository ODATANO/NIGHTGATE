/**
 * Startup check that every stored encryption key id is in the key ring, and the `nightgate-rewrap-keys` tool.
 * Ring-encrypted values start with their key id, so they can be re-encrypted without any wallet secret.
 * "Legacy rows" (`keyScheme` null) use an older scheme that needs the wallet's viewing key to decrypt.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import {
    decrypt, encrypt, inspectCiphertext, getEncryptionKey, UnknownEncryptionKeyError, KeyRing, LEGACY_KEY_ID,
    BOUND_ENVELOPE_VERSION, ENVELOPE_VERSION, EnvelopeBinding
} from './crypto';
import {
    walletSessionViewingKeyBinding, walletSessionSeedBinding, jobCommandBinding, accountDekBinding, accountDekViewingKeySealBinding,
    holderDisclosureContentBinding
} from './envelope-bindings';
import { StorageEncryption, decryptWithPassword, extractEncryptedComponents } from './storage-encryption';
// Imported statically so the data key cache is shared with the sessions that read the same rows.
import { resolveAccountDek, privateStatePasswordFromDek, syncStatePassphraseFromDek, DEK_SCHEME } from '../submission/account-keys';
import type { DbService } from './db-types';
import { errorMessage } from './errors';

const log = cds.log('nightgate:crypto');

export interface CiphertextColumn {
    entity: string;
    table: string;
    key: string;
    column: string;
    where?: Record<string, unknown>;
    whereSql?: string;
    /** Extra columns the binding needs. */
    select?: string[];
    binding: (row: Record<string, any>) => EnvelopeBinding;
    /** A value with this prefix is not ring-encrypted yet and only needs to be encrypted. */
    plainPrefix?: string;
}

/** Prefix of an account data key sealed only with the viewing key, not yet with the key ring. */
export const BARE_VIEWING_KEY_SEAL_PREFIX = 'vk1:';

export const ENVELOPE_COLUMNS: readonly CiphertextColumn[] = [
    { entity: 'midnight.WalletSessions', table: 'midnight_WalletSessions', key: 'ID', column: 'encryptedViewingKey', select: ['sessionId'], binding: r => walletSessionViewingKeyBinding(r.sessionId) },
    { entity: 'midnight.WalletSessions', table: 'midnight_WalletSessions', key: 'ID', column: 'encryptedSeedKey', select: ['sessionId'], binding: r => walletSessionSeedBinding(r.sessionId) },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', key: 'ID', column: 'command', where: { commandEncoding: 'aes-gcm-v1' }, whereSql: "commandEncoding = 'aes-gcm-v1'", binding: r => jobCommandBinding(r.ID) },
    { entity: 'midnight.AccountKeys', table: 'midnight_AccountKeys', key: 'accountId', column: 'wrappedDek', binding: r => accountDekBinding(r.accountId) },
    { entity: 'midnight.AccountKeys', table: 'midnight_AccountKeys', key: 'accountId', column: 'wrappedDekByViewingKey', binding: r => accountDekViewingKeySealBinding(r.accountId), plainPrefix: BARE_VIEWING_KEY_SEAL_PREFIX },
    { entity: 'midnight.HolderDisclosureGrants', table: 'midnight_HolderDisclosureGrants', key: 'ID', column: 'content', binding: r => holderDisclosureContentBinding(r.ID) }
];

/** Tables whose rows use the per-account data key when `keyScheme` is 'dek1', and the legacy scheme when it is null. */
export const DEK_TABLES = [
    { entity: 'midnight.PrivateStates', table: 'midnight_PrivateStates', what: 'private state row(s)' },
    { entity: 'midnight.ContractSigningKeys', table: 'midnight_ContractSigningKeys', what: 'signing key(s)' },
    { entity: 'midnight.WalletSyncStates', table: 'midnight_WalletSyncStates', what: 'sync-state row(s)' }
] as const;

/** The key id at the start of a stored value. Null for a value sealed only with the viewing key. */
export function keyIdFromPrefix(prefix: string): string | null {
    if (prefix.startsWith(BARE_VIEWING_KEY_SEAL_PREFIX)) return null;
    for (const version of [BOUND_ENVELOPE_VERSION, ENVELOPE_VERSION]) {
        const head = `${version}:`;
        if (!prefix.startsWith(head)) continue;
        const end = prefix.indexOf(':', head.length);
        return end > head.length ? prefix.slice(head.length, end) : prefix.slice(head.length);
    }
    return LEGACY_KEY_ID;
}

/** The key ids used in each encrypted column. Only the first characters of each value are read. */
export async function scanStoredKeyIds(db: DbService): Promise<Array<{ column: CiphertextColumn; keyIds: string[] }>> {
    const out: Array<{ column: CiphertextColumn; keyIds: string[] }> = [];
    for (const column of ENVELOPE_COLUMNS) {
        const where = [`${column.column} IS NOT NULL`, column.whereSql].filter(Boolean).join(' AND ');
        const rows: Array<Record<string, unknown>> = await db.run(
            `SELECT DISTINCT substr(${column.column}, 1, 24) AS prefix FROM ${column.table} WHERE ${where}`
        );
        const ids = new Set<string>();
        for (const r of (Array.isArray(rows) ? rows : [])) {
            const prefix = String(r.prefix ?? r.PREFIX ?? '');
            const id = prefix ? keyIdFromPrefix(prefix) : null;
            if (id) ids.add(id);
        }
        out.push({ column, keyIds: [...ids].sort() });
    }
    return out;
}

export interface LegacyRowCensus {
    tables: Array<{ entity: string; what: string; rows: number; accounts: number }>;
    accounts: string[];
    total: number;
}

/** Counts legacy rows. Reads only, decrypts nothing. */
export async function countLegacyRows(db: DbService): Promise<LegacyRowCensus> {
    const tables: LegacyRowCensus['tables'] = [];
    const accounts = new Set<string>();
    let total = 0;
    for (const t of DEK_TABLES) {
        const rows: Array<Record<string, unknown>> = await db.run(
            `SELECT accountId AS accountId, count(*) AS n FROM ${t.table} WHERE keyScheme IS NULL GROUP BY accountId`
        );
        let n = 0; let a = 0;
        for (const r of (Array.isArray(rows) ? rows : [])) {
            const id = String(r.accountId ?? r.ACCOUNTID ?? '');
            const count = Number(r.n ?? r.N ?? 0);
            if (!id || !count) continue;
            accounts.add(id); a++; n += count;
        }
        tables.push({ entity: t.entity, what: t.what, rows: n, accounts: a });
        total += n;
    }
    return { tables, accounts: [...accounts].sort(), total };
}

/**
 * Fails when a stored value uses a key id that is not in the ring.
 * Otherwise a seed that cannot be decrypted would look like a missing seed.
 * Legacy rows only cause a warning.
 */
export async function assertStoredKeyIdsKnown(db: DbService, ring: KeyRing = getEncryptionKey(), opts: { reportLegacy?: boolean } = {}): Promise<void> {
    const unknown = new Map<string, string[]>();
    for (const { column, keyIds } of await scanStoredKeyIds(db)) {
        for (const id of keyIds) {
            if (!ring.has(id)) unknown.set(id, [...(unknown.get(id) ?? []), `${column.entity}.${column.column}`]);
        }
    }
    if (unknown.size) {
        const detail = [...unknown].map(([id, cols]) => `'${id}' (${cols.join(', ')})`).join('; ');
        throw new Error(`stored ciphertexts reference encryption key id(s) not in the ring: ${detail}. Add the key to ENCRYPTION_KEYS, or run nightgate-rewrap-keys with the old key still in the ring before removing it.`);
    }
    if (opts.reportLegacy === false) return;   // the rewrap tool prints its own counts
    let census: LegacyRowCensus | undefined;
    try { census = await countLegacyRows(db); } catch (err) {
        // The `keyScheme` column is missing. The schema check reports that separately.
        log.warn(`legacy-row census skipped: ${errorMessage(err)}`);
        return;
    }
    if (census.total > 0) {
        const detail = census.tables.filter(t => t.rows > 0).map(t => `${t.rows} ${t.what} of ${t.accounts} account(s)`).join(', ');
        log.warn(`${census.total} row(s) of ${census.accounts.length} account(s) are still encrypted under a pre-account-key derivation (${detail}); they migrate when their wallet reconnects. Do not remove the encryption key they were written under until nightgate-rewrap-keys reports zero legacy rows.`);
    }
}

export interface RewrapOptions {
    ring?: KeyRing;
    dryRun?: boolean;
    batchSize?: number;
    /** Delete legacy wallet sync data of accounts whose viewing key cannot be read. Those wallets re-sync. Private state and signing keys are never touched. */
    dropLegacySyncState?: boolean;
    log?: (msg: string) => void;
}

export interface RewrapReport {
    activeId: string;
    dryRun: boolean;
    envelope: Array<{ column: string; scanned: number; rewrapped: number; unreadable: number; bySourceKey: Record<string, number> }>;
    syncState: { accounts: number; blobsRewrapped: number; blobsDropped: number; sessionsUnreadable: number };
    privateState: { accounts: number; rowsRewrapped: number; rowsUnreadable: number };
    /** Legacy rows left after this run. A dry run reports the current state. */
    legacy: LegacyRowCensus;
    /** Accounts whose legacy rows were migrated, or could be in a dry run. */
    migratableAccounts: string[];
}

/**
 * Re-encrypts all ring-encrypted values with the active key.
 * Also migrates legacy rows whose viewing key is still available in a wallet session.
 */
export async function rewrapStoredCiphertexts(db: DbService, opts: RewrapOptions = {}): Promise<RewrapReport> {
    const ring = opts.ring ?? getEncryptionKey();
    const dryRun = opts.dryRun === true;
    const batchSize = Math.max(1, opts.batchSize ?? 200);
    const say = opts.log ?? (() => undefined);
    await assertStoredKeyIdsKnown(db, ring, { reportLegacy: false });

    const { SELECT, UPDATE } = cds.ql;
    const report: RewrapReport = {
        activeId: ring.activeId, dryRun, envelope: [],
        syncState: { accounts: 0, blobsRewrapped: 0, blobsDropped: 0, sessionsUnreadable: 0 },
        privateState: { accounts: 0, rowsRewrapped: 0, rowsUnreadable: 0 },
        legacy: { tables: [], accounts: [], total: 0 },
        migratableAccounts: []
    };

    for (const column of ENVELOPE_COLUMNS) {
        const stats = { column: `${column.entity}.${column.column}`, scanned: 0, rewrapped: 0, unreadable: 0, bySourceKey: {} as Record<string, number> };
        let last: string | undefined;
        for (;;) {
            let q = SELECT.from(column.entity).columns(column.key, column.column, ...(column.select ?? []), ...Object.keys(column.where ?? {})).orderBy(column.key).limit(batchSize);
            if (last !== undefined) q = q.where({ [column.key]: { '>': last } });
            const rows: Array<Record<string, any>> = await db.run(q);
            if (!rows?.length) break;
            last = String(rows[rows.length - 1][column.key]);
            const updates: Array<{ id: string; value: string }> = [];
            for (const row of rows) {
                const value = row[column.column];
                if (typeof value !== 'string' || !value) continue;
                if (column.where && !Object.entries(column.where).every(([k, v]) => row[k] === v)) continue;
                stats.scanned++;
                const binding = column.binding(row);
                if (column.plainPrefix && value.startsWith(column.plainPrefix)) {
                    stats.bySourceKey.bare = (stats.bySourceKey.bare ?? 0) + 1;
                    updates.push({ id: String(row[column.key]), value: encrypt(value, ring, binding) });
                    continue;
                }
                const { version, keyId } = inspectCiphertext(value);
                if (version === 3 && keyId === ring.activeId) continue;
                let plain: string;
                try {
                    plain = decrypt(value, ring, binding, { allowUnbound: true });
                } catch (err) {
                    if (err instanceof UnknownEncryptionKeyError) throw err;
                    // Never overwrite an unreadable value.
                    stats.unreadable++;
                    continue;
                }
                stats.bySourceKey[keyId] = (stats.bySourceKey[keyId] ?? 0) + 1;
                updates.push({ id: String(row[column.key]), value: encrypt(plain, ring, binding) });
            }
            if (updates.length && !dryRun) {
                await db.tx(async tx => {
                    for (const u of updates) {
                        const set: Record<string, unknown> = { [column.column]: u.value };
                        if (column.entity === 'midnight.AccountKeys') set.rotatedAt = new Date().toISOString();
                        await tx.run(UPDATE.entity(column.entity).set(set).where({ [column.key]: u.id, ...(column.where ?? {}) }));
                    }
                });
            }
            stats.rewrapped += updates.length;
            if (rows.length < batchSize) break;
        }
        say(`${stats.column}: ${stats.scanned} ciphertext(s), ${stats.rewrapped} ${dryRun ? 'to rewrap' : 'rewrapped'}${Object.keys(stats.bySourceKey).length ? ' from ' + Object.entries(stats.bySourceKey).map(([k, n]) => `'${k}'x${n}`).join(', ') : ''}${stats.unreadable ? `, ${stats.unreadable} unreadable (left as is)` : ''}`);
        report.envelope.push(stats);
    }

    const migrated = await migrateLegacyRows(db, ring, dryRun, report, say);
    await dropLegacySyncStates(db, dryRun, opts.dropLegacySyncState === true, migrated, report, say);
    report.legacy = await countLegacyRows(db);
    report.migratableAccounts = [...migrated].sort();
    const l = report.legacy;
    const unreachable = l.accounts.filter(a => !migrated.has(a));
    if (dryRun && l.total > 0) {
        say(`${l.total} legacy row(s) of ${l.accounts.length} account(s) are under a pre-account-key derivation; a real run migrates ${migrated.size} account(s) through their sessions, ${unreachable.length} account(s) have no session with a readable viewing key and keep their rows.`);
    } else if (l.total > 0) {
        say(`${l.total} legacy row(s) of ${l.accounts.length} account(s) remain under a pre-account-key derivation: ${l.tables.filter(t => t.rows > 0).map(t => `${t.rows} ${t.what}`).join(', ')}; they need the wallet's viewing key (a reconnect migrates them). Keep the key they were written under in the ring.`);
    } else {
        say('no legacy rows remain; every stored value is under the ring or the account keys');
    }
    return report;
}

async function migrateLegacyRows(db: DbService, ring: KeyRing, dryRun: boolean, report: RewrapReport, say: (m: string) => void): Promise<Set<string>> {
    const { SELECT, UPDATE } = cds.ql;
    // Required lazily, so the startup check does not load the wallet worker code.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deriveAccountId, deriveStoragePassword, privateStatePasswordCandidates } = require('../submission/wallet-material-factory') as typeof import('../submission/wallet-material-factory');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { privateStateStableSalt } = require('../midnight/CapDbPrivateStateProvider') as typeof import('../midnight/CapDbPrivateStateProvider');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { deriveStableSalt, syncStatePassphraseCandidates, SALT_LABEL_DEK } = require('../submission/wallet-sync-state-store') as typeof import('../submission/wallet-sync-state-store');

    const sessions: Array<{ sessionId: string; encryptedViewingKey: string | null }> = await db.run(
        SELECT.from('midnight.WalletSessions').columns('sessionId', 'encryptedViewingKey').where({ encryptedViewingKey: { '!=': null } })
    );
    const migrated = new Set<string>();
    const seen = new Set<string>();
    for (const s of sessions ?? []) {
        if (!s.encryptedViewingKey) continue;
        let viewingKey: string;
        try {
            viewingKey = decrypt(s.encryptedViewingKey, ring, walletSessionViewingKeyBinding(s.sessionId), { allowUnbound: true });
        } catch (err) {
            if (err instanceof UnknownEncryptionKeyError) throw err;
            report.syncState.sessionsUnreadable++;
            continue;
        }
        const accountId = deriveAccountId(viewingKey);
        if (seen.has(accountId)) continue;
        seen.add(accountId);
        const storagePassword = deriveStoragePassword(viewingKey);
        let dek: Buffer | null;
        try {
            dek = dryRun
                ? await resolveAccountDek({ db, ring, accountId, storagePassword, create: false, readOnly: true })
                : await resolveAccountDek({ db, ring, accountId, storagePassword, create: true });
        } catch {
            report.syncState.sessionsUnreadable++;
            continue;
        }
        const wouldCreate = !dek;
        const dekPassword = dek ? privateStatePasswordFromDek(dek, accountId) : undefined;
        const dekPassphrase = dek ? syncStatePassphraseFromDek(dek, accountId) : undefined;

        const candidates = privateStatePasswordCandidates(ring, viewingKey).map(c => ({ ...c, salt: privateStateStableSalt(accountId, c.password) }));
        const readers = new Map<string, StorageEncryption>();
        let writer: StorageEncryption | undefined;
        let touched = false;
        for (const table of [
            { entity: 'midnight.PrivateStates', keys: ['accountId', 'contractAddress', 'privateStateId'] },
            { entity: 'midnight.ContractSigningKeys', keys: ['accountId', 'contractAddress'] }
        ]) {
            const rows: Array<Record<string, any>> = await db.run(SELECT.from(table.entity).where({ accountId, keyScheme: null }));
            for (const row of (Array.isArray(rows) ? rows : [])) {
                const blob = row.ciphertext;
                if (typeof blob !== 'string' || !blob) continue;
                touched = true;
                let salt: Buffer;
                try { salt = extractEncryptedComponents(Buffer.from(blob, 'base64')).salt; } catch { report.privateState.rowsUnreadable++; continue; }
                const match = candidates.find(c => c.salt.equals(salt));
                if (!match) { report.privateState.rowsUnreadable++; continue; }
                let plain: string;
                try {
                    let reader = readers.get(match.password);
                    if (!reader) { reader = new StorageEncryption(match.password, match.salt); readers.set(match.password, reader); }
                    plain = reader.decrypt(blob);
                } catch {
                    report.privateState.rowsUnreadable++;
                    continue;
                }
                if (!dryRun && dekPassword) {
                    writer ??= new StorageEncryption(dekPassword, privateStateStableSalt(accountId, dekPassword));
                    const fresh = writer.encrypt(plain);
                    const where = Object.fromEntries(table.keys.map(k => [k, row[k]]));
                    await db.tx(async tx => { await tx.run(UPDATE.entity(table.entity).set({ ciphertext: fresh, keyScheme: DEK_SCHEME, updatedAt: new Date().toISOString() }).where(where)); });
                }
                report.privateState.rowsRewrapped++;
                migrated.add(accountId);
            }
        }
        if (touched) report.privateState.accounts++;
        for (const r of readers.values()) r.clear();
        writer?.clear();

        const row: Record<string, any> | null = await db.run(SELECT.one.from('midnight.WalletSyncStates').where({ accountId }));
        if (row && row.keyScheme !== DEK_SCHEME) {
            report.syncState.accounts++;
            const legacyCandidates = syncStatePassphraseCandidates(ring, storagePassword);
            let blobWriter: StorageEncryption | undefined;
            const set: Record<string, string | null> = {};
            for (const col of ['shieldedStateBlob', 'unshieldedStateBlob', 'dustStateBlob'] as const) {
                const blob = row[col];
                if (typeof blob !== 'string' || !blob) continue;
                let salt: Buffer;
                try { salt = extractEncryptedComponents(Buffer.from(blob, 'base64')).salt; } catch { set[col] = null; report.syncState.blobsDropped++; continue; }
                if (dekPassphrase && deriveStableSalt(accountId, dekPassphrase, SALT_LABEL_DEK).equals(salt)) continue;
                const match = legacyCandidates.find(c => deriveStableSalt(accountId, c.passphrase, c.label).equals(salt));
                let plain: string | undefined;
                if (match) {
                    try { plain = decryptWithPassword(blob, match.passphrase); } catch { plain = undefined; }
                }
                if (plain === undefined) { set[col] = null; report.syncState.blobsDropped++; continue; }
                if (!dryRun && dekPassphrase) {
                    blobWriter ??= new StorageEncryption(dekPassphrase, deriveStableSalt(accountId, dekPassphrase, SALT_LABEL_DEK));
                    set[col] = blobWriter.encrypt(plain);
                }
                report.syncState.blobsRewrapped++;
            }
            if (!dryRun) {
                await db.tx(async tx => { await tx.run(UPDATE.entity('midnight.WalletSyncStates').set({ ...set, keyScheme: DEK_SCHEME }).where({ accountId })); });
            }
            migrated.add(accountId);
            blobWriter?.clear();
        }
        if (wouldCreate && dryRun) migrated.add(accountId);
    }
    const p = report.privateState;
    say(`midnight.PrivateStates + ContractSigningKeys: ${p.accounts} account(s) with legacy rows reachable through a session, ${p.rowsRewrapped} row(s) ${dryRun ? 'to move' : 'moved'} under the account key${p.rowsUnreadable ? `, ${p.rowsUnreadable} unreadable (left as is)` : ''}`);
    const s = report.syncState;
    say(`midnight.WalletSyncStates: ${s.accounts} account(s) with legacy blobs reachable through a session, ${s.blobsRewrapped} blob(s) ${dryRun ? 'to move' : 'moved'} under the account key, ${s.blobsDropped} unreadable blob(s) ${dryRun ? 'to drop' : 'dropped'} (re-sync), ${s.sessionsUnreadable} session(s) with an unreadable viewing key`);
    return migrated;
}

async function dropLegacySyncStates(db: DbService, dryRun: boolean, drop: boolean, migrated: Set<string>, report: RewrapReport, say: (m: string) => void): Promise<void> {
    if (!drop) return;
    const { SELECT, DELETE } = cds.ql;
    const rows: Array<Record<string, any>> = await db.run(SELECT.from('midnight.WalletSyncStates').columns('accountId').where({ keyScheme: null }));
    let dropped = 0;
    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (migrated.has(String(r.accountId))) continue;
        if (!dryRun) {
            await db.tx(async tx => {
                await tx.run(DELETE.from('midnight.WalletSyncStates').where({ accountId: r.accountId }));
            });
        }
        dropped++;
        migrated.add(String(r.accountId));
    }
    report.syncState.blobsDropped += dropped;
    say(`midnight.WalletSyncStates: ${dropped} legacy row(s) of unreachable accounts ${dryRun ? 'to drop' : 'dropped'} (--drop-legacy-sync-state; those wallets re-sync from genesis)`);
}
