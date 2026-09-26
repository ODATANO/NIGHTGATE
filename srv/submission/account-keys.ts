/**
 * Random 32-byte DEK per account; private states, signing keys and sync-state blobs use passwords
 * derived from it. Sealed twice: `wrappedDek` (ring v3 envelope, rotatable without the viewing key)
 * and `wrappedDekByViewingKey` (vk1 seal inside a ring envelope: needs both secrets, and a session
 * must prove its viewing key). A DEK whose ring key was removed without a rewrap is lost.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import cds from '@sap/cds';
import { encrypt, decrypt, inspectCiphertext, KeyRing, UnknownEncryptionKeyError, UnboundEnvelopeError } from '../utils/crypto';
import { accountDekBinding, accountDekViewingKeySealBinding } from '../utils/envelope-bindings';

const { SELECT, INSERT, UPDATE } = cds.ql;
const ENTITY = 'midnight.AccountKeys';

/** Marker on rows encrypted under a DEK-derived password. */
export const DEK_SCHEME = 'dek1';

const DEK_LENGTH = 32;
const VK_SEAL_VERSION = 'vk1';
const VK_SEAL_INFO = 'nightgate/account-dek/vk-seal/v1';
const VK_SEAL_SALT = 'nightgate-account-dek';
const PRIVATE_STATE_DEK_INFO = 'nightgate/private-state/dek/v1';
const SYNC_STATE_DEK_INFO = 'nightgate/sync-state/dek/v1';

type Runner = { run: (q: any) => Promise<any> };

export class AccountDekUnavailableError extends Error {
    constructor(accountId: string, reason: string) {
        super(`account key for ${accountId.slice(0, 16)} cannot be opened: ${reason}`);
        this.name = 'AccountDekUnavailableError';
    }
}

// ---- Seals ------------------------------------------------------------------------

function vkSealKey(storagePassword: string): Buffer {
    return Buffer.from(crypto.hkdfSync('sha256', storagePassword, VK_SEAL_SALT, VK_SEAL_INFO, 32));
}

/** Seal the DEK under the viewing-key-derived storage password: `vk1:<iv>:<tag>:<data>`. */
export function sealDekByStoragePassword(dek: Buffer, storagePassword: string): string {
    const key = vkSealKey(storagePassword);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(VK_SEAL_VERSION));
    const data = Buffer.concat([cipher.update(dek), cipher.final()]);
    key.fill(0);
    return [VK_SEAL_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Open a `vk1` seal. Throws on a wrong password or a damaged value. */
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

/** True for a bare `vk1:` seal written before the ring wrapped it. */
export function isBareViewingKeySeal(stored: string): boolean {
    return String(stored).startsWith(`${VK_SEAL_VERSION}:`);
}

/** `vk1` seal wrapped in a ring envelope bound to the account: either secret alone opens nothing. */
export function sealDekByViewingKey(dek: Buffer, storagePassword: string, ring: KeyRing, accountId: string): string {
    return encrypt(sealDekByStoragePassword(dek, storagePassword), ring, accountDekViewingKeySealBinding(accountId));
}

/** Open the ring envelope (a bare `vk1:` seal is accepted as is), then the storage password seal. */
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

/** Password of the CAP-DB private-state rows (PrivateStates, ContractSigningKeys). */
export function privateStatePasswordFromDek(dek: Buffer, accountId: string): string {
    return dekPassword(dek, accountId, PRIVATE_STATE_DEK_INFO);
}

/** Passphrase of the wallet sync-state blobs. */
export function syncStatePassphraseFromDek(dek: Buffer, accountId: string): string {
    return dekPassword(dek, accountId, SYNC_STATE_DEK_INFO);
}

// ---- Resolution ---------------------------------------------------------------------

const cache = new Map<string, { dek: Buffer; keyId: string; passwordHash: string | null }>();
// One resolution per account. A cache write is accepted only while its token is current,
// so an eviction during the resolution leaves nothing resident.
const inflight = new Map<string, { promise: Promise<Buffer | null>; token: symbol }>();

function storeDek(accountId: string, entry: { dek: Buffer; keyId: string; passwordHash: string | null }, token: symbol): void {
    if (inflight.get(accountId)?.token !== token) {
        // Evicted while resolving; the caller keeps its own copy.
        entry.dek.fill(0);
        return;
    }
    cache.set(accountId, entry);
}

/** Zero and drop one account's cached DEK (wallet disconnect, facade eviction). */
export function evictAccountDek(accountId: string): void {
    const e = cache.get(accountId);
    if (e) e.dek.fill(0);
    cache.delete(accountId);
    inflight.delete(accountId);   // the running resolution's token is gone: its result is not cached
}

/** Zero and drop every cached DEK (plugin shutdown, tests). */
export function clearAllAccountDeks(): void {
    for (const e of cache.values()) e.dek.fill(0);
    cache.clear();
    inflight.clear();
}

/** Resolutions in flight (monitoring, tests); bounds the bookkeeping. */
export function inflightAccountDekCount(): number {
    return inflight.size;
}

/** Number of accounts with a resident DEK (monitoring, tests). */
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
    /** Viewing-key-derived storage password: opens the second seal and creates a missing DEK. */
    storagePassword?: string;
    /** Create the DEK when the account has none (needs `storagePassword`). Default true. */
    create?: boolean;
    /** Open only: a seal under an inactive key or a bare viewing-key seal is left as stored. Default false. */
    readOnly?: boolean;
}

/**
 * The account's DEK from cache, ring seal or viewing-key seal; re-sealed under the active key once opened.
 * Null only when the account has none and none may be created.
 */
export async function resolveAccountDek(args: ResolveAccountDekArgs): Promise<Buffer | null> {
    const { accountId, storagePassword } = args;
    const cached = cache.get(accountId);
    if (cached && cached.keyId === args.ring.activeId) {
        // A presented storage password must match, cache hit or not.
        if (storagePassword && cached.passwordHash && cached.passwordHash !== passwordHash(storagePassword)) {
            throw new AccountDekUnavailableError(accountId, 'the viewing key does not match the account key');
        }
        return Buffer.from(cached.dek);   // callers get a copy; the cache zeroes its own on eviction
    }
    // Concurrent first saves of one wallet must share one key, each in its own buffer:
    // a caller zeroes its copy after use.
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
                // The seal's own ring key missing is not a wrong viewing key.
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
            // Ring opened it, but the viewing key belongs to another wallet.
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
                // Rotate the outer envelope with the ring; the inner seal stays.
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
        // Concurrent create: the first insert wins, re-read it.
        dek.fill(0);
        const again: Record<string, any> | null = await db.run(SELECT.one.from(ENTITY).where({ accountId }));
        if (!again?.wrappedDek) throw err;
        return resolveUncached(args, token);
    }
    const copy = Buffer.from(dek);
    storeDek(accountId, { dek, keyId: ring.activeId, passwordHash: passwordHash(storagePassword) }, token);
    return copy;
}

/** Key id the stored ring seal names, without opening it (rewrap reporting). */
export function accountDekKeyId(row: { wrappedDek?: string | null }): string | null {
    if (!row?.wrappedDek) return null;
    try { return inspectCiphertext(row.wrappedDek).keyId; } catch { return null; }
}
