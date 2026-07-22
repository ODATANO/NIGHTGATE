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
    type WalletInitArgs
} from '../midnight/wallet-worker-client';
import {
    saveSyncState,
    loadSyncState,
    getWalletSdkVersion
} from './wallet-sync-state-store';
import { formatErr } from '../utils/format-error';
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

const sessionRegistry = new Map<string, SessionRecord>();

/**
 * Initialise a wallet for `cacheKey` via the worker. Idempotent: subsequent calls
 * for the same cacheKey hit the worker's cache. Returns a placeholder shape whose
 * `.facade`/`.keys.*` methods throw if hit (unmigrated paths fail loudly).
 */
export async function getOrBuildWalletFacade(
    cacheKey: string,
    args: WalletFacadeBuildArgs
): Promise<{ facade: any; zswapKeys: any; dustKey: any; unshieldedKeystore: any }> {
    // Attempt to restore from CAP-persisted state (plain `db.run(SELECT)`).
    let restoreBlobs: { shielded?: string; unshielded?: string; dust?: string } | undefined;
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
    }

    const initArgs: WalletInitArgs = {
        sessionId:      cacheKey,
        seedHex:        args.seedHex,
        networkId:      args.networkId,
        indexerHttpUrl: args.indexerHttpUrl,
        indexerWsUrl:   args.indexerWsUrl,
        proofServerUrl: args.proofServerUrl,
        relayUrl:       args.relayUrl,
        restoreBlobs
    };

    const result = await walletInit(initArgs);
    dbgSync(
        `worker init ok for ${cacheKey.slice(0, 16)}: ` +
        `alreadyExisted=${result.alreadyExisted} sdk=${result.sdkVersion ?? '?'}`
    );

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
        sessionRegistry.delete(cacheKey);
    }
}

export function getCacheSize(): number {
    return sessionRegistry.size;
}

export function clearAllFacades(): void {
    sessionRegistry.clear();
}

/**
 * Wire the worker → main-thread `state-save` events to standard CAP
 * `db.run(...)` via `saveSyncState`. Call ONCE at plugin init AFTER
 * `startWalletWorker()` has resolved.
 */
export function wireWorkerStateSaveSink(): void {
    setStateSaveSink(async event => {
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
    });
}
