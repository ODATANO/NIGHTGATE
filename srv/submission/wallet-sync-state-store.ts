/**
 * Encrypted `serializeState()` snapshots of the three sub-wallets. Blobs must stay strings
 * end to end: a Uint8Array fed back into `restore(...)` fails the SDK deserializer.
 * All DB writes run through one global chain; encryption stays outside it.
 */

import crypto from 'crypto';
import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { WalletSyncStates } from '#cds-models/midnight';
import { StorageEncryption, decryptWithPassword, extractEncryptedComponents } from '../utils/storage-encryption';
import { getEncryptionKey, deriveBoundSecret, type KeyRing } from '../utils/crypto';
import { resolveAccountDek, syncStatePassphraseFromDek, clearAllAccountDeks, DEK_SCHEME } from './account-keys';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { isLockContention } from './db-write-retry';
import { configFlag } from '../utils/config';
const log = cds.log('nightgate:sync');

const DEBUG_SYNC = configFlag('NIGHTGATE_DEBUG_WALLET_SYNC');
const dbgSync = (msg: string): void => { if (DEBUG_SYNC) log.debug(msg); };

/** Sub-state strings from `serializeState()`, passed back to `restore(...)` unchanged. */
export interface SerializedWalletStates {
    shielded?: string | null;
    unshielded?: string | null;
    dust?: string | null;
}

export interface SaveSyncStateArgs {
    accountId: string;
    passphrase: string;
    sdkVersion: string;
    states: SerializedWalletStates;
    networkId?: string;
    seedFingerprint?: string;
}

export interface LoadSyncStateArgs {
    accountId: string;
    passphrase: string;
    expectedSdkVersion: string;
    expectedNetworkId?: string;
    expectedSeedFingerprint?: string;
}

export interface LoadedSyncState {
    shielded?: string;
    unshielded?: string;
    dust?: string;
    /** Row updatedAt of the snapshot. */
    savedAt?: string | null;
}

// ---- DB handle cache ------------------------------------------------------
let dbPromise: Promise<cds.DatabaseService> | null = null;

async function getDb(): Promise<cds.DatabaseService> {
    if (!dbPromise) {
        dbPromise = (async () => {
            await ensureNightgateModelLoaded();
            return cds.connect.to('db');
        })();
    }
    return dbPromise;
}

// ---- Memoized per-account encryption --------------------------------------

/**
 * One async PBKDF2 per (accountId, passphrase) per process. The salt is deterministic, which is
 * safe only because the passphrase is a high-entropy per-account secret; blobs still carry it.
 * Keys are zeroed on disconnect and shutdown, so the cache holds connected wallets only.
 */
interface EncryptionCacheEntry {
    /** Hash of (accountId, effective passphrase) so a changed passphrase or key re-derives. */
    passHash: string;
    pending: Promise<StorageEncryption>;
}

const encryptionCache = new Map<string, EncryptionCacheEntry>();

/**
 * Blobs are written under a passphrase from the account DEK (account-keys.ts). Legacy blobs
 * (label v2 = ring key + passphrase, v1 = passphrase only) stay readable and are rewritten at the next save.
 */
const SYNC_STATE_INFO = 'nightgate/sync-state/v2';
const SALT_LABEL_V1 = 'nightgate-wallet-sync-salt-v1';
const SALT_LABEL_V2 = 'nightgate-wallet-sync-salt-v2';
/** Blobs under the account DEK (account-keys.ts); the row is marked `keyScheme = 'dek1'`. */
export const SALT_LABEL_DEK = 'nightgate-wallet-sync-salt-dek1';

function boundPassphrase(ring: KeyRing, keyId: string, passphrase: string): string {
    return deriveBoundSecret(ring, keyId, passphrase, SYNC_STATE_INFO).toString('hex');
}

/** Salt in the blob header: names the derivation the blob was written with. */
export function deriveStableSalt(accountId: string, passphrase: string, label: string = SALT_LABEL_V2): Buffer {
    return crypto
        .createHash('sha256')
        .update(`${passphrase}|${accountId}|${label}`)
        .digest();
}

