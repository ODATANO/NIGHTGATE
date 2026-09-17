/**
 * Facade registry lifecycle: build, sync waits, periodic state save with
 * main-thread acks, idle progress watch, per-session submit locks, evict.
 */

// First import on purpose: the worker modules import each other in cycles, and a
// module-level read must come from an import resolved before the cycle re-enters.
import { configMs, configNumber, configFlag } from '../../utils/config';
import path from 'node:path';
import { profileCurrentThread } from '../cpu-profile';
import { formatErr } from '../../utils/format-error';
import { deriveIndexerWsUrl } from '../../utils/indexer-url';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { deriveAttestationSecret } from '../../submission/contract-witnesses';
import { deriveRoleSeeds } from '../../utils/wallet-hd';
import { parentPort } from 'node:worker_threads';
import { FacadeEntry, InitArgs, ensureNetworkId, facades, getSdkVersion, loadProvingSdk, loadSdk, log, resolveProvingMode } from './context';
import { restoreDustFromSnapshot } from './submit';
import { sponsorUnboundTx } from './sponsor';
import {
    ReplayKind, appliedIndexOf, describeSyncState, formatSyncState, lastReplayRejection,
    observeReplayTrack, shouldResetRestoredSubWallet
} from './sync-replay';

// Pre-balance sync bound: a stalled indexer subscription fails the job instead of hanging it.
export const BALANCE_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS');

