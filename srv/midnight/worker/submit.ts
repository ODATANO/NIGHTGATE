/**
 * Submission: dust wedge protection, the same-transaction resend on a
 * transport failure, the pre-broadcast submit-intent handshake, dedicated
 * submit clients and the wallet providers that route a build through them.
 */

// First import on purpose: the worker modules import each other in cycles,
// and a value read at module level must come from an import that is
// resolved before the cycle re-enters this module.
import { configNumber, configMs, configEnum } from '../../utils/config';
import { SUBMIT_METHODS } from '../wallet-worker-protocol';
import { classifySubmitFailure, isPreMempoolFailure } from '../submit-error-classification';
import path from 'node:path';
import { classificationHaystack, formatErr, formatErrWithCauses, safeDeepInspect } from '../../utils/format-error';
import { type MessagePort } from 'node:worker_threads';
import { FacadeEntry, loadSdk, loadSubmissionSdk, log, loadLedger } from './context';
import { BALANCE_SYNC_TIMEOUT_MS, applySaveAck, pushStateSaveAcked, restoreSaveAckTimeoutMs, waitForGenuineSync } from './facades';

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

/**
 * Best-effort revert of a built-but-never-submitted recipe (or finalized tx).
 *
 * SDK builds move the selected coins into the sub-wallets' `pendingUtxos` at
 * BUILD time. A recipe that is discarded (fee estimate) or dies before a
 * successful submit must be reverted, or those coins stay pending forever:
 * there is no TTL reclaim for untracked builds, and the periodic state save
 * persists the phantom spend across restarts (bug_002 Bug A). The facade's
 * public `revert(txOrRecipe)` runs the same sequence as its internal error
 * paths; sub-wallet rollbacks are keyed no-ops on absent entries, so
 * overlapping with the SDK's own reverts (finalize/submit catch) is safe.
 */
export async function revertRecipeBestEffort(facade: any, txOrRecipe: any, site: string): Promise<void> {
    if (!txOrRecipe) return;
    try {
        await facade.revert(txOrRecipe);
    } catch (e) {
        log('warn', `${site}: recipe revert failed (coins may stay pending until a fresh resync): ${formatErr(e)}`);
    }
}

/**
 * Fee of a recipe that exists only to be priced: computes the fee, then
 * ALWAYS reverts the recipe (success and failure alike).
 *
 * Uses `calculateTransactionFee`, not `estimateTransactionFee`: the estimate
 * variant re-runs the dust balancer's convergence loop (uncapped
 * `Effect.iterate` under `Effect.runSync`) over the already fee-balanced tx
 * and can pin the worker's event loop (bug_002 Bug B). On a balanced recipe
 * `calculateFee` yields the fee that recipe actually pays, loop-free.
 */
export async function feeOfDiscardedRecipe(facade: any, recipe: any, site: string): Promise<bigint> {
    try {
        return await facade.calculateTransactionFee(recipe.transaction);
    } finally {
        await revertRecipeBestEffort(facade, recipe, site);
    }
}

// ---- Dust wedge protection (dust-pending-note-leak FR) --------------------
//
// A submission that provably never reached the mempool leaves the dust note
// it spent marked in-flight FOREVER: the facade's submit-error revert does
// call dust.revertTransaction, but CoreWallet.applyFailed drops the
// pendingDust marker while the ledger-side reclaim
// (processTtls(ctime + grace)) no-ops, so the note stays spent in
// DustLocalState and no later sweep can find it. A single-note wallet (the
// common self-generation case) is then wedged: every build fails with
// `could not balance dust` until a cold re-sync. Until that is fixed
// upstream, we snapshot the dust sub-wallet BEFORE each build (the build is
// what books the spend) and, when the submit dies pre-mempool, swap in a
// fresh dust wallet restored from that snapshot. Nothing reached the chain,
// so the snapshot is by definition still valid; sync resumes from the
// snapshot's own progress index, exactly like a restart warm-restore.

/**
 * Substrate rejects that provably never entered the mempool: 1010 (invalid),
 * 1014 (priority too low; the pool kept the EARLIER tx, this one never
 * entered) and 1016 (immediately dropped). Deliberately NOT 1013 (already
 * imported: the tx IS in the pool, its spends must stay marked in-flight).
 *
 * The SDK buries the node's reject under generic wrappers (live-verified:
 * the thrown error is `(FiberFailure) SubmissionError: Transaction
 * submission error`, while `1010: Invalid Transaction: Custom error: 182`
 * only exists in the nested `cause`), so this matches against a bounded
 * deep inspection of the whole error structure, not just `message`.
 */
