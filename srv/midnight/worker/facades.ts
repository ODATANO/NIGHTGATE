/**
 * Loads, syncs, saves and unloads the wallets (facades) of the worker.
 * Wallet state is saved through the main thread, which confirms each save.
 */

// Must stay the first import. The worker modules import each other in a cycle,
// and config is read at load time.
import { configMs, configNumber, configFlag } from '../../utils/config';
import { rpcCancellation, throwIfRpcCancelled } from './cancellation';
import { profileCurrentThread } from '../cpu-profile';
import { errorName, formatErr } from '../../utils/format-error';
import { NightgateError } from '../../utils/errors';
import { deriveIndexerWsUrl } from '../../utils/indexer-url';
import { getSharedKeyMaterialProvider } from '../wasm-proof-provider';
import { deriveAttestationSecret, deriveTokenFactoryIssuerSecret } from '../../submission/contract-witnesses';
import { deriveRoleSeeds } from '../../utils/wallet-hd';
import { parentPort } from 'node:worker_threads';
import { FacadeEntry, InitArgs, PendingSave, SerializedBlobs, ensureNetworkId, facades, getSdkVersion, loadProvingSdk, loadSdk, log, resolveProvingMode } from './context';
import { collapseDustState, collapsedDustBlob, dustSaveKey } from './dust-collapse';
import { verifyCollapsedDustInHelper } from './dust-verify';
import type { DustCollapseSample } from '../dust-collapse-stats';
import {
    ReplayKind, appliedIndexOf, describeSyncState, formatSyncState, lastReplayRejection,
    observeReplayTrack, shouldResetRestoredSubWallet
} from './sync-replay';

// Limit for the sync wait before building a tx, so a stuck indexer fails the job instead of hanging it.
export const BALANCE_SYNC_TIMEOUT_MS = configMs('NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS');

/** `facade.waitForSyncedState()` never returns while the indexer lags, so it always gets a timeout. */
export async function waitForSyncedStateBounded(entry: FacadeEntry, site: string, timeoutMs?: number): Promise<any> {
    const bound = timeoutMs && timeoutMs > 0 ? timeoutMs : BALANCE_SYNC_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = rpcCancellation(`${site} sync wait`);
    try {
        return await Promise.race([
            entry.facade.waitForSyncedState(),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new NightgateError('WALLET_NOT_SYNCED', `${site}: sync timeout after ${bound}ms`)), bound); }),
            cancelled.promise
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        cancelled.dispose();
    }
}

// How many dust ledger events the wallet may lag and still count as synced. Event ids are not block heights.
export const SYNC_TIP_GAP = BigInt(configNumber('NIGHTGATE_SYNC_TIP_GAP'));
// Max age of the indexer's latest block. Syncing to an old block makes the wallet spend dust
// against tree roots the node no longer knows, which fails with error 117.
export const SYNC_FRESHNESS_MS = configMs('NIGHTGATE_SYNC_FRESHNESS_MS');
export const SYNC_POLL_MS = 3000;
export const SYNC_PROGRESS_LOG_MS = 15_000;
// The sync rate is measured over at most this window, so it reflects the current speed.
export const SYNC_RATE_WINDOW_MS = 60_000;
// A sync that made no progress for this long is stuck. A sync that still moves is only slow
// and may run up to the ceiling. 0 or less turns this off.
export const SYNC_STALL_MS = configMs('NIGHTGATE_PREWARM_STALL_MS');
// Upper limit for the initial sync wait when the caller sets none.
export const SYNC_CEILING_MS = 12 * 60 * 60 * 1000;
export const wsleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Sync progress of one wallet. The worker pushes it to the main thread, because the worker
 * cannot answer calls while it is busy syncing. Event ids are decimal strings.
 */
export interface SyncProgressSnapshot {
    sessionId: string;
    /** Dust ledger events applied so far. '-1' when unknown. */
    appliedIndex: string;
    /** Latest dust ledger event on the chain. '-1' when it could not be read. */
    streamTip: string;
    behindEvents: string | null;
    /** Events per second over about the last minute. Null until known. */
    eventsPerSecond: number | null;
    etaSeconds: number | null;
    blockHeight: string | null;
    isConnected: boolean;
    /** The indexer's latest block is recent enough. */
    indexerFresh: boolean;
    /** Null when the read failed. */
    indexerTipAgeMs?: number | null;
    indexerError?: string | null;
    caughtUp: boolean;
    elapsedMs: number;
    /** The kind of wait that produced this, such as 'prewarm' or 'balance'. */
    label: string;
    updatedAt: string;
    /** When `appliedIndex` last moved. If only `updatedAt` moves, the sync is stuck, not slow. */
    lastProgressAt: string;
    /** Dust figures at push time, shown while the worker is too busy to answer. */
    dust?: SyncDustFigures;
}

export interface SyncDustFigures {
    balance: string;
    availableNotes: number;
    pendingNotes: number;
    restoreCount: number;
    registeredNightUtxos: number;
    totalNightUtxos: number;
    at: string;
}

