/**
 * Each account has a random 32-byte data key (DEK). The passwords for its private state,
 * signing keys and saved wallet state are derived from it.
 * The DEK is stored twice. `wrappedDek` is encrypted with the server's key ring, the set of
 * server encryption keys, so it can be re-encrypted without the viewing key.
 * `wrappedDekByViewingKey` needs both the server key and the viewing key, so a session must prove its viewing key.
 * If a server key is removed before its DEKs were re-encrypted, those DEKs are lost.
 */

import crypto from 'node:crypto';
import cds from '@sap/cds';
import { encrypt, decrypt, inspectCiphertext, KeyRing, UnknownEncryptionKeyError, UnboundEnvelopeError } from '../utils/crypto';
import { accountDekBinding, accountDekViewingKeySealBinding } from '../utils/envelope-bindings';
import type { DbRunner } from '../utils/db-types';
import { NightgateError } from '../utils/errors';

const { SELECT, INSERT, UPDATE } = cds.ql;
const ENTITY = 'midnight.AccountKeys';

/** Marks rows encrypted with a password derived from the DEK. */
export const DEK_SCHEME = 'dek1';

const DEK_LENGTH = 32;
const VK_SEAL_VERSION = 'vk1';
const VK_SEAL_INFO = 'nightgate/account-dek/vk-seal/v1';
const VK_SEAL_SALT = 'nightgate-account-dek';
const PRIVATE_STATE_DEK_INFO = 'nightgate/private-state/dek/v1';
const SYNC_STATE_DEK_INFO = 'nightgate/sync-state/dek/v1';

type Runner = DbRunner;

export class AccountDekUnavailableError extends NightgateError {
    constructor(accountId: string, reason: string) {
        super('ACCOUNT_KEY_UNAVAILABLE', `account key for ${accountId.slice(0, 16)} cannot be opened: ${reason}`);
    }
}

// ---- Encrypting the DEK ------------------------------------------------------------

function vkSealKey(storagePassword: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', storagePassword, VK_SEAL_SALT, VK_SEAL_INFO, 32));
}

/** Encrypts the DEK with the storage password derived from the viewing key: `vk1:<iv>:<tag>:<data>`. */
export function sealDekByStoragePassword(dek: Buffer, storagePassword: string): string {
    const key = vkSealKey(storagePassword);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(VK_SEAL_VERSION));
    const data = Buffer.concat([cipher.update(dek), cipher.final()]);
    key.fill(0);
    return [VK_SEAL_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function openDekByStoragePassword(sealed: string, storagePassword: string): Buffer {
    const parts = String(sealed).split(':');
    if (parts.length !== 4 || parts[0] !== VK_SEAL_VERSION) throw new Error('Invalid account key seal: expected vk1:iv:tag:data');
    const key = vkSealKey(storagePassword);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(VK_SEAL_VERSION));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
        const dek = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
        if (dek.length !== DEK_LENGTH) throw new Error(`Invalid account key length: ${dek.length}`);
        return dek;
    } finally {
        key.fill(0);
    }
}

/** True for an older `vk1:` value that is not yet wrapped with a server key. */
export function isBareViewingKeySeal(stored: string): boolean {
    return String(stored).startsWith(`${VK_SEAL_VERSION}:`);
}

/** Encrypts the DEK with the viewing key, then with a server key. Neither key alone can open it. */
export function sealDekByViewingKey(dek: Buffer, storagePassword: string, ring: KeyRing, accountId: string): string {
    return encrypt(sealDekByStoragePassword(dek, storagePassword), ring, accountDekViewingKeySealBinding(accountId));
}

/** Removes the server-key layer, if present, then decrypts with the storage password. */
export function openDekByViewingKey(stored: string, storagePassword: string, ring: KeyRing, accountId: string): Buffer {
    const inner = isBareViewingKeySeal(stored) ? stored : decrypt(stored, ring, accountDekViewingKeySealBinding(accountId));
    return openDekByStoragePassword(inner, storagePassword);
}

function wrapDek(dek: Buffer, ring: KeyRing, accountId: string): string {
    return encrypt(dek.toString('hex'), ring, accountDekBinding(accountId));
}

