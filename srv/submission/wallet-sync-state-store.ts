/**
 * Persisted wallet sync-state store.
 *
 * Saves and loads encrypted snapshots of `serializeState()` output for the
 * three wallet sub-wallets (shielded / unshielded / dust). Persisting these
 * lets a server restart resume an existing wallet via `XxxWallet.restore(...)`
 * instead of paying the multi-hour fresh chain scan from genesis.
 *
 * Format: each blob is the SDK's `serializeState()` output, a JSON-ish text
 * string, encrypted via storage-encryption.ts (AES-256-GCM, same wire format
 * as PrivateStates.ciphertext). Strings stay as strings end-to-end: feeding
 * a Uint8Array back into `restore(...)` makes the SDK's Effect/Either
 * deserializer fail with `Either.getOrThrow called on a Left`.
 *
 * DB layer: standard CAP `cds.connect.to('db').run(...)`. The wallet SDK no
 * longer blocks the main thread's microtask queue because it runs in a
 * `worker_threads` worker, so CAP's Promise machinery resolves normally.
 * See `srv/midnight/wallet-worker.ts` and `wallet-worker-client.ts`.
 *
 * Concurrency: ONE global in-process chain serializes all persists (across
 * accounts, which implies per-account), and the DB section retries bounded
 * on write contention. Measured under parallel consumer runs (NIGHTPASS demo
 * pool): with 6+ active facades and concurrent foreign commits, interleaved
 * per-account saves kept losing the SQLite write lock ('database is locked'
 * on every tick) and the re-push turned into a standing retry storm. The
 * CPU-heavy part (PBKDF2 + AES) stays OUTSIDE the chain so only the short
 * DB writes are serialized.
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import { WalletSyncStates } from '#cds-models/midnight';
import { StorageEncryption, decryptWithPassword } from '../utils/storage-encryption';
import { ensureNightgateModelLoaded } from '../utils/cds-model';

// Opt-in per-save timing diagnostics (off by default so the plugin doesn't
// spam a consumer's stdout). Enable with NIGHTGATE_DEBUG_WALLET_SYNC=true.
const DEBUG_SYNC = process.env.NIGHTGATE_DEBUG_WALLET_SYNC === 'true';
const dbgSync = (msg: string): void => { if (DEBUG_SYNC) console.log(msg); };

/**
 * Wallet sub-state blobs from `serializeState()`. SDK returns strings; pass
 * them back to `restore(...)` unchanged.
 */
export interface SerializedWalletStates {
    shielded?:   string | null;
    unshielded?: string | null;
    dust?:       string | null;
}

export interface SaveSyncStateArgs {
    accountId:   string;
    passphrase:  string;
    sdkVersion:  string;
    states:      SerializedWalletStates;
    /** Network the state belongs to (guards cross-network restore). */
    networkId?:  string;
    /** Fingerprint of the signing seed (guards cross-wallet restore). */
    seedFingerprint?: string;
}

export interface LoadSyncStateArgs {
    accountId:        string;
    passphrase:       string;
    expectedSdkVersion: string;
    /** When set and the stored row carries a DIFFERENT networkId, the load
     *  returns null (cold start) instead of restoring cross-network state. */
    expectedNetworkId?: string;
    /** When set and the stored row carries a DIFFERENT seed fingerprint, the
     *  load returns null instead of restoring another wallet's state. */
    expectedSeedFingerprint?: string;
}

export interface LoadedSyncState {
    shielded?:   string;
    unshielded?: string;
    dust?:       string;
}