export function isPreMempoolReject(err: unknown): boolean {
    // One classifier for every submit path (submit-error-classification.ts);
    // this is the dust-guard's view of it: a reject the node made before the
    // mempool, fee unspent, so the pre-build dust snapshot may be restored.
    return isPreMempoolFailure(classifySubmitFailure(err));
}

/**
 * Arm the wedge protection for the submission that is about to build.
 * Best-effort: a failed snapshot only disarms the protection for this tx.
 */
export async function captureDustSnapshot(entry: FacadeEntry, site: string): Promise<void> {
    try {
        entry.preSubmitDustSnapshot = await entry.facade.dust.serializeState();
    } catch (e) {
        entry.preSubmitDustSnapshot = undefined;
        log('warn', `${site}: dust pre-build snapshot failed (wedge protection disarmed for this tx): ${formatErr(e)}`);
    }
}

/**
 * Replace the facade's dust sub-wallet with one restored from the armed
 * pre-build snapshot. The swap is safe mid-life: facade methods and our
 * periodic save / sync probes all reach the sub-wallet through `facade.dust`
 * at call time, and submits serialize per facade (the dispatcher's
 * SUBMIT_METHODS lock) so no other build is in flight. The unbound sponsor
 * path runs outside that lock but never books a spend in this wallet and
 * never arms this snapshot, so it cannot be rolled back by (or steal) one.
 * The old wallet is stopped only after the restored one started; if the
 * restore fails the old (wedged) wallet stays, which is no worse than today.
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
        // The periodic save may have persisted the poisoned in-flight state
        // while the tx was proving; a crash before the next tick would then
        // warm-restore the wedge. Persist the clean snapshot NOW, under a
        // bumped dust epoch: a save tick that already serialized the
        // pre-restore wallet drops its dust blob (epoch check in the tick),
        // and acks of dust pushed under an older epoch are ignored by
        // applySaveAck, so neither late pushes nor out-of-order acks can
        // win over the restored baseline.
        entry.dustEpoch = (entry.dustEpoch ?? 0) + 1;
        log('info', `${site}: dust sub-wallet restored from pre-build snapshot after pre-mempool reject (leaked in-flight spend discarded, snapshot re-persisted)`);
        // The push alone is fire-and-forget; a crash or persist failure
        // between push and ack would keep the poisoned DB state. WAIT for
        // the main thread's ack (bounded) and count the restore as durable
        // only then: dustRestoreCount reports persist-CONFIRMED restores,
        // so the live e2e gate also proves durability.
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

/**
 * Best-effort pre-submit diagnostics: serialized size and the ledger's own
 * cost verdict for the transaction. Reads the ledger's cost model
 * (Transaction.cost) so a "1010: Transaction would exhaust the block
 * limits" reject is diagnosable from the field (which dimension overflowed,
 * by how much). Never throws; costing failures only log.
 */
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
//
// A proof is bound to its transaction. When the SEND fails (the RPC closed the
// websocket at submit, connection reset, no reply), the finalized bytes are
// still valid and nothing needs re-proving; re-running the job rebuilt and
// re-proved the call instead (live preprod 2026-08-30: a 13 min relation
// proof twice for one `1000 Normal Closure`). The facade reverts its pending
// bookkeeping on any submit failure and re-pends on the next
// submitTransaction, so the SAME tx object is handed back to it. A send whose
// reply was lost may still have reached the node, so the indexer is asked for
// the identifier before every resend and after a reject of a resend; a landed
// transaction is reported as submitted (the SDK reads its apply status from
// the indexer as usual). Real rejects (pre-mempool, on-chain) are never resent.
export function submitTransportRetries(): number {
    return configNumber('NIGHTGATE_SUBMIT_TRANSPORT_RETRIES');
}
export function submitTransportBackoffMs(): number {
    return configMs('NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS');
}
export function submitLandedProbeMs(): number {
    return configMs('NIGHTGATE_SUBMIT_LANDED_PROBE_MS');
}

/**
 * The send itself failed (socket closed, reset, refused, timed out, no
 * reply); never a node reject. Runs only on the submit call, so any timeout
 * wording here is the submit's own (the proof round is over by then).
 */
export function isSubmitTransportFailure(err: unknown): boolean {
    return classifySubmitFailure(err).code === 'transport';
}

