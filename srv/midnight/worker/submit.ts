/**
 * Submission: dust wedge protection, the submit-intent handshake, the one send path (a
 * dedicated phased client per submit, same-transaction resend on a transport failure) and the
 * wallet providers that route a build through it.
 */

import { configNumber, configMs, configEnum } from '../../utils/config';
import { SUBMIT_METHODS } from '../wallet-worker-protocol';
import { classifySubmitFailure, isPreMempoolFailure } from '../submit-error-classification';
import path from 'node:path';
import { classificationHaystack, formatErr, formatErrWithCauses, safeDeepInspect } from '../../utils/format-error';
import { type MessagePort } from 'node:worker_threads';
import { FacadeEntry, loadSdk, loadNodeClientSdk, log, loadLedger } from './context';
import { createPhasedSubmitService, createSdkNodeAdapter, submitPhaseOf, type PhasedSubmitService } from './phased-submit';
import { BALANCE_SYNC_TIMEOUT_MS, applySaveAck, pushStateSaveAcked, restoreSaveAckTimeoutMs, waitForGenuineSync } from './facades';

/**
 * Dust sections per intent. A DustActions section with no spends and no registrations is the
 * node's 1010/117 NotNormalized. Never throws.
 */
export function describeTxDust(tx: any): { summary: string; emptyDustActions: boolean } {
    try {
        const parts: string[] = [];
        let empty = false;
        const intents = tx?.intents;
        if (!intents || typeof intents.entries !== 'function') {
            return { summary: 'no intents', emptyDustActions: false };
        }
        for (const [seg, intent] of intents.entries()) {
            const da = intent?.dustActions;
            if (!da) {
                parts.push(`seg=${seg} dust=none`);
                continue;
            }
            const spends = da.spends?.length ?? 0;
            const regs = da.registrations?.length ?? 0;
            const ctime = da.ctime instanceof Date ? da.ctime.toISOString() : String(da.ctime ?? '?');
            parts.push(`seg=${seg} dust{spends=${spends} regs=${regs} ctime=${ctime}}`);
            if (spends === 0 && regs === 0) empty = true;
        }
        return { summary: parts.join(' | ') || 'no intents', emptyDustActions: empty };
    } catch (e) {
        return { summary: `dump failed: ${(e as Error)?.message ?? e}`, emptyDustActions: false };
    }
}

/** Best-effort revert of a built-but-never-submitted recipe (or finalized tx). */
export async function revertRecipeBestEffort(facade: any, txOrRecipe: any, site: string): Promise<void> {
    if (!txOrRecipe) return;
    try {
        await facade.revert(txOrRecipe);
    } catch (e) {
        log('warn', `${site}: recipe revert failed (coins may stay pending until a fresh resync): ${formatErr(e)}`);
    }
}

/** Fee of a recipe built only for pricing; the recipe is always reverted. */
export async function feeOfDiscardedRecipe(facade: any, recipe: any, site: string): Promise<bigint> {
    try {
        return await facade.calculateTransactionFee(recipe.transaction);
    } finally {
        await revertRecipeBestEffort(facade, recipe, site);
    }
}

// ---- Dust wedge protection ------------------------------------------------
// A pre-mempool reject leaks the spent dust note (the SDK revert drops the pending marker but
// never reclaims the note), wedging a single-note wallet. So dust is snapshotted before each
// build and restored on a pre-mempool reject: nothing reached the chain, the snapshot is valid.

/** Rejects that provably never entered the mempool; never 1013 (that tx is in the pool). */
export function isPreMempoolReject(err: unknown): boolean {
    return isPreMempoolFailure(classifySubmitFailure(err));
}

/**
 * An earlier attempt may have reached the node and the indexer has not shown it, so a later
 * failure cannot say more than "unknown": the earlier bytes may still land. The main thread
 * keeps the identifier and never rebuilds (two identifiers, two fees).
 */
export class SubmitOutcomeUnknownError extends Error {
    readonly identifier: string;
    constructor(identifier: string, cause: unknown) {
        super(`submit outcome unknown: an earlier send of ${identifier.slice(0, 16)} may have reached the node and the indexer does not show it yet; the later attempt failed: ${formatErr(cause).slice(0, 300)}`, { cause });
        this.name = 'SubmitOutcomeUnknownError';
        this.identifier = identifier;
    }
}

/** Marks a submit failure whose attempts all ended before a send; the dust guard restores on it. */
function markNothingSent(err: unknown): void {
    if (err && typeof err === 'object') (err as any).nothingSent = true;
}
export function isNothingSent(err: unknown): boolean {
    let cur: any = err;
    for (let depth = 0; cur && depth < 8; depth++) {
        if (cur.nothingSent === true) return true;
        cur = cur.cause;
    }
    return false;
}