/** `facade.waitForSyncedState()` never resolves against an indexer that is not caught up, so it is always bounded. */
export async function waitForSyncedStateBounded(entry: FacadeEntry, site: string, timeoutMs?: number): Promise<any> {
    const bound = timeoutMs && timeoutMs > 0 ? timeoutMs : BALANCE_SYNC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            entry.facade.waitForSyncedState(),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${site}: sync timeout after ${bound}ms`)), bound); })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Slack to the dust stream tip, in ledger EVENTS: their ids advance independently of block height.
export const SYNC_TIP_GAP = BigInt(configNumber('NIGHTGATE_SYNC_TIP_GAP'));
// Max age of the indexer's latest block: syncing to a stale tip spends dust whose
// merkle roots have pruned out of the node's root_history (117).
export const SYNC_FRESHNESS_MS = configMs('NIGHTGATE_SYNC_FRESHNESS_MS');
export const SYNC_POLL_MS = 3000;
// How often the catch-up loop reports progress (log line + snapshot refresh).
export const SYNC_PROGRESS_LOG_MS = 15_000;
// Max age of the rate anchor, so the rate reflects current throughput.
export const SYNC_RATE_WINDOW_MS = 60_000;
// A sync whose appliedIndex has not moved for this long is stalled; a sync still
// applying events is slow and runs up to the absolute ceiling. <= 0 disables.
export const SYNC_STALL_MS = configMs('NIGHTGATE_PREWARM_STALL_MS');
// Absolute ceiling for the prewarm wait when the caller passes none; SYNC_STALL_MS is the primary limit.
export const SYNC_CEILING_MS = 12 * 60 * 60 * 1000;
export const wsleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Catch-up progress of one facade, PUSHED to the main thread: an RPC would stall exactly
 * while this thread is busy catching up. Event ids are decimal strings (bigint precision).
 */
export interface SyncProgressSnapshot {
    /** The facade key this snapshot belongs to (the caller's accountId). */
    sessionId: string;
    /** Ledger events applied by the dust sub-wallet so far. '-1' when unknown. */
    appliedIndex: string;
    /** Current tip of the dust ledger-event stream. '-1' when the probe failed. */
    streamTip: string;
    /** streamTip - appliedIndex, or null when either side is unknown. */
    behindEvents: string | null;
    /** Applied events per second over the last ~minute; null until measurable. */
    eventsPerSecond: number | null;
    /** Seconds to reach the tip at the current rate; null when not derivable. */
    etaSeconds: number | null;
    /** Indexer block height, for correlating with the chain. */
    blockHeight: string | null;
    isConnected: boolean;
    /** The indexer's latest block is recent enough to count as tip. */
    indexerFresh: boolean;
    caughtUp: boolean;
    /** Milliseconds this wait has been running. */
    elapsedMs: number;
    /** The wait that produced this snapshot ('prewarm', 'balance', ...). */
    label: string;
    updatedAt: string;
    /** When `appliedIndex` last advanced; unchanged while `updatedAt` moves = stalled, not slow. */
    lastProgressAt: string;
}

export const syncProgress = new Map<string, SyncProgressSnapshot>();

export function pushSyncProgress(snapshot: SyncProgressSnapshot): void {
    parentPort?.postMessage({ kind: 'sync-progress', sessionId: snapshot.sessionId, snapshot });
}

/** The indexer's latest indexed block (height + timestamp, ms epoch). */
export async function getIndexerTip(indexerHttpUrl: string): Promise<{ height: bigint | null; timestampMs: number | null }> {
    try {
        const r = await fetch(indexerHttpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ block { height timestamp } }' }),
            signal: AbortSignal.timeout(15_000)
        });
        const j: any = await r.json();
        const b = j?.data?.block;
        return {
            height: b?.height != null ? BigInt(b.height) : null,
            timestampMs: b?.timestamp != null ? Number(b.timestamp) : null
        };
    } catch { return { height: null, timestampMs: null }; }
}

export type LedgerEventStream = 'dust' | 'zswap';
const STREAM_FIELD: Record<LedgerEventStream, string> = { dust: 'dustLedgerEvents', zswap: 'zswapLedgerEvents' };

// One stream-tip probe per few seconds is plenty for a 3s poll loop.
export const streamTipCache = new Map<LedgerEventStream, { tip: bigint; at: number }>();

/** A failed tip read reuses the last read within this window (`NIGHTGATE_STREAM_TIP_GRACE_MS`, 0 = off). */
export function streamTipGraceMs(): number {
    return configMs('NIGHTGATE_STREAM_TIP_GRACE_MS');
}

/**
 * Stream tip = `maxId` of the first event of a one-shot ws subscription; the only valid target for
 * `appliedIndex` (`progress.highestIndex` stays 0 on public indexers, block end-indices are another
 * series). A failed read falls back to the last read while that is within the grace window: an
 * unknown tip fails the sync gate, and the public indexer drops a few percent of these
 * subscriptions. Null once the fallback has aged out too.
 */
export function getDustStreamTip(indexerHttpUrl: string): Promise<bigint | null> {
    return getLedgerEventStreamTip(indexerHttpUrl, 'dust');
}

export async function getLedgerEventStreamTip(indexerHttpUrl: string, stream: LedgerEventStream): Promise<bigint | null> {
    const cached = streamTipCache.get(stream);
    if (cached && Date.now() - cached.at < 10_000) return cached.tip;
    const field = STREAM_FIELD[stream];
    const wsUrl = deriveIndexerWsUrl(indexerHttpUrl);
    try {
        const { default: WebSocket } = await import('ws');
        const tip = await new Promise<bigint | null>((resolve) => {
            const sock: any = new (WebSocket as any)(wsUrl, 'graphql-transport-ws');
            let settled = false;
            const done = (v: bigint | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { sock.close(); } catch { /* already closed */ }
                resolve(v);
            };
            const timer = setTimeout(() => done(null), 10_000);
            sock.on('open', () => sock.send(JSON.stringify({ type: 'connection_init' })));
            sock.on('message', (buf: Buffer) => {
                try {
                    const m = JSON.parse(buf.toString());
                    if (m.type === 'connection_ack') {
                        sock.send(JSON.stringify({
                            id: '1', type: 'subscribe',
                            payload: { query: `subscription { ${field}(id: 0) { id maxId } }` }
                        }));
                    } else if (m.type === 'next') {
                        const maxId = m.payload?.data?.[field]?.maxId;
                        done(maxId != null ? BigInt(maxId) : null);
                    } else if (m.type === 'error' || m.type === 'complete') {
                        done(null);
                    }
                } catch { done(null); }
            });
            sock.on('error', () => done(null));
            sock.on('close', () => done(null));
        });
        if (tip != null) {
            streamTipCache.set(stream, { tip, at: Date.now() });
            return tip;
        }
        return staleStreamTip(stream, cached);
    } catch { return staleStreamTip(stream, cached); }
}

function staleStreamTip(stream: LedgerEventStream, cached: { tip: bigint; at: number } | undefined): bigint | null {
    const age = cached ? Date.now() - cached.at : Infinity;
    if (!cached || age >= streamTipGraceMs()) return null;
    log('debug', `${stream} stream tip read failed, reusing ${cached.tip} from ${Math.round(age / 1000)}s ago`);
    return cached.tip;
}

/** The sync gate's verdict for one reading: connected, a known stream tip, within SYNC_TIP_GAP of it, and a fresh indexer. */
export function isGenuinelyCaughtUp(r: { connected: boolean; applied: bigint; streamTip: bigint; indexerFresh: boolean }): boolean {
    return r.connected && r.streamTip > 0n && r.applied >= 0n && r.applied >= r.streamTip - SYNC_TIP_GAP && r.indexerFresh;
}

/** One emission of the non-blocking `facade.state()` observable, or null on timeout/error. Never blocks on `waitForSyncedState()`. */
export async function peekFacadeState(facade: any, timeoutMs: number): Promise<any | null> {
    let sub: any;
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            new Promise<any>((res, rej) => {
                try { sub = facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); }
                catch (e) { rej(e); }
            }),
            new Promise<null>(res => { timer = setTimeout(() => res(null), timeoutMs); })
        ]);
    } catch {
        return null;
    } finally {
        try { sub && sub.unsubscribe(); } catch { }
        if (timer) clearTimeout(timer);
    }
}

/** Registered NIGHT UTXOs in a facade state's full unshielded coin set (`totalCoins`). */
export function countRegisteredNightUtxos(state: any): number {
    const all: any[] = state?.unshielded?.totalCoins ?? [];
    return all.filter((c: any) => c?.meta?.registeredForDustGeneration === true).length;
}

/** Every unshielded NIGHT UTXO, registered or not; `fallback` while the state carries no coin set yet. */
export function countAllNightUtxos(state: any, fallback: number): number {
    const all: any[] | undefined = state?.unshielded?.totalCoins;
    return Array.isArray(all) ? all.length : fallback;
}

/**
 * Polls until `isGenuinelyCaughtUp`; `waitForSyncedState()` is not trusted. Fails after `stallMs`
 * without progress or at `timeoutMs`.
 */
export async function waitForGenuineSync(entry: FacadeEntry, timeoutMs: number, label: string, stallMs: number = SYNC_STALL_MS): Promise<void> {
    const { facade, indexerHttpUrl, sessionId } = entry;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastLog = 0;
    let lastApplied = -1n;
    let lastHighest = -1n;
    // The first observation seeds the index without counting as progress.
    let progressApplied = -1n;
    let lastProgressAt = startedAt;
    let anchor: { applied: bigint; at: number } | null = null;

    const publish = (
        applied: bigint, highest: bigint, blockHeight: bigint | null,
        connected: boolean, fresh: boolean, caughtUp: boolean
    ): SyncProgressSnapshot => {
        const now = Date.now();
        let eventsPerSecond: number | null = null;
        if (applied >= 0n) {
            if (!anchor) {
                anchor = { applied, at: now };
            } else if (now - anchor.at >= SYNC_POLL_MS) {
                const seconds = (now - anchor.at) / 1000;
                const delta = Number(applied - anchor.applied);
                // A restored facade can report a lower index right after start.
                if (delta >= 0) eventsPerSecond = delta / seconds;
                if (now - anchor.at >= SYNC_RATE_WINDOW_MS) anchor = { applied, at: now };
            }
        }
        const behind = highest >= 0n && applied >= 0n ? highest - applied : null;
        const snapshot: SyncProgressSnapshot = {
            sessionId,
            appliedIndex: applied.toString(),
            streamTip: highest.toString(),
            behindEvents: behind != null ? behind.toString() : null,
            eventsPerSecond,
            etaSeconds: behind != null && behind > 0n && eventsPerSecond != null && eventsPerSecond > 0
                ? Math.round(Number(behind) / eventsPerSecond)
                : (behind === 0n ? 0 : null),
            blockHeight: blockHeight != null ? blockHeight.toString() : null,
            isConnected: connected,
            indexerFresh: fresh,
            caughtUp,
            elapsedMs: now - startedAt,
            label,
            updatedAt: new Date(now).toISOString(),
            lastProgressAt: new Date(lastProgressAt).toISOString()
        };
        syncProgress.set(sessionId, snapshot);
        return snapshot;
    };

    while (Date.now() < deadline) {
        const tip = await getIndexerTip(indexerHttpUrl);
        // Non-blocking state() observable: it emits the current state immediately.
        let state: any;
        let sub: any;
        let peekTimer: NodeJS.Timeout | undefined;
        let peekFailed = false;
        try {
            state = await Promise.race([
                new Promise<any>((res, rej) => {
                    try { sub = facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); }
                    catch (e) { rej(e); }
                }),
                new Promise((_, rej) => { peekTimer = setTimeout(() => rej(new Error('state peek timeout')), 30_000); })
            ]);
        } catch {
            peekFailed = true;
        } finally {
            // Release on every path: on a stalled indexer the timeout wins each poll.
            try { sub && sub.unsubscribe(); } catch { }
            if (peekTimer) clearTimeout(peekTimer);
        }
        if (peekFailed) {
            // An unreadable state counts as no progress for the stall bound.
            if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
                const last = syncProgress.get(sessionId);
                throw new Error(`wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min and the wallet state is not readable (state peek timed out or failed on every poll; last snapshot: dust appliedIndex=${last?.appliedIndex ?? lastApplied}, streamTip=${last?.streamTip ?? lastHighest}, isConnected=${last?.isConnected ?? '?'}, elapsed=${Math.round((Date.now() - startedAt) / 1000)}s)`);
            }
            await wsleep(SYNC_POLL_MS);
            continue;
        }
        const p: any = state?.dust?.progress;
        const applied = p?.appliedIndex != null ? BigInt(p.appliedIndex) : -1n;
        const streamTip = await getDustStreamTip(indexerHttpUrl);
        const highest = streamTip ?? -1n;
        const connected = p?.isConnected === true;
        const fresh = tip.timestampMs != null && Date.now() - tip.timestampMs <= SYNC_FRESHNESS_MS;
        lastApplied = applied;
        lastHighest = highest;
        if (applied >= 0n) {
            if (progressApplied >= 0n && applied > progressApplied) lastProgressAt = Date.now();
            progressApplied = applied;
        }
        const caughtUp = isGenuinelyCaughtUp({ connected, applied, streamTip: highest, indexerFresh: fresh });
        const snapshot = publish(applied, highest, tip.height, connected, fresh, caughtUp);
        if (caughtUp) {
            pushSyncProgress(snapshot);
            log('info', `genuine-sync [${label}] CAUGHT UP: appliedIndex=${applied} streamTip=${highest} blockHeight=${tip.height} fresh=${fresh} after=${Math.round(snapshot.elapsedMs / 1000)}s`);
            return;
        }
        if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
            pushSyncProgress(snapshot);
            const behind = snapshot.behindEvents ?? '?';
            throw new Error(`wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min (dust appliedIndex stuck at ${applied}, streamTip=${highest}, ${behind} events behind, blockHeight=${tip.height}, isConnected=${connected}, indexerFresh=${fresh}, elapsed=${Math.round(snapshot.elapsedMs / 1000)}s)`);
        }
        // INFO: without it a long catch-up is indistinguishable from a hang.
        if (Date.now() - lastLog > SYNC_PROGRESS_LOG_MS) {
            pushSyncProgress(snapshot);
            const rate = snapshot.eventsPerSecond != null ? snapshot.eventsPerSecond.toFixed(1) : '?';
            const eta = snapshot.etaSeconds != null ? `${Math.round(snapshot.etaSeconds / 60)}min` : '?';
            log('info', `genuine-sync [${label}] ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${snapshot.behindEvents ?? '?'} rate=${rate}/s eta=${eta} elapsed=${Math.round(snapshot.elapsedMs / 1000)}s blockHeight=${tip.height} fresh=${fresh} connected=${connected}`);
            lastLog = Date.now();
        }
        await wsleep(SYNC_POLL_MS);
    }
    const tip = await getIndexerTip(indexerHttpUrl);
    const behind = lastHighest >= 0n && lastApplied >= 0n ? (lastHighest - lastApplied).toString() : '?';
    // The last snapshot stays in `syncProgress` so a caller can tell slow from stalled.
    const rate = syncProgress.get(sessionId)?.eventsPerSecond;
    throw new Error(`wallet not synced to tip after ${timeoutMs}ms (absolute ceiling): still ${behind} events behind at ${rate != null ? rate.toFixed(1) : '?'} events/s, dust appliedIndex=${lastApplied} streamTip=${lastHighest}, blockHeight=${tip.height}; the sync was moving (no stall detected), raise NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS or wait for a quieter machine`);
}

// ---- Facade construction --------------------------------------------------

export async function buildFacade(args: InitArgs): Promise<FacadeEntry> {
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);

    // Each key type comes from its own HD role, as in Lace (wallet-hd.ts); accountIndex
    // must match the session's WalletSessions.accountIndex.
    const bip39Seed = new Uint8Array(Buffer.from(args.seedHex, 'hex'));
    const roleSeeds = await deriveRoleSeeds(bip39Seed, args.accountIndex ?? 0);
    const zswapKeys = sdk.ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey = sdk.ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    const txHistoryStorage = new sdk.abstractions.InMemoryTransactionHistoryStorage(
        sdk.facade.WalletEntrySchema,
        sdk.facade.mergeWalletEntries
    );
    const { createKeystore, PublicKey } = sdk.unshielded;
    const unshieldedKeystore = createKeystore(roleSeeds.night, args.networkId);

    const configuration = {
        networkId: args.networkId,
        provingServerUrl: new URL(args.proofServerUrl),
        relayURL: new URL(args.relayUrl),
        indexerClientConnection: {
            indexerHttpUrl: args.indexerHttpUrl,
            indexerWsUrl: args.indexerWsUrl
        },
        txHistoryStorage,
        // additionalFeeOverhead >= 1n keeps the dust balancer off an empty recipe (fee 0 ->
        // 1010/117 NotNormalized). feeBlocksMargin 1 sits on the 0/1-atom edge on quiet networks.
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };

    const dustParameters = sdk.ledger.LedgerParameters.initialParameters().dust;
    const ShieldedWallet = sdk.shielded.ShieldedWallet;
    const UnshieldedWallet = sdk.unshielded.UnshieldedWallet;
    const DustWallet = sdk.dust.DustWallet;
    const restore = args.restoreBlobs;

    const provingMode = resolveProvingMode();
    const proving = provingMode === 'wasm' ? await loadProvingSdk() : undefined;
    // One shared key provider per worker, else every session re-downloads the keys.
    const sharedKeys = provingMode === 'wasm' ? await getSharedKeyMaterialProvider() : undefined;
    if (provingMode === 'wasm') {
        log('info', 'proving mode: wasm (in-process prover; proof server not used for wallet proving)');
    }

    const facade = await sdk.facade.WalletFacade.init({
        configuration,
        // Without provingService the facade uses the server prover at provingServerUrl.
        ...(proving ? { provingService: () => proving.makeWasmProvingService({ keyMaterialProvider: sharedKeys }) } : {}),
        shielded: () => restore?.shielded
            ? ShieldedWallet(configuration).restore(restore.shielded)
            : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? UnshieldedWallet(configuration).restore(restore.unshielded)
            : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        // Restored dust state can carry roots pruned from the node's root_history (unspendable,
        // 117); NIGHTGATE_DUST_COLD_START syncs dust fresh instead.
        dust: () => (restore?.dust && !configFlag('NIGHTGATE_DUST_COLD_START'))
            ? DustWallet(configuration).restore(restore.dust)
            : DustWallet(configuration).startWithSecretKey(dustKey, dustParameters)
    });

    await facade.start(zswapKeys, dustKey);
    log('info', `facade started for ${args.sessionId.slice(0, 16)} (restored=${!!restore})`);

    return {
        sessionId: args.sessionId,
        facade,
        restoredSubWallets: {
            shielded: !!restore?.shielded,
            dust: !!restore?.dust && !configFlag('NIGHTGATE_DUST_COLD_START')
        },
        sdkVersion: getSdkVersion(),
        zswapKeys,
        dustKey,
        unshieldedKeystore,
        networkId: args.networkId,
        indexerHttpUrl: args.indexerHttpUrl,
        walletConfiguration: configuration,
        attestationSecret: deriveAttestationSecret(roleSeeds.zswap)
    };
}

// ---- Periodic state save (pushed to main thread) -------------------------

export let saveSeqCounter = 0;

// Keyed by save seq and resolved independently of the facade lookup, so an
// eviction between push and ack cannot strand a waiter.
export const saveAckWaiters = new Map<number, () => void>();

export function resolveSaveAckWaiter(seq: number): void {
    saveAckWaiters.get(seq)?.();
}

/**
 * `lastSavedBlobs` advances only on the ack, so a dropped persist is re-pushed next tick.
 * `beforePost` runs before posting, so an ack waiter registers race-free.
 */
export function pushStateSave(sessionId: string, entry: FacadeEntry, blobs: { shielded?: string; unshielded?: string; dust?: string }, beforePost?: (seq: number) => void): number {
    const seq = ++saveSeqCounter;
    entry.pendingSaves ??= new Map();
    entry.pendingSaves.set(seq, blobs);
    // Serialize epoch per push, so applySaveAck ignores acks from before a restore or replacement.
    if (blobs.dust !== undefined) {
        (entry.dustSaveEpochs ??= new Map()).set(seq, entry.dustEpoch ?? 0);
    }
    if (blobs.shielded !== undefined) {
        (entry.shieldedSaveEpochs ??= new Map()).set(seq, entry.shieldedEpoch ?? 0);
    }
    // Bound the in-flight map when main never acks.
    if (entry.pendingSaves.size > 4) {
        const oldest = Math.min(...entry.pendingSaves.keys());
        entry.pendingSaves.delete(oldest);
        entry.dustSaveEpochs?.delete(oldest);
        entry.shieldedSaveEpochs?.delete(oldest);
    }
    beforePost?.(seq);
    parentPort?.postMessage({
        kind: 'state-save',
        sessionId,
        sdkVersion: entry.sdkVersion,
        seq,
        blobs
    });
    return seq;
}

export function restoreSaveAckTimeoutMs(): number {
    // Read per call so tests can shrink the window.
    return configMs('NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS');
}

/** Resolves on the ack for this seq; rejects after `timeoutMs` (there is no nack: a sink failure never acks). */
export function pushStateSaveAcked(sessionId: string, entry: FacadeEntry, blobs: { shielded?: string; unshielded?: string; dust?: string }, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        pushStateSave(sessionId, entry, blobs, (seq) => {
            const timer = setTimeout(() => {
                saveAckWaiters.delete(seq);
                reject(new Error(`state-save seq=${seq} not acked within ${timeoutMs}ms`));
            }, timeoutMs);
            (timer as any).unref?.();
            saveAckWaiters.set(seq, () => {
                clearTimeout(timer);
                saveAckWaiters.delete(seq);
                resolve();
            });
        });
    });
}

/**
 * Merges, since pushes carry only changed sub-blobs. A blob acked under a stale epoch is dropped:
 * after a restore or replacement only its own push is a valid baseline.
 */
export function applySaveAck(entry: FacadeEntry, seq: number): void {
    const blobs = entry.pendingSaves?.get(seq);
    if (!blobs) return;
    let effective = blobs;
    if (blobs.dust !== undefined && (entry.dustSaveEpochs?.get(seq) ?? 0) !== (entry.dustEpoch ?? 0)) {
        const { dust: _stale, ...rest } = effective;
        effective = rest;
    }
    if (blobs.shielded !== undefined && (entry.shieldedSaveEpochs?.get(seq) ?? 0) !== (entry.shieldedEpoch ?? 0)) {
        const { shielded: _stale, ...rest } = effective;
        effective = rest;
    }
    entry.lastSavedBlobs = { ...entry.lastSavedBlobs, ...effective };
    entry.pendingSaves!.delete(seq);
    entry.dustSaveEpochs?.delete(seq);
    entry.shieldedSaveEpochs?.delete(seq);
}

/** Idle progress watch: `waitForGenuineSync` publishes only while a job waits. */
export const PROGRESS_WATCH_MS = configMs('NIGHTGATE_PROGRESS_WATCH_MS');

export function startProgressWatch(sessionId: string, entry: FacadeEntry): void {
    if (entry.progressTimer) return;
    let busy = false;
    entry.progressTimer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            await progressWatchTick(sessionId, entry);
        } catch (e) {
            log('debug', `progress watch ${sessionId.slice(0, 16)}: ${formatErr(e)}`);
        } finally {
            busy = false;
        }
    }, PROGRESS_WATCH_MS);
    entry.progressTimer.unref();
}

/**
 * Replay check first, then the snapshot; skipped while a genuine-sync wait refreshed it
 * within the interval, and after a replacement.
 */
export async function progressWatchTick(sessionId: string, entry: FacadeEntry, now: number = Date.now()): Promise<void> {
    if (facades.get(sessionId) !== entry) return;
    const last = syncProgress.get(sessionId);
    const refreshedByWait = !!last && now - Date.parse(last.updatedAt) < PROGRESS_WATCH_MS;
    const replayArmed = snapshotReplayResetMs() > 0 && !!(entry.restoredSubWallets?.dust || entry.restoredSubWallets?.shielded);
    if (refreshedByWait && !replayArmed) return;
    const state = await peekFacadeState(entry.facade, 5_000);
    if (state == null) return;
    if (replayArmed && await checkSnapshotReplay(sessionId, entry, state, now)) return;
    if (refreshedByWait || facades.get(sessionId) !== entry) return;

    const p: any = state?.dust?.progress;
    const applied = p?.appliedIndex != null ? BigInt(p.appliedIndex) : -1n;
    const [streamTip, tip] = await Promise.all([getDustStreamTip(entry.indexerHttpUrl), getIndexerTip(entry.indexerHttpUrl)]);
    const highest = streamTip ?? -1n;
    const behind = highest >= 0n && applied >= 0n ? highest - applied : null;
    const connected = p?.isConnected === true;
    const indexerFresh = tip.timestampMs != null && Date.now() - tip.timestampMs <= SYNC_FRESHNESS_MS;
    const caughtUp = isGenuinelyCaughtUp({ connected, applied, streamTip: highest, indexerFresh });
    const at = new Date().toISOString();
    const snapshot: SyncProgressSnapshot = {
        sessionId, appliedIndex: applied.toString(), streamTip: highest.toString(),
        behindEvents: behind != null ? behind.toString() : null, eventsPerSecond: null, etaSeconds: caughtUp ? 0 : null,
        blockHeight: tip.height != null ? tip.height.toString() : null, isConnected: connected, indexerFresh, caughtUp,
        elapsedMs: 0, label: last?.label ?? 'idle', updatedAt: at,
        lastProgressAt: last && last.appliedIndex === applied.toString() ? last.lastProgressAt : at
    };
    syncProgress.set(sessionId, snapshot);
    pushSyncProgress(snapshot);
    if (!caughtUp) {
        log('info', `idle-sync ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${behind ?? '?'} connected=${connected} fresh=${indexerFresh} (no job waiting)`);
    }
}

/** Replacement window of a restored sub-wallet whose replay the ledger rejects (`NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS`, 0 = off). */
export function snapshotReplayResetMs(): number {
    return configMs('NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS');
}

/**
 * Replaces a restored sub-wallet stuck at its offset for the window while the ledger rejected a
 * replay of its kind and the stream tip lies beyond (sync-replay.ts). Returns whether one was replaced.
 */
export async function checkSnapshotReplay(sessionId: string, entry: FacadeEntry, state: any, now: number = Date.now()): Promise<boolean> {
    const windowMs = snapshotReplayResetMs();
    let replaced = false;
    for (const kind of ['dust', 'shielded'] as const) {
        if (!entry.restoredSubWallets?.[kind]) continue;
        const applied = appliedIndexOf(state, kind);
        if (applied == null) continue;
        const track = observeReplayTrack(entry.replayTracks?.[kind], applied, now);
        (entry.replayTracks ??= {})[kind] = track;
        if (!entry.restoredStateLogged) {
            entry.restoredStateLogged = true;
            log('info', `sync-state ${sessionId.slice(0, 16)} ${formatSyncState(describeSyncState(state))} (restored from snapshot)`);
        }
        if (track.advanced) {
            entry.restoredSubWallets = { ...entry.restoredSubWallets, [kind]: false };
            delete entry.replayTracks[kind];
            continue;
        }
        const rejection = lastReplayRejection[kind];
        if (!rejection || now - rejection.at > windowMs || now - track.since < windowMs) continue;
        const streamTip = await getLedgerEventStreamTip(entry.indexerHttpUrl, kind === 'dust' ? 'dust' : 'zswap');
        if (!shouldResetRestoredSubWallet({ track, streamTip, rejection, now, windowMs, tipGap: SYNC_TIP_GAP })) continue;
        log('warn', `snapshot replay ${sessionId.slice(0, 16)}: ${formatSyncState(describeSyncState(state))}`);
        const reason = `restored at appliedIndex=${track.startIndex}, unchanged for ${Math.round((now - track.since) / 1000)}s with the stream tip at ${streamTip}; the ledger rejects the replay: ${rejection.message}`;
        if (await resetRestoredSubWallet(entry, kind, reason)) replaced = true;
    }
    return replaced;
}

/**
 * In-place swap under the submit lock (facade methods resolve sub-wallets at call time). The fresh
 * state is persisted with ack and the save epoch bumped, so neither a restart nor a late ack brings
 * back the rejected state. False when the facade is gone or the fresh sub-wallet does not start.
 */
export async function resetRestoredSubWallet(entry: FacadeEntry, kind: ReplayKind, reason: string): Promise<boolean> {
    return withSessionLocks([entry.sessionId], async () => {
        if (facades.get(entry.sessionId) !== entry) return false;
        const id = entry.sessionId.slice(0, 16);
        let fresh: any;
        try {
            const sdk = await loadSdk();
            if (kind === 'dust') {
                fresh = sdk.dust.DustWallet(entry.walletConfiguration)
                    .startWithSecretKey(entry.dustKey, sdk.ledger.LedgerParameters.initialParameters().dust);
                await fresh.start(entry.dustKey);
            } else {
                fresh = sdk.shielded.ShieldedWallet(entry.walletConfiguration).startWithSecretKeys(entry.zswapKeys);
                await fresh.start(entry.zswapKeys);
            }
        } catch (e) {
            log('warn', `snapshot replay ${id}: the fresh ${kind} sub-wallet did not start, the restored one stays: ${formatErr(e)}`);
            return false;
        }
        const old = entry.facade[kind];
        entry.facade[kind] = fresh;
        try { await old?.stop?.(); } catch { /* an already stopped wallet is fine */ }
        if (kind === 'dust') {
            entry.dustEpoch = (entry.dustEpoch ?? 0) + 1;
            entry.preSubmitDustSnapshot = undefined;
        } else {
            entry.shieldedEpoch = (entry.shieldedEpoch ?? 0) + 1;
        }
        entry.restoredSubWallets = { ...entry.restoredSubWallets, [kind]: false };
        delete entry.replayTracks?.[kind];
        log('warn', `snapshot replay ${id}: ${kind} sub-wallet replaced by a fresh one syncing from genesis (${reason})`);
        try {
            const blob = await fresh.serializeState();
            if (typeof blob === 'string') {
                await pushStateSaveAcked(entry.sessionId, entry, { [kind]: blob }, restoreSaveAckTimeoutMs());
                log('info', `snapshot replay ${id}: fresh ${kind} state persisted (state-save ack)`);
            }
        } catch (e) {
            log('warn', `snapshot replay ${id}: fresh ${kind} state persist not confirmed (${formatErr(e)}); the next periodic save writes it`);
        }
        return true;
    });
}

/** Interval of the `sync-state` INFO line (`NIGHTGATE_SYNC_STATE_LOG_MS`, 0 = off). */
export function syncStateLogMs(): number {
    return configMs('NIGHTGATE_SYNC_STATE_LOG_MS');
}

/** Logs the offsets the saved blobs carry, so a lagging offset shows before a restart depends on it. */
export async function maybeLogSyncState(sessionId: string, entry: FacadeEntry, now: number = Date.now()): Promise<void> {
    const interval = syncStateLogMs();
    if (interval <= 0 || now - (entry.lastSyncStateLogAt ?? 0) < interval) return;
    entry.lastSyncStateLogAt = now;
    const state = await peekFacadeState(entry.facade, 5_000);
    if (state == null) return;
    log('info', `sync-state ${sessionId.slice(0, 16)} ${formatSyncState(describeSyncState(state))}`);
}

/**
 * Each tick serializes multi-MB blobs and dust changes nearly every block, so a short interval
 * becomes GC load; the interval only bounds the sync work redone after a crash.
 */
export function saveIntervalMs(): number {
    return configMs('NIGHTGATE_SAVE_INTERVAL_MS');
}

export function startPeriodicSave(sessionId: string, entry: FacadeEntry): void {
    if (entry.saveTimer) return;
    let tickCount = 0;
    const intervalMs = saveIntervalMs();
    log('info', `periodic-save interval armed for ${sessionId.slice(0, 16)} (every ${Math.round(intervalMs / 1000)}s)`);
    entry.saveTimer = setInterval(async () => {
        tickCount++;
        const tickStart = Date.now();
        // Logged before the first await: serializeState() can hang.
        log('debug', `save-tick #${tickCount} fired, calling collectSerializedStates...`);
        try {
            const collectStart = Date.now();
            const epochAtCollect = entry.dustEpoch ?? 0;
            const shieldedEpochAtCollect = entry.shieldedEpoch ?? 0;
            const blobs = await collectSerializedStates(entry.facade);
            if ((entry.dustEpoch ?? 0) !== epochAtCollect && blobs.dust) {
                // Swapped during collect: the blob may be the old wallet's; the swap persisted its own.
                delete blobs.dust;
                log('debug', `save-tick #${tickCount} dropped dust blob (dust sub-wallet swapped during collect)`);
            }
            if ((entry.shieldedEpoch ?? 0) !== shieldedEpochAtCollect && blobs.shielded) {
                delete blobs.shielded;
                log('debug', `save-tick #${tickCount} dropped shielded blob (shielded sub-wallet swapped during collect)`);
            }
            const collectMs = Date.now() - collectStart;
            const shape = [
                `sh=${blobs.shielded ? blobs.shielded.length : '-'}`,
                `un=${blobs.unshielded ? blobs.unshielded.length : '-'}`,
                `du=${blobs.dust ? blobs.dust.length : '-'}`
            ].join(' ');
            log('debug', `save-tick #${tickCount} collect returned in ${collectMs}ms: ${shape}`);

            if (!hasAnyBlob(blobs)) return;
            await maybeLogSyncState(sessionId, entry);
            // Only sub-blobs that differ from the last ACKED save (the sink keeps absent keys),
            // so a failed persist stays marked unsaved.
            const changed = diffAgainstConfirmed(entry, blobs);
            if (!hasAnyBlob(changed)) {
                log('debug', `save-tick #${tickCount} unchanged, skipping push`);
                return;
            }
            const seq = pushStateSave(sessionId, entry, changed);
            log('debug', `save-tick #${tickCount} pushed seq=${seq} (total ${Date.now() - tickStart}ms)`);
        } catch (err: any) {
            log('warn', `periodic save failed: ${formatErr(err)}`);
        }
    }, intervalMs);
    entry.saveTimer.unref();
}

