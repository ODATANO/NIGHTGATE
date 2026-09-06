/**
 * Facade registry lifecycle: build, sync waits, periodic state save with
 * main-thread acks, idle progress watch, per-session submit locks, evict.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
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

export const BALANCE_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS');

/**
 * `facade.waitForSyncedState()` is `Promise.all` of the sub-wallet waits and
 * never resolves against an indexer that is not caught up, so every caller
 * gets a bound (the caller's, else BALANCE_SYNC_TIMEOUT_MS) and the timer is
 * cleared. A submit path used to hold its session lock on this until the
 * client's 30 min backstop.
 */
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

// How close to the DUST STREAM tip counts as "caught up". Measured in ledger
// EVENTS, not blocks: the dust sub-wallet consumes dustLedgerEvents whose ids
// advance independently of (and far slower than) block height. A few events
// of slack avoids chasing a moving target.
export const SYNC_TIP_GAP = BigInt(configNumber('NIGHTGATE_SYNC_TIP_GAP'));
// The indexer's latest block must be at most this old for "caught up" to
// count. This preserves the guard against a lagging (self-hosted) indexer:
// the wallet would sync to a STALE tip and later spend dust whose merkle
// roots have pruned out of the node's root_history (Custom error 117).
export const SYNC_FRESHNESS_MS = configMs('NIGHTGATE_SYNC_FRESHNESS_MS');
export const SYNC_POLL_MS = 3000;
// How often the catch-up loop reports progress (log line + snapshot refresh).
export const SYNC_PROGRESS_LOG_MS = 15_000;
// Rate is measured against an anchor no older than this, so a long catch-up
// reports its CURRENT throughput rather than an average diluted by the start.
export const SYNC_RATE_WINDOW_MS = 60_000;
// A sync whose appliedIndex has not moved for this long is stalled; a sync still
// applying events is slow and runs up to the absolute ceiling. <= 0 disables.
export const SYNC_STALL_MS = configMs('NIGHTGATE_PREWARM_STALL_MS');
// Absolute ceiling for the prewarm wait when the caller passes none; SYNC_STALL_MS is the primary limit.
export const SYNC_CEILING_MS = 12 * 60 * 60 * 1000;
export const wsleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Last observed catch-up progress for one facade, refreshed by
 * `waitForGenuineSync` on every poll and PUSHED to the main thread (which caches
 * it) at the progress-log cadence.
 *
 * This exists because a catch-up used to be completely opaque: between "facade
 * started" and "CAUGHT UP" the worker emitted nothing above debug level, so a
 * stalled sync and a working one were indistinguishable from outside and the
 * only way to tell them apart was sampling the OS process CPU counter.
 *
 * Push, not an RPC the main thread issues: a catch-up is CPU-bound work on THIS
 * single thread, so a request/response round trip would be answered slowly or
 * time out exactly in the situation the numbers are wanted for. Pushing means
 * the main thread always has an answer, timestamped so a reader can tell how
 * stale it is. Numbers are decimal strings: appliedIndex and streamTip are
 * ledger-event ids (bigint) and must not lose precision crossing the thread
 * boundary or OData.
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
    /**
     * When `appliedIndex` last advanced (the wait's start until it first moves).
     * Unchanged across polls while `updatedAt` moves = stalled, not slow.
     */
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

// One stream-tip probe per few seconds is plenty for a 3s poll loop.
export let dustTipCache: { tip: bigint; at: number } | null = null;

/**
 * The dust ledger-event stream's CURRENT tip (max id), read straight from the
 * indexer via a one-shot graphql-transport-ws subscription: the stream's
 * first backfill event carries `maxId`. This is the only reliable target for
 * the dust sub-wallet's `appliedIndex`:
 *  - `dust.progress.highestIndex` stays 0 against the public indexers, so
 *    the SDK itself never reports the stream tip;
 *  - the Block end-indices are DIFFERENT series and do not match the
 *    dustLedgerEvents ids (measured: dustGenerationEndIndex ~330k,
 *    dustCommitmentEndIndex ~939k vs stream maxId ~1.262M).
 * The ws URL is derived from the HTTP URL (.../graphql -> .../graphql/ws).
 * Returns null on any failure; callers treat that as "tip unknown".
 */
