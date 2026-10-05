/**
 * Main-thread side of the wallets that run in the wallet worker thread.
 * The worker exists because a syncing SDK wallet would block the main thread.
 * This module hands saved wallet state to the worker and stores the state it sends back.
 */

import {
    walletInit,
    walletEvict,
    setStateSaveSink,
    onWorkerGone,
    type WalletInitArgs
} from '../midnight/wallet-worker-client';
import {
    saveSyncState,
    loadSyncState,
    getWalletSdkVersion,
    evictEncryptionKey
} from './wallet-sync-state-store';
import { evictAccountDek } from './account-keys';
import { formatErr } from '../utils/format-error';
import { withKeyedLock } from '../utils/keyed-lock';
import cds from '@sap/cds';
const log = cds.log('nightgate:facade');
import nodeCrypto from 'node:crypto';
import { configFlag } from '../utils/config';

const DEBUG_SYNC = configFlag('NIGHTGATE_DEBUG_WALLET_SYNC');
const dbgSync = (msg: string): void => { if (DEBUG_SYNC) log.debug(msg); };

export interface WalletFacadeBuildArgs {
    seedHex: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    /** Substrate node RPC URL (`relayURL` in the SDK config). */
    relayUrl: string;
    /** Passphrase for the saved wallet state. Without it nothing is restored or saved. */
    syncStatePassphrase?: string;
    /** BIP32 account index, default 0. Comes from `WalletSessions.accountIndex`, never from the caller. */
    accountIndex?: number;
}

interface SessionRecord {
    passphrase: string;
    accountId: string;
    /** Saved with the state, so a restore on another network starts from scratch. */
    networkId: string;
    /** Saved with the state, so a restore with another seed starts from scratch instead of mixing wallets. */
    seedFingerprint: string;
}

const SEED_FINGERPRINT_LABEL = 'nightgate-seed-fingerprint-v1';

/** Stable, non-reversible fingerprint of the bip39 seed hex. */
export function seedFingerprintOf(seedHex: string): string {
    return nodeCrypto.createHmac('sha256', SEED_FINGERPRINT_LABEL)
        .update(Buffer.from(seedHex, 'hex'))
        .digest('hex');
}

/**
 * `sessionRegistry` holds what a save needs. `residentAccounts` lists the wallets loaded in the worker.
 * A worker crash clears only the second: saves it already sent may still be queued and need the passphrase.
 */
const sessionRegistry = new Map<string, SessionRecord>();
const residentAccounts = new Set<string>();

/** Whether a loaded wallet came from saved state or started from scratch. Shown by getWalletSyncProgress. */
export interface FacadeOrigin {
    restoredFromSnapshot: boolean;
    snapshotSavedAt: string | null;
    buildStartedAt: string;
    /** Null while the worker is still loading the saved state. */
    builtAt: string | null;
}
const facadeOrigins = new Map<string, FacadeOrigin>();

export function getFacadeOrigin(cacheKey: string): FacadeOrigin | null {
    return facadeOrigins.get(cacheKey) ?? null;
}

/** Saves in progress. A planned worker stop waits for them. */
const savesInFlight = new Set<Promise<void>>();

onWorkerGone(async (reason) => {
    if (residentAccounts.size > 0) {
        log.info(`worker ${reason}: dropping ${residentAccounts.size} facade residency claim(s)`);
        residentAccounts.clear();
    }
    // Clear old entries, otherwise the next build would not record its own.
    facadeOrigins.clear();
    if (reason === 'exit') {
        // Crash: keep the passphrases, since queued saves still need them and the worker cannot resend.
        return;
    }
    if (savesInFlight.size > 0) {
        log.info(`worker stop: draining ${savesInFlight.size} state-save(s) before releasing passphrases`);
        await Promise.allSettled([...savesInFlight]);
    }
    if (sessionRegistry.size > 0) {
        log.info(`worker stop: releasing persistence material for ${sessionRegistry.size} account(s)`);
        sessionRegistry.clear();
    }
});

/**
 * Loads the wallet for `cacheKey` into the worker. Safe to call repeatedly.
 * Holds the account lock, so a disconnect cannot remove a wallet while it is being built.
 */