export async function collectSerializedStates(facade: any): Promise<{ shielded?: string; unshielded?: string; dust?: string }> {
    const out: any = {};
    const tryOne = async (key: 'shielded' | 'unshielded' | 'dust') => {
        try {
            const sub = facade?.[key];
            if (sub && typeof sub.serializeState === 'function') {
                const blob = await sub.serializeState();
                if (typeof blob === 'string') out[key] = blob;
            }
        } catch {
            // Best effort: one missing blob must not block the others.
        }
    };
    await Promise.all([tryOne('shielded'), tryOne('unshielded'), tryOne('dust')]);
    return out;
}

export function hasAnyBlob(b: { shielded?: string; unshielded?: string; dust?: string }): boolean {
    return !!(b.shielded || b.unshielded || b.dust);
}

/** Sub-blobs that differ from the last save the main thread acked. */
export function diffAgainstConfirmed(
    entry: FacadeEntry,
    blobs: { shielded?: string; unshielded?: string; dust?: string }
): { shielded?: string; unshielded?: string; dust?: string } {
    const saved = entry.lastSavedBlobs ?? {};
    const changed: { shielded?: string; unshielded?: string; dust?: string } = {};
    if (blobs.shielded && blobs.shielded !== saved.shielded) changed.shielded = blobs.shielded;
    if (blobs.unshielded && blobs.unshielded !== saved.unshielded) changed.unshielded = blobs.unshielded;
    if (blobs.dust && blobs.dust !== saved.dust) changed.dust = blobs.dust;
    return changed;
}