/** Arm the wedge protection before the build; a failed snapshot only disarms it for this tx. */
export async function captureDustSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    try {
        entry.preSubmitDustSnapshot = await entry.facade.dust.serializeState();
    } catch (e) {
        entry.preSubmitDustSnapshot = undefined;
        log('warn', `${site}: dust pre-build snapshot failed (wedge protection disarmed for this tx): ${formatErr(e)}`);
    }
}

/**
 * Safe mid-life: everything reaches the sub-wallet via `facade.dust` at call time and submits
 * serialize per facade. The unbound sponsor path runs outside that lock but never books a spend
 * here nor arms this snapshot. The old wallet stops only after the restored one started.
 */
export async function restoreDustFromSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    const snapshot = entry.preSubmitDustSnapshot;
    entry.preSubmitDustSnapshot = undefined;
    if (!snapshot) return;
    try {
        const sdk = await loadSdk();
        const fresh = sdk.dust.DustWallet(entry.walletConfiguration).restore(snapshot);
        await fresh.start(entry.dustKey);
        const old = entry.facade.dust;
        entry.facade.dust = fresh;
        try { await old.stop(); } catch { /* already dead is fine */ }
        // The save tick may have persisted the wedged state while proving. Persist the snapshot
        // now under a bumped epoch, so neither a late tick push nor a stale ack wins over it.
        entry.dustEpoch = (entry.dustEpoch ?? 0) + 1;
        log('info', `${site}: dust sub-wallet restored from pre-build snapshot after pre-mempool reject (leaked in-flight spend discarded, snapshot re-persisted)`);
        // Counted as persisted only after the main thread's ack.
        try {
            await pushStateSaveAcked(entry.sessionId, entry, { dust: snapshot }, restoreSaveAckTimeoutMs());
            entry.dustRestoresPersisted = (entry.dustRestoresPersisted ?? 0) + 1;
            log('info', `${site}: restored dust snapshot persist CONFIRMED (state-save ack)`);
        } catch (e) {
            log('warn', `${site}: restored dust snapshot persist NOT confirmed (${formatErr(e)}); the DB may hold the pre-restore state until the next periodic save lands`);
        }
    } catch (e) {
        log('warn', `${site}: dust snapshot restore failed; wallet may be dust-wedged until a cold re-sync: ${formatErr(e)}`);
    }
}

/** Pre-submit size and ledger cost, so a block-limit reject shows which dimension overflowed. Never throws. */
export async function logTxCost(tx: any, site: string): Promise<void> {
    try {
        const bytes = typeof tx?.serialize === 'function' ? tx.serialize() : undefined;
        const size = bytes?.length ?? bytes?.byteLength;
        let costSummary = 'n/a';
        try {
            const ledger: any = await loadLedger();
            const params = ledger.LedgerParameters.initialParameters();
            if (params && typeof tx?.cost === 'function') {
                const c = tx.cost(params);
                costSummary = typeof c === 'object' ? JSON.stringify(c, (_k, v) => typeof v === 'bigint' ? v.toString() : v) : String(c);
            }
        } catch (err) {
            costSummary = `cost() failed: ${(err as Error)?.message}`;
        }
        log('info', `${site}: pre-submit tx size=${size ?? '?'}B cost=${costSummary.slice(0, 800)}`);
    } catch {
        /* diagnostics only */
    }
}

// ---- Same-transaction resend on a transport failure -----------------------
// A failed SEND leaves the proven bytes valid, so the same tx object is resent. A lost reply may
// still have reached the node, so the indexer is probed before every resend and after a refused
// resend. Node rejects are never resent.
export function submitTransportRetries(): number {
    return configNumber('NIGHTGATE_SUBMIT_TRANSPORT_RETRIES');
}
export function submitTransportBackoffMs(): number {
    return configMs('NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS');
}
export function submitLandedProbeMs(): number {
    return configMs('NIGHTGATE_SUBMIT_LANDED_PROBE_MS');
}

/** The send itself failed; never a node reject. */
export function isSubmitTransportFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'transport';
}

/** Poll the indexer for the identifier for up to `windowMs`; null when it is not there. */
export async function waitLandedOnIndexer(entry: FacadeEntry, identifier: string, windowMs: number) {
    const deadline = Date.now() + windowMs;
    for (; ;) {
        const found = await indexerBlockOfIdentifier(entry.indexerHttpUrl, identifier);
        if (found) return found;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, deadline - Date.now()))));
    }
}