/** Read-only legacy passphrases of a blob (ring keys, active first, then pre-ring); shared with the rewrap tool. */
export function syncStatePassphraseCandidates(ring: KeyRing, passphrase: string): Array<{ keyId: string | null; passphrase: string; label: string; legacy: boolean }> {
    const out = [ring.activeId, ...ring.ids().filter(i => i !== ring.activeId)].map(id => ({
        keyId: id as string | null, passphrase: boundPassphrase(ring, id, passphrase), label: SALT_LABEL_V2, legacy: false
    }));
    out.push({ keyId: null, passphrase, label: SALT_LABEL_V1, legacy: true });
    return out;
}

function getEncryption(accountId: string, passphrase: string): Promise<StorageEncryption> {
    const passHash = crypto
        .createHash('sha256')
        .update(`${accountId}|${passphrase}`)
        .digest('hex');
    const hit = encryptionCache.get(accountId);
    if (hit && hit.passHash === passHash) return hit.pending;
    if (hit) {
        void hit.pending.then(e => e.clear()).catch(() => undefined);
    }
    const pending = StorageEncryption.createAsync(passphrase, deriveStableSalt(accountId, passphrase, SALT_LABEL_DEK));
    encryptionCache.set(accountId, { passHash, pending });
    // A failed derivation must not poison the cache.
    pending.catch(() => {
        if (encryptionCache.get(accountId)?.pending === pending) encryptionCache.delete(accountId);
    });
    return pending;
}

// Key eviction waits for these: zeroing mid-encrypt would persist undecryptable blobs.
const inFlightSaves = new Map<string, Set<Promise<void>>>();

function trackInFlightSave(accountId: string, p: Promise<void>): void {
    let set = inFlightSaves.get(accountId);
    if (!set) {
        set = new Set();
        inFlightSaves.set(accountId, set);
    }
    const tracked = set;
    tracked.add(p);
    const untrack = (): void => {
        tracked.delete(p);
        if (tracked.size === 0 && inFlightSaves.get(accountId) === tracked) {
            inFlightSaves.delete(accountId);
        }
    };
    p.then(untrack, untrack);
}

/** Zero and drop an account's memoized storage key, after its in-flight saves settle. */
export async function evictEncryptionKey(accountId: string): Promise<void> {
    const pending = inFlightSaves.get(accountId);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);
    const hit = encryptionCache.get(accountId);
    if (!hit) return;
    encryptionCache.delete(accountId);
    try {
        (await hit.pending).clear();
    } catch {
        // Derivation failed; there is no key to zero.
    }
}

/** Zeroes and drops ALL memoized storage keys (plugin shutdown). */
export async function clearAllEncryptionKeys(): Promise<void> {
    await Promise.allSettled([...encryptionCache.keys()].map(evictEncryptionKey));
    clearAllAccountDeks();
}

// ---- Global persist chain -------------------------------------------------

let saveChain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The upsert is idempotent, so write contention is retried in place.
const SAVE_ATTEMPTS = 3;
const SAVE_BACKOFF_MS = [0, 1500, 4000];

/** Encrypt and upsert the sub-states; serialized through the global chain. */
export function saveSyncState(args: SaveSyncStateArgs): Promise<void> {
    const p = saveSyncStateInner(args);
    if (args.accountId) trackInFlightSave(args.accountId, p);
    return p;
}