export async function getDustStreamTip(indexerHttpUrl: string): Promise<bigint | null> {
    if (dustTipCache && Date.now() - dustTipCache.at < 10_000) return dustTipCache.tip;
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
                            payload: { query: 'subscription { dustLedgerEvents(id: 0) { id maxId } }' }
                        }));
                    } else if (m.type === 'next') {
                        const maxId = m.payload?.data?.dustLedgerEvents?.maxId;
                        done(maxId != null ? BigInt(maxId) : null);
                    } else if (m.type === 'error' || m.type === 'complete') {
                        done(null);
                    }
                } catch { done(null); }
            });
            sock.on('error', () => done(null));
            sock.on('close', () => done(null));
        });
        if (tip != null) dustTipCache = { tip, at: Date.now() };
        return tip;
    } catch { return null; }
}

/**
 * GENUINE sync gate.
 *
 * `dust.progress.appliedIndex` counts LEDGER EVENTS (the indexer's
 * dustLedgerEvents id series), NOT blocks. Comparing it against the indexer's
 * BLOCK height is wrong: the event series never reaches block height
 * (preprod: ~1.26M events vs ~1.59M blocks), so every fully synced wallet
 * would look like a silent "stall" at the event tip and the prewarm would
 * time out.
 *
 * `dust.progress.highestIndex` stays 0 against the public indexers, so the
 * SDK never reports the stream tip itself. The tip therefore comes from
 * `getDustStreamTip` (a one-shot dustLedgerEvents probe whose first event
 * carries `maxId`).
 *
 * The gate checks, per poll:
 *   1. `appliedIndex >= streamTip - SYNC_TIP_GAP`: caught up with the dust
 *      stream's OWN tip, with `isConnected`.
 *   2. `streamTip > 0`: guards the historical failure where a wallet that
 *      never received a tip looked trivially synced.
 *   3. The indexer's latest block timestamp is fresh (SYNC_FRESHNESS_MS).
 *      This preserves the original guard motivation: a lagging self-hosted
 *      indexer must not count as tip, or balancing spends dust whose merkle
 *      roots pruned out of the node's ~1h root_history (Custom error 117).
 *
 * `waitForSyncedState()` is still not trusted; we read the numbers.
 *
 * Every poll refreshes `syncProgress[entry.sessionId]` and, every
 * SYNC_PROGRESS_LOG_MS, emits an INFO line. Both carry the applied index, the
 * stream tip, the current rate and an ETA, so a slow catch-up is legible from
 * the log and from `getSyncProgress` instead of looking identical to a hang.
 */
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