// ---- DB handle cache ------------------------------------------------------
// Connect once and reuse, same pattern as `srv/crawler/Crawler.ts`. The
// handle is async-initialised lazily on first save/load.

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
export async function saveSyncState(args: SaveSyncStateArgs): Promise<void> {
    const { accountId, passphrase, sdkVersion, states, networkId, seedFingerprint } = args;
    if (!accountId)   throw new Error('saveSyncState: accountId is required');
    if (!passphrase)  throw new Error('saveSyncState: passphrase is required');
    if (!sdkVersion)  throw new Error('saveSyncState: sdkVersion is required');

    const db = await getDb();

    const callId = Math.random().toString(36).slice(2, 8);
    // CPU-heavy crypto OUTSIDE the chain: PBKDF2 + AES of multi-MB blobs may
    // take real milliseconds and needs no serialization.
    dbgSync(`[save-sync-state] ${callId} starting StorageEncryption ctor (PBKDF2)`);
    const t0 = Date.now();
    const enc = new StorageEncryption(passphrase);
    const shieldedCipher   = states.shielded   ? enc.encrypt(states.shielded)   : null;
    const unshieldedCipher = states.unshielded ? enc.encrypt(states.unshielded) : null;
    const dustCipher       = states.dust       ? enc.encrypt(states.dust)       : null;
    dbgSync(`[save-sync-state] ${callId} encrypt done in ${Date.now() - t0}ms`);

    const persistOnce = async (): Promise<void> => {
        const now = new Date().toISOString();
        const t1 = Date.now();
        const existing = await db.run(
            SELECT.one.from(WalletSyncStates).where({ accountId })
        );
        dbgSync(`[save-sync-state] ${callId} SELECT done in ${Date.now() - t1}ms, existing=${!!existing}`);

        if (existing) {
            // Preserve previously-stored blobs when this save passes null for
            // a sub-wallet (caller might serialize only what's changed).
            await db.run(
                UPDATE.entity(WalletSyncStates)
                    .set({
                        shieldedStateBlob:   shieldedCipher   ?? existing.shieldedStateBlob,
                        unshieldedStateBlob: unshieldedCipher ?? existing.unshieldedStateBlob,
                        dustStateBlob:       dustCipher       ?? existing.dustStateBlob,
                        sdkVersion,
                        networkId:           networkId       ?? existing.networkId,
                        seedFingerprint:     seedFingerprint ?? existing.seedFingerprint,
                        updatedAt:           now
                    })
                    .where({ accountId })
            );
        } else {
            await db.run(
                INSERT.into(WalletSyncStates).entries({
                    accountId,
                    shieldedStateBlob:   shieldedCipher,
                    unshieldedStateBlob: unshieldedCipher,
                    dustStateBlob:       dustCipher,
                    sdkVersion,
                    networkId:           networkId ?? null,
                    seedFingerprint:     seedFingerprint ?? null,
                    createdAt:           now,
                    updatedAt:           now
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
                dbgSync(`[save-sync-state] ${callId} chain complete (attempt ${attempt + 1})`);
                return;
            } catch (e) {
                lastErr = e;
                const msg = String((e as Error)?.message ?? e);
                if (!/database is locked|SQLITE_BUSY/i.test(msg)) throw e;
                dbgSync(`[save-sync-state] ${callId} write contention (attempt ${attempt + 1}): ${msg.slice(0, 60)}`);
            }
        }
        throw lastErr;
    };

    dbgSync(`[save-sync-state] ${callId} queued (accountId=${accountId.slice(0, 16)})`);
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
 * A null return triggers the caller to fall back to a fresh `startWith*()`
 * sync from genesis.
 */
export async function loadSyncState(args: LoadSyncStateArgs): Promise<LoadedSyncState | null> {
    const { accountId, passphrase, expectedSdkVersion, expectedNetworkId, expectedSeedFingerprint } = args;
    if (!accountId)         throw new Error('loadSyncState: accountId is required');
    if (!passphrase)        throw new Error('loadSyncState: passphrase is required');
    if (!expectedSdkVersion) throw new Error('loadSyncState: expectedSdkVersion is required');

    const db = await getDb();
    const row = await db.run(
        SELECT.one.from(WalletSyncStates).where({ accountId })
    );
    if (!row) return null;

    if (row.sdkVersion !== expectedSdkVersion) {
        return null;
    }
    // Guard rails: a stored row from a different network or a different seed
    // must NEVER be restored (cross-network/cross-wallet state poisons the
    // facade). Rows written before these columns existed have null and pass.
    if (expectedNetworkId && row.networkId && row.networkId !== expectedNetworkId) {
        console.warn(
            `[load-sync-state] refusing restore for ${accountId.slice(0, 16)}: ` +
            `stored networkId '${row.networkId}' != expected '${expectedNetworkId}' (cold start)`
        );
        return null;
    }
    if (expectedSeedFingerprint && row.seedFingerprint && row.seedFingerprint !== expectedSeedFingerprint) {
        console.warn(
            `[load-sync-state] refusing restore for ${accountId.slice(0, 16)}: ` +
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

/** Removes any persisted state for an account (e.g. on disconnectWallet). */
export async function deleteSyncState(accountId: string): Promise<void> {
    if (!accountId) return;
    const db = await getDb();
    await db.run(
        DELETE.from(WalletSyncStates).where({ accountId })
    );
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