export function getOrBuildWalletFacade(
    cacheKey: string,
    args: WalletFacadeBuildArgs
): Promise<void> {
    return withKeyedLock(cacheKey, () => buildWalletFacadeLocked(cacheKey, args));
}

async function buildWalletFacadeLocked(
    cacheKey: string,
    args: WalletFacadeBuildArgs
): Promise<void> {
    let restoreBlobs: { shielded?: string; unshielded?: string; dust?: string } | undefined;
    let pendingOrigin: FacadeOrigin | undefined;
    const seedFingerprint = seedFingerprintOf(args.seedHex);
    if (args.syncStatePassphrase) {
        const loaded = await loadSyncState({
            accountId:          cacheKey,
            passphrase:         args.syncStatePassphrase,
            expectedSdkVersion: getWalletSdkVersion(),
            expectedNetworkId:  args.networkId,
            expectedSeedFingerprint: seedFingerprint
        });
        if (loaded) {
            restoreBlobs = {
                shielded:   loaded.shielded,
                unshielded: loaded.unshielded,
                dust:       loaded.dust
            };
            dbgSync(
                `restored prior state for ${cacheKey.slice(0, 16)}: ` +
                `shielded=${!!loaded.shielded} unshielded=${!!loaded.unshielded} dust=${!!loaded.dust}`
            );
        } else {
            dbgSync(`no usable prior state for ${cacheKey.slice(0, 16)} (cold start)`);
        }
        // If the worker already has this wallet, the entry of the first build is kept.
        pendingOrigin = {
            restoredFromSnapshot: !!loaded,
            snapshotSavedAt: loaded?.savedAt ?? null,
            buildStartedAt: new Date().toISOString(),
            builtAt: null
        };
    } else {
        pendingOrigin = { restoredFromSnapshot: false, snapshotSavedAt: null, buildStartedAt: new Date().toISOString(), builtAt: null };
    }
    // Record this before the worker starts. Loading a large dust state takes minutes,
    // and the progress report should show it in the meantime.
    const earlyRegistered = !facadeOrigins.has(cacheKey);
    if (earlyRegistered) {
        facadeOrigins.set(cacheKey, pendingOrigin);
        if (pendingOrigin.restoredFromSnapshot) {
            const savedMs = pendingOrigin.snapshotSavedAt ? Date.parse(pendingOrigin.snapshotSavedAt) : NaN;
            const age = Number.isFinite(savedMs) ? `${Math.round((Date.now() - savedMs) / 60_000)} min old` : 'age unknown';
            log.info(`facade ${cacheKey.slice(0, 16)}: sync state RESTORED from snapshot saved ${pendingOrigin.snapshotSavedAt ?? '?'} (${age}); the reconnect applies only the delta since (deserialising the snapshot first)`);
        } else {
            log.info(`facade ${cacheKey.slice(0, 16)}: COLD START, no usable prior sync state; a wallet with history syncs from zero (hours)`);
        }
    }

    const initArgs: WalletInitArgs = {
        sessionId:      cacheKey,
        seedHex:        args.seedHex,
        accountIndex:   args.accountIndex,
        networkId:      args.networkId,
        indexerHttpUrl: args.indexerHttpUrl,
        indexerWsUrl:   args.indexerWsUrl,
        proofServerUrl: args.proofServerUrl,
        relayUrl:       args.relayUrl,
        restoreBlobs
    };

    let result: Awaited<ReturnType<typeof walletInit>>;
    try {
        result = await walletInit(initArgs);
    } catch (err) {
        if (earlyRegistered) facadeOrigins.delete(cacheKey);
        throw err;
    }
    dbgSync(
        `worker init ok for ${cacheKey.slice(0, 16)}: ` +
        `alreadyExisted=${result.alreadyExisted} sdk=${result.sdkVersion ?? '?'}`
    );
    const current = facadeOrigins.get(cacheKey);
    if (current && current.builtAt === null) {
        facadeOrigins.set(cacheKey, { ...current, builtAt: new Date().toISOString() });
        const took = Math.round((Date.now() - Date.parse(current.buildStartedAt)) / 1000);
        log.info(`facade ${cacheKey.slice(0, 16)}: built in ${took}s (${current.restoredFromSnapshot ? 'snapshot deserialised' : 'cold'}), catching up now`);
    }

    // The wallet counts as loaded even when its state is not saved.
    residentAccounts.add(cacheKey);

    if (args.syncStatePassphrase) {
        sessionRegistry.set(cacheKey, {
            passphrase:      args.syncStatePassphrase,
            accountId:       cacheKey,
            networkId:       args.networkId,
            seedFingerprint
        });
    }

}