/** Counts like `getBalance`. Undefined when the state has no dust wallet or cannot be read. */
export function dustFiguresOf(state: any, entry: Pick<FacadeEntry, 'dustRestoresPersisted'>, now: number = Date.now()): SyncDustFigures | undefined {
    try {
        const dust = state?.dust;
        if (!dust) return undefined;
        const total: any[] = dust.totalCoins ?? [];
        const pending: any[] = dust.pendingCoins ?? [];
        const available: any[] | undefined = dust.availableCoins;
        return {
            balance: typeof dust.balance === 'function' ? String(dust.balance(new Date(now))) : '0',
            availableNotes: Array.isArray(available) ? available.length : Math.max(0, total.length - pending.length),
            pendingNotes: pending.length,
            restoreCount: entry.dustRestoresPersisted ?? 0,
            registeredNightUtxos: countRegisteredNightUtxos(state),
            totalNightUtxos: countAllNightUtxos(state, 0),
            at: new Date(now).toISOString()
        };
    } catch {
        return undefined;
    }
}

export const syncProgress = new Map<string, SyncProgressSnapshot>();

export function pushSyncProgress(snapshot: SyncProgressSnapshot, dust?: SyncDustFigures): void {
    if (dust) snapshot.dust = dust;
    parentPort?.postMessage({ kind: 'sync-progress', sessionId: snapshot.sessionId, snapshot });
}

/** The indexer's latest block. */
export interface IndexerTip {
    height: bigint | null;
    timestampMs: number | null;
    /** Why the read failed, such as `HTTP 403` or `timeout`. Null on success. */
    error: string | null;
    /** `cached` means the read failed and the values come from the last successful read. */
    via: 'http' | 'ws' | 'cached' | null;
}

const BLOCK_TIP_QUERY = '{ block { height timestamp } }';

async function readIndexerTipHttp(indexerHttpUrl: string): Promise<IndexerTip> {
    try {
        const r = await fetch(indexerHttpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: BLOCK_TIP_QUERY }),
            signal: AbortSignal.timeout(15_000)
        });
        // A refusal from the indexer's proxy is HTML, not JSON.
        const j: any = await r.json().catch(() => null);
        const b = j?.data?.block;
        if (b?.timestamp == null) {
            return { height: null, timestampMs: null, error: r.ok === false ? `HTTP ${r.status}` : 'no block in the answer', via: null };
        }
        return { height: b.height != null ? BigInt(b.height) : null, timestampMs: Number(b.timestamp), error: null, via: 'http' };
    } catch (err: unknown) {
        const error = errorName(err) === 'TimeoutError' ? 'timeout' : formatErr(err).slice(0, 120);
        return { height: null, timestampMs: null, error, via: null };
    }
}

async function readIndexerTipWs(indexerHttpUrl: string): Promise<IndexerTip | null> {
    const b: any = await oneShotSubscription(indexerHttpUrl, 'subscription { blocks { height timestamp } }', (data) => data?.blocks ?? null);
    if (b?.timestamp == null) return null;
    return { height: b.height != null ? BigInt(b.height) : null, timestampMs: Number(b.timestamp), error: null, via: 'ws' };
}

export const indexerTipCache = new Map<string, { tip: IndexerTip; at: number }>();
const indexerTipVia = new Map<string, IndexerTip['via']>();

/** How long a failed read may reuse the last successful one. 0 turns this off. */
export function indexerTipGraceMs(): number {
    return configMs('NIGHTGATE_INDEXER_TIP_GRACE_MS');
}

/**
 * Reads the indexer's latest block over HTTP, else over a websocket subscription, because the two
 * can fail independently. As a last resort it reuses a recent successful read. Its timestamp
 * is kept, so it still counts as old when it is old.
 */
export async function getIndexerTip(indexerHttpUrl: string): Promise<IndexerTip> {
    const http = await readIndexerTipHttp(indexerHttpUrl);
    let tip = http;
    if (http.error) {
        const ws = await readIndexerTipWs(indexerHttpUrl);
        if (ws) tip = ws;
        else {
            const cached = indexerTipCache.get(indexerHttpUrl);
            const age = cached ? Date.now() - cached.at : Infinity;
            if (cached && age < indexerTipGraceMs()) tip = { ...cached.tip, error: http.error, via: 'cached' };
        }
    }
    if (!tip.error) indexerTipCache.set(indexerHttpUrl, { tip, at: Date.now() });
    const before = indexerTipVia.get(indexerHttpUrl);
    if (before !== tip.via) {
        indexerTipVia.set(indexerHttpUrl, tip.via);
        if (tip.via === 'http') { if (before !== undefined) log('info', 'indexer tip read over http again'); }
        else if (tip.via === 'ws') log('info', `indexer tip read over the blocks subscription (http: ${http.error})`);
        else if (tip.via === 'cached') log('info', `indexer tip reads failing (http: ${http.error}, no subscription answer), reusing the last read within ${Math.round(indexerTipGraceMs() / 1000)}s`);
        else log('info', `indexer tip unknown (http: ${http.error}, no subscription answer, nothing to reuse)`);
    }
    return tip;
}