/**
 * Bound-channel handshake: the main thread persists the identifier as the job's external-effect
 * boundary and acks. Without an ack nothing is broadcast, so no landed tx is unknown to its job.
 */
export interface BoundSubmitIntent {
    replyPort?: MessagePort;
    contractAddress?: string;
    circuits?: string[];
    note?: string;
    /** Set by the balancing provider: the ttl it balanced with (ISO). */
    ttl?: string;
}

/**
 * Restores the dust snapshot only on a pre-mempool reject: a tx that may have reached the pool,
 * or failed on chain, has spent its dust fee.
 */
export async function submitWithDustGuard(entry: FacadeEntry, tx: any, site: string, intent?: BoundSubmitIntent): Promise<any> {
    if (intent?.replyPort) {
        try {
            // Fail closed: an unannounced tx could never be reconciled.
            if (typeof tx?.identifiers !== 'function') throw new Error(`${site}: transaction exposes no identifiers(); refusing to broadcast unannounced`);
            await announceSubmitIntent(intent.replyPort, {
                txHash: String(tx.identifiers().at(-1)),
                contractAddress: intent.contractAddress, circuits: intent.circuits, note: intent.note, ttl: intent.ttl
            });
        } catch (e) {
            // Not broadcast: free booked spends and dust (the SDK reverts only on a failed submit).
            await revertRecipeBestEffort(entry.facade, tx, `${site} intent`);
            await restoreDustFromSnapshot(entry, `${site} intent`);
            throw e;
        }
    }
    try {
        const txId = await submitOnDedicatedClient(entry, tx, site, { book: true });
        entry.preSubmitDustSnapshot = undefined;
        return txId;
    } catch (e) {
        if (isPreMempoolReject(e) || isNothingSent(e)) {
            await restoreDustFromSnapshot(entry, site);
        } else {
            // A tx that may have reached the pool keeps its booked spends.
            log('info', `${site}: submit failed, NOT classified pre-mempool (dust guard disarmed): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            entry.preSubmitDustSnapshot = undefined;
        }
        throw e;
    }
}

// ---- Dedicated submission clients (parallel sponsor path) ------------------
// The SDK node client disconnects its shared socket after every submission stream, so concurrent
// submits on one client kill each other: each gets an exclusive pooled client. `disconnect()`
// returns before the socket closes, so a slot is ready only a settle window after creation
// and each use; a send that dies on that closing socket never left and is retried once.
export let SUBMIT_CLIENT_POOL_MAX = 8;
let submitClientSettleMs = 2500;
/** Bound on closing an abandoned client: its SDK close waits for the client's own initialisation, which may be what hung. */
export const SUBMIT_CLOSE_TIMEOUT_MS = 5000;
export type SubmitClientSlot = { svc: any; busy: Promise<unknown> | null; readyAt: number };
export const submitClientPools = new Map<string, SubmitClientSlot[]>();
export const submitClientWaiters = new Map<string, number>(); // callers currently acquiring, per relay
export type SubmitServiceFactory = (relayURL: URL) => Promise<PhasedSubmitService> | PhasedSubmitService;
/** The adapter is created lazily so the connect phase covers the client's own initialisation. */
const defaultSubmitServiceFactory: SubmitServiceFactory = (relayURL) => createPhasedSubmitService({
    adapter: () => createSdkNodeAdapter(relayURL, { connectTimeoutMs: SUBMIT_CONNECT_TIMEOUT_MS, sdk: loadNodeClientSdk }),
    timeouts: { connectMs: SUBMIT_CONNECT_TIMEOUT_MS, requestMs: SUBMIT_REQUEST_TIMEOUT_MS, watchMs: SUBMIT_WATCH_TIMEOUT_MS, closeMs: SUBMIT_CLOSE_TIMEOUT_MS, lateGraceMs: SUBMIT_LATE_GRACE_MS }
});
let submitServiceFactory: SubmitServiceFactory = defaultSubmitServiceFactory;
// Test seams: pool cap and introspection, service factory.
export const __submitClientPoolForTests = {
    setMax: (n: number) => { SUBMIT_CLIENT_POOL_MAX = n; },
    setSettleMs: (ms: number) => { submitClientSettleMs = ms; },
    size: (relayURL: URL) => submitClientPools.get(relayURL.toString())?.length ?? 0,
    reset: () => submitClientPools.clear(),
    setServiceFactory: (factory: SubmitServiceFactory | null) => { submitServiceFactory = factory ?? defaultSubmitServiceFactory; }
};

export class SubmitWatchTimeoutError extends Error {
    constructor(ms: number) { super(`submit watch timed out after ${ms}ms without a Finalized status`); this.name = 'SubmitWatchTimeoutError'; }
}

export async function withDedicatedSubmitClient<T>(relayURL: URL, fn: (svc: any) => Promise<T>, opts: { abandonAfterMs?: number; label?: string } = {}): Promise<T> {
    const key = relayURL.toString();
    let pool = submitClientPools.get(key);
    if (!pool) { pool = []; submitClientPools.set(key, pool); }
    submitClientWaiters.set(key, (submitClientWaiters.get(key) ?? 0) + 1);
    let slot: SubmitClientSlot | undefined;
    try {
        for (; ;) {
            const now = Date.now();
            const free = pool.filter((s) => s.busy === null);
            slot = free.find((s) => s.readyAt <= now);
            if (slot) break;
            // Create only when free slots cannot cover the waiters, up to the cap. Reserved
            // synchronously, before any await, so concurrent callers cannot over-create.
            const waiters = submitClientWaiters.get(key) ?? 1;
            if (pool.length < SUBMIT_CLIENT_POOL_MAX && free.length < waiters) {
                const created: SubmitClientSlot = { svc: null, busy: null, readyAt: Number.POSITIVE_INFINITY };
                pool.push(created);
                try {
                    created.svc = await submitServiceFactory(relayURL);
                    created.readyAt = Date.now() + submitClientSettleMs;
                } catch (e) {
                    pool.splice(pool.indexOf(created), 1);
                    throw e;
                }
                continue; // the new slot is ready after its settle window
            }
            const settling = free.filter((s) => Number.isFinite(s.readyAt));
            if (settling.length > 0) {
                const wait = Math.max(0, Math.min(...settling.map((s) => s.readyAt)) - Date.now());
                await new Promise((r) => setTimeout(r, wait));
            } else if (free.length > 0) {
                await new Promise((r) => setTimeout(r, 100)); // a slot is being created by another caller
            } else {
                await Promise.race(pool.map((s) => s.busy!.catch(() => undefined)));
            }
        }
    } finally {
        submitClientWaiters.set(key, Math.max(0, (submitClientWaiters.get(key) ?? 1) - 1));
    }
    const run = fn(slot.svc);
    slot.busy = run.catch(() => undefined);
    const label = opts.label ?? 'submit';
    // Evict a slot whose client state is unknown. Bounded close: it waits for the client's
    // own initialisation, which may be what hung.
    const evict = async (): Promise<void> => {
        const idx = pool!.indexOf(slot!);
        if (idx >= 0) pool!.splice(idx, 1);
        await Promise.race([
            Promise.resolve().then(() => slot!.svc?.close?.()).catch(() => undefined),
            new Promise<void>((r) => setTimeout(r, SUBMIT_CLOSE_TIMEOUT_MS))
        ]);
        slot!.busy = null;
    };
    if (!opts.abandonAfterMs) {
        try {
            return await run;
        } catch (e) {
            // After a request/watch failure the client keeps listening; no new submit may use it.
            if (submitPhaseOf(e) !== null) await evict();
            throw e;
        } finally {
            if (pool.includes(slot)) { slot.busy = null; slot.readyAt = Date.now() + submitClientSettleMs; }
        }
    }
    // Backstop only (the phased service bounds each phase): abandon, evict, the caller asks the indexer.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SubmitWatchTimeoutError(opts.abandonAfterMs!)), opts.abandonAfterMs); });
    try {
        return await Promise.race([run, timeout]);
    } catch (e) {
        if (e instanceof SubmitWatchTimeoutError) {
            void run.then(
                () => log('warn', `${label}: submit resolved ${'after'} the ${opts.abandonAfterMs}ms backstop had abandoned it (the transaction reached the node; the confirmer resolves the job)`),
                (err) => log('warn', `${label}: submit failed after the ${opts.abandonAfterMs}ms backstop had abandoned it: ${formatErrWithCauses(err).slice(0, 400)}`)
            );
            await evict();
        } else if (submitPhaseOf(e) !== null) {
            await evict();
        }
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
        if (pool.includes(slot)) { slot.busy = null; slot.readyAt = Date.now() + submitClientSettleMs; }
    }
}

/**
 * Indexer lookup by identifier with the ledger apply result (a tx in a block whose call did not
 * apply is not a success). Null when unknown or unreachable.
 */
export async function indexerBlockOfIdentifier(indexerHttpUrl: string, identifier: string): Promise<{ height: string; status: string | null; failedSegments: number[] } | null> {
    try {
        const r = await fetch(indexerHttpUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `{ transactions(offset:{identifier:"${identifier}"}) { block { height } ... on RegularTransaction { transactionResult { status segments { id success } } } } }` }),
            signal: AbortSignal.timeout(15_000)
        });
        const j: any = await r.json();
        const t = j?.data?.transactions?.[0];
        const h = t?.block?.height;
        if (h == null) return null;
        const res = t?.transactionResult;
        const failed = Array.isArray(res?.segments) ? res.segments.filter((s: any) => s?.success === false).map((s: any) => Number(s.id)) : [];
        return { height: String(h), status: res?.status ?? null, failedSegments: failed };
    } catch { return null; }
}

/**
 * In a block but the call did not apply (fee spent). Named like the SDK's error so the main
 * thread classifies it the same way; the block height is the rollback coordinate.
 */
export class TxNotAppliedError extends Error {
    readonly blockHeight: number | null;
    constructor(identifier: string, height: string, status: string, failedSegments: number[]) {
        super(`TxFailedError: transaction ${identifier.slice(0, 16)} is in block ${height} but its call did NOT apply (ledger result ${status}, failed segment${failedSegments.length === 1 ? '' : 's'} ${failedSegments.join(',') || '?'}); the fee was spent, the call must be rebuilt against the current contract state`);
        this.name = 'TxFailedError';
        const h = Number(height);
        this.blockHeight = Number.isInteger(h) && h >= 0 ? h : null;
    }
}
/** A landed transaction counts only with ledger result SUCCESS. */
export function assertApplied(found: { height: string; status: string | null; failedSegments: number[] }, identifier: string): void {
    if (found.status && found.status !== 'SUCCESS') throw new TxNotAppliedError(identifier, found.height, found.status, found.failedSegments);
}
// Keep above the node client's own 60 s request timeout, or an unanswered send and a
// watch timeout (answered, not included) become indistinguishable.
export const SUBMIT_WATCH_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS');
export const SUBMIT_CONNECT_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS');
export const SUBMIT_REQUEST_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS');
export const SUBMIT_LATE_GRACE_MS = configMs('NIGHTGATE_SUBMIT_LATE_GRACE_MS');
export const SUBMIT_WATCH_CONFIRM_MS = 90_000;
/** The outer backstop of a dedicated-client submit: every phase budget plus room for the phased service's own bookkeeping. */
export function submitBackstopMs(): number { return SUBMIT_CONNECT_TIMEOUT_MS + SUBMIT_REQUEST_TIMEOUT_MS + SUBMIT_WATCH_TIMEOUT_MS + Math.min(10_000, SUBMIT_WATCH_TIMEOUT_MS); }
// InBlock is safe for the unbound sponsor path: the indexer confirmer checks the chain
// outcome afterwards, so a reorg shows as a failed chain status, not a lost job.
export function sponsorSubmitWaitStage(): 'InBlock' | 'Finalized' { return configEnum('NIGHTGATE_SPONSOR_WAIT') === 'finalized' ? 'Finalized' : 'InBlock'; }
// After the wanted status, wait until the indexer has the tx and check the ledger result there:
// a caller building its next call reads contract state on the indexer, and neither InBlock nor
// Finalized says whether the call applied.
export async function waitIndexerVisible(indexerHttpUrl: string, identifier: string, site: string): Promise<void> {
    const windowMs = configMs('NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS');
    if (windowMs === 0) return;
    const t0 = Date.now();
    while (Date.now() - t0 < windowMs) {
        const found = await indexerBlockOfIdentifier(indexerHttpUrl, identifier);
        if (found) {
            log('debug', `${site}: indexer has the transaction in block ${found.height} (${found.status ?? 'status n/a'}) after ${Date.now() - t0}ms`);
            assertApplied(found, identifier);
            return;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    log('warn', `${site}: transaction in block but not visible on the indexer after ${windowMs}ms; reporting landed anyway`);
}

/** What the worker knows about the transaction it is about to broadcast. */
export interface SubmitIntent {
    txHash: string;
    /** Inspected from the caller transaction (shape check), not from the allow-list. */
    contractAddress?: string;
    circuits?: string[];
    /** Unbound channel: the dust backing the sponsor pays from. */
    note?: string;
    /** The sponsor ACCOUNT paying (the facade's account id). */
    sponsorAccountId?: string;
    /** Addresses of contract deploy actions in the tx; the main thread reserves the grant's deploy budget on them before acking. */
    deployed?: string[];
    /** End of the validity window (ISO): once the indexer tip is past it, the tx is provably not on chain. */
    ttl?: string;
}
/** An ack slower than this is logged: the main thread's boundary write was slow. */
const INTENT_ACK_WARN_MS = 10_000;
/** Resolves on the main thread's ack; without one the job fails before broadcasting. No-op without a port. */
export async function announceSubmitIntent(port: MessagePort | undefined, intent: SubmitIntent): Promise<void> {
    if (!port) return;
    const { txHash } = intent;
    const ackTimeoutMs = configMs('NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS');
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { port.off('message', onMsg); reject(new Error(`submit-intent was not acknowledged by the main thread within ${ackTimeoutMs}ms; not broadcasting`)); }, ackTimeoutMs);
        const onMsg = (m: any) => {
            if (m?.kind === 'submit-intent-ack' && m.txHash === txHash) {
                clearTimeout(timer); port.off('message', onMsg);
                if (m.ok === false) { reject(new Error(`submit-intent rejected by the main thread: ${m.error ?? 'unknown'}`)); return; }
                const ms = Date.now() - startedAt;
                if (ms > INTENT_ACK_WARN_MS) log('warn', `submit-intent ${txHash.slice(0, 16)}: acknowledged after ${ms}ms`);
                resolve();
            }
        };
        port.on('message', onMsg);
        port.postMessage({ kind: 'submit-intent', ...intent });
    });
}

/** The send itself died on the client's own lagging close (see settle window). */
export function isClosingSocketReject(err: unknown): boolean {
    return /disconnected from \S*:\s*1000\s*::\s*Normal Closure/i.test(classificationHaystack(err));
}

/** Books the spends with the facade's pending service, as the facade's own submit does. */
async function bookPending(entry: FacadeEntry, tx: any, site: string): Promise<void> {
    const svc = entry.facade?.pendingTransactionsService;
    if (typeof svc?.addPendingTransaction !== 'function') {
        log('warn', `${site}: facade exposes no pending-transaction service; spends are booked only once the sync sees the transaction`);
        return;
    }
    await svc.addPendingTransaction(tx);
}

/**
 * The one send path: a dedicated phased client per submit (the facade's shared socket
 * disconnects after each submission and its submit promise settles only when that socket
 * closes). `book` = the facade's own bookkeeping around a send: pend before, revert on failure.
 * A connect failure or a send that died is resent (same bytes, the indexer probed first); a
 * request or watch timeout is looked up on the indexer; node rejects are never resent.
 */
export async function submitOnDedicatedClient(entry: FacadeEntry, tx: any, site: string, opts: { book?: boolean } = {}): Promise<any> {
    await logTxCost(tx, site);
    const relayURL: URL = entry.walletConfiguration.relayURL;
    const identifier = String(tx.identifiers().at(-1));
    const label = `${site} ${identifier.slice(0, 16)}`;
    const retries = submitTransportRetries();
    const waitFor = sponsorSubmitWaitStage();
    // Set once any attempt got past the connect phase without the indexer showing the tx: from
    // then on the bytes may be on the node and no later failure is definitive.
    let maybeSent = false;
    const unknownOutcome = (e: unknown): Error => new SubmitOutcomeUnknownError(identifier, e);
    const landed = async (windowMs: number, how: string): Promise<boolean> => {
        const found = await waitLandedOnIndexer(entry, identifier, windowMs);
        if (!found) return false;
        log('info', `${site}: transaction ${identifier.slice(0, 16)} is in block ${found.height} (${found.status ?? 'status n/a'}) ${how}; landed`);
        assertApplied(found, identifier);
        return true;
    };
    const resend = async (reason: string): Promise<void> => {
        log('warn', `${site}: ${reason}; resending the SAME transaction (no rebuild, no re-proving)`);
        await new Promise((r) => setTimeout(r, submitTransportBackoffMs()));
    };
    if (opts.book) await bookPending(entry, tx, site);
    try {
        for (let attempt = 0, resends = 0; ; attempt++) {
            try {
                await withDedicatedSubmitClient(relayURL, (svc) => svc.submitTransaction(tx, waitFor, { identifier, correlation: site }), { abandonAfterMs: submitBackstopMs(), label });
                await waitIndexerVisible(entry.indexerHttpUrl, identifier, site);
                return identifier;
            } catch (e) {
                const phase = submitPhaseOf(e);
                const earlierUnresolved = maybeSent;
                if (attempt === 0 && isClosingSocketReject(e)) {
                    log('warn', `${site}: submit request died on the client's own closing socket (SDK disconnect lag); retrying once on a settled client`);
                    continue;
                }
                if (phase === 'connect') {
                    if (resends >= retries) {
                        if (earlierUnresolved) throw unknownOutcome(e);
                        // Every attempt failed before a send: the dust note was never spent anywhere.
                        markNothingSent(e);
                        throw e;
                    }
                    resends++;
                    await resend(`submit connect phase failed, nothing sent (send ${resends}/${retries + 1}): ${formatErr(e).slice(0, 200)}`);
                    continue;
                }
                if (e instanceof SubmitWatchTimeoutError || phase === 'watch' || phase === 'request') {
                    if (await landed(SUBMIT_WATCH_CONFIRM_MS, `although the watch saw no ${waitFor}`)) return identifier;
                    log('warn', `${site}: ${phase === 'request' ? 'no status from the node after the send' : 'submit watch timed out'} and the indexer does not know the transaction ${identifier.slice(0, 16)} after ${SUBMIT_WATCH_CONFIRM_MS}ms; leaving it to the confirmer${phase ? '' : ' (backstop timeout, no phase information)'}`);
                    throw e;
                }
                if (isSubmitTransportFailure(e)) {
                    // The send died mid-stream: it may or may not have reached the node.
                    if (await landed(submitLandedProbeMs(), 'although the submit reply was lost')) return identifier;
                    maybeSent = true;
                    if (resends >= retries) throw unknownOutcome(e);
                    resends++;
                    await resend(`submit transport failure (send ${resends}/${retries + 1}): ${formatErrWithCauses(e).slice(0, 300)}; the indexer does not have ${identifier.slice(0, 16)}`);
                    continue;
                }
                // A refused resend: the first send may have landed, making these bytes a replay.
                if (resends > 0 && await landed(submitLandedProbeMs(), 'although the resend was refused')) return identifier;
                if (earlierUnresolved) throw unknownOutcome(e);
                log('info', `${site}: submit failed (${isPreMempoolReject(e) ? 'pre-mempool reject' : 'not pre-mempool'}): ${safeDeepInspect(e, 512).slice(0, 600)}`);
                throw e;
            }
        }
    } catch (e) {
        // The facade's own rule: a failed submit frees the booked spends (the dust guard decides about the note).
        if (opts.book) await revertRecipeBestEffort(entry.facade, tx, `${site} pending`);
        throw e;
    }
}

