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
 * CPU-heavy PBKDF2 + AES stays OUTSIDE the chain; only the short DB writes are
 * serialized.
 */

import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
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
    if (!accountId) throw new Error('saveSyncState: accountId is required');
    if (!passphrase) throw new Error('saveSyncState: passphrase is required');
    if (!sdkVersion) throw new Error('saveSyncState: sdkVersion is required');

    const db = await getDb();

    const callId = Math.random().toString(36).slice(2, 8);
    // CPU-heavy crypto (PBKDF2 + AES of multi-MB blobs) stays OUTSIDE the chain.
    dbgSync(`${callId} starting StorageEncryption ctor (PBKDF2)`);
    const t0 = Date.now();
    const enc = new StorageEncryption(passphrase);
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