export function indexerTipAgeMs(tip: IndexerTip, now: number = Date.now()): number | null {
    return tip.timestampMs != null ? Math.max(0, now - tip.timestampMs) : null;
}

export type LedgerEventStream = 'dust' | 'zswap';
const STREAM_FIELD: Record<LedgerEventStream, string> = { dust: 'dustLedgerEvents', zswap: 'zswapLedgerEvents' };

export const streamTipCache = new Map<LedgerEventStream, { tip: bigint; at: number }>();

/** How long a failed read may reuse the last successful one. 0 turns this off. */
export function streamTipGraceMs(): number {
    return configMs('NIGHTGATE_STREAM_TIP_GRACE_MS');
}

/**
 * The latest dust ledger event id on the chain. This is the only correct target for `appliedIndex`,
 * because `progress.highestIndex` stays 0 on public indexers.
 * The public indexer drops some of these requests, so a failed read reuses a recent one.
 * Null when nothing recent is known.
 */
export function getDustStreamTip(indexerHttpUrl: string): Promise<bigint | null> {
    return getLedgerEventStreamTip(indexerHttpUrl, 'dust');
}

export async function getLedgerEventStreamTip(indexerHttpUrl: string, stream: LedgerEventStream): Promise<bigint | null> {
    const cached = streamTipCache.get(stream);
    if (cached && Date.now() - cached.at < 10_000) return cached.tip;
    const field = STREAM_FIELD[stream];
    const maxId = await oneShotSubscription(indexerHttpUrl, `subscription { ${field}(id: 0) { id maxId } }`, (data) => data?.[field]?.maxId ?? null);
    if (maxId != null) {
        const tip = BigInt(maxId);
        streamTipCache.set(stream, { tip, at: Date.now() });
        return tip;
    }
    return staleStreamTip(stream, cached);
}

let wsModule: Promise<any> | undefined;
function loadWs(): Promise<any> {
    wsModule ??= import('ws').catch((e) => { wsModule = undefined; throw e; });
    return wsModule;
}

/**
 * Opens a GraphQL subscription on the indexer and returns its first answer.
 * Null on any error or when no answer comes within 10 s.
 */
async function oneShotSubscription<T>(indexerHttpUrl: string, query: string, pick: (data: any) => T | null): Promise<T | null> {
    const wsUrl = deriveIndexerWsUrl(indexerHttpUrl);
    try {
        const { default: WebSocket } = await loadWs();
        return await new Promise<T | null>((resolve) => {
            const sock: any = new (WebSocket as any)(wsUrl, 'graphql-transport-ws');
            let settled = false;
            const done = (v: T | null) => {
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
                        sock.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query } }));
                    } else if (m.type === 'next') {
                        done(pick(m.payload?.data));
                    } else if (m.type === 'error' || m.type === 'complete') {
                        done(null);
                    }
                } catch { done(null); }
            });
            sock.on('error', () => done(null));
            sock.on('close', () => done(null));
        });
    } catch { return null; }
}

function staleStreamTip(stream: LedgerEventStream, cached: { tip: bigint; at: number } | undefined): bigint | null {
    const age = cached ? Date.now() - cached.at : Infinity;
    if (!cached || age >= streamTipGraceMs()) return null;
    log('debug', `${stream} stream tip read failed, reusing ${cached.tip} from ${Math.round(age / 1000)}s ago`);
    return cached.tip;
}

/** True when the wallet is connected, close enough to the latest event, and the indexer is current. */
export function isGenuinelyCaughtUp(r: { connected: boolean; applied: bigint; streamTip: bigint; indexerFresh: boolean }): boolean {
    return r.connected && r.streamTip > 0n && r.applied >= 0n && r.applied >= r.streamTip - SYNC_TIP_GAP && r.indexerFresh;
}

/** The wallet's current state without waiting for a sync, or null on timeout or error. */
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
        try { sub && sub.unsubscribe(); } catch { /* already closed */ }
        if (timer) clearTimeout(timer);
    }
}

export function countRegisteredNightUtxos(state: any): number {
    const all: any[] = state?.unshielded?.totalCoins ?? [];
    return all.filter((c: any) => c?.meta?.registeredForDustGeneration === true).length;
}

/** All NIGHT UTXOs, registered or not. Returns `fallback` while the state has no coin list yet. */
export function countAllNightUtxos(state: any, fallback: number): number {
    const all: any[] | undefined = state?.unshielded?.totalCoins;
    return Array.isArray(all) ? all.length : fallback;
}

/**
 * Waits until the wallet is really synced, because the SDK's `waitForSyncedState()` cannot be trusted.
 * Fails after `stallMs` without progress or after `timeoutMs` in total.
 */