async function saveSyncStateInner(args: SaveSyncStateArgs): Promise<void> {
    const { accountId, passphrase, sdkVersion, states, networkId, seedFingerprint } = args;
    if (!accountId) throw new Error('saveSyncState: accountId is required');
    if (!passphrase) throw new Error('saveSyncState: passphrase is required');
    if (!sdkVersion) throw new Error('saveSyncState: sdkVersion is required');

    const db = await getDb();

    const callId = Math.random().toString(36).slice(2, 8);
    // Encryption of multi-MB blobs stays outside the chain.
    dbgSync(`${callId} resolving encryption key`);
    const t0 = Date.now();
    const ring = getEncryptionKey();
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword: passphrase });
    if (!dek) throw new Error('saveSyncState: the account key could not be resolved');
    const dekPassphrase = syncStatePassphraseFromDek(dek, accountId);
    const enc = await getEncryption(accountId, dekPassphrase);
    const shieldedCipher = states.shielded ? enc.encrypt(states.shielded) : null;
    const unshieldedCipher = states.unshielded ? enc.encrypt(states.unshielded) : null;
    const dustCipher = states.dust ? enc.encrypt(states.dust) : null;
    dbgSync(`${callId} encrypt done in ${Date.now() - t0}ms`);

    // The row is marked `dek1` as a whole, so untouched legacy blobs are re-encrypted
    // and unreadable ones dropped (that sub-wallet re-syncs).
    const carry = (blob: string | null | undefined): string | null => {
        if (!blob) return null;
        const plain = decryptSyncBlob(accountId, blob, passphrase, ring, dekPassphrase);
        return plain === null ? null : (plain.underDek ? blob : enc.encrypt(plain.text));
    };

    const persistOnce = async (): Promise<void> => {
        const now = new Date().toISOString();
        const t1 = Date.now();
        const existing = await db.run(
            SELECT.one.from(WalletSyncStates).where({ accountId })
        );
        dbgSync(`${callId} SELECT done in ${Date.now() - t1}ms, existing=${!!existing}`);

        if (existing) {
            // A null sub-state keeps the stored blob.
            await db.run(
                UPDATE.entity(WalletSyncStates)
                    .set({
                        shieldedStateBlob: shieldedCipher ?? carry(existing.shieldedStateBlob),
                        unshieldedStateBlob: unshieldedCipher ?? carry(existing.unshieldedStateBlob),
                        dustStateBlob: dustCipher ?? carry(existing.dustStateBlob),
                        keyScheme: DEK_SCHEME,
                        sdkVersion,
                        networkId: networkId ?? existing.networkId,
                        seedFingerprint: seedFingerprint ?? existing.seedFingerprint,
                        updatedAt: now
                    })
                    .where({ accountId })
            );
        } else {
            await db.run(
                INSERT.into(WalletSyncStates).entries({
                    accountId,
                    shieldedStateBlob: shieldedCipher,
                    unshieldedStateBlob: unshieldedCipher,
                    dustStateBlob: dustCipher,
                    keyScheme: DEK_SCHEME,
                    sdkVersion,
                    networkId: networkId ?? null,
                    seedFingerprint: seedFingerprint ?? null,
                    createdAt: now,
                    updatedAt: now
                })
            );
        }
    };

    const work = async (): Promise<void> => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
            if (SAVE_BACKOFF_MS[attempt]) await sleep(SAVE_BACKOFF_MS[attempt]);
            try {
                await persistOnce();
                dbgSync(`${callId} chain complete (attempt ${attempt + 1})`);
                return;
            } catch (e) {
                lastErr = e;
                const msg = String((e as Error)?.message ?? e);
                if (!isLockContention(e)) throw e;
                dbgSync(`${callId} write contention (attempt ${attempt + 1}): ${msg.slice(0, 60)}`);
            }
        }
        throw lastErr;
    };

    dbgSync(`${callId} queued (accountId=${accountId.slice(0, 16)})`);
    const next = saveChain.then(work, work);
    // One failed save must not wedge the chain.
    saveChain = next.catch(() => undefined);
    await next;
}

/** Load and decrypt an account's sub-states; null (cold start) on any mismatch or unreadable blob. */
export async function loadSyncState(args: LoadSyncStateArgs): Promise<LoadedSyncState | null> {
    const { accountId, passphrase, expectedSdkVersion, expectedNetworkId, expectedSeedFingerprint } = args;
    if (!accountId) throw new Error('loadSyncState: accountId is required');
    if (!passphrase) throw new Error('loadSyncState: passphrase is required');
    if (!expectedSdkVersion) throw new Error('loadSyncState: expectedSdkVersion is required');

    const db = await getDb();
    const row = await db.run(
        SELECT.one.from(WalletSyncStates).where({ accountId })
    );
    if (!row) return null;

    if (row.sdkVersion !== expectedSdkVersion) {
        return null;
    }

    if (expectedNetworkId && row.networkId && row.networkId !== expectedNetworkId) {
        log.warn(
            `refusing restore for ${accountId.slice(0, 16)}: ` +
            `stored networkId '${row.networkId}' != expected '${expectedNetworkId}' (cold start)`
        );
        return null;
    }
    if (expectedSeedFingerprint && row.seedFingerprint && row.seedFingerprint !== expectedSeedFingerprint) {
        log.warn(
            `refusing restore for ${accountId.slice(0, 16)}: ` +
            `stored seed fingerprint does not match the session's seed (cold start)`
        );
        return null;
    }

    const ring = getEncryptionKey();
    // A load never creates the DEK.
    let dekPassphrase: string | undefined;
    try {
        const dek = await resolveAccountDek({ db, ring, accountId, storagePassword: passphrase, create: false });
        if (dek) dekPassphrase = syncStatePassphraseFromDek(dek, accountId);
    } catch (err) {
        log.warn(`sync state for ${accountId.slice(0, 16)}: ${String((err as Error)?.message ?? err)}; starting from a cold sync`);
        return null;
    }
    const result: LoadedSyncState = { savedAt: row.updatedAt ?? null };
    const blobs: Array<[keyof Pick<LoadedSyncState, 'shielded' | 'unshielded' | 'dust'>, string | null | undefined]> = [
        ['shielded', row.shieldedStateBlob],
        ['unshielded', row.unshieldedStateBlob],
        ['dust', row.dustStateBlob]
    ];
    for (const [name, blob] of blobs) {
        if (!blob) continue;
        const plain = decryptSyncBlob(accountId, blob, passphrase, ring, dekPassphrase);
        if (plain === null) return null;
        result[name] = plain.text;
    }
    return result;
}