export async function waitForGenuineSync(entry: FacadeEntry, timeoutMs: number, label: string, stallMs: number = SYNC_STALL_MS): Promise<void> {
    const { facade, indexerHttpUrl, sessionId } = entry;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastLog = 0;
    let lastApplied = -1n;
    let lastHighest = -1n;
    // The first observation seeds the index without counting as progress: an
    // index unchanged from the start is stalled once stallMs has passed.
    let progressApplied = -1n;
    let lastProgressAt = startedAt;
    // Sliding anchor for the rate: refreshed once it ages past the window, so
    // the reported throughput tracks the present, not the whole wait.
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
                // A restored facade can report a LOWER index right after start;
                // a negative rate is noise, not information.
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
        // Read state via the NON-BLOCKING facade.state() observable.
        // facade.waitForSyncedState() is Promise.all([... dust.waitForSyncedState() ...])
        // which only resolves once every sub-wallet isStrictlyComplete(). That is never
        // true against an indexer not yet caught_up to chain tip (highestIndex stays 0),
        // so it would time out every poll and the real (advancing) appliedIndex would
        // never be read. The observable emits the current FacadeState immediately.
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
            // Always release the subscription and timer, whether `next` fired or
            // the timeout won the race. On a stalled indexer the timeout wins
            // every poll, so leaking here would accumulate one live subscription
            // per cycle exactly on the pathological path.
            try { sub && sub.unsubscribe(); } catch { }
            if (peekTimer) clearTimeout(peekTimer);
        }
        if (peekFailed) {
            // A state observable that never emits (or errors every poll) counts as no
            // progress for the stall bound. The last readable snapshot stays for diagnosis.
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
        const caughtUp = connected && highest > 0n && applied >= 0n && applied >= highest - SYNC_TIP_GAP && fresh;
        const snapshot = publish(applied, highest, tip.height, connected, fresh, caughtUp);
        if (caughtUp) {
            pushSyncProgress(snapshot);
            log('info', `genuine-sync [${label}] CAUGHT UP: appliedIndex=${applied} streamTip=${highest} blockHeight=${tip.height} fresh=${fresh} after=${Math.round(snapshot.elapsedMs / 1000)}s`);
            return;
        }
        if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
            // The last snapshot stays readable; the message names this condition ("no progress", not "too slow").
            pushSyncProgress(snapshot);
            const behind = snapshot.behindEvents ?? '?';
            throw new Error(`wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min (dust appliedIndex stuck at ${applied}, streamTip=${highest}, ${behind} events behind, blockHeight=${tip.height}, isConnected=${connected}, indexerFresh=${fresh}, elapsed=${Math.round(snapshot.elapsedMs / 1000)}s)`);
        }
        // INFO, not debug: without this line a multi-hour catch-up is
        // indistinguishable from a hang for anyone outside this thread. The
        // push shares the cadence so the readable snapshot and the log agree.
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
    // The last snapshot stays in `syncProgress` on purpose: a caller that saw
    // the timeout can still read how far the wallet got and how fast it was
    // moving, which is what separates "too slow" from "stalled".
    const rate = syncProgress.get(sessionId)?.eventsPerSecond;
    throw new Error(`wallet not synced to tip after ${timeoutMs}ms (absolute ceiling): still ${behind} events behind at ${rate != null ? rate.toFixed(1) : '?'} events/s, dust appliedIndex=${lastApplied} streamTip=${lastHighest}, blockHeight=${tip.height}; the sync was moving (no stall detected), raise NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS or wait for a quieter machine`);
}

/**
 * Pre-submit diagnostic dump: summarizes every intent's dust section of a
 * balanced/proven transaction. Node error `1010 Custom error: 117`
 * (NotNormalized) has exactly one dust-related trigger in the ledger: a
 * DustActions section whose spends AND registrations are both empty
 * (midnight-ledger dust.rs "non-canonical dust actions: empty"). This dump
 * makes the next 117 attributable: either the log shows an empty DustActions
 * (balancer bug, wallet SDK Transacting.balanceTransactions attaches the
 * section even for an empty recipe) or the malformation is elsewhere in the
 * transaction. Never throws: diagnostics must not break the submit path.
 */
// ---- Facade construction --------------------------------------------------

