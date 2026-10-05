/**
 * Sends transactions from the worker. Every tx is announced to the main thread before it is sent,
 * and every send uses its own node connection.
 */

import { configNumber, configMs, configEnum } from '../../utils/config';
import { markIntentAnnounced } from './cancellation';
import { callSegments } from '../batch-segment-order';
import { classifySubmitFailure, isPreMempoolFailure } from '../submit-error-classification';
import { classificationHaystack, formatErr, formatErrWithCauses, safeDeepInspect } from '../../utils/format-error';
import { NightgateError, errorMessage } from '../../utils/errors';
import { type MessagePort } from 'node:worker_threads';
import { FacadeEntry, loadSdk, loadNodeClientSdk, log, loadLedger } from './context';
import { createPhasedSubmitService, createSdkNodeAdapter, submitPhaseOf, type PhasedSubmitService } from './phased-submit';
import { BALANCE_SYNC_TIMEOUT_MS, pushStateSaveAcked, restoreSaveAckTimeoutMs, waitForGenuineSync } from './facades';

/**
 * Describes the dust parts of a tx for logging. Never throws.
 * An empty dust part makes the node reject the tx with 1010/117 (NotNormalized).
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
        return { summary: `dump failed: ${errorMessage(e)}`, emptyDustActions: false };
    }
}

/** Frees the coins a built but unsent tx reserved. Never throws. */
export async function revertRecipeBestEffort(facade: any, txOrRecipe: any, site: string): Promise<void> {
    if (!txOrRecipe) return;
    try {
        await facade.revert(txOrRecipe);
    } catch (e) {
        log('warn', `${site}: recipe revert failed (coins may stay pending until a fresh resync): ${formatErr(e)}`);
    }
}

export async function feeOfDiscardedRecipe(facade: any, recipe: any, site: string): Promise<bigint> {
    try {
        return await facade.calculateTransactionFee(recipe.transaction);
    } finally {
        await revertRecipeBestEffort(facade, recipe, site);
    }
}

// When the node rejects a tx before the mempool, the SDK still treats its dust as spent.
// A wallet with a single dust note is then stuck. So the dust state is saved before each build
// and restored after such a reject. Nothing reached the chain, so the saved state is still valid.

/** True for rejects that surely never reached the mempool. Not 1013, which means the tx is already there. */
export function isPreMempoolReject(err: unknown): boolean {
    return isPreMempoolFailure(classifySubmitFailure(err));
}

/**
 * An earlier send may still land, so a later failure means the outcome is unknown.
 * The main thread keeps the tx id and never rebuilds, which could pay the fee twice.
 */
export class SubmitOutcomeUnknownError extends Error {
    readonly identifier: string;
    constructor(identifier: string, cause: unknown) {
        super(`submit outcome unknown: an earlier send of ${identifier.slice(0, 16)} may have reached the node and the indexer does not show it yet; the later attempt failed: ${formatErr(cause).slice(0, 300)}`, { cause });
        this.name = 'SubmitOutcomeUnknownError';
        this.identifier = identifier;
    }
}

/** Marks a failure where no attempt sent anything, so the dust state may be restored. */
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

/** Saves the dust state before a build. If saving fails, only this tx goes without the protection. */
export async function captureDustSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    try {
        entry.preSubmitDustSnapshot = await entry.facade.dust.serializeState();
    } catch (e) {
        entry.preSubmitDustSnapshot = undefined;
        log('warn', `${site}: dust pre-build snapshot failed (wedge protection disarmed for this tx): ${formatErr(e)}`);
    }
}

/**
 * Replaces the running dust wallet with one restored from the saved state.
 * Safe while the wallet is in use, because all code reaches it through `facade.dust`
 * and submits of one wallet run one at a time.
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
        // A periodic save may have stored the broken state meanwhile. Save the restored state now
        // and raise the epoch, so no older save can overwrite it.
        entry.dustEpoch = (entry.dustEpoch ?? 0) + 1;
        log('info', `${site}: dust sub-wallet restored from pre-build snapshot after pre-mempool reject (leaked in-flight spend discarded, snapshot re-persisted)`);
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

/** Logs the tx size and cost, so a block limit reject shows which limit was hit. Never throws. */
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

// After a connection failure the same tx is sent again, because it is still valid.
// The send may have reached the node anyway, so the indexer is asked first.
// A tx the node rejected is never sent again.
export function submitTransportRetries(): number {
    return configNumber('NIGHTGATE_SUBMIT_TRANSPORT_RETRIES');
}
export function submitTransportBackoffMs(): number {
    return configMs('NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS');
}
export function submitLandedProbeMs(): number {
    return configMs('NIGHTGATE_SUBMIT_LANDED_PROBE_MS');
}