export async function waitForGenuineSync(entry: FacadeEntry, timeoutMs: number, label: string, stallMs: number = SYNC_STALL_MS): Promise<void> {
    const { facade, indexerHttpUrl, sessionId } = entry;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastLog = 0;
    let lastApplied = -1n;
    let lastHighest = -1n;
    let progressApplied = -1n;
    let lastProgressAt = startedAt;
    let anchor: { applied: bigint; at: number } | null = null;

    const publish = (
        applied: bigint, highest: bigint, tip: IndexerTip,
        connected: boolean, fresh: boolean, caughtUp: boolean
    ): SyncProgressSnapshot => {
        const blockHeight = tip.height;
        const now = Date.now();
        let eventsPerSecond: number | null = null;
        if (applied >= 0n) {
            if (!anchor) {
                anchor = { applied, at: now };
            } else if (now - anchor.at >= SYNC_POLL_MS) {
                const seconds = (now - anchor.at) / 1000;
                const delta = Number(applied - anchor.applied);
                // A restored wallet can report a lower index right after start.
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
            indexerTipAgeMs: indexerTipAgeMs(tip, now),
            indexerError: tip.error,
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
        throwIfRpcCancelled(`${label} sync wait`);
        const tip = await getIndexerTip(indexerHttpUrl);
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
            // Always unsubscribe. With a stuck indexer the timeout wins every time.
            try { sub && sub.unsubscribe(); } catch { /* already closed */ }
            if (peekTimer) clearTimeout(peekTimer);
        }
        if (peekFailed) {
            // An unreadable state counts as no progress.
            if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
                const last = syncProgress.get(sessionId);
                throw new NightgateError('WALLET_NOT_SYNCED', `wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min and the wallet state is not readable (state peek timed out or failed on every poll; last snapshot: dust appliedIndex=${last?.appliedIndex ?? lastApplied}, streamTip=${last?.streamTip ?? lastHighest}, isConnected=${last?.isConnected ?? '?'}, elapsed=${Math.round((Date.now() - startedAt) / 1000)}s)`);
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
        const snapshot = publish(applied, highest, tip, connected, fresh, caughtUp);
        if (caughtUp) {
            pushSyncProgress(snapshot, dustFiguresOf(state, entry));
            log('info', `genuine-sync [${label}] CAUGHT UP: appliedIndex=${applied} streamTip=${highest} blockHeight=${tip.height} fresh=${fresh} after=${Math.round(snapshot.elapsedMs / 1000)}s`);
            return;
        }
        if (stallMs > 0 && Date.now() - lastProgressAt > stallMs) {
            pushSyncProgress(snapshot);
            const behind = snapshot.behindEvents ?? '?';
            throw new NightgateError('WALLET_NOT_SYNCED', `wallet sync stalled: no progress for ${Math.round((Date.now() - lastProgressAt) / 60_000)} min (dust appliedIndex stuck at ${applied}, streamTip=${highest}, ${behind} events behind, blockHeight=${tip.height}, isConnected=${connected}, indexerFresh=${fresh}, elapsed=${Math.round(snapshot.elapsedMs / 1000)}s)`);
        }
        // Logged at info level so a long sync can be told apart from a hang.
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
    const rate = syncProgress.get(sessionId)?.eventsPerSecond;
    throw new NightgateError('WALLET_NOT_SYNCED', `wallet not synced to tip after ${timeoutMs}ms (absolute ceiling): still ${behind} events behind at ${rate != null ? rate.toFixed(1) : '?'} events/s, dust appliedIndex=${lastApplied} streamTip=${lastHighest}, blockHeight=${tip.height}; the sync was moving (no stall detected), raise NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS or wait for a quieter machine`);
}

export async function buildFacade(args: InitArgs): Promise<FacadeEntry> {
    const sdk = await loadSdk();
    await ensureNetworkId(args.networkId, sdk);

    // Each key type comes from its own HD path, as in the Lace wallet.
    // accountIndex must match the session's WalletSessions.accountIndex.
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
        // A fee of 0 makes the SDK build an empty dust part, which the node rejects with 1010/117.
        // additionalFeeOverhead of at least 1 prevents that. feeBlocksMargin 1 is too tight on quiet networks.
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };

    const dustParameters = sdk.ledger.LedgerParameters.initialParameters().dust;
    const ShieldedWallet = sdk.shielded.ShieldedWallet;
    const UnshieldedWallet = sdk.unshielded.UnshieldedWallet;
    const DustWallet = sdk.dust.DustWallet;
    const restore = args.restoreBlobs;

    const provingMode = resolveProvingMode();
    const proving = provingMode === 'wasm' ? await loadProvingSdk() : undefined;
    // Shared by all wallets, so the keys are downloaded only once.
    const sharedKeys = provingMode === 'wasm' ? await getSharedKeyMaterialProvider() : undefined;
    if (provingMode === 'wasm') {
        log('info', 'proving mode: wasm (in-process prover; proof server not used for wallet proving)');
    }

    const facade = await sdk.facade.WalletFacade.init({
        configuration,
        ...(proving ? { provingService: () => proving.makeWasmProvingService({ keyMaterialProvider: sharedKeys }) } : {}),
        shielded: () => restore?.shielded
            ? ShieldedWallet(configuration).restore(restore.shielded)
            : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => restore?.unshielded
            ? UnshieldedWallet(configuration).restore(restore.unshielded)
            : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        // A restored dust state can refer to tree roots the node has forgotten, so its dust cannot be
        // spent (error 117). NIGHTGATE_DUST_COLD_START syncs the dust wallet from scratch instead.
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
        attestationSecret: deriveAttestationSecret(roleSeeds.zswap),
        tokenFactoryIssuerSecret: deriveTokenFactoryIssuerSecret(roleSeeds.zswap)
    };
}

export let saveSeqCounter = 0;

// Keyed by save number and not by wallet, so a wallet unloaded before the
// confirmation arrives does not leave a waiter hanging.
export const saveAckWaiters = new Map<number, () => void>();

export function resolveSaveAckWaiter(seq: number): void {
    saveAckWaiters.get(seq)?.();
}

export interface PushStateSaveOptions {
    /** Runs before sending, so a waiter is registered before any confirmation can arrive. */
    beforePost?: (seq: number) => void;
    /** `dustSaveKey` of the dust blob, remembered on confirmation so an unchanged state skips the next collapse. */
    dustKey?: string;
}

/** `lastSavedBlobs` changes only on confirmation, so a lost save is sent again on the next tick. */
export function pushStateSave(sessionId: string, entry: FacadeEntry, blobs: SerializedBlobs, options: PushStateSaveOptions = {}): number {
    const seq = ++saveSeqCounter;
    entry.pendingSaves ??= new Map();
    // The epochs let applySaveAck ignore saves of a wallet that was replaced since.
    const pending: PendingSave = { blobs, dustEpoch: entry.dustEpoch ?? 0, shieldedEpoch: entry.shieldedEpoch ?? 0 };
    if (blobs.dust !== undefined && options.dustKey !== undefined) pending.dustKey = options.dustKey;
    entry.pendingSaves.set(seq, pending);
    // Keep the map small when the main thread never confirms.
    if (entry.pendingSaves.size > 4) {
        entry.pendingSaves.delete(Math.min(...entry.pendingSaves.keys()));
    }
    options.beforePost?.(seq);
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
    return configMs('NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS');
}

/** Resolves when the main thread confirms the save. Rejects after `timeoutMs`, because a failed save is never confirmed. */
export function pushStateSaveAcked(sessionId: string, entry: FacadeEntry, blobs: SerializedBlobs, timeoutMs: number, dustKey?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const beforePost = (seq: number): void => {
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
        };
        pushStateSave(sessionId, entry, blobs, { beforePost, dustKey });
    });
}

/**
 * Merges, because a save carries only the parts that changed.
 * A part saved before its wallet was replaced is ignored.
 */
export function applySaveAck(entry: FacadeEntry, seq: number): void {
    const pending = entry.pendingSaves?.get(seq);
    if (!pending) return;
    let effective = pending.blobs;
    if (effective.dust !== undefined && pending.dustEpoch !== (entry.dustEpoch ?? 0)) {
        const { dust: _stale, ...rest } = effective;
        effective = rest;
    }
    if (effective.shielded !== undefined && pending.shieldedEpoch !== (entry.shieldedEpoch ?? 0)) {
        const { shielded: _stale, ...rest } = effective;
        effective = rest;
    }
    if (effective.dust !== undefined) {
        // A dust save without a key (a restore's re-save) must not let an old key skip the next tick.
        entry.lastSavedDustKey = pending.dustKey === undefined ? undefined : { epoch: pending.dustEpoch, key: pending.dustKey };
    }
    entry.lastSavedBlobs = { ...entry.lastSavedBlobs, ...effective };
    entry.pendingSaves!.delete(seq);
}

/** Reports sync progress while no job waits, because `waitForGenuineSync` reports only during a wait. */
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
 * Checks for a stuck restored wallet first, then reports progress.
 * Skips the report when a sync wait reported recently, and after a wallet part was replaced.
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
        blockHeight: tip.height != null ? tip.height.toString() : null, isConnected: connected, indexerFresh,
        indexerTipAgeMs: indexerTipAgeMs(tip), indexerError: tip.error, caughtUp,
        elapsedMs: 0, label: last?.label ?? 'idle', updatedAt: at,
        lastProgressAt: last && last.appliedIndex === applied.toString() ? last.lastProgressAt : at
    };
    syncProgress.set(sessionId, snapshot);
    pushSyncProgress(snapshot, dustFiguresOf(state, entry));
    if (!caughtUp) {
        log('info', `idle-sync ${sessionId.slice(0, 16)} appliedIndex=${applied} streamTip=${highest} behindEvents=${behind ?? '?'} connected=${connected} fresh=${indexerFresh}${tip.error ? ` indexerError=${tip.error}` : ''} (no job waiting)`);
    }
}