function unwrapDek(wrapped: string, ring: KeyRing, accountId: string): Buffer {
    const hex = decrypt(wrapped, ring, accountDekBinding(accountId));
    const dek = Buffer.from(hex, 'hex');
    if (dek.length !== DEK_LENGTH) throw new Error(`Invalid account key length: ${dek.length}`);
    return dek;
}

// ---- Derived passwords ---------------------------------------------------------------

function dekPassword(dek: Buffer, accountId: string, info: string): string {
    return Buffer.from(crypto.hkdfSync('sha256', dek, accountId, info, 32)).toString('hex');
}

/** Password for the private-state rows in the database (PrivateStates, ContractSigningKeys). */
export function privateStatePasswordFromDek(dek: Buffer, accountId: string): string {
    return dekPassword(dek, accountId, PRIVATE_STATE_DEK_INFO);
}

/** Passphrase for the saved wallet sync state. */
export function syncStatePassphraseFromDek(dek: Buffer, accountId: string): string {
    return dekPassword(dek, accountId, SYNC_STATE_DEK_INFO);
}

// ---- Lookup and cache ---------------------------------------------------------------

const cache = new Map<string, { dek: Buffer; keyId: string; passwordHash: string | null }>();
// One lookup per account at a time. Its result is cached only if its token is still current,
// so a key evicted during the lookup does not come back.
const inflight = new Map<string, { promise: Promise<Buffer | null>; token: symbol }>();

function storeDek(accountId: string, entry: { dek: Buffer; keyId: string; passwordHash: string | null }, token: symbol): void {
    if (inflight.get(accountId)?.token !== token) {
        // Evicted during the lookup. The caller still has its own copy.
        entry.dek.fill(0);
        return;
    }
    cache.set(accountId, entry);
}

export function evictAccountDek(accountId: string): void {
    const e = cache.get(accountId);
    if (e) e.dek.fill(0);
    cache.delete(accountId);
    inflight.delete(accountId);   // a lookup still running will not cache its result
}

export function clearAllAccountDeks(): void {
    for (const e of cache.values()) e.dek.fill(0);
    cache.clear();
    inflight.clear();
}

export function inflightAccountDekCount(): number {
    return inflight.size;
}

export function residentAccountDekCount(): number {
    return cache.size;
}

function passwordHash(storagePassword: string): string {
    return crypto.createHash('sha256').update(storagePassword).digest('hex');
}

export interface ResolveAccountDekArgs {
    db: Runner;
    ring: KeyRing;
    accountId: string;
    /** Storage password derived from the viewing key. Needed to open the second copy and to create a DEK. */
    storagePassword?: string;
    /** Create the DEK when the account has none (needs `storagePassword`). Default true. */
    create?: boolean;
    /** Only read. Stored values under an older key are not re-encrypted. Default false. */
    readOnly?: boolean;
}

/**
 * Returns the account's DEK and re-encrypts stored copies that use an older server key.
 * Null only when the account has none and none may be created.
 */
export async function resolveAccountDek(args: ResolveAccountDekArgs): Promise<Buffer | null> {
    const { accountId, storagePassword } = args;
    const cached = cache.get(accountId);
    if (cached && cached.keyId === args.ring.activeId) {
        // A given storage password must match, even when the key is cached.
        if (storagePassword && cached.passwordHash && cached.passwordHash !== passwordHash(storagePassword)) {
            throw new AccountDekUnavailableError(accountId, 'the viewing key does not match the account key');
        }
        return Buffer.from(cached.dek);   // a copy, since the cache wipes its own buffer on eviction
    }
    // Parallel first saves of one wallet must get the same key. Each gets its own
    // buffer, because callers wipe their copy after use.
    let pending = inflight.get(accountId);
    if (!pending) {
        const token = Symbol(accountId);
        const promise = resolveUncached(args, token).finally(() => { if (inflight.get(accountId)?.token === token) inflight.delete(accountId); });
        pending = { promise, token };
        inflight.set(accountId, pending);
    }
    return pending.promise.then(dek => (dek ? Buffer.from(dek) : dek));
}

