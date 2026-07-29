/**
 * Persisted wallet sync-state store.
 *
 * Saves/loads encrypted `serializeState()` snapshots for the three sub-wallets
 * (shielded / unshielded / dust), so a server restart resumes via
 * `XxxWallet.restore(...)` instead of a multi-hour fresh chain scan.
 *
 * Format: each blob is the SDK's `serializeState()` text output, encrypted via
 * storage-encryption.ts (AES-256-GCM). GOTCHA: strings must stay strings
 * end-to-end; feeding a Uint8Array back into `restore(...)` fails the SDK's
 * Effect/Either deserializer with `Either.getOrThrow called on a Left`.
 *
 * Concurrency: ONE global in-process chain serializes all persists (across
 * accounts), and the DB section retries bounded on write contention. Under
 * parallel consumer runs (6+ active facades + foreign commits) interleaved
 * per-account saves kept losing the SQLite write lock into a retry storm. The
 * AES encryption stays OUTSIDE the chain; only the short DB writes are
 * serialized.
 *
 * Key derivation: PBKDF2 runs ONCE per (accountId, passphrase) per process
 * (memoized, async on the libuv threadpool), not once per save. See
 * `getEncryption` below.
 */

import crypto from 'crypto';
import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { WalletSyncStates } from '#cds-models/midnight';
import { StorageEncryption, decryptWithPassword } from '../utils/storage-encryption';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
const log = cds.log('nightgate:sync');

const DEBUG_SYNC = process.env.NIGHTGATE_DEBUG_WALLET_SYNC === 'true';
const dbgSync = (msg: string): void => { if (DEBUG_SYNC) log.debug(msg); };

/**
 * Wallet sub-state blobs from `serializeState()`. SDK returns strings; pass
 * them back to `restore(...)` unchanged.
 */
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
 * One PBKDF2 (600k iterations) per (accountId, passphrase) per process
 * instead of one per save. Same pattern and security rationale as
 * `CapDbPrivateStateProvider.getEncryption()`: the salt is DETERMINISTIC per
 * (accountId, passphrase), so every save reuses the derived key. The
 * passphrase is a high-entropy per-account secret, so a passphrase-derived
 * salt doesn't weaken anti-precomputation. Every blob still carries its salt
 * in the wire header, so `loadSyncState`/`decryptWithPassword` and SDK
 * cross-compat are untouched. Derivation runs async on the libuv threadpool,
 * so even the one-time cost never blocks the event loop.
 *
 * Lifetime: memoized keys are NOT process-lifetime. `evictEncryptionKey`
 * (called from `evictWalletFacade` after the final save) zeroes and drops an
 * account's key on wallet disconnect; `clearAllEncryptionKeys` does the same
 * for every account on plugin shutdown. One entry per accountId, so the cache
 * is bounded by the number of CONNECTED wallets, not ever-connected ones.
 */
interface EncryptionCacheEntry {
    /** Hash of (accountId, passphrase) so a changed passphrase re-derives. */
    passHash: string;
    pending: Promise<StorageEncryption>;
}

const encryptionCache = new Map<string, EncryptionCacheEntry>();

function deriveStableSalt(accountId: string, passphrase: string): Buffer {
    return crypto
        .createHash('sha256')
        .update(`${passphrase}|${accountId}|nightgate-wallet-sync-salt-v1`)
        .digest();
}

function getEncryption(accountId: string, passphrase: string): Promise<StorageEncryption> {
    const passHash = crypto
        .createHash('sha256')
        .update(`${accountId}|${passphrase}`)
        .digest('hex');
    const hit = encryptionCache.get(accountId);
    if (hit && hit.passHash === passHash) return hit.pending;
    if (hit) {
        // Same account, different passphrase: replace, zeroing the old key.
        void hit.pending.then(e => e.clear()).catch(() => undefined);
    }
    const pending = StorageEncryption.createAsync(passphrase, deriveStableSalt(accountId, passphrase));
    encryptionCache.set(accountId, { passHash, pending });
    // A failed derivation must not poison the cache.
    pending.catch(() => {
        if (encryptionCache.get(accountId)?.pending === pending) encryptionCache.delete(accountId);
    });
    return pending;
}

// In-flight saves per account: key eviction must wait for them, or zeroing
// the key mid-encrypt would persist undecryptable blobs (silent cold start
// on the next restore).
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