// ---- Per-facade serialization ---------------------------------------------

// Submits serialize per facade: concurrent balancing on one wallet double-selects inputs.
// Sponsored submits lock both keys; the dust snapshot/restore relies on this lock.
// `sponsorUnboundTx` locks only around its own build.
export const sessionChains = new Map<string, Promise<unknown>>();

export function submitLockKeys(args: any): string[] {
    return [args?.sessionId, args?.sponsorSessionId]
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/** Exclusive slot on every key; no slot is held while waiting for another, so it cannot deadlock. */
export async function withSessionLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    if (ordered.length === 0) return fn();
    const prevs = ordered.map((k) => sessionChains.get(k) ?? Promise.resolve());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const k of ordered) sessionChains.set(k, gate);
    await Promise.allSettled(prevs);
    try {
        return await fn();
    } finally {
        release();
        // Drop a facade-less session's chain only while our gate is last: deleting a
        // later locker's gate would let the next one skip the wait.
        for (const k of ordered) {
            if (sessionChains.get(k) === gate && !facades.has(k)) sessionChains.delete(k);
        }
    }
}


export async function init(args: InitArgs) {
    if (facades.has(args.sessionId)) {
        log('debug', `init: cache hit ${args.sessionId.slice(0, 16)}`);
        return { facadeReady: true, alreadyExisted: true };
    }
    const entry = await buildFacade(args);
    facades.set(args.sessionId, entry);
    startPeriodicSave(args.sessionId, entry);
    startProgressWatch(args.sessionId, entry);
    return { facadeReady: true, alreadyExisted: false, sdkVersion: entry.sdkVersion };
}