/**
 * A transaction found on the indexer after a lost reply: in a block, but
 * its call did not apply (ledger result FAILURE / PARTIAL_SUCCESS; the
 * guaranteed part, i.e. the fee, went through). Named like the SDK's own
 * error for the same outcome so the main-thread classification
 * (`TxFailed`, not retryable) applies.
 */
export class LandedTxFailedError extends Error {
    constructor(identifier: string, height: string, status: string, failedSegments: number[]) {
        super(`TxFailedError: transaction ${identifier.slice(0, 16)} is in block ${height} but did not apply (ledger result ${status}, failed segment${failedSegments.length === 1 ? '' : 's'} ${failedSegments.join(',') || '?'}); the fee was spent, the call must be rebuilt against the current contract state`);
        this.name = 'TxFailedError';
    }
}
export function landedOrThrow(found: { height: string; status: string | null; failedSegments: number[] }, identifier: string, site: string, how: string): string {
    if (found.status && found.status !== 'SUCCESS') throw new LandedTxFailedError(identifier, found.height, found.status, found.failedSegments);
    log('info', `${site}: transaction ${identifier.slice(0, 16)} is in block ${found.height} (${found.status ?? 'status n/a'}) ${how}; landed`);
    return identifier;
}

export function txIdentifierOf(tx: any): string | null {
    try {
        const id = typeof tx?.identifiers === 'function' ? tx.identifiers().at(-1) : undefined;
        return id == null ? null : String(id);
    } catch { return null; }
}

/** Poll the indexer for the identifier for up to `windowMs`; null when it is not there. */
export async function waitLandedOnIndexer(entry: FacadeEntry, identifier: string, windowMs: number) {
    const deadline = Date.now() + windowMs;
    for (;;) {
        const found = await indexerBlockOfIdentifier(entry.indexerHttpUrl, identifier);
        if (found) return found;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, deadline - Date.now()))));
    }
}

export async function submitSameTxWithTransportRetry(entry: FacadeEntry, tx: any, site: string): Promise<any> {
    const retries = submitTransportRetries();
    const identifier = txIdentifierOf(tx);
    for (let attempt = 0; ; attempt++) {
        try {
            return await entry.facade.submitTransaction(tx);
        } catch (e) {
            if (attempt > 0 && identifier && !isSubmitTransportFailure(e)) {
                // The resend was refused (a validity reject, `1013 Already Imported`,
                // anything but transport): the send whose reply was lost may have
                // reached the node after all, and the same bytes are then a replay.
                const found = await waitLandedOnIndexer(entry, identifier, submitLandedProbeMs());
                if (found) return landedOrThrow(found, identifier, site, 'although the resend was refused');
                throw e;
            }
            if (!identifier || attempt >= retries || !isSubmitTransportFailure(e)) throw e;
            log('warn', `${site}: submit transport failure (send ${attempt + 1}/${retries + 1}): ${formatErrWithCauses(e).slice(0, 300)}; ` +
                `checking the indexer for ${identifier.slice(0, 16)}, then resending the SAME transaction (no rebuild, no re-proving)`);
            const found = await waitLandedOnIndexer(entry, identifier, submitLandedProbeMs());
            if (found) return landedOrThrow(found, identifier, site, 'although the submit reply was lost');
            await new Promise((r) => setTimeout(r, submitTransportBackoffMs()));
        }
    }
}

/**
 * facade.submitTransaction with the dust-wedge protection applied: a
 * pre-mempool reject restores the pre-build dust snapshot, every other
 * outcome (success, or a failure where the tx may have reached the pool)
 * just disarms it. Never restore for post-mempool failures: a tx that
 * landed and failed on-chain HAS consumed its guaranteed-section dust fee.
 */
/**
 * Pre-broadcast handshake for the BOUND channel: the identifier of the
 * transaction about to be sent goes to the main thread first (`replyPort`),
 * which persists it as the job's external-effect boundary and acks. Without
 * an ack nothing is broadcast: a lost RPC (timeout, restart) can then never
 * leave a landed transaction the job does not know about. `contractAddress`,
 * `circuits`, `note` describe the attempt for the bookkeeping row.
 */
export interface BoundSubmitIntent {
    replyPort?: MessagePort;
    contractAddress?: string;
    circuits?: string[];
    note?: string;
}