/** How long a restored wallet part may be stuck before it is replaced. 0 turns this off. */
export function snapshotReplayResetMs(): number {
    return configMs('NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS');
}

/**
 * Replaces a restored wallet part that is stuck while the ledger rejects its events.
 * Returns whether one was replaced.
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
 * Replaces a wallet part with a fresh one that syncs from the start. Runs under the submit lock.
 * The fresh state is saved and the epoch raised, so neither a restart nor an old save brings back
 * the broken state. Returns false when the wallet is gone or the fresh part does not start.
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

export function syncStateLogMs(): number {
    return configMs('NIGHTGATE_SYNC_STATE_LOG_MS');
}

/** Logs the positions the saved state resumes from, so a problem shows before a restart needs them. */
export async function maybeLogSyncState(sessionId: string, entry: FacadeEntry, now: number = Date.now()): Promise<void> {
    const interval = syncStateLogMs();
    if (interval <= 0 || now - (entry.lastSyncStateLogAt ?? 0) < interval) return;
    entry.lastSyncStateLogAt = now;
    const state = await peekFacadeState(entry.facade, 5_000);
    if (state == null) return;
    log('info', `sync-state ${sessionId.slice(0, 16)} ${formatSyncState(describeSyncState(state))}`);
}

/**
 * Each save serializes several MB, and dust changes almost every block, so a short interval
 * costs a lot of garbage collection. The interval only limits how much sync is redone after a crash.
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
        // Logged before the first await, because serializeState() can hang.
        log('debug', `save-tick #${tickCount} fired, calling collectSerializedStates...`);
        try {
            const collectStart = Date.now();
            const epochAtCollect = entry.dustEpoch ?? 0;
            const shieldedEpochAtCollect = entry.shieldedEpoch ?? 0;
            const { blobs, dustKey, dustCollapse } = await collectSerializedStates(entry.facade, entry);
            if (dustCollapse) parentPort?.postMessage({ kind: 'save-stats', sessionId, dust: dustCollapse });
            if ((entry.dustEpoch ?? 0) !== epochAtCollect && blobs.dust) {
                // The dust wallet was replaced meanwhile, so this blob may be the old one's. The replacement saved its own.
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
            // Send only the parts that differ from the last confirmed save, so a failed save is retried.
            const changed = diffAgainstConfirmed(entry, blobs);
            if (!hasAnyBlob(changed)) {
                log('debug', `save-tick #${tickCount} unchanged, skipping push`);
                return;
            }
            const seq = pushStateSave(sessionId, entry, changed, { dustKey });
            log('debug', `save-tick #${tickCount} pushed seq=${seq} (total ${Date.now() - tickStart}ms)`);
        } catch (err: unknown) {
            log('warn', `periodic save failed: ${formatErr(err)}`);
        }
    }, intervalMs);
    entry.saveTimer.unref();
}

export interface CollectedStates {
    blobs: SerializedBlobs;
    /** `dustSaveKey` of `blobs.dust`, when the state exposed one. */
    dustKey?: string;
    /** Set when the collapse flag is on and the dust part was handled. */
    dustCollapse?: DustCollapseSample;
}