const legacyBlobNoted = new Set<string>();
const unreadableBlobNoted = new Set<string>();

/**
 * Open one blob; its header salt selects the derivation (DEK, then legacy). Null means
 * no cached state, never a crash. `underDek`: the blob may be carried over unchanged.
 */
function decryptSyncBlob(accountId: string, blob: string, passphrase: string, ring: KeyRing, dekPassphrase?: string): { text: string; underDek: boolean } | null {
    let salt: Buffer;
    try {
        salt = extractEncryptedComponents(Buffer.from(blob, 'base64')).salt;
    } catch {
        return null;
    }
    if (dekPassphrase && deriveStableSalt(accountId, dekPassphrase, SALT_LABEL_DEK).equals(salt)) {
        try { return { text: decryptWithPassword(blob, dekPassphrase), underDek: true }; } catch { return null; }
    }
    for (const c of syncStatePassphraseCandidates(ring, passphrase)) {
        if (!deriveStableSalt(accountId, c.passphrase, c.label).equals(salt)) continue;
        try {
            const plain = decryptWithPassword(blob, c.passphrase);
            if (!legacyBlobNoted.has(accountId)) {
                legacyBlobNoted.add(accountId);
                log.info(`sync state for ${accountId.slice(0, 16)} predates the account key; it is rewritten under it at the next save`);
            }
            return { text: plain, underDek: false };
        } catch {
            return null;
        }
    }
    if (!unreadableBlobNoted.has(accountId)) {
        unreadableBlobNoted.add(accountId);
        log.warn(`sync state for ${accountId.slice(0, 16)} was written under an encryption key that is not in the ring; starting from a cold sync`);
    }
    return null;
}

/** Installed wallet-sdk-facade version, pinned at first call. */
let resolvedSdkVersion: string | undefined;

export function getWalletSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        // The package's `exports` map blocks require.resolve() of package.json; walk the resolution paths.
        let pkgPath: string | undefined;
        const searchDirs = require.resolve.paths('@midnightntwrk/wallet-sdk-facade') ?? [];
        for (const dir of searchDirs) {
            const candidate = path.join(dir, '@midnightntwrk', 'wallet-sdk-facade', 'package.json');
            if (fs.existsSync(candidate)) { pkgPath = candidate; break; }
        }
        if (!pkgPath) throw new Error('package.json not located');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        resolvedSdkVersion = `wallet-sdk-facade@${pkg.version}`;
    } catch {
        resolvedSdkVersion = 'wallet-sdk-facade@unknown';
    }
    return resolvedSdkVersion;
}

/** Test-only. */
export function __resetDbHandleForTests(): void {
    dbPromise = null;
}

/** Test-only: synchronously drop all memoized derived keys (zeroing async). */
export function __resetEncryptionCacheForTests(): void {
    for (const { pending } of encryptionCache.values()) {
        void pending.then(e => e.clear()).catch(() => undefined);
    }
    encryptionCache.clear();
}

/** Test-only: number of memoized derived keys. */
export function __getEncryptionCacheSizeForTests(): number {
    return encryptionCache.size;
}