async function resolveUncached(args: ResolveAccountDekArgs, token: symbol): Promise<Buffer | null> {
    const { db, ring, accountId, storagePassword } = args;
    const create = args.create !== false;

    const row: Record<string, any> | null = await db.run(SELECT.one.from(ENTITY).where({ accountId }));
    if (row?.wrappedDek) {
        let dek: Buffer | undefined;
        let ringError: unknown;
        try {
            dek = unwrapDek(row.wrappedDek, ring, accountId);
        } catch (err) {
            if (err instanceof UnboundEnvelopeError) throw err;
            ringError = err;
        }
        let vkOpens: boolean | undefined;
        let vkUnknownKey: UnknownEncryptionKeyError | undefined;
        if (storagePassword && row.wrappedDekByViewingKey) {
            try {
                const viaVk = openDekByViewingKey(row.wrappedDekByViewingKey, storagePassword, ring, accountId);
                vkOpens = !dek || viaVk.equals(dek);
                dek ??= viaVk;
            } catch (err) {
                if (err instanceof UnboundEnvelopeError) throw err;
                // A missing server key does not mean the viewing key is wrong.
                if (err instanceof UnknownEncryptionKeyError) vkUnknownKey = err;
                else vkOpens = false;
            }
        }
        if (!dek) {
            const missing = ringError instanceof UnknownEncryptionKeyError ? ringError : vkUnknownKey;
            const reason = missing
                ? `it is sealed under encryption key id '${missing.keyId}', which is not in the ring`
                : storagePassword ? 'neither the ring nor the viewing key opens it' : 'the ring does not open it and no viewing key is at hand';
            throw new AccountDekUnavailableError(accountId, reason);
        }
        if (vkOpens === false) {
            // The server key opened it, but the viewing key belongs to another wallet.
            throw new AccountDekUnavailableError(accountId, 'the viewing key does not match the account key');
        }
        const { keyId, version } = inspectCiphertext(row.wrappedDek);
        const set: Record<string, unknown> = {};
        if (keyId !== ring.activeId || version !== 3 || ringError) {
            set.wrappedDek = wrapDek(dek, ring, accountId);
        }
        if (storagePassword && !row.wrappedDekByViewingKey) {
            set.wrappedDekByViewingKey = sealDekByViewingKey(dek, storagePassword, ring, accountId);
        } else if (row.wrappedDekByViewingKey && isBareViewingKeySeal(row.wrappedDekByViewingKey)) {
            set.wrappedDekByViewingKey = encrypt(row.wrappedDekByViewingKey, ring, accountDekViewingKeySealBinding(accountId));
        } else if (row.wrappedDekByViewingKey && !vkUnknownKey) {
            const sealed = inspectCiphertext(row.wrappedDekByViewingKey);
            if (sealed.keyId !== ring.activeId) {
                // Re-encrypt only the outer server-key layer. The viewing-key layer stays.
                set.wrappedDekByViewingKey = encrypt(
                    decrypt(row.wrappedDekByViewingKey, ring, accountDekViewingKeySealBinding(accountId)),
                    ring, accountDekViewingKeySealBinding(accountId));
            }
        }
        if (Object.keys(set).length && !args.readOnly) {
            set.rotatedAt = new Date().toISOString();
            await db.run(UPDATE.entity(ENTITY).set(set).where({ accountId }));
        }
        const copy = Buffer.from(dek);
        storeDek(accountId, { dek, keyId: ring.activeId, passwordHash: storagePassword ? passwordHash(storagePassword) : null }, token);
        return copy;
    }
    if (!create || !storagePassword) return null;

    const dek = crypto.randomBytes(DEK_LENGTH);
    const now = new Date().toISOString();
    try {
        await db.run(INSERT.into(ENTITY).entries({
            accountId,
            wrappedDek: wrapDek(dek, ring, accountId),
            wrappedDekByViewingKey: sealDekByViewingKey(dek, storagePassword, ring, accountId),
            createdAt: now,
            rotatedAt: null
        }));
    } catch (err) {
        // Another request created the key first. Read that one.
        dek.fill(0);
        const again: Record<string, any> | null = await db.run(SELECT.one.from(ENTITY).where({ accountId }));
        if (!again?.wrappedDek) throw err;
        return resolveUncached(args, token);
    }
    const copy = Buffer.from(dek);
    storeDek(accountId, { dek, keyId: ring.activeId, passwordHash: passwordHash(storagePassword) }, token);
    return copy;
}

/** The server key id a stored DEK was encrypted with, read without decrypting. */
export function accountDekKeyId(row: { wrappedDek?: string | null }): string | null {
    if (!row?.wrappedDek) return null;
    try { return inspectCiphertext(row.wrappedDek).keyId; } catch { return null; }
}