/** A facade as the SDK's WalletProvider & MidnightProvider. */
export function buildWorkerWalletProvider(entry: FacadeEntry, intent?: BoundSubmitIntent): any {
    return {
        getCoinPublicKey(): string { return entry.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return entry.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            await waitForGenuineSync(entry, BALANCE_SYNC_TIMEOUT_MS, 'balance');
            // Arm the dust-wedge protection BEFORE the build books the spend.
            await captureDustSnapshot(entry, 'balance');
            const effectiveTtl = ttl ?? new Date(Date.now() + 60 * 60 * 1000);
            if (intent) intent.ttl = effectiveTtl.toISOString();
            const recipe = await entry.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
                { ttl: effectiveTtl }
            );
            let finalized: any;
            try {
                finalized = await entry.facade.finalizeRecipe(recipe);
            } catch (e) {
                // On prove failure the SDK reverts only the balancing tx of an unbound recipe.
                await revertRecipeBestEffort(entry.facade, recipe, 'balance');
                throw e;
            }
            const dust = describeTxDust(finalized);
            log('info', `balanced tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                await revertRecipeBestEffort(entry.facade, finalized, 'balance');
                throw new Error(
                    'balanced transaction carries an EMPTY DustActions section ' +
                    '(node would reject it as 1010 Custom error: 117 NotNormalized). ' +
                    'The dust balancer produced an empty recipe, i.e. the computed ' +
                    `fee was 0. Dust sections: ${dust.summary}`
                );
            }
            return finalized;
        },
        async submitTx(tx: any): Promise<any> {
            const dust = describeTxDust(tx);
            log('info', `pre-submit tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                log('warn', `pre-submit tx has an EMPTY DustActions section (node rejects as 1010/117 NotNormalized): ${dust.summary}`);
            }
            return submitWithDustGuard(entry, tx, 'submit', intent);
        }
    };
}