export async function submitWithDustGuard(entry: FacadeEntry, tx: any, site: string, intent?: BoundSubmitIntent): Promise<any> {
    if (intent?.replyPort) {
        try {
            // Fail closed: a transaction whose identifier cannot be announced is
            // not broadcast (the main thread could never reconcile it).
            if (typeof tx?.identifiers !== 'function') throw new Error(`${site}: transaction exposes no identifiers(); refusing to broadcast unannounced`);
            await announceSubmitIntent(intent.replyPort, {
                txHash: String(tx.identifiers().at(-1)),
                contractAddress: intent.contractAddress, circuits: intent.circuits, note: intent.note
            });
        } catch (e) {
            // Not broadcast: free the booked spends and the dust as a pre-mempool
            // reject would (the SDK's own revert only runs on a failed submit).
            await revertRecipeBestEffort(entry.facade, tx, `${site} intent`);
            await restoreDustFromSnapshot(entry, `${site} intent`);
            throw e;
        }
    }
    await logTxCost(tx, site);
    try {
        const txId = await submitSameTxWithTransportRetry(entry, tx, site);
        entry.preSubmitDustSnapshot = undefined;
        return txId;
    } catch (e) {
        if (isPreMempoolReject(e)) {
            await restoreDustFromSnapshot(entry, site);
        } else {
            // Deliberate: a tx that may have reached the pool keeps its
            // booked spends. Log the inspected head so a mis-classified
            // reject is diagnosable from the field.
            log('info', `${site}: submit failed, NOT classified pre-mempool (dust guard disarmed): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            entry.preSubmitDustSnapshot = undefined;
        }
        throw e;
    }
}

// ---- Dedicated submission clients (parallel sponsor path) ------------------
//
// The SDK's PolkadotNodeClient ends EVERY submission stream with
// `api.disconnect()` on the facade's ONE shared node socket
// (`Stream.ensuring` in sendMidnightTransaction). Two concurrent
// submitAndWatch subscriptions on that client therefore kill each other: the
// first stream to finish drops the socket and the other never receives its
// InBlock/Finalized (live 2026-08-19: 3 of 4 concurrent sponsorings hung with
// their transactions already on-chain). "Submits serialize per facade" is
// thus a NODE-CLIENT invariant, independent of dust state. Every concurrent
// unbound submit gets its OWN SDK SubmissionService (own socket) from a small
// pool per relay URL; a slot is exclusive while its submit is in flight.
//
// SETTLE WINDOW: `WsProvider.disconnect()` returns before the socket is
// closed and `isConnected` stays true until `onclose`, so the SDK's
// ensureConnection skips the reconnect and sends on a CLOSING socket, which
// rejects the request with `disconnected ...: 1000:: Normal Closure`. The
// SDK client disconnects right after creation (PolkadotNodeClient.make) and
// after every submission stream (Stream.ensuring), so a slot is unusable
// for a moment after both (measured: broken at <= 300 ms, fine at >= 800 ms
// against preprod). A slot therefore becomes ready only SUBMIT_CLIENT_SETTLE_MS
// after creation and after each use; a submit that still dies on that exact
// close is retried once (the request never left the closing socket, so no
// double submit is possible).
export let SUBMIT_CLIENT_POOL_MAX = 8;
export const SUBMIT_CLIENT_SETTLE_MS = 2500;
export type SubmitClientSlot = { svc: any; busy: Promise<unknown> | null; readyAt: number };
export const submitClientPools = new Map<string, SubmitClientSlot[]>();
export const submitClientWaiters = new Map<string, number>(); // callers currently acquiring, per relay
// Test seams: cap + pool introspection (the cap is a constant in production).
export const __submitClientPoolForTests = {
    setMax: (n: number) => { SUBMIT_CLIENT_POOL_MAX = n; },
    size: (relayURL: URL) => submitClientPools.get(relayURL.toString())?.length ?? 0,
    reset: () => submitClientPools.clear()
};

export class SubmitWatchTimeoutError extends Error {
    constructor(ms: number) { super(`submit watch timed out after ${ms}ms without a Finalized status`); this.name = 'SubmitWatchTimeoutError'; }
}

export async function withDedicatedSubmitClient<T>(relayURL: URL, fn: (svc: any) => Promise<T>, opts: { abandonAfterMs?: number } = {}): Promise<T> {
    const key = relayURL.toString();
    let pool = submitClientPools.get(key);
    if (!pool) { pool = []; submitClientPools.set(key, pool); }
    submitClientWaiters.set(key, (submitClientWaiters.get(key) ?? 0) + 1);
    let slot: SubmitClientSlot | undefined;
    try {
        for (;;) {
            const now = Date.now();
            const free = pool.filter((s) => s.busy === null);
            slot = free.find((s) => s.readyAt <= now);
            if (slot) break;
            // Create a client only when the free (ready or settling) slots cannot
            // cover the callers currently waiting, and never beyond the cap. The
            // slot is RESERVED SYNCHRONOUSLY (before any await) so concurrent
            // first callers cannot all pass the size check and over-create; it is
            // not ready (readyAt = Infinity) until the client exists.
            const waiters = submitClientWaiters.get(key) ?? 1;
            if (pool.length < SUBMIT_CLIENT_POOL_MAX && free.length < waiters) {
                const created: SubmitClientSlot = { svc: null, busy: null, readyAt: Number.POSITIVE_INFINITY };
                pool.push(created);
                try {
                    const caps: any = await loadSubmissionSdk();
                    created.svc = caps.makeDefaultSubmissionService({ relayURL });
                    created.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS;
                } catch (e) {
                    pool.splice(pool.indexOf(created), 1);
                    throw e;
                }
                continue; // re-evaluate; the new slot becomes ready after its settle window
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
    if (!opts.abandonAfterMs) {
        try { return await run; } finally { slot.busy = null; slot.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS; }
    }
    // WATCHDOG: a submitAndWatch whose socket died mid-watch never resolves
    // (the SDK client has no auto-reconnect after its own disconnect()). Do
    // not let that pin the job until the TTL: abandon the call, EVICT the slot
    // (its socket/subscription state is unknown) and let the caller decide via
    // the indexer whether the transaction is on-chain.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SubmitWatchTimeoutError(opts.abandonAfterMs!)), opts.abandonAfterMs); });
    try {
        return await Promise.race([run, timeout]);
    } catch (e) {
        if (e instanceof SubmitWatchTimeoutError) {
            const idx = pool.indexOf(slot);
            if (idx >= 0) pool.splice(idx, 1);
            try { await slot.svc?.close?.(); } catch { /* best effort */ }
            slot.busy = null;
        }
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
        if (pool.includes(slot)) { slot.busy = null; slot.readyAt = Date.now() + SUBMIT_CLIENT_SETTLE_MS; }
    }
}

/**
 * Indexer lookup by transaction IDENTIFIER; null when unknown or unreachable.
 * Also returns the ledger's APPLY result: `SUCCESS`, or `PARTIAL_SUCCESS` /
 * `FAILURE` when a segment (the contract call) was rejected at apply time
 * although the transaction sits in a block (its guaranteed part, i.e. the
 * fee, went through). A sponsoring whose call did not apply is NOT a success
 * (live: `attest` in block 2172277 with segment 42593 success=false, the
 * anchor never existed, the sponsor paid).
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

export class SponsoredCallNotAppliedError extends Error {
    /** Height of the block the indexer reported the transaction in (rollback coordinate). */
    readonly blockHeight: number | null;
    constructor(identifier: string, height: string, status: string, failedSegments: number[]) {
        super(`sponsored transaction ${identifier.slice(0, 16)} is in block ${height} but its contract call did NOT apply (ledger result ${status}, failed segment${failedSegments.length === 1 ? '' : 's'} ${failedSegments.join(',') || '?'}); the sponsor paid the fee, the call must be rebuilt against the current contract state`);
        this.name = 'SponsoredCallNotAppliedError';
        const h = Number(height);
        this.blockHeight = Number.isInteger(h) && h >= 0 ? h : null;
    }
}
export function assertApplied(found: { height: string; status: string | null; failedSegments: number[] }, identifier: string): void {
    if (found.status && found.status !== 'SUCCESS') throw new SponsoredCallNotAppliedError(identifier, found.height, found.status, found.failedSegments);
}
// 60 s by default: a healthy submit sees Finalized well within that on preprod;
// anything slower is answered by the indexer lookup (the tx landed) or by a
// rebuild (it did not), instead of a watch that may never return.
export const SUBMIT_WATCH_TIMEOUT_MS = configMs('NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS');
export const SUBMIT_WATCH_CONFIRM_MS = 90_000;
// Which submission stage the unbound sponsor path waits for. 'Finalized' is
// what the facade waits for; 'InBlock' returns as soon as the transaction is
// in a block (measured preprod: ~12-18 s earlier per transaction). The job's
// chain outcome is confirmed by the indexer afterwards either way
// (crawler-free chain-outcome confirmer), so a reorg before finality surfaces
// as a failed chain status, not as a lost job. Default InBlock.
export const SPONSOR_SUBMIT_WAIT: 'InBlock' | 'Finalized' = configEnum('NIGHTGATE_SPONSOR_WAIT') === 'finalized' ? 'Finalized' : 'InBlock';
export function sponsorSubmitWaitStage(): 'InBlock' | 'Finalized' { return SPONSOR_SUBMIT_WAIT; }
// After InBlock, wait (bounded) until the PUBLIC INDEXER has the transaction
// before reporting landed: a caller that builds its next call right away reads
// the contract state from that indexer, and between InBlock and indexing it
// serves an inconsistent state (live: `expected a cell, received null` in the
// caller's findDeployedContract). Finalized mode never needed this (the
// indexer was always ahead by then).
export const SPONSOR_INDEXER_VISIBLE_MS = configMs('NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS');
export async function waitIndexerVisible(indexerHttpUrl: string, identifier: string, site: string): Promise<void> {
    if (SPONSOR_INDEXER_VISIBLE_MS === 0) return;
    const t0 = Date.now();
    while (Date.now() - t0 < SPONSOR_INDEXER_VISIBLE_MS) {
        const found = await indexerBlockOfIdentifier(indexerHttpUrl, identifier);
        if (found) {
            log('debug', `${site}: indexer has the transaction in block ${found.height} (${found.status ?? 'status n/a'}) after ${Date.now() - t0}ms`);
            assertApplied(found, identifier);
            return;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    log('warn', `${site}: transaction in block but not visible on the indexer after ${SPONSOR_INDEXER_VISIBLE_MS}ms; reporting landed anyway`);
}

/**
 * Pre-broadcast handshake with the main thread over the RPC reply port: sends
 * `{ kind: 'submit-intent', txHash }` and resolves when the client acks it
 * (`submit-intent-ack`). Without a port (tests calling the handler directly)
 * it is a no-op. A missing ack is NOT tolerated: better to fail the job before
 * the broadcast than to broadcast without the durable boundary.
 */
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
}
export async function announceSubmitIntent(port: MessagePort | undefined, intent: SubmitIntent): Promise<void> {
    if (!port) return;
    const { txHash } = intent;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { port.off('message', onMsg); reject(new Error('submit-intent was not acknowledged by the main thread within 30s; not broadcasting')); }, 30_000);
        const onMsg = (m: any) => {
            if (m?.kind === 'submit-intent-ack' && m.txHash === txHash) {
                clearTimeout(timer); port.off('message', onMsg);
                if (m.ok === false) reject(new Error(`submit-intent rejected by the main thread: ${m.error ?? 'unknown'}`));
                else resolve();
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

/**
 * Submit on a DEDICATED node client, without the dust-wedge guard and without
 * the facade's pending-tx tracker: for the unbound sponsor path, which never
 * booked a spend in the facade's dust wallet (the sponsor learns about the
 * landed spend from chain sync). Waits for FINALIZED like the facade does and
 * returns the transaction identifier the facade would return. On failure it
 * logs the reject class so a field 1010/170 is recognisable, then rethrows
 * for the handler's own retry.
 */
export async function submitOnDedicatedClient(entry: FacadeEntry, tx: any, site: string): Promise<any> {
    await logTxCost(tx, site);
    const relayURL: URL = entry.walletConfiguration.relayURL;
    const identifier = String(tx.identifiers().at(-1));
    for (let attempt = 0; ; attempt++) {
        try {
            await withDedicatedSubmitClient(relayURL, (svc) => svc.submitTransaction(tx, SPONSOR_SUBMIT_WAIT), { abandonAfterMs: SUBMIT_WATCH_TIMEOUT_MS });
            if (SPONSOR_SUBMIT_WAIT === 'InBlock') await waitIndexerVisible(entry.indexerHttpUrl, identifier, site);
            return identifier;
        } catch (e) {
            if (attempt === 0 && isClosingSocketReject(e)) {
                log('warn', `${site}: submit request died on the client's own closing socket (SDK disconnect lag); retrying once on a settled client`);
                continue;
            }
            if (e instanceof SubmitWatchTimeoutError) {
                // The watch is gone, the transaction may well be on-chain (live:
                // a watch that never saw Finalized while the block was final for
                // minutes). Ask the indexer for up to SUBMIT_WATCH_CONFIRM_MS
                // before calling it lost; only then let the handler rebuild.
                const deadline = Date.now() + SUBMIT_WATCH_CONFIRM_MS;
                for (;;) {
                    const found = await indexerBlockOfIdentifier(entry.indexerHttpUrl, identifier);
                    if (found) {
                        log('info', `${site}: no Finalized within ${SUBMIT_WATCH_TIMEOUT_MS}ms, indexer has the transaction in block ${found.height} (${found.status ?? 'status n/a'}); landed`);
                        assertApplied(found, identifier);
                        return identifier;
                    }
                    if (Date.now() >= deadline) break;
                    await new Promise((r) => setTimeout(r, 10_000));
                }
                log('warn', `${site}: submit watch timed out and the indexer does not know the transaction ${identifier.slice(0, 16)} after ${SUBMIT_WATCH_CONFIRM_MS}ms; failing for a rebuild`);
                throw e;
            }
            log('info', `${site}: submit failed (${isPreMempoolReject(e) ? 'pre-mempool reject' : 'not pre-mempool'}; no dust guard on this path): ${safeDeepInspect(e, 512).slice(0, 600)}`);
            throw e;
        }
    }
}