export async function buildFacade(args: InitArgs): Promise<FacadeEntry> {
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);

    // args.seedHex is the 64-byte BIP39 seed (128 hex). Lace derives each key
    // type from a DIFFERENT HD role (Zswap/Dust/NightExternal); deriving them
    // all from one raw seed lands on the wrong account. See srv/utils/wallet-hd.ts.
    // args.accountIndex selects the BIP32 account level; it must match the
    // account the session was connected for (WalletSessions.accountIndex).
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
        // Fee floor: additionalFeeOverhead >= 1n guarantees the dust balancer
        // never converges on an EMPTY recipe (fee 0 -> empty DustActions -> node
        // 1010 Custom error: 117 NotNormalized, the only dust-related
        // NotNormalized site in midnight-ledger dust.rs). feeBlocksMargin 5
        // matches the wallet SDK's own e2e configuration; our previous margin 1
        // sat on the 0/1-atom knife edge on quiet test networks. Overpayment is
        // bounded by the overhead (1 atom, negligible vs typical balances).
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };

    const dustParameters = sdk.ledger.LedgerParameters.initialParameters().dust;
    const ShieldedWallet = sdk.shielded.ShieldedWallet;
    const UnshieldedWallet = sdk.unshielded.UnshieldedWallet;
    const DustWallet = sdk.dust.DustWallet;
    const restore = args.restoreBlobs;

    const provingMode = resolveProvingMode();
    const proving = provingMode === 'wasm' ? await loadProvingSdk() : undefined;
    // One shared provider per worker: makeWasmProvingService() would otherwise
    // create a fresh in-memory key cache per session and re-download from S3.
    const sharedKeys = provingMode === 'wasm' ? await getSharedKeyMaterialProvider() : undefined;
    if (provingMode === 'wasm') {
        log('info', 'proving mode: wasm (in-process prover; proof server not used for wallet proving)');
    }

    const facade = await sdk.facade.WalletFacade.init({
        configuration,
        // Without provingService the facade defaults to the SERVER prover at
        // configuration.provingServerUrl (and throws if that is unset).
        ...(proving ? { provingService: () => proving.makeWasmProvingService({ keyMaterialProvider: sharedKeys }) } : {}),
        shielded: () => restore?.shielded
            ? ShieldedWallet(configuration).restore(restore.shielded)
            : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? UnshieldedWallet(configuration).restore(restore.unshielded)
            : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        // NIGHTGATE_DUST_COLD_START=true forces the dust sub-wallet to sync
        // fresh from chain instead of restoring the persisted blob. Restored
        // dust state can carry merkle roots that have since been pruned from the
        // node's ~1h root_history, making the (large) dust balance UNSPENDABLE
        // and every submission fail with Custom error 117 (NotNormalized: empty
        // dust actions). Cold-starting dust rebuilds spendable, fresh-rooted
        // outputs. Experimental flag while we settle on a permanent fix.
        dust: () => (restore?.dust && !configFlag('NIGHTGATE_DUST_COLD_START'))
            ? DustWallet(configuration).restore(restore.dust)
            : DustWallet(configuration).startWithSecretKey(dustKey, dustParameters)
    });

    await facade.start(zswapKeys, dustKey);
    log('info', `facade started for ${args.sessionId.slice(0, 16)} (restored=${!!restore})`);

    return {
        sessionId: args.sessionId,
        facade,
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

// Ack waiters for pushes that need durability confirmation (dust snapshot
// restore). Keyed by save seq; resolved by the dispatcher on state-save-ack
// INDEPENDENTLY of the facade lookup, so a waiter cannot dangle when the
// entry is evicted between push and ack.
export const saveAckWaiters = new Map<number, () => void>();

export function resolveSaveAckWaiter(seq: number): void {
    saveAckWaiters.get(seq)?.();
}

/**
 * Push a state-save to the main thread. `lastSavedBlobs` is only advanced by
 * the corresponding `state-save-ack` (see the parentPort dispatcher), so a
 * failed or dropped persist keeps the blobs "unsaved" and they are re-pushed
 * on the next tick. `beforePost` runs after the seq is allocated but BEFORE
 * the message goes out, so an ack waiter can be registered race-free even
 * against a synchronous ack.
 */
export function pushStateSave(sessionId: string, entry: FacadeEntry, blobs: { shielded?: string; unshielded?: string; dust?: string }, beforePost?: (seq: number) => void): number {
    const seq = ++saveSeqCounter;
    entry.pendingSaves ??= new Map();
    entry.pendingSaves.set(seq, blobs);
    // Tag dust-bearing pushes with the epoch their blob was serialized
    // under, so applySaveAck can reject acks that arrive after a dust
    // snapshot restore invalidated the blob.
    if (blobs.dust !== undefined) {
        (entry.dustSaveEpochs ??= new Map()).set(seq, entry.dustEpoch ?? 0);
    }
    // Bound the in-flight map: acks normally clear entries; if main never
    // acks (persist layer down), keep only the most recent few.
    if (entry.pendingSaves.size > 4) {
        const oldest = Math.min(...entry.pendingSaves.keys());
        entry.pendingSaves.delete(oldest);
        entry.dustSaveEpochs?.delete(oldest);
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
    // Read per call so tests can shrink the window. The main-thread persist
    // chain can queue behind other saves; 30s is generous but bounded.
    return configMs('NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS');
}

/**
 * pushStateSave that resolves once the main thread CONFIRMED the persist
 * (state-save-ack for this seq) and rejects after `timeoutMs` (there is no
 * explicit nack: a sink failure simply never acks).
 */
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
 * Apply a main-thread `state-save-ack`: advance the confirmed-saved blobs so
 * the tick's unchanged-skip applies. Pushes carry only CHANGED sub-blobs, so
 * this merges instead of replacing (a dust-only ack must not mark
 * shielded/unshielded never-saved). A dust blob acked under a STALE dust
 * epoch (a snapshot restore happened after its push) is dropped from the
 * merge: the restore's own push is the only valid dust baseline from then
 * on. Exported for the in-thread unit tests.
 */
export function applySaveAck(entry: FacadeEntry, seq: number): void {
    const blobs = entry.pendingSaves?.get(seq);
    if (!blobs) return;
    let effective = blobs;
    if (blobs.dust !== undefined && (entry.dustSaveEpochs?.get(seq) ?? 0) !== (entry.dustEpoch ?? 0)) {
        const { dust: _stale, ...rest } = blobs;
        effective = rest;
    }
    entry.lastSavedBlobs = { ...entry.lastSavedBlobs, ...effective };
    entry.pendingSaves!.delete(seq);
    entry.dustSaveEpochs?.delete(seq);
}

/**
 * Idle progress watch (0.21.4): `waitForGenuineSync` only publishes progress
 * while a job waits, so a facade that is far behind but has nothing to do
 * logs nothing and its `getWalletSyncProgress` row goes stale, which reads
 * like a hang. Every PROGRESS_WATCH_MS this peeks the dust progress (bounded
 * state read + one tip query), refreshes the cached snapshot and logs an INFO
 * line while the facade is behind; silent once at tip. Skipped while a
 * genuine-sync wait refreshed the snapshot itself within the interval.
 */
export const PROGRESS_WATCH_MS = configMs('NIGHTGATE_PROGRESS_WATCH_MS');

export function startProgressWatch(sessionId: string, entry: FacadeEntry): void {
    if (entry.progressTimer) return;
    let busy = false;
    entry.progressTimer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            const last = syncProgress.get(sessionId);
            if (last && Date.now() - Date.parse(last.updatedAt) < PROGRESS_WATCH_MS) return;
            let state: any; let sub: any; let timer: NodeJS.Timeout | undefined;
            try {
                state = await Promise.race([
                    new Promise<any>((res, rej) => { try { sub = entry.facade.state().subscribe({ next: (v: any) => res(v), error: (e: any) => rej(e) }); } catch (e) { rej(e); } }),
                    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('state peek timeout')), 5_000); })
                ]);
            } catch { return; } finally { try { sub && sub.unsubscribe(); } catch { } if (timer) clearTimeout(timer); }
            const p: any = state?.dust?.progress;
            const applied = p?.appliedIndex != null ? BigInt(p.appliedIndex) : -1n;
            const highest = (await getDustStreamTip(entry.indexerHttpUrl)) ?? -1n;
            const behind = highest >= 0n && applied >= 0n ? highest - applied : null;
            const caughtUp = behind != null && behind <= SYNC_TIP_GAP;
            const now = Date.now();
            syncProgress.set(sessionId, {
                sessionId, appliedIndex: applied.toString(), streamTip: highest.toString(),
                behindEvents: behind != null ? behind.toString() : null, eventsPerSecond: null, etaSeconds: caughtUp ? 0 : null,
                blockHeight: null, isConnected: p?.isConnected === true, indexerFresh: true, caughtUp,
                elapsedMs: 0, label: last?.label ?? 'idle', updatedAt: new Date(now).toISOString(),
                lastProgressAt: last && last.appliedIndex === applied.toString() ? last.lastProgressAt : new Date(now).toISOString()
            });
            if (!caughtUp) {
                log('info', `idle-sync ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${behind ?? '?'} connected=${p?.isConnected === true} (no job waiting)`);
            }
        } catch (e) {
            log('debug', `progress watch ${sessionId.slice(0, 16)}: ${formatErr(e)}`);
        } finally {
            busy = false;
        }
    }, PROGRESS_WATCH_MS);
    entry.progressTimer.unref();
}

