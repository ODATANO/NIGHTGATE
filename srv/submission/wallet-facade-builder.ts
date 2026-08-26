/**
 * WalletFacade orchestration, main-thread side.
 *
 * The real `WalletFacade` lives in a `worker_threads` worker (see
 * `srv/midnight/wallet-worker.ts`): the wallet SDK's Effect.ts Fiber scheduler
 * monopolises Node's microtask queue during a chain sync, so it stays off the
 * main thread. This builder is a thin glue layer:
 *
 *   1. Load persisted sub-state blobs from `midnight.WalletSyncStates`.
 *   2. Tell the worker to `init(sessionId, seedHex, ..., restoreBlobs?)`.
 *   3. Record that this session has an active facade in the worker.
 *
 * Periodic state-save: the worker pushes `{state-save, sessionId, blobs}` events
 * on `parentPort`; `wireWorkerStateSaveSink()` (below, called once by the plugin
 * lifecycle) persists them via CAP `db.run`.
 *
 * `getOrBuildWalletFacade` returns a stub object whose `.facade`/`.keys` methods
 * throw if called; real balanceTx/submitTx/dust-registration go through the
 * worker-client RPC API directly. `evictWalletFacade` tells the worker to drop
 * and final-save.
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
import { formatErr } from '../utils/format-error';
import { withKeyedLock } from '../utils/keyed-lock';
import cds from '@sap/cds';
const log = cds.log('nightgate:facade');
import nodeCrypto from 'node:crypto';

// Opt-in facade-restore diagnostics (off by default; enable with
// NIGHTGATE_DEBUG_WALLET_SYNC=true). Keeps the plugin quiet on a consumer's stdout.
const DEBUG_SYNC = process.env.NIGHTGATE_DEBUG_WALLET_SYNC === 'true';
const dbgSync = (msg: string): void => { if (DEBUG_SYNC) log.debug(msg); };

export interface WalletFacadeBuildArgs {
    seedHex: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    /** Substrate node RPC URL (`relayURL` in the SDK config). */
    relayUrl: string;
    /**
     * Passphrase used to encrypt persisted sub-state blobs. Same value the
     * caller would pass as `privateStoragePasswordProvider()`. Required for
     * persistence to function; if omitted, restore/save are skipped.
     */
    syncStatePassphrase?: string;
    /**
     * BIP32 account level the seed signs with (default 0). Must match the
     * account the session's viewing key was derived for; sourced from
     * `WalletSessions.accountIndex`, never from ad-hoc caller input.
     */
    accountIndex?: number;
}

/** Stub returned to callers that still expect a `facade` object; throws if a method is actually called. */
const phase2Stub = (op: string) => () => {
    throw new Error(
        `[phase-1 worker migration] ${op} is not yet wired through wallet-worker-client. ` +
        `Re-route this call site to use srv/midnight/wallet-worker-client directly.`
    );
};

const subStub = (label: string): any => ({
    start: phase2Stub(`${label}.start`),
    stop: phase2Stub(`${label}.stop`),
    waitForSyncedState: phase2Stub(`${label}.waitForSyncedState`),
    balanceTransaction: phase2Stub(`${label}.balanceTransaction`),
    serializeState: phase2Stub(`${label}.serializeState`)
});

const facadeStub: any = {
    state: phase2Stub('facade.state'),
    waitForSyncedState: phase2Stub('facade.waitForSyncedState'),
    submitTransaction: phase2Stub('facade.submitTransaction'),
    balanceUnboundTransaction: phase2Stub('facade.balanceUnboundTransaction'),
    finalizeRecipe: phase2Stub('facade.finalizeRecipe'),
    registerNightUtxosForDustGeneration: phase2Stub('facade.registerNightUtxosForDustGeneration'),
    revert: phase2Stub('facade.revert'),
    stop: phase2Stub('facade.stop'),
    shielded:   subStub('shielded'),
    unshielded: subStub('unshielded'),
    dust:       subStub('dust')
};