// Exported for the in-thread unit tests (wallet-worker-dispatch.test.ts):
// the 117-guard around balanceTx/submitTx is OUR logic, not SDK choreography.
export function buildWorkerWalletProvider(entry: FacadeEntry, intent?: BoundSubmitIntent): any {
    return {
        getCoinPublicKey(): string { return entry.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return entry.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            // Block until GENUINELY synced to the indexer tip before balancing
            // (not the lying isSynced flag). Balancing stale (restored/partial)
            // dust makes the node reject the tx: `1010 Custom error: 170` (dust
            // validity window ctime+grace < tblock) or `117` (pruned dust merkle
            // roots). The prewarm job usually caught up already, so this is a
            // cheap re-check on the warm path; waitForGenuineSync is bounded so a
            // stalled indexer subscription fails fast instead of hanging.
            await waitForGenuineSync(entry, BALANCE_SYNC_TIMEOUT_MS, 'balance');
            // Arm the dust-wedge protection BEFORE the build books the spend.
            await captureDustSnapshot(entry, 'balance');
            const effectiveTtl = ttl ?? new Date(Date.now() + 60 * 60 * 1000);
            const recipe = await entry.facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: entry.zswapKeys, dustSecretKey: entry.dustKey },
                { ttl: effectiveTtl }
            );
            let finalized: any;
            try {
                finalized = await entry.facade.finalizeRecipe(recipe);
            } catch (e) {
                // On prove failure the SDK reverts only the BALANCING tx of an
                // UNBOUND recipe; the base tx's in-place unshielded spends
                // would stay pending without this (bug_002 Bug A).
                await revertRecipeBestEffort(entry.facade, recipe, 'balance');
                throw e;
            }
            const dust = describeTxDust(finalized);
            log('info', `balanced tx dust sections: ${dust.summary}`);
            if (dust.emptyDustActions) {
                // The node would reject this as 1010/117 (NotNormalized). Fail
                // here instead: saves the proof round and pins the root cause
                // (balancer emitted an empty DustActions = fee evaluated to 0).
                // The tx is finalized but will never be submitted: free its
                // coins now instead of waiting for the pending-tx TTL reclaim.
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
 * Two-phase sponsored wallet provider: the CALLER builds and signs the
 * transaction, the SPONSOR pays the dust fee and submits.
 *
 * Phase 1 (caller facade): balanceUnboundTransaction with
 * tokenKindsToBalance ['shielded','unshielded'], signRecipe for any
 * unshielded inputs the balancer selected (no-op otherwise), finalizeRecipe.
 * The result is a fully signed, fee-unpaid FinalizedTransaction.
 *
 * Phase 2 (sponsor facade): balanceFinalizedTransaction with
 * tokenKindsToBalance ['dust'] ONLY. Re-balancing token kinds the caller
 * already balanced would double-spend; never widen this list. finalizeRecipe
 * proves the sponsor's dust spends; submitTx routes through the sponsor
 * facade (only the sponsor submits; its state anticipates the dust spends).
 *
 * Both phases share one explicit TTL so a stalled phase 2 cannot submit
 * against an expired phase 1.
 *
 * Exported for the in-thread unit tests, like buildWorkerWalletProvider.
 */
export function buildSponsoredWalletProvider(caller: FacadeEntry, sponsor: FacadeEntry, intent?: BoundSubmitIntent): any {
    // The caller-side finalized tx of the LAST successful balanceTx. Kept so
    // a submit failure can revert the CALLER facade too: the SDK's
    // submitTransaction error path reverts only the facade it ran on (the
    // sponsor), while the caller's spends were pended by phase 1 (bug_002).
    // One slot is enough: providers are built per submission and submits
    // serialize per facade.
    let lastCallerFinalized: any;
    return {
        getCoinPublicKey(): string { return caller.zswapKeys.coinPublicKey; },
        getEncryptionPublicKey(): string { return caller.zswapKeys.encryptionPublicKey; },
        async balanceTx(tx: any, ttl?: Date): Promise<any> {
            // The SPONSOR spends the dust, so ITS wallet must be genuinely
            // synced (stale dust merkle roots are the Custom error 117 site).
            // The caller only balances shielded/unshielded; by default sync it
            // too so stale coin state cannot double-select inputs. Deployments
            // whose sponsored callers are known to hold nothing (e.g. a public
            // demo minting fresh identity wallets) can skip the caller wait
            // with NIGHTGATE_SPONSORED_CALLER_SYNC=skip: with no coins there
            // is nothing to select, and the fee side is the sponsor's alone.
            if (configEnum('NIGHTGATE_SPONSORED_CALLER_SYNC') === 'skip') {
                log('info', 'sponsored-balance: caller sync SKIPPED (NIGHTGATE_SPONSORED_CALLER_SYNC=skip)');
            } else {
                await waitForGenuineSync(caller, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance caller');
            }
            await waitForGenuineSync(sponsor, BALANCE_SYNC_TIMEOUT_MS, 'sponsored-balance sponsor');
            const effectiveTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000);

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
                // Sign failures are not covered by any SDK revert, and prove
                // failures revert only the balancing part of an UNBOUND recipe
                // (bug_002 Bug A). Reverting the unsigned recipe is fine: the
                // rollback matches by UTxO, not object identity.
                await revertRecipeBestEffort(caller.facade, recipe, 'sponsored-balance caller');
                throw e;
            }

            try {
                // Phase 2 books the SPONSOR's dust spend: arm its wedge
                // protection before the build.
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
                // The caller-side finalized tx will never be submitted; free
                // its coins now instead of waiting for the TTL reclaim.
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
                // The SDK reverted the SPONSOR facade (plus our dust guard
                // above); the caller's phase-1 spends stay pending without
                // this (bug_002). Safe either way: if the tx did land, sync
                // reconciles and a retry is rejected by the node; if it did
                // not, the retry works.
                await revertRecipeBestEffort(caller.facade, lastCallerFinalized ?? tx, 'sponsored-submit caller');
                lastCallerFinalized = undefined;
                throw e;
            }
        }
    };
}

/**
 * EXPERIMENTAL (cross-server-fee-sponsoring FR): a wallet provider that does
 * ONLY the caller's phase 1 (balance shielded/unshielded, sign, finalize) and
 * then STOPS instead of submitting. `submitTx` captures the fee-unpaid,
 * caller-signed FinalizedTransaction into `holder.captured` and returns a
 * sentinel, so the SDK's callTx completes without touching the chain. The
 * captured tx is what a remote sponsor would receive, balance dust onto, and
 * submit.
 *
 * This is the caller half of a cross-server split: prove it round-trips
 * through serialize/deserialize and is still accepted by
 * balanceFinalizedTransaction, and cross-machine sponsoring is just transport.
 */
/** Thrown by the build-only provider to stop the SDK's callTx at submit time. */
export class BuildOnlyStop extends Error {
    constructor() { super('build-only: captured finalized tx, stopping before submit'); this.name = 'BuildOnlyStop'; }
}

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
            // Capture and STOP: returning a fake tx id lets the SDK's callTx
            // continue into a watch-for-confirmation phase that never resolves.
            // Throwing aborts callTx here; the handler catches BuildOnlyStop and
            // proceeds to the sponsor phase with holder.captured. The caller's
            // phase-1 spends are pended by finalize and reverted by the handler
            // if the sponsor half never runs.
            holder.captured = tx;
            throw new BuildOnlyStop();
        }
    };
}

/**
 * Deserialize a caller-finalized (fee-unpaid, signed, proven, bound) Transaction
 * from base64. ledger-v8 `Transaction.deserialize` takes three string markers
 * (Signaturish/Proofish/Bindingish tags) + the raw bytes; a finalized tx is
 * signed+proven+bound. Live-proven pairing: ('signature','proof','binding').
 */