/**
 * Save tick interval (0.21.6: `NIGHTGATE_SAVE_INTERVAL_MS`, default 60 s,
 * min 10 s; was a fixed 30 s). Every tick serializes all three sub-wallets
 * of a facade into multi-MB hex strings; the dust wallet changes with
 * practically every block, so the tick nearly always allocates and pushes.
 * On the hosted pool (three facades) that churn made minor GC the worker's
 * main occupation (profileWorker: 63 scavenges of ~180 ms in 20 s, GC 42 %).
 * The interval bounds only how much sync work a crash re-does on restore.
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
        // Log BEFORE the first await so we know the timer fired even if
        // serializeState() hangs on the rx Observable.
        log('debug', `save-tick #${tickCount} fired, calling collectSerializedStates...`);
        try {
            const collectStart = Date.now();
            const epochAtCollect = entry.dustEpoch ?? 0;
            const blobs = await collectSerializedStates(entry.facade);
            if ((entry.dustEpoch ?? 0) !== epochAtCollect && blobs.dust) {
                // A dust snapshot restore landed while we were serializing:
                // this blob may describe the pre-restore (poisoned) wallet,
                // and the restore already persisted the clean snapshot.
                delete blobs.dust;
                log('debug', `save-tick #${tickCount} dropped dust blob (dust restore during collect)`);
            }
            const collectMs = Date.now() - collectStart;
            const shape = [
                `sh=${blobs.shielded ? blobs.shielded.length : '-'}`,
                `un=${blobs.unshielded ? blobs.unshielded.length : '-'}`,
                `du=${blobs.dust ? blobs.dust.length : '-'}`
            ].join(' ');
            log('debug', `save-tick #${tickCount} collect returned in ${collectMs}ms: ${shape}`);

            if (!hasAnyBlob(blobs)) return;
            // Push only sub-blobs that differ from the last CONFIRMED-saved
            // state (saveSyncState preserves stored blobs for keys sent as
            // null/absent). Dust churns with practically every block while
            // shielded/unshielded mostly don't; sending only what changed
            // avoids cloning + re-encrypting multi-MB blobs 2x/min per facade.
            // Diffing against CONFIRMED blobs (advanced only by the ack) keeps
            // a save whose persist failed marked unsaved for re-push.
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
            // Best-effort: a missing blob for one sub-wallet doesn't block
            // persistence of the others.
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

// Submitting handlers serialize per facade: two concurrent balance+submit calls
// on the SAME wallet would select overlapping UTXO/dust inputs and the node
// rejects the second (double-select). A sponsored submit also balances the
// sponsor's facade, so it locks both keys. Read-only handlers stay concurrent.
// This whole-call lock is ALSO what makes the dust-wedge snapshot/restore
// safe (one build/submit per facade at a time, see restoreDustFromSnapshot).
// `sponsorUnboundTx` is deliberately NOT listed: it takes the lock itself
// around its fast build only, so proving + submit overlap across jobs (its
// doc comment states the contract that makes that safe).
export const sessionChains = new Map<string, Promise<unknown>>();

export function submitLockKeys(args: any): string[] {
    return [args?.sessionId, args?.sponsorSessionId]
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/**
 * Run `fn` with an exclusive slot on every key in `keys`. Keys are deduped and
 * sorted, and we never hold one slot while waiting for another (we wait for all
 * prior holders to settle, THEN run), so multi-key acquisition can't deadlock.
 */
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
        // Drop the chain of a session that no longer has a facade, but ONLY
        // while our gate is still the last one: a later locker (a submit that
        // queued behind an evict) has set its own gate, and deleting that
        // would let the next locker skip the wait.
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

