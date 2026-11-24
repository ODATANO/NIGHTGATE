// Startup check that every stored encryption key id is in the key ring, plus the tool `scripts/rewrap-encryption-keys.mjs`.
// The tool re-encrypts every ring-encrypted value with the active key. It needs no wallet secret.
// SPDX-License-Identifier: Apache-2.0

import cds from '@sap/cds';
import {
    decrypt, encrypt, inspectCiphertext, getEncryptionKey, UnknownEncryptionKeyError, KeyRing, BOUND_ENVELOPE_VERSION, EnvelopeBinding
} from './crypto';
import {
    walletSessionViewingKeyBinding, walletSessionSeedBinding, jobCommandBinding, accountDekBinding, accountDekViewingKeySealBinding,
    holderDisclosureContentBinding
} from './envelope-bindings';
import type { DbService } from './db-types';

export interface CiphertextColumn {
    entity: string;
    table: string;
    key: string;
    column: string;
    where?: Record<string, unknown>;
    whereSql?: string;
    binding: (row: Record<string, unknown>) => EnvelopeBinding;
}

export const ENVELOPE_COLUMNS: readonly CiphertextColumn[] = [
    { entity: 'midnight.WalletSessions', table: 'midnight_WalletSessions', key: 'sessionId', column: 'encryptedViewingKey', binding: r => walletSessionViewingKeyBinding(String(r.sessionId)) },
    { entity: 'midnight.WalletSessions', table: 'midnight_WalletSessions', key: 'sessionId', column: 'encryptedSeedKey', binding: r => walletSessionSeedBinding(String(r.sessionId)) },
    { entity: 'midnight.BackgroundJobs', table: 'midnight_BackgroundJobs', key: 'ID', column: 'command', where: { commandEncoding: 'aes-gcm-v1' }, whereSql: "commandEncoding = 'aes-gcm-v1'", binding: r => jobCommandBinding(String(r.ID)) },
    { entity: 'midnight.AccountKeys', table: 'midnight_AccountKeys', key: 'accountId', column: 'wrappedDek', binding: r => accountDekBinding(String(r.accountId)) },
    { entity: 'midnight.AccountKeys', table: 'midnight_AccountKeys', key: 'accountId', column: 'wrappedDekByViewingKey', binding: r => accountDekViewingKeySealBinding(String(r.accountId)) },
    { entity: 'midnight.HolderDisclosureGrants', table: 'midnight_HolderDisclosureGrants', key: 'ID', column: 'content', binding: r => holderDisclosureContentBinding(String(r.ID)) }
];

/** The key id at the start of a stored value. Null for a value in another format. */
export function keyIdFromPrefix(prefix: string): string | null {
    const head = `${BOUND_ENVELOPE_VERSION}:`;
    if (!prefix.startsWith(head)) return null;
    const end = prefix.indexOf(':', head.length);
    return end > head.length ? prefix.slice(head.length, end) : prefix.slice(head.length);
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

/** Fails when a stored value uses a key id that is not in the ring.
 *  Otherwise a seed that cannot be decrypted would look like a missing seed. */
export async function assertStoredKeyIdsKnown(db: DbService, ring: KeyRing = getEncryptionKey()): Promise<void> {
    const unknown = new Map<string, string[]>();
    for (const { column, keyIds } of await scanStoredKeyIds(db)) {
        for (const id of keyIds) {
            if (!ring.has(id)) unknown.set(id, [...(unknown.get(id) ?? []), `${column.entity}.${column.column}`]);
        }
    }
    if (unknown.size) {
        const detail = [...unknown].map(([id, cols]) => `'${id}' (${cols.join(', ')})`).join('; ');
        throw new Error(`stored ciphertexts reference encryption key id(s) not in the ring: ${detail}. Add the key to ENCRYPTION_KEYS, or run scripts/rewrap-encryption-keys.mjs with the old key still in the ring before removing it.`);
    }
}

export interface RewrapOptions {
    ring?: KeyRing;
    dryRun?: boolean;
    batchSize?: number;
    log?: (msg: string) => void;
}

export interface RewrapReport {
    activeId: string;
    dryRun: boolean;
    envelope: Array<{ column: string; scanned: number; rewrapped: number; unreadable: number; bySourceKey: Record<string, number> }>;
}

/** Re-encrypts all ring-encrypted values with the active key. */
export async function rewrapStoredCiphertexts(db: DbService, opts: RewrapOptions = {}): Promise<RewrapReport> {
    const ring = opts.ring ?? getEncryptionKey();
    const dryRun = opts.dryRun === true;
    const batchSize = Math.max(1, opts.batchSize ?? 200);
    const say = opts.log ?? (() => undefined);
    await assertStoredKeyIdsKnown(db, ring);

    const { SELECT, UPDATE } = cds.ql;
    const report: RewrapReport = { activeId: ring.activeId, dryRun, envelope: [] };

    for (const column of ENVELOPE_COLUMNS) {
        const stats = { column: `${column.entity}.${column.column}`, scanned: 0, rewrapped: 0, unreadable: 0, bySourceKey: {} as Record<string, number> };
        let last: string | undefined;
        for (;;) {
            let q = SELECT.from(column.entity).columns(column.key, column.column, ...Object.keys(column.where ?? {})).orderBy(column.key).limit(batchSize);
            if (last !== undefined) q = q.where({ [column.key]: { '>': last } });
            const rows: Array<Record<string, unknown>> = await db.run(q);
            if (!rows?.length) break;
            last = String(rows[rows.length - 1][column.key]);
            const updates: Array<{ id: string; value: string }> = [];
            for (const row of rows) {
                const value = row[column.column];
                if (typeof value !== 'string' || !value) continue;
                if (column.where && !Object.entries(column.where).every(([k, v]) => row[k] === v)) continue;
                stats.scanned++;
                const binding = column.binding(row);
                const { keyId } = inspectCiphertext(value);
                if (keyId === ring.activeId) continue;
                let plain: string;
                try {
                    plain = decrypt(value, ring, binding);
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

    return report;
}