export function isSubmitTransportFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'transport';
}

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
 * Before sending, the main thread stores the tx id on the job and confirms.
 * Without that confirmation nothing is sent, so every landed tx belongs to a known job.
 */
export interface BoundSubmitIntent {
    replyPort?: MessagePort;
    contractAddress?: string;
    circuits?: string[];
    note?: string;
    /** The tx expiry the wallet provider used, as ISO time. */
    ttl?: string;
}

/**
 * Restores the saved dust state only when the tx surely never reached the mempool.
 * A tx that may have reached it has spent its dust fee.
 */
export async function submitWithDustGuard(entry: FacadeEntry, tx: any, site: string, intent?: BoundSubmitIntent): Promise<any> {
    if (intent?.replyPort) {
        try {
            // A tx that was not announced could never be traced, so refuse to send it.
            if (typeof tx?.identifiers !== 'function') throw new Error(`${site}: transaction exposes no identifiers(); refusing to broadcast unannounced`);
            await announceSubmitIntent(intent.replyPort, {
                txHash: String(tx.identifiers().at(-1)),
                contractAddress: intent.contractAddress, circuits: intent.circuits, note: intent.note, ttl: intent.ttl,
                segments: callSegments(tx)
            });
        } catch (e) {
            // Not sent, so free the reserved coins and dust. The SDK does this only after a failed submit.
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
            log('info', `${site}: submit failed, NOT classified pre-mempool (dust guard disarmed): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            entry.preSubmitDustSnapshot = undefined;
        }
        throw e;
    }
}

// The SDK's node client closes its connection after every submit, so parallel submits on one
// client break each other. Each submit therefore gets a client of its own from a pool.
// The SDK's disconnect returns before the socket is closed, so a client is reused only after a
// short wait. A send that fails on such a closing socket was never sent and is retried once.
export let SUBMIT_CLIENT_POOL_MAX = 8;
let submitClientSettleMs = 2500;
/** Limit for closing a stuck client. The SDK's close waits for the client's start, which may be what hangs. */
export const SUBMIT_CLOSE_TIMEOUT_MS = 5000;
export type SubmitClientSlot = { svc: any; busy: Promise<unknown> | null; readyAt: number };
export const submitClientPools = new Map<string, SubmitClientSlot[]>();
export const submitClientWaiters = new Map<string, number>(); // callers waiting for a client, per node URL
export type SubmitServiceFactory = (relayURL: URL) => Promise<PhasedSubmitService> | PhasedSubmitService;
/** Creates the client lazily, so the connect timeout also covers its start. */
const defaultSubmitServiceFactory: SubmitServiceFactory = (relayURL) => createPhasedSubmitService({
    adapter: () => createSdkNodeAdapter(relayURL, { connectTimeoutMs: SUBMIT_CONNECT_TIMEOUT_MS, sdk: loadNodeClientSdk }),
    timeouts: { connectMs: SUBMIT_CONNECT_TIMEOUT_MS, requestMs: SUBMIT_REQUEST_TIMEOUT_MS, watchMs: SUBMIT_WATCH_TIMEOUT_MS, closeMs: SUBMIT_CLOSE_TIMEOUT_MS, lateGraceMs: SUBMIT_LATE_GRACE_MS }
});
let submitServiceFactory: SubmitServiceFactory = defaultSubmitServiceFactory;
// Test only.
export const __submitClientPoolForTests = {
    setMax: (n: number) => { SUBMIT_CLIENT_POOL_MAX = n; },
    setSettleMs: (ms: number) => { submitClientSettleMs = ms; },
    size: (relayURL: URL) => submitClientPools.get(relayURL.toString())?.length ?? 0,
    reset: () => submitClientPools.clear(),
    setServiceFactory: (factory: SubmitServiceFactory | null) => { submitServiceFactory = factory ?? defaultSubmitServiceFactory; }
};

export class SubmitWatchTimeoutError extends NightgateError {
    constructor(ms: number) { super('SUBMIT_WATCH_TIMEOUT', `submit watch timed out after ${ms}ms without a Finalized status`); }
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
            // Create a client only when the free ones cannot serve all waiters. The slot is reserved
            // before any await, so concurrent callers cannot create too many.
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
                continue; // the new client is ready after a short wait
            }
            const settling = free.filter((s) => Number.isFinite(s.readyAt));
            if (settling.length > 0) {
                const wait = Math.max(0, Math.min(...settling.map((s) => s.readyAt)) - Date.now());
                await new Promise((r) => setTimeout(r, wait));
            } else if (free.length > 0) {
                await new Promise((r) => setTimeout(r, 100)); // another caller is creating a client
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
    // Drop a client whose state is unknown.
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
            // After a timeout the client keeps listening for a while, so no other submit may use it.
            if (submitPhaseOf(e) !== null) await evict();
            throw e;
        } finally {
            if (pool.includes(slot)) { slot.busy = null; slot.readyAt = Date.now() + submitClientSettleMs; }
        }
    }
    // Last resort only, since each step has its own timeout. On timeout, drop the client and let the caller ask the indexer.
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
 * Looks up a tx on the indexer, with the ledger result. A tx in a block whose call failed is not a success.
 * Null when the tx is unknown or the indexer is unreachable.
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
 * The tx is in a block but its call did not apply, and the fee is spent.
 * Named like the SDK's error so the main thread handles both the same way.
 */
export class TxNotAppliedError extends NightgateError {
    readonly blockHeight: number | null;
    constructor(identifier: string, height: string, status: string, failedSegments: number[]) {
        super('TX_FAILED', `TxFailedError: transaction ${identifier.slice(0, 16)} is in block ${height} but its call did NOT apply (ledger result ${status}, failed segment${failedSegments.length === 1 ? '' : 's'} ${failedSegments.join(',') || '?'}); the fee was spent, the call must be rebuilt against the current contract state`);
        this.name = 'TxFailedError';
        const h = Number(height);
        this.blockHeight = Number.isInteger(h) && h >= 0 ? h : null;
    }
}
export function assertApplied(found: { height: string; status: string | null; failedSegments: number[] }, identifier: string): void {
    if (found.status && found.status !== 'SUCCESS') throw new TxNotAppliedError(identifier, found.height, found.status, found.failedSegments);
}
// Keep above the node client's own 60 s request timeout. Otherwise "no answer" and
// "answered but not in a block" cannot be told apart.
export const SUBMIT_WATCH_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS');
export const SUBMIT_CONNECT_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS');
export const SUBMIT_REQUEST_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS');
export const SUBMIT_LATE_GRACE_MS = configMs('NIGHTGATE_SUBMIT_LATE_GRACE_MS');
export const SUBMIT_WATCH_CONFIRM_MS = 90_000;
/** Overall limit of a submit: all step timeouts plus some room. */
export function submitBackstopMs(): number { return SUBMIT_CONNECT_TIMEOUT_MS + SUBMIT_REQUEST_TIMEOUT_MS + SUBMIT_WATCH_TIMEOUT_MS + Math.min(10_000, SUBMIT_WATCH_TIMEOUT_MS); }
// Waiting only for InBlock is safe, because a later indexer check still verifies the result.
// A chain reorganization then shows as a failed status, not as a lost job.
export function sponsorSubmitWaitStage(): 'InBlock' | 'Finalized' { return configEnum('NIGHTGATE_SPONSOR_WAIT') === 'finalized' ? 'Finalized' : 'InBlock'; }
// Wait until the indexer has the tx and check its ledger result there.
// The caller's next call reads contract state from the indexer, and the node's
// InBlock or Finalized status does not say whether the call applied.
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

export interface SubmitIntent {
    txHash: string;
    /** Read from the caller's tx itself, not from the allow list. */
    contractAddress?: string;
    circuits?: string[];
    /** For unbound sponsoring: the NIGHT UTXO whose dust pays the fee. */
    note?: string;
    /** The sponsor account that pays. */
    sponsorAccountId?: string;
    /** Contracts this tx deploys. The main thread counts them against the grant's deploy limit before it confirms. */
    deployed?: string[];
    /** When the tx expires, as ISO time. Once the chain is past it, the tx can no longer land. */
    ttl?: string;
    /** For batches: the calls in each segment, so the result can say which calls applied. */
    segments?: Array<{ segment: number; calls: string[] }>;
    /** Raw token types the calls mint. Recorded on the grant once the tx landed. */
    minted?: string[];
}
const INTENT_ACK_WARN_MS = 10_000;
/** Waits for the main thread to confirm the tx id. Without a confirmation the tx is not sent. Does nothing without a port. */
export async function announceSubmitIntent(port: MessagePort | undefined, intent: SubmitIntent): Promise<void> {
    if (!port) return;
    markIntentAnnounced();
    const { txHash } = intent;
    const ackTimeoutMs = configMs('NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS');
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { port.off('message', onMsg); reject(new NightgateError('SUBMIT_INTENT_TIMEOUT', `submit-intent was not acknowledged by the main thread within ${ackTimeoutMs}ms; not broadcasting`)); }, ackTimeoutMs);
        const onMsg = (m: any) => {
            if (m?.kind === 'submit-intent-ack' && m.txHash === txHash) {
                clearTimeout(timer); port.off('message', onMsg);
                if (m.ok === false) { reject(new NightgateError('SUBMIT_INTENT_REJECTED', `submit-intent rejected by the main thread: ${m.error ?? 'unknown'}`)); return; }
                const ms = Date.now() - startedAt;
                if (ms > INTENT_ACK_WARN_MS) log('warn', `submit-intent ${txHash.slice(0, 16)}: acknowledged after ${ms}ms`);
                resolve();
            }
        };
        port.on('message', onMsg);
        port.postMessage({ kind: 'submit-intent', ...intent });
    });
}

/** The send failed on a socket the client was still closing, so nothing was sent. */
export function isClosingSocketReject(err: unknown): boolean {
    return /disconnected from \S*:\s*1000\s*::\s*Normal Closure/i.test(classificationHaystack(err));
}

/** Marks the tx's coins as spent, like the SDK's own submit does. */
async function bookPending(entry: FacadeEntry, tx: any, site: string): Promise<void> {
    const svc = entry.facade?.pendingTransactionsService;
    if (typeof svc?.addPendingTransaction !== 'function') {
        log('warn', `${site}: facade exposes no pending-transaction service; spends are booked only once the sync sees the transaction`);
        return;
    }
    await svc.addPendingTransaction(tx);
}

/**
 * Every tx is sent through here, on a node connection of its own.
 * With `book`, its coins are marked as spent before sending and freed again on failure.
 * A connection failure leads to a resend of the same tx. A timeout leads to an indexer lookup.
 * A tx the node rejected is never sent again.
 */
export async function submitOnDedicatedClient(entry: FacadeEntry, tx: any, site: string, opts: { book?: boolean } = {}): Promise<any> {
    await logTxCost(tx, site);
    const relayURL: URL = entry.walletConfiguration.relayURL;
    const identifier = String(tx.identifiers().at(-1));
    const label = `${site} ${identifier.slice(0, 16)}`;
    const retries = submitTransportRetries();
    const waitFor = sponsorSubmitWaitStage();
    // Set once an attempt may have reached the node. From then on no later failure is final.
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
                        // No attempt sent anything, so the dust was never spent.
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
                    if (await landed(submitLandedProbeMs(), 'although the submit reply was lost')) return identifier;
                    maybeSent = true;
                    if (resends >= retries) throw unknownOutcome(e);
                    resends++;
                    await resend(`submit transport failure (send ${resends}/${retries + 1}): ${formatErrWithCauses(e).slice(0, 300)}; the indexer does not have ${identifier.slice(0, 16)}`);
                    continue;
                }
                // A resend was refused. The first send may have landed, so check the indexer.
                if (resends > 0 && await landed(submitLandedProbeMs(), 'although the resend was refused')) return identifier;
                if (earlierUnresolved) throw unknownOutcome(e);
                log('info', `${site}: submit failed (${isPreMempoolReject(e) ? 'pre-mempool reject' : 'not pre-mempool'}): ${safeDeepInspect(e, 512).slice(0, 600)}`);
                throw e;
            }
        }
    } catch (e) {
        // Free the reserved coins, like the SDK does after a failed submit.
        if (opts.book) await revertRecipeBestEffort(entry.facade, tx, `${site} pending`);
        throw e;
    }
}

/** The wallet as the SDK's WalletProvider and MidnightProvider. */
export function buildWorkerWalletProvider(entry: FacadeEntry, intent?: BoundSubmitIntent): any {
    return {
        getCoinPublicKey(): string { return entry.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return entry.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            await waitForGenuineSync(entry, BALANCE_SYNC_TIMEOUT_MS, 'balance');
            // Save the dust state before the build marks the dust as spent.
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
                // On a failed proof the SDK frees only part of the reserved coins, so free them here.
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

/**
 * Wallet provider for a sponsored tx. The caller pays everything except the fee, signs and finalizes.
 * The sponsor then adds the dust fee and sends.
 */
export function buildSponsoredWalletProvider(caller: FacadeEntry, sponsor: FacadeEntry, intent?: BoundSubmitIntent): any {
    // The caller's finalized tx from the last successful balanceTx, freed if the submit fails.
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
                // The SDK frees nothing after a failed signature and only part after a failed proof.
                await revertRecipeBestEffort(caller.facade, recipe, 'sponsored-balance caller');
                throw e;
            }

            try {
                // The next step spends the sponsor's dust, so save the sponsor's dust state first.
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
                // The caller's tx will never be sent, so free its coins now.
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

/** Thrown to stop the SDK's callTx right before it sends. */
export class BuildOnlyStop extends Error {
    constructor() { super('build-only: captured finalized tx, stopping before submit'); this.name = 'BuildOnlyStop'; }
}

/** Builds, signs and finalizes as the caller, then keeps the tx in `holder` instead of sending it. */
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