/**
 * CPU profile of THIS worker thread for `seconds` (1..120), taken with the
 * in-thread inspector while the worker keeps serving; the summary travels
 * back, the raw .cpuprofile stays on disk for DevTools. Admin diagnostic
 * (`profileWorker`), added when the hosted worker sat at 100 % CPU with
 * three warm facades and nothing in the log said why.
 */
export async function cpuProfile({ seconds, dir }: { seconds?: number; dir?: string }) {
    const p = await profileCurrentThread(seconds ?? 20, { dir, filePrefix: 'worker' });
    log('info', `cpuProfile: ${p.seconds}s sampled, idle ${p.idlePercent}%, gc ${p.gcPercent}% (${p.gc.count} collections, ${p.gc.totalMs}ms), wasm ${p.wasmPercent}%, heap ${p.heapAfter.usedMb}/${p.heapAfter.limitMb} MB, external ${p.heapAfter.externalMb} MB, top: ${p.topFunctions.slice(0, 3).map((f: { label: string; percent: number }) => `${f.label.split('  ')[0]} ${f.percent}%`).join(', ')}`);
    return { thread: 'worker', facadeCount: facades.size, ...p, gc: { ...p.gc, byKind: JSON.stringify(p.gc.byKind) } };
}

export async function waitForSyncedState({ sessionId, timeoutMs, stallMs }: { sessionId: string; timeoutMs?: number; stallMs?: number }) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    // Genuine catch-up to the indexer tip (the isSynced flag is trivially true
    // when highestIndex=0). Prewarm path: bounded by lack of progress (stallMs),
    // with an absolute ceiling as backstop.
    await waitForGenuineSync(entry, timeoutMs ?? SYNC_CEILING_MS, 'prewarm', stallMs ?? SYNC_STALL_MS);
    return { synced: true };
}

/**
 * `awaitSaveAck` (the main-thread client always sets it): reply only after
 * the final save was acked, see below. Off by default so in-thread tests
 * under fake timers are not held by the bounded wait.
 */
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
    // Teardown (final save + zeroing secrets + stopping the facade) runs under
    // the per-session submit lock so it can't yank key material from a submit
    // still in flight for this session (it holds `entry` mid-SDK-call). New
    // submits already fail the `facades.get` above, so never contend this lock.
    await withSessionLocks([sessionId], async () => {
        // Final save, ACKED: the reply to this RPC is what lets the main
        // thread drop the session from its save registry, so the push must
        // have been persisted (acked) before we return, or the sink finds
        // no session and drops the save. Bounded wait; on timeout the blobs
        // stay unconfirmed and the eviction proceeds (logged, not silent).
        try {
            const blobs = await collectSerializedStates(entry.facade);
            // Changed-only, same as the tick: blobs already confirmed
            // persisted don't need a goodbye re-encrypt.
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
            // Zero every secret held by the entry, not just the zswap keys, so
            // nothing sensitive lingers in the orphaned entry until GC.
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