/** CPU profile of this worker thread via the in-thread inspector; the raw .cpuprofile stays on disk. */
export async function cpuProfile({ seconds, dir }: { seconds?: number; dir?: string }) {
    const p = await profileCurrentThread(seconds ?? 20, { dir, filePrefix: 'worker' });
    log('info', `cpuProfile: ${p.seconds}s sampled, idle ${p.idlePercent}%, gc ${p.gcPercent}% (${p.gc.count} collections, ${p.gc.totalMs}ms), wasm ${p.wasmPercent}%, heap ${p.heapAfter.usedMb}/${p.heapAfter.limitMb} MB, external ${p.heapAfter.externalMb} MB, top: ${p.topFunctions.slice(0, 3).map((f: { label: string; percent: number }) => `${f.label.split('  ')[0]} ${f.percent}%`).join(', ')}`);
    return { thread: 'worker', facadeCount: facades.size, ...p, gc: { ...p.gc, byKind: JSON.stringify(p.gc.byKind) } };
}

export async function waitForSyncedState({ sessionId, timeoutMs, stallMs }: { sessionId: string; timeoutMs?: number; stallMs?: number }) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    // isSynced is trivially true when highestIndex=0; bounded by stall, ceiling as backstop.
    await waitForGenuineSync(entry, timeoutMs ?? SYNC_CEILING_MS, 'prewarm', stallMs ?? SYNC_STALL_MS);
    return { synced: true };
}