/** Two-phase provider: the caller balances (non-dust), signs and finalizes; the sponsor balances dust and submits. */
export function buildSponsoredWalletProvider(caller: FacadeEntry, sponsor: FacadeEntry, intent?: BoundSubmitIntent): any {
    // The caller-side finalized tx of the LAST successful balanceTx
    let lastCallerFinalized: any;
    return {
        getCoinPublicKey(): string { return caller.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return caller.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {

            if (configEnum('NIGHTGATE_SPONSORED_CALLER_SYNC') === 'skip') {
                log('info', 'sponsored-balance: caller sync SKIPPED (NIGHTGATE_SPONSORED_CALLER_SYNC=skip)');
            } else {
                await waitForGenuineSync(caller, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance caller');
            }
            await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance sponsor');
            const effectiveTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
            if (intent) intent.ttl = effectiveTtl.toISOString();

            const recipe = await caller.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: caller.zswapKeys, dustSecretKey: caller.dustKey },
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const callerSign = (payload: Uint8Array) => caller.unshieldedKeystore.signData(payload);
            let callerFinalized: any;
            try {
                const signed = await caller.facade.signRecipe(recipe, callerSign);
                callerFinalized = await caller.facade.finalizeRecipe(signed);
            } catch (e) {
                // No SDK revert covers sign failures; prove failures revert only the balancing part.
                await revertRecipeBestEffort(caller.facade, recipe, 'sponsored-balance caller');
                throw e;
            }

            try {
                // Phase 2 books the sponsor's dust spend: arm its protection first.
                await captureDustSnapshot(sponsor, 'sponsored-balance sponsor');
                const sponsorRecipe = await sponsor.facade.balanceFinalizedTransaction(
                    callerFinalized,
                    { shieldedSecretKeys: sponsor.zswapKeys, dustSecretKey: sponsor.dustKey },
                    { ttl: effectiveTtl, tokenKindsToBalance: ['dust'] }
                );
                let finalized: any;
                try {
                    finalized = await sponsor.facade.finalizeRecipe(sponsorRecipe);
                } catch (e) {
                    await revertRecipeBestEffort(sponsor.facade, sponsorRecipe, 'sponsored-balance sponsor');
                    throw e;
                }

                const dust = describeTxDust(finalized);
                log('info', `sponsored balanced tx dust sections: ${dust.summary}`);
                if (dust.emptyDustActions) {
                    await revertRecipeBestEffort(sponsor.facade, finalized, 'sponsored-balance sponsor');
                    throw new Error(
                        'sponsored balanced transaction carries an EMPTY DustActions section ' +
                        '(node would reject it as 1010 Custom error: 117 NotNormalized). ' +
                        `The sponsor's dust balancer produced an empty recipe, i.e. the computed ` +
                        `fee was 0. Dust sections: ${dust.summary}`
                    );
                }
                lastCallerFinalized = callerFinalized;
                return finalized;
            } catch (e) {
                // The caller's finalized tx will never be submitted: free its coins now.
                await revertRecipeBestEffort(caller.facade, callerFinalized, 'sponsored-balance caller');
                throw e;
            }
        },
        async submitTx(tx: any): Promise<any> {
            const dust = describeTxDust(tx);
            log('info', `pre-submit (sponsored) tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                log('warn', `pre-submit sponsored tx has an EMPTY DustActions section (node rejects as 1010/117 NotNormalized): ${dust.summary}`);
            }
            try {
                const result = await submitWithDustGuard(sponsor, tx, 'sponsored-submit sponsor', intent);
                lastCallerFinalized = undefined;
                return result;
            } catch (e) {
                await revertRecipeBestEffort(caller.facade, lastCallerFinalized ?? tx, 'sponsored-submit caller');
                lastCallerFinalized = undefined;
                throw e;
            }
        }
    };
}

/** Thrown by the build-only provider to stop the SDK's callTx at submit time. */
export class BuildOnlyStop extends Error {
    constructor() { super('build-only: captured finalized tx, stopping before submit'); this.name = 'BuildOnlyStop'; }
}

/** Caller phase 1 only (balance, sign, finalize); captures the tx and stops instead of submitting. */
export function buildBuildOnlyWalletProvider(caller: FacadeEntry, holder: { captured?: any }): any {
    return {
        getCoinPublicKey(): string { return caller.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return caller.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            if (configEnum('NIGHTGATE_SPONSORED_CALLER_SYNC') !== 'skip') {
                await waitForGenuineSync(caller, BALANCE_SYNC_TIMEOUT_MS, 'build-only caller');
            }
            const effectiveTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);
            log('info', 'build-only: balanceUnboundTransaction (shielded/unshielded)');
            const recipe = await caller.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: caller.zswapKeys, dustSecretKey: caller.dustKey },
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const callerSign = (payload: Uint8Array) => caller.unshieldedKeystore.signData(payload);
            try {
                log('info', 'build-only: signRecipe + finalizeRecipe');
                const signed = await caller.facade.signRecipe(recipe, callerSign);
                const fin = await caller.facade.finalizeRecipe(signed);
                log('info', 'build-only: finalized (fee-unpaid); returning to callTx');
                return fin;
            } catch (e) {
                await revertRecipeBestEffort(caller.facade, recipe, 'build-only caller');
                throw e;
            }
        },
        async submitTx(tx: any): Promise<any> {
            holder.captured = tx;
            throw new BuildOnlyStop();
        }
    };
}