/** The last confirmed dust save, so an unchanged dust state is not serialized again. */
export type SaveSkipContext = Pick<FacadeEntry, 'dustEpoch' | 'lastSavedDustKey'>;

export async function collectSerializedStates(facade: any, skip?: SaveSkipContext): Promise<CollectedStates> {
    const blobs: SerializedBlobs = {};
    const out: CollectedStates = { blobs };
    const tryOne = async (key: 'shielded' | 'unshielded' | 'dust') => {
        try {
            const sub = facade?.[key];
            if (key === 'dust' && sub?.state && configFlag('NIGHTGATE_DUST_SNAPSHOT_COLLAPSE')) {
                const started = Date.now();
                try {
                    const collapsed = await collapsedDustSave(sub, skip);
                    out.dustCollapse = collapsed.sample;
                    if (collapsed.skipped) return;
                    blobs.dust = collapsed.blob;
                    if (collapsed.dustKey !== null) out.dustKey = collapsed.dustKey;
                    return;
                } catch (err) {
                    noteDustCollapseFallback(formatErr(err));
                    out.dustCollapse = { outcome: 'uncollapsed', ms: Date.now() - started, verifyMs: null, fullBytes: null, bytes: null, at: new Date().toISOString() };
                }
            }
            if (sub && typeof sub.serializeState === 'function') {
                const blob = await sub.serializeState();
                if (typeof blob === 'string') blobs[key] = blob;
            }
        } catch {
            // One missing part must not block the others.
        }
    };
    await Promise.all([tryOne('shielded'), tryOne('unshielded'), tryOne('dust')]);
    return out;
}

// Each reason is logged once, not on every save.
const dustCollapseNoted = new Set<string>();