/** `awaitSaveAck`: reply only after the final save was acked; off by default for fake-timer tests. */
export async function evict({ sessionId, awaitSaveAck }: { sessionId: string; awaitSaveAck?: boolean }) {
    const entry = facades.get(sessionId);
    if (!entry) return { evicted: false };
    // `saved`: the final save was pushed (and, with awaitSaveAck, acked).
    let saved = true;
    // Remove from the map first so no NEW submit can resolve this facade.
    facades.delete(sessionId);
    syncProgress.delete(sessionId);
    if (entry.saveTimer) clearInterval(entry.saveTimer);
    if (entry.progressTimer) clearInterval(entry.progressTimer);
    // Teardown under the submit lock so it cannot zero keys under an in-flight submit.
    await withSessionLocks([sessionId], async () => {
        // Acked before replying: the reply lets main drop the session, after which
        // the sink would drop the save. Bounded; on timeout eviction proceeds.
        try {
            const blobs = await collectSerializedStates(entry.facade);
            const changed = diffAgainstConfirmed(entry, blobs);
            if (hasAnyBlob(changed)) {
                if (awaitSaveAck) await pushStateSaveAcked(sessionId, entry, changed, restoreSaveAckTimeoutMs());
                else pushStateSave(sessionId, entry, changed);
            }
        } catch (err) {
            saved = false;
            log('warn', `evict final-save failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
        }
        try {
            // Zero every secret held by the entry, not just the zswap keys.
            entry.zswapKeys?.clear?.();
            entry.dustKey?.clear?.();
            entry.unshieldedKeystore?.clear?.();
            try { entry.attestationSecret?.fill?.(0); } catch { }
            await entry.facade?.stop?.();
        } catch (err) {
            log('warn', `evict cleanup failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
        }
    });
    return { evicted: true, saved };
}

export const facadeHandlers = { init, cpuProfile, waitForSyncedState, evict };