/**
 * Zeroes and drops the memoized storage key for an account. Awaits the
 * account's in-flight saves first (the disconnect final-save may still be
 * encrypting). The next save for this account, if any, re-derives.
 */
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
}

// ---- Global persist chain -------------------------------------------------

/** All persists queue here, across accounts (see the module docstring). */
let saveChain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bounded retry for the persist's DB section: write contention with foreign
 *  commit traffic (job rows, consumer writes) is transient and the payload
 *  is idempotent, so retrying in place beats waiting for the next 30s tick. */
const SAVE_ATTEMPTS = 3;
const SAVE_BACKOFF_MS = [0, 1500, 4000];

/**
 * Encrypts (if non-null) and persists the wallet sub-states.
 *
 * Idempotent per (accountId): a row is upserted by primary key. All persists
 * are serialized through one global chain and retried on write contention.
 */
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
    // AES of multi-MB blobs stays OUTSIDE the chain; the key is memoized
    // (one async PBKDF2 per account per process, see getEncryption).
    dbgSync(`${callId} resolving encryption key`);
    const t0 = Date.now();
    const enc = await getEncryption(accountId, passphrase);
    const shieldedCipher = states.shielded ? enc.encrypt(states.shielded) : null;
    const unshieldedCipher = states.unshielded ? enc.encrypt(states.unshielded) : null;
    const dustCipher = states.dust ? enc.encrypt(states.dust) : null;
    dbgSync(`${callId} encrypt done in ${Date.now() - t0}ms`);

    const persistOnce = async (): Promise<void> => {
        const now = new Date().toISOString();
        const t1 = Date.now();
        const existing = await db.run(
            SELECT.one.from(WalletSyncStates).where({ accountId })
        );
        dbgSync(`${callId} SELECT done in ${Date.now() - t1}ms, existing=${!!existing}`);

        if (existing) {
            // Preserve previously-stored blobs when this save passes null for
            // a sub-wallet (caller might serialize only what's changed).
            await db.run(
                UPDATE.entity(WalletSyncStates)
                    .set({
                        shieldedStateBlob: shieldedCipher ?? existing.shieldedStateBlob,
                        unshieldedStateBlob: unshieldedCipher ?? existing.unshieldedStateBlob,
                        dustStateBlob: dustCipher ?? existing.dustStateBlob,
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
                if (!/database is locked|SQLITE_BUSY/i.test(msg)) throw e;
                dbgSync(`${callId} write contention (attempt ${attempt + 1}): ${msg.slice(0, 60)}`);
            }
        }
        throw lastErr;
    };

    dbgSync(`${callId} queued (accountId=${accountId.slice(0, 16)})`);
    const next = saveChain.then(work, work);
    // Keep the chain rejection-safe so one failed save never wedges the rest.
    saveChain = next.catch(() => undefined);
    await next;
}

/**
 * Loads and decrypts persisted sub-states for an account.
 *
 * Returns `null` when:
 *   - no row exists
 *   - the stored `sdkVersion` doesn't match `expectedSdkVersion`
 *   - decryption of any non-null blob fails (wrong passphrase, corruption)
 *
 */
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

    try {
        const result: LoadedSyncState = {};
        if (row.shieldedStateBlob) {
            result.shielded = decryptWithPassword(row.shieldedStateBlob, passphrase);
        }
        if (row.unshieldedStateBlob) {
            result.unshielded = decryptWithPassword(row.unshieldedStateBlob, passphrase);
        }
        if (row.dustStateBlob) {
            result.dust = decryptWithPassword(row.dustStateBlob, passphrase);
        }
        return result;
    } catch {
        return null;
    }
}

/**
 * Resolved SDK version string for the `@midnightntwrk/wallet-sdk-facade`
 * package, read from the installed package's package.json. Pinned at first
 * call so a hot-reload of node_modules doesn't change the answer mid-process.
 */
let resolvedSdkVersion: string | undefined;

export function getWalletSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        // The package's `exports` map exposes neither `./package.json` nor a
        // `require` condition, so require.resolve() throws for both the
        // subpath and the bare specifier. Locate the package.json on disk by
        // walking the module resolution paths instead.
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

/** Test-only: reset the cached db promise so each test gets a fresh handle. */
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