function firstEmission(observable: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
        let sub: any;
        const timer = setTimeout(() => { sub?.unsubscribe?.(); reject(new Error(`no state within ${timeoutMs}ms`)); }, timeoutMs);
        sub = observable.subscribe({
            next: (v: any) => { clearTimeout(timer); resolve(v); queueMicrotask(() => sub?.unsubscribe?.()); },
            error: (e: any) => { clearTimeout(timer); reject(e); }
        });
    });
}

// A collapse slower than this is logged at INFO, so the operator sees the cost grow.
export const DUST_COLLAPSE_SLOW_MS = 5000;

type CollapsedDustSave =
    | { skipped: true; sample: DustCollapseSample }
    | { skipped: false; blob: string; dustKey: string | null; sample: DustCollapseSample };

/**
 * Like `serializeState()`, but with the dust tree shrunk (see dust-collapse.ts).
 * Skips everything while the state's key equals the last confirmed save's.
 * The restore check runs in the helper thread; past its budget or failed, the full blob is saved.
 */
async function collapsedDustSave(dust: any, skip?: SaveSkipContext): Promise<CollapsedDustSave> {
    const started = Date.now();
    const walletState = await firstEmission(dust.state, 30_000);
    const dustKey = dustSaveKey(walletState);
    const last = skip?.lastSavedDustKey;
    if (dustKey !== null && last && last.key === dustKey && last.epoch === (skip?.dustEpoch ?? 0)) {
        log('debug', `dust snapshot unchanged (key ${dustKey}), collapse skipped`);
        return { skipped: true, sample: { outcome: 'skipped', ms: Date.now() - started, verifyMs: null, fullBytes: null, bytes: null, at: new Date().toISOString() } };
    }
    const collapsed = collapseDustState(walletState);
    const verifyStarted = Date.now();
    let verdict: { ok: true } | { ok: false; reason: string };
    try {
        verdict = await verifyCollapsedDustInHelper(collapsed.bytes, collapsed.expect);
    } catch (err) {
        verdict = { ok: false, reason: formatErr(err) };
    }
    const verifyMs = Date.now() - verifyStarted;
    const ms = Date.now() - started;
    if (!verdict.ok) {
        noteDustCollapseFallback(verdict.reason);
        return { skipped: false, blob: collapsed.fullBlob, dustKey, sample: { outcome: 'uncollapsed', ms, verifyMs, fullBytes: collapsed.fullBytes, bytes: collapsed.fullBytes, at: new Date().toISOString() } };
    }
    const bytes = collapsed.bytes.length;
    log(ms > DUST_COLLAPSE_SLOW_MS ? 'info' : 'debug', `dust snapshot collapsed ${collapsed.fullBytes} -> ${bytes} bytes in ${ms}ms (verify ${verifyMs}ms, ${collapsed.ranges} ranges, ${collapsed.ownLeaves} own leaves)`);
    return { skipped: false, blob: collapsedDustBlob(collapsed.fullBlob, collapsed.bytes), dustKey, sample: { outcome: 'collapsed', ms, verifyMs, fullBytes: collapsed.fullBytes, bytes, at: new Date().toISOString() } };
}

function noteDustCollapseFallback(reason: string): void {
    if (dustCollapseNoted.has(reason)) return;
    dustCollapseNoted.add(reason);
    log('warn', `dust snapshot saved uncollapsed: ${reason}`);
}

export function hasAnyBlob(b: SerializedBlobs): boolean {
    return !!(b.shielded || b.unshielded || b.dust);
}

export function diffAgainstConfirmed(entry: FacadeEntry, blobs: SerializedBlobs): SerializedBlobs {
    const saved = entry.lastSavedBlobs ?? {};
    const changed: SerializedBlobs = {};
    if (blobs.shielded && blobs.shielded !== saved.shielded) changed.shielded = blobs.shielded;
    if (blobs.unshielded && blobs.unshielded !== saved.unshielded) changed.unshielded = blobs.unshielded;
    if (blobs.dust && blobs.dust !== saved.dust) changed.dust = blobs.dust;
    return changed;
}

// Submits of one wallet run one at a time, because parallel builds would pick the same coins.
// Sponsored submits lock both wallets. Saving and restoring the dust state relies on this lock.
export const sessionChains = new Map<string, Promise<unknown>>();

export function submitLockKeys(args: any): string[] {
    return [args?.sessionId, args?.sponsorSessionId]
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
}

/** Runs `fn` while holding all given locks. All locks are taken at once, so this cannot deadlock. */
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
        // Clean up the lock of an unloaded wallet, but only if no later caller is queued on it.
        for (const k of ordered) {
            if (sessionChains.get(k) === gate && !facades.has(k)) sessionChains.delete(k);
        }
    }
}


// A wallet build can outlast the main thread's timeout. A retry joins it instead of starting another.
const buildsInFlight = new Map<string, Promise<FacadeEntry>>();
// Sessions unloaded while their build ran. The finished wallet is discarded.
const evictedWhileBuilding = new Set<string>();

