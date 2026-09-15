/**
 * Main-thread side of the WalletFacade, which lives in the wallet worker (the SDK's
 * scheduler monopolises the microtask queue during a sync). Restores persisted
 * sub-states into the worker and persists the worker's state-save events.
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
    /** Passphrase of the persisted sub-state blobs; without it restore and save are skipped. */
    syncStatePassphrase?: string;
    /** BIP32 account the seed signs with (default 0); from `WalletSessions.accountIndex`, never caller input. */
    accountIndex?: number;
}

interface SessionRecord {
    passphrase: string;
    accountId: string;
    /** Persisted with every save: a restore on another network cold-starts. */
    networkId: string;
    /** Persisted with every save: a restore under another seed cold-starts instead of corrupting. */
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
 * `sessionRegistry`: material a save needs. `residentAccounts`: facades alive in the worker.
 * A worker crash drops residency only; saves it already delivered may still be queued and need the passphrase.
 */
const sessionRegistry = new Map<string, SessionRecord>();
const residentAccounts = new Set<string>();

/** Whether the resident facade was restored from a snapshot or cold-started; surfaced by getWalletSyncProgress. */
export interface FacadeOrigin {
    restoredFromSnapshot: boolean;
    snapshotSavedAt: string | null;
    buildStartedAt: string;
    /** Null while the worker is still deserialising the snapshot. */
    builtAt: string | null;
}
const facadeOrigins = new Map<string, FacadeOrigin>();

export function getFacadeOrigin(cacheKey: string): FacadeOrigin | null {
    return facadeOrigins.get(cacheKey) ?? null;
}

/** Running state-save handlers; a planned stop drains them. */
const savesInFlight = new Set<Promise<void>>();

onWorkerGone(async (reason) => {
    if (residentAccounts.size > 0) {
        log.info(`worker ${reason}: dropping ${residentAccounts.size} facade residency claim(s)`);
        residentAccounts.clear();
    }
    // A stale origin would keep the next build from registering its own.
    facadeOrigins.clear();
    if (reason === 'exit') {
        // Crash: queued saves still need their passphrases, a dead worker cannot resend.
        return;
    }
    // Planned stop: drain the saves, then release the passphrases of closed sessions.
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
 * Initialise the wallet for `cacheKey` in the worker; idempotent. Runs under the per-account
 * lock so a sweep or disconnect cannot evict a facade that is being built.
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
        // A facade the worker already had keeps the origin of the build that created it.
        pendingOrigin = {
            restoredFromSnapshot: !!loaded,
            snapshotSavedAt: loaded?.savedAt ?? null,
            buildStartedAt: new Date().toISOString(),
            builtAt: null
        };
    } else {
        pendingOrigin = { restoredFromSnapshot: false, snapshotSavedAt: null, buildStartedAt: new Date().toISOString(), builtAt: null };
    }
    // Registered before the worker init: deserialising a large dust snapshot
    // takes minutes, and the progress surface reports the origin meanwhile.
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

    // Residency is claimed with or without persistence.
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

/** Tell the worker to drop and final-save the facade for this cacheKey. */
export async function evictWalletFacade(cacheKey: string): Promise<void> {
    // Registry entry is deleted AFTER the evict RPC: the final state-save arrives
    // during it, and the sink drops saves of unregistered sessions.
    try {
        await walletEvict(cacheKey);
    } catch (err) {
        log.warn(`evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
    } finally {
        residentAccounts.delete(cacheKey);
        facadeOrigins.delete(cacheKey);
        sessionRegistry.delete(cacheKey);
        // No new save can arrive now; evictEncryptionKey awaits in-flight saves before zeroing.
        try {
            await evictEncryptionKey(cacheKey);
            evictAccountDek(cacheKey);
        } catch (err) {
            log.warn(`key evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
        }
    }
}

/**
 * Whether a facade for this account is resident; builds nothing. Authoritative, unlike the
 * sync-progress cache, which fills only at the first progress-watch tick.
 */
export function hasWalletFacade(cacheKey: string): boolean {
    return residentAccounts.has(cacheKey);
}

/** Every account with a resident facade (see `hasWalletFacade`). */
export function listWalletFacades(): string[] {
    return [...residentAccounts];
}

/** Test-only. */
export function __getCacheSizeForTests(): number {
    return residentAccounts.size;
}

/** Test-only: accounts carrying persistence material (independent of residency). */
export function __getPersistenceSizeForTests(): number {
    return sessionRegistry.size;
}

/** Test-only. */
export function __clearAllFacadesForTests(): void {
    residentAccounts.clear();
    facadeOrigins.clear();
    sessionRegistry.clear();
}

/** Persist the worker's `state-save` events. Call once at plugin init, after `startWalletWorker()` resolved. */
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
            // Not acked: the worker keeps the blobs unsaved and retries.
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
            // Not acked: the worker re-pushes on the next tick.
            throw err;
        }
    }
}