/** Tells the worker to save one last time and unload the wallet for this cacheKey. */
export async function evictWalletFacade(cacheKey: string): Promise<void> {
    // Remove the registry entry only after the worker call. The final save arrives
    // during that call and would be dropped without the entry.
    try {
        await walletEvict(cacheKey);
    } catch (err) {
        log.warn(`evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
    } finally {
        residentAccounts.delete(cacheKey);
        facadeOrigins.delete(cacheKey);
        sessionRegistry.delete(cacheKey);
        // No new save can arrive now. evictEncryptionKey waits for running saves before wiping the key.
        try {
            await evictEncryptionKey(cacheKey);
            evictAccountDek(cacheKey);
        } catch (err) {
            log.warn(`key evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
        }
    }
}

/**
 * Whether this account's wallet is loaded in the worker. Builds nothing.
 * More reliable than the sync-progress cache, which fills only after the first progress check.
 */
export function hasWalletFacade(cacheKey: string): boolean {
    return residentAccounts.has(cacheKey);
}

export function listWalletFacades(): string[] {
    return [...residentAccounts];
}

/** Test-only. */
export function __getCacheSizeForTests(): number {
    return residentAccounts.size;
}

/** Test-only: accounts that have a passphrase registered, loaded or not. */
export function __getPersistenceSizeForTests(): number {
    return sessionRegistry.size;
}

/** Test-only. */
export function __clearAllFacadesForTests(): void {
    residentAccounts.clear();
    facadeOrigins.clear();
    sessionRegistry.clear();
}

/** Stores the state the worker sends. Call once at plugin start, after `startWalletWorker()` resolved. */
export function wireWorkerStateSaveSink(): void {
    setStateSaveSink(event => {
        const running = handleStateSave(event);
        savesInFlight.add(running);
        return running.finally(() => savesInFlight.delete(running));
    });
}

async function handleStateSave(event: Parameters<Parameters<typeof setStateSaveSink>[0] & object>[0]): Promise<void> {
    {
        const session = sessionRegistry.get(event.sessionId);
        if (!session) {
            log.warn(
                `DROPPED save for ${event.sessionId.slice(0, 16)}: ` +
                `no session in registry (known: [${Array.from(sessionRegistry.keys()).map(k => k.slice(0, 16)).join(',')}])`
            );
            // Throwing tells the worker the save failed, so it keeps the state and retries.
            throw new Error('state-save dropped: session not registered');
        }
        log.debug(`received save for ${event.sessionId.slice(0, 16)}, persisting...`);
        try {
            await saveSyncState({
                accountId:       session.accountId,
                passphrase:      session.passphrase,
                sdkVersion:      event.sdkVersion,
                states:          event.blobs,
                networkId:       session.networkId,
                seedFingerprint: session.seedFingerprint
            });
            const sizes = [
                event.blobs.shielded   ? `sh=${event.blobs.shielded.length}`   : 'sh=-',
                event.blobs.unshielded ? `un=${event.blobs.unshielded.length}` : 'un=-',
                event.blobs.dust       ? `du=${event.blobs.dust.length}`       : 'du=-'
            ].join(' ');
            log.debug(`saved ${event.sessionId.slice(0, 16)} ${sizes}`);
        } catch (err) {
            log.warn(`save failed for ${event.sessionId.slice(0, 16)}:`, formatErr(err));
            // Throwing makes the worker send the state again later.
            throw err;
        }
    }
}
