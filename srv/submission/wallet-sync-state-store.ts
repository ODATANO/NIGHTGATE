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
 * as PrivateStates.ciphertext). Strings stay as strings end-to-end — feeding
 * a Uint8Array back into `restore(...)` makes the SDK's Effect/Either
 * deserializer fail with `Either.getOrThrow called on a Left`.
 *
 * DB layer: standard CAP `cds.connect.to('db').run(...)`. The wallet SDK no
 * longer blocks the main thread's microtask queue because it runs in a
 * `worker_threads` worker, so CAP's Promise machinery resolves normally.
 * See `srv/midnight/wallet-worker.ts` and `wallet-worker-client.ts`.
 *
 * Concurrency: a per-accountId in-process mutex serializes saves so two
 * overlapping ticks can't race the upsert.
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
}

export interface LoadSyncStateArgs {
    accountId:        string;
    passphrase:       string;
    expectedSdkVersion: string;
}

export interface LoadedSyncState {
    shielded?:   string;
    unshielded?: string;
    dust?:       string;
}

// ---- DB handle cache ------------------------------------------------------
// Connect once and reuse — same pattern as `srv/crawler/Crawler.ts`. The
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

// ---- Per-accountId save mutex --------------------------------------------

const saveMutex = new Map<string, Promise<void>>();

/**
 * Encrypts (if non-null) and persists the wallet sub-states.
 *
 * Idempotent per (accountId): a row is upserted by primary key. Concurrent
 * saves for the same accountId are serialised via the in-process mutex so
 * later writes always win.
 */
export async function saveSyncState(args: SaveSyncStateArgs): Promise<void> {
    const { accountId, passphrase, sdkVersion, states } = args;
    if (!accountId)   throw new Error('saveSyncState: accountId is required');
    if (!passphrase)  throw new Error('saveSyncState: passphrase is required');
    if (!sdkVersion)  throw new Error('saveSyncState: sdkVersion is required');

    const db = await getDb();

    const previous = saveMutex.get(accountId) ?? Promise.resolve();
    const callId = Math.random().toString(36).slice(2, 8);
    dbgSync(`[save-sync-state] ${callId} queued (accountId=${accountId.slice(0, 16)})`);
    const next = previous.then(async () => {
        dbgSync(`[save-sync-state] ${callId} starting StorageEncryption ctor (PBKDF2)`);
        const t0 = Date.now();
        const enc = new StorageEncryption(passphrase);
        dbgSync(`[save-sync-state] ${callId} StorageEncryption ctor done in ${Date.now() - t0}ms`);
        const shieldedCipher   = states.shielded   ? enc.encrypt(states.shielded)   : null;
        const unshieldedCipher = states.unshielded ? enc.encrypt(states.unshielded) : null;
        const dustCipher       = states.dust       ? enc.encrypt(states.dust)       : null;
        dbgSync(`[save-sync-state] ${callId} encrypt done in ${Date.now() - t0}ms`);

        const now = new Date().toISOString();
        const t1 = Date.now();
        const existing = await db.run(
            SELECT.one.from(WalletSyncStates).where({ accountId })
        );
        dbgSync(`[save-sync-state] ${callId} SELECT done in ${Date.now() - t1}ms, existing=${!!existing}`);

        if (existing) {
            const t2 = Date.now();
            // Preserve previously-stored blobs when this save passes null for
            // a sub-wallet (caller might serialize only what's changed).
            await db.run(
                UPDATE.entity(WalletSyncStates)
                    .set({
                        shieldedStateBlob:   shieldedCipher   ?? existing.shieldedStateBlob,
                        unshieldedStateBlob: unshieldedCipher ?? existing.unshieldedStateBlob,
                        dustStateBlob:       dustCipher       ?? existing.dustStateBlob,
                        sdkVersion,
                        updatedAt:           now
                    })
                    .where({ accountId })
            );
            dbgSync(`[save-sync-state] ${callId} UPDATE done in ${Date.now() - t2}ms`);
        } else {
            const t2 = Date.now();
            await db.run(
                INSERT.into(WalletSyncStates).entries({
                    accountId,
                    shieldedStateBlob:   shieldedCipher,
                    unshieldedStateBlob: unshieldedCipher,
                    dustStateBlob:       dustCipher,
                    sdkVersion,
                    createdAt:           now,
                    updatedAt:           now
                })
            );
            dbgSync(`[save-sync-state] ${callId} INSERT done in ${Date.now() - t2}ms`);
        }
        dbgSync(`[save-sync-state] ${callId} chain complete`);
    });

    // The mutex tracks the rejection-safe chain so the next caller waits even
    // if this save throws; the actual `await next` below propagates the throw
    // to the caller.
    const tracked = next.catch(() => undefined);
    saveMutex.set(accountId, tracked);
    try {
        await next;
    } finally {
        if (saveMutex.get(accountId) === tracked) {
            saveMutex.delete(accountId);
        }
    }
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
    const { accountId, passphrase, expectedSdkVersion } = args;
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
 * Resolved SDK version string for the `@midnight-ntwrk/wallet-sdk-facade`
 * package, read from the installed package's package.json. Pinned at first
 * call so a hot-reload of node_modules doesn't change the answer mid-process.
 */
let resolvedSdkVersion: string | undefined;

export function getWalletSdkVersion(): string {
    if (resolvedSdkVersion) return resolvedSdkVersion;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const pkgPath = require.resolve('@midnight-ntwrk/wallet-sdk-facade/package.json');
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