interface SessionRecord {
    /** Passphrase needed to encrypt periodic state-save events. */
    passphrase: string;
    /** AccountId (same as cacheKey) used as DB key. */
    accountId: string;
    /** Network the facade was built for; persisted with every save so a
     *  restore on a different network cold-starts instead of poisoning. */
    networkId: string;
    /** HMAC fingerprint of the signing seed; persisted with every save so a
     *  restore with a DIFFERENT seed (blobs of wallet A into a facade running
     *  wallet B's keys) cold-starts instead of corrupting. */
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
 * What we know about a wallet, which is TWO things with different lifetimes.
 *
 * `sessionRegistry` holds the material a persisted save needs: passphrase,
 * network, seed fingerprint. `residentAccounts` records that a facade for the
 * account is alive INSIDE the worker right now.
 *
 * They were one map, and that was wrong in both directions. A worker crash
 * takes every facade with it, so residency has to be dropped; but state-save
 * events the worker already delivered can still be queued behind a slow DB
 * write, and dropping the passphrase with the residency made those saves fail
 * to resolve a session and be discarded. The worker is dead by then and cannot
 * resend, so the next start restored an older snapshot and cold-resynced the
 * part in between. Persistence material therefore outlives the worker; only
 * the residency claim dies with it.
 */
const sessionRegistry = new Map<string, SessionRecord>();
const residentAccounts = new Set<string>();

/**
 * Origin of the resident facade (0.21.0): restored from a persisted sync
 * snapshot (delta since `snapshotSavedAt`, minutes) or cold-started (hours).
 * Surfaced by getWalletSyncProgress; dropped with the facade.
 */
export interface FacadeOrigin {
    restoredFromSnapshot: boolean;
    snapshotSavedAt: string | null;
    /** When this process started building the facade, before the worker init. */
    buildStartedAt: string;
    /** When the worker finished building it; null while the snapshot is still deserialising. */
    builtAt: string | null;
}
const facadeOrigins = new Map<string, FacadeOrigin>();

export function getFacadeOrigin(cacheKey: string): FacadeOrigin | null {
    return facadeOrigins.get(cacheKey) ?? null;
}

/** State-save handlers currently writing, so a planned stop can wait for them. */
const savesInFlight = new Set<Promise<void>>();

onWorkerGone(async (reason) => {
    if (residentAccounts.size > 0) {
        log.info(`worker ${reason}: dropping ${residentAccounts.size} facade residency claim(s)`);
        residentAccounts.clear();
    }
    // The origins describe facades that died with the worker; a stale entry
    // would keep the next build from registering its own.
    facadeOrigins.clear();
    if (reason === 'exit') {
        // A crash cannot be waited on, and saves the worker already delivered
        // may still be queued behind a slower write. Their passphrases have to
        // stay until they resolve, because a dead worker cannot resend.
        return;
    }
    // An intentional stop CAN wait. Finish the queued writes, then release the
    // storage passphrases: keeping them would leave credentials of closed
    // sessions referenced for the life of the process, and a shutdown followed
    // by a re-initialise in the same process is a normal thing to do.
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
 * Initialise a wallet for `cacheKey` via the worker. Idempotent: subsequent calls
 * for the same cacheKey hit the worker's cache. Returns a placeholder shape whose
 * `.facade`/`.keys.*` methods throw if hit (unmigrated paths fail loudly).
 *
 * Runs under the per-account keyed lock so a build cannot interleave with a
 * shared-session eviction decision for the same account (the session sweep /
 * disconnect check "is anyone still using this facade?" and must not tear
 * down a facade that is being (re)built concurrently).
 */
export function getOrBuildWalletFacade(
    cacheKey: string,
    args: WalletFacadeBuildArgs
): Promise<{ facade: any; zswapKeys: any; dustKey: any; unshieldedKeystore: any }> {
    return withKeyedLock(cacheKey, () => buildWalletFacadeLocked(cacheKey, args));
}

async function buildWalletFacadeLocked(
    cacheKey: string,
    args: WalletFacadeBuildArgs
): Promise<{ facade: any; zswapKeys: any; dustKey: any; unshieldedKeystore: any }> {
    // Attempt to restore from CAP-persisted state (plain `db.run(SELECT)`).
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
        // Recorded once per build; a facade the worker already had keeps the
        // origin of the build that created it.
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
        // No facade came of it; drop the early origin.
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

    // Residency is claimed for EVERY facade the worker built, whether or not
    // the caller asked for persistence: a status surface must see a wallet
    // that is warm, and persistence is a separate concern below.
    residentAccounts.add(cacheKey);

    if (args.syncStatePassphrase) {
        sessionRegistry.set(cacheKey, {
            passphrase:      args.syncStatePassphrase,
            accountId:       cacheKey,
            networkId:       args.networkId,
            seedFingerprint
        });
    }

    return {
        facade:             facadeStub,
        zswapKeys:          { clear: () => undefined, __phase2: true },
        dustKey:            { __phase2: true },
        unshieldedKeystore: { __phase2: true }
    };
}

/**
 * Tell the worker to drop and final-save the facade for this cacheKey.
 */
export async function evictWalletFacade(cacheKey: string): Promise<void> {
    // Evict FIRST, delete the registry entry AFTER: the worker's final
    // `state-save` push arrives while the evict RPC is in flight, and the
    // save sink drops events whose session is no longer registered. Deleting
    // up front made the final save deterministically lost; this order lets
    // it persist.
    try {
        await walletEvict(cacheKey);
    } catch (err) {
        log.warn(`evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
    } finally {
        residentAccounts.delete(cacheKey);
        facadeOrigins.delete(cacheKey);
        sessionRegistry.delete(cacheKey);
        // Registry entry is gone, so the save sink drops any NEW save for this
        // account; now the memoized storage key can go. evictEncryptionKey
        // awaits the account's in-flight saves (the final save above may still
        // be encrypting) before zeroing, so no blob is garbled mid-encrypt.
        try {
            await evictEncryptionKey(cacheKey);
        } catch (err) {
            log.warn(`key evict failed for ${cacheKey.slice(0, 16)}:`, formatErr(err));
        }
    }
}

/**
 * Is a facade for this account resident RIGHT NOW? A pure in-memory read that
 * builds nothing, for status surfaces that must report on wallets without
 * creating work for the worker.
 *
 * The sync-progress cache is not a substitute: the worker only pushes progress
 * snapshots while a sync WAIT is running, so a facade restored from persisted
 * state that was already at the tip is fully usable and never reported any
 * progress at all (live-observed on the hosted sponsor pool).
 */
export function hasWalletFacade(cacheKey: string): boolean {
    return residentAccounts.has(cacheKey);
}

/**
 * Every account whose facade is resident right now, for status surfaces. Same
 * caveat as `hasWalletFacade`: the sync-progress cache under-reports, because
 * a facade restored at the tip never pushes a snapshot, so a warm pool can
 * look empty. This registry is the authority on what the process holds.
 */
export function listWalletFacades(): string[] {
    return [...residentAccounts];
}

/** Test-only: residency size probe (no production caller). */
export function __getCacheSizeForTests(): number {
    return residentAccounts.size;
}

/**
 * Test-only: how many accounts carry PERSISTENCE material. Distinct from
 * residency on purpose: a facade built without a passphrase is warm but not
 * persisted, and a facade whose worker died is persisted but not warm.
 */
export function __getPersistenceSizeForTests(): number {
    return sessionRegistry.size;
}

/** Test-only: reset both maps between tests (no production caller). */
export function __clearAllFacadesForTests(): void {
    residentAccounts.clear();
    facadeOrigins.clear();
    sessionRegistry.clear();
}

/**
 * Wire the worker → main-thread `state-save` events to standard CAP
 * `db.run(...)` via `saveSyncState`. Call ONCE at plugin init AFTER
 * `startWalletWorker()` has resolved.
 */
export function wireWorkerStateSaveSink(): void {
    // Every handler is tracked while it runs, so a planned stop can drain them
    // before releasing the passphrases they need.
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
            // The session was evicted between save scheduling and arrival,
            // OR it was never registered (e.g. caller didn't pass
            // syncStatePassphrase to getOrBuildWalletFacade).
            log.warn(
                `DROPPED save for ${event.sessionId.slice(0, 16)}: ` +
                `no session in registry (known: [${Array.from(sessionRegistry.keys()).map(k => k.slice(0, 16)).join(',')}])`
            );
            // Throw so the drop is NOT acked: the worker keeps the blobs
            // marked unsaved and retries on a later tick.
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
            // Rethrow so the worker-client does NOT ack this save; the worker
            // keeps its lastSavedBlobs stale and re-pushes on the next tick.
            throw err;
        }
    }
}