export async function init(args: InitArgs, build: (args: InitArgs) => Promise<FacadeEntry> = buildFacade) {
    if (facades.has(args.sessionId)) {
        log('debug', `init: cache hit ${args.sessionId.slice(0, 16)}`);
        return { facadeReady: true, alreadyExisted: true };
    }
    const running = buildsInFlight.get(args.sessionId);
    if (running) {
        log('info', `init: joining the build in flight for ${args.sessionId.slice(0, 16)}`);
        const entry = await running;
        return { facadeReady: true, alreadyExisted: true, sdkVersion: entry.sdkVersion };
    }
    evictedWhileBuilding.delete(args.sessionId);
    const building = (async () => {
        const entry = await build(args);
        if (evictedWhileBuilding.delete(args.sessionId)) {
            await zeroEntry(entry, args.sessionId);
            throw new Error(`Session ${args.sessionId.slice(0, 16)} was evicted while its wallet was being built`);
        }
        facades.set(args.sessionId, entry);
        startPeriodicSave(args.sessionId, entry);
        startProgressWatch(args.sessionId, entry);
        return entry;
    })();
    buildsInFlight.set(args.sessionId, building);
    try {
        const entry = await building;
        return { facadeReady: true, alreadyExisted: false, sdkVersion: entry.sdkVersion };
    } finally {
        buildsInFlight.delete(args.sessionId);
    }
}

async function zeroEntry(entry: FacadeEntry, sessionId: string): Promise<void> {
    try {
        entry.zswapKeys?.clear?.();
        entry.dustKey?.clear?.();
        entry.unshieldedKeystore?.clear?.();
        try { entry.attestationSecret?.fill?.(0); } catch { /* not a buffer */ }
        try { entry.tokenFactoryIssuerSecret?.fill?.(0); } catch { /* not a buffer */ }
        await entry.facade?.stop?.();
    } catch (err) {
        log('warn', `evict cleanup failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
    }
}

export async function cpuProfile({ seconds, dir }: { seconds?: number; dir?: string }) {
    const p = await profileCurrentThread(seconds ?? 20, { dir, filePrefix: 'worker' });
    log('info', `cpuProfile: ${p.seconds}s sampled, idle ${p.idlePercent}%, gc ${p.gcPercent}% (${p.gc.count} collections, ${p.gc.totalMs}ms), wasm ${p.wasmPercent}%, heap ${p.heapAfter.usedMb}/${p.heapAfter.limitMb} MB, external ${p.heapAfter.externalMb} MB, top: ${p.topFunctions.slice(0, 3).map((f: { label: string; percent: number }) => `${f.label.split('  ')[0]} ${f.percent}%`).join(', ')}`);
    return { thread: 'worker', facadeCount: facades.size, ...p, gc: { ...p.gc, byKind: JSON.stringify(p.gc.byKind) } };
}

export async function waitForSyncedState({ sessionId, timeoutMs, stallMs }: { sessionId: string; timeoutMs?: number; stallMs?: number }) {
    const entry = facades.get(sessionId);
    if (!entry) throw new Error(`No facade for sessionId=${sessionId.slice(0, 16)}`);
    // The SDK's isSynced is always true when highestIndex is 0, so use our own check.
    await waitForGenuineSync(entry, timeoutMs ?? SYNC_CEILING_MS, 'prewarm', stallMs ?? SYNC_STALL_MS);
    return { synced: true };
}

/** With `awaitSaveAck`, replies only after the final save was confirmed. */
export async function evict({ sessionId, awaitSaveAck }: { sessionId: string; awaitSaveAck?: boolean }) {
    const entry = facades.get(sessionId);
    if (!entry) {
        if (!buildsInFlight.has(sessionId)) return { evicted: false };
        evictedWhileBuilding.add(sessionId);
        return { evicted: true, saved: false };
    }
    let saved = true;
    // Remove it first so no new submit can find this wallet.
    facades.delete(sessionId);
    syncProgress.delete(sessionId);
    if (entry.saveTimer) clearInterval(entry.saveTimer);
    if (entry.progressTimer) clearInterval(entry.progressTimer);
    // Runs under the submit lock so the keys are not wiped during a running submit.
    await withSessionLocks([sessionId], async () => {
        // Wait for the confirmation before replying, because after the reply the main thread
        // no longer stores saves for this session. On timeout the unload continues.
        try {
            const { blobs, dustKey } = await collectSerializedStates(entry.facade, entry);
            const changed = diffAgainstConfirmed(entry, blobs);
            if (hasAnyBlob(changed)) {
                if (awaitSaveAck) await pushStateSaveAcked(sessionId, entry, changed, restoreSaveAckTimeoutMs(), dustKey);
                else pushStateSave(sessionId, entry, changed, { dustKey });
            }
        } catch (err) {
            saved = false;
            log('warn', `evict final-save failed for ${sessionId.slice(0, 16)}: ${formatErr(err)}`);
        }
        await zeroEntry(entry, sessionId);
    });
    return { evicted: true, saved };
}

export const facadeHandlers = { init, cpuProfile, waitForSyncedState, evict };
