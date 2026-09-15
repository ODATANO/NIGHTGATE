/**
 * Main-thread side of the wallet-worker RPC: one worker per process, one
 * MessageChannel per call, push events (state-save, log, ...) on the worker port.
 */

import cds from '@sap/cds';
import { Worker, MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import type { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';
import type { MerkleProofBundle } from '../submission/contract-witnesses';
import { formatErr } from '../utils/format-error';
import { isSubmittingMethod, WORKER_ROTATING, WORKER_ROTATED, WorkerSubmitError, isSubmitFailureCode } from './wallet-worker-protocol';
import { getEncryptionKey } from '../utils/crypto';
import { configMs, configNumberFrom, resolvedConfigSnapshot } from '../utils/config';

const log = cds.log('nightgate:worker-client');

export interface WalletInitArgs {
    sessionId: string;
    seedHex: string;
    /** BIP32 account level the seed signs with (default 0). */
    accountIndex?: number;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    relayUrl: string;
    restoreBlobs?: { shielded?: string; unshielded?: string; dust?: string };
}

export interface SerializedBlobs {
    shielded?: string;
    unshielded?: string;
    dust?: string;
}

export type StateSaveSink = (event: {
    sessionId: string;
    sdkVersion: string;
    /** Echoed back as `state-save-ack` only when the sink persisted. */
    seq?: number;
    blobs: SerializedBlobs;
}) => void | Promise<void>;

/** Mirrors the worker's `SyncProgressSnapshot`; not imported, the worker module loads the ESM SDK. */
export interface WalletSyncProgress {
    sessionId: string;
    /** Ledger events applied by the dust sub-wallet. Decimal string (bigint). */
    appliedIndex: string;
    /** Tip of the dust ledger-event stream. Decimal string; '-1' if unknown. */
    streamTip: string;
    behindEvents: string | null;
    eventsPerSecond: number | null;
    etaSeconds: number | null;
    blockHeight: string | null;
    isConnected: boolean;
    indexerFresh: boolean;
    caughtUp: boolean;
    elapsedMs: number;
    label: string;
    updatedAt: string;
    /** When appliedIndex last advanced. */
    lastProgressAt?: string;
}

// Latest pushed snapshot per facade; cleared on evict and on worker exit.
const syncProgressCache = new Map<string, WalletSyncProgress>();

interface ClientState {
    worker: Worker;
    readyPromise: Promise<void>;
}

let client: ClientState | null = null;

// Distinguishes "never started" (reject) from "crashed after start" (respawn).
let everStarted = false;

// Crash exits only; rotations and stops are counted apart.
let workerExitCount = 0;
let lastExitCode: number | null = null;
let lastExitAt: string | null = null;
let workerRotationCount = 0;
let rotationAnnounced = false;
// Announced its rotation, not exited yet; new calls wait for the respawn.
let drainingWorker: Worker | null = null;
// Stopped on purpose: its exit is neither a crash nor a rotation.
let stoppingWorker: Worker | null = null;

/**
 * Rotation drain ceiling. Terminating past it is safe: every submit announced
 * its identifier before sending, so reconciliation resolves what was cut.
 */
function drainMaxMs(): number {
    return configMs('NIGHTGATE_WORKER_DRAIN_MAX_MS');
}

// Module scope so the sink, wired once, survives a worker respawn.
let stateSaveSink: StateSaveSink | undefined;

/**
 * Only the young generation is sized (save ticks serialize multi-MB blobs); the
 * old generation still inherits NODE_OPTIONS. 0 = V8 default.
 */
export function workerResourceLimits(env: NodeJS.ProcessEnv = process.env): { maxYoungGenerationSizeMb: number } | undefined {
    const n = configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', env);
    if (n <= 0) return undefined;
    return { maxYoungGenerationSizeMb: Math.max(16, n) };
}

// Serializes state-save persists in arrival order (each handler settles, so
// the chain never rejects and a failed persist doesn't block later ones).
let stateSaveChain: Promise<void> = Promise.resolve();

// A worker exit rejects these; their ports would never reply.
interface PendingRpc { reject: (e: Error) => void; }
const pendingRpcs = new Set<PendingRpc>();

function rejectAllPendingRpcs(reason: string, name?: string): void {
    for (const p of [...pendingRpcs]) {
        const err = new Error(reason);
        if (name) err.name = name;
        try { p.reject(err); } catch { /* already settled */ }
    }
    pendingRpcs.clear();
}

const RPC_TIMEOUT_MS = configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS');
// An intent hook (persisting an announced identifier) slower than this is logged.
const INTENT_PERSIST_WARN_MS = 5_000;

/**
 * Main-side targets of the worker's `private-state-rpc` proxy, one fresh `proxyId`
 * per submission so concurrent calls don't share a `currentContractAddress`.
 */
const privateStateProviders = new Map<string, CapDbPrivateStateProvider>();

export function registerPrivateStateProvider(proxyId: string, provider: CapDbPrivateStateProvider): void {
    privateStateProviders.set(proxyId, provider);
}

export function unregisterPrivateStateProvider(proxyId: string): void {
    privateStateProviders.delete(proxyId);
}

/** The compiled worker entry next to this file (in-place build). */
function resolveWorkerEntry(): string {
    return path.join(__dirname, 'wallet-worker.js');
}

/** Start the worker (idempotent); resolves on its `ready` message. */
export async function startWalletWorker(): Promise<void> {
    if (client) {
        await client.readyPromise;
        return;
    }

    everStarted = true;
    const entry = resolveWorkerEntry();
    const worker = new Worker(entry, {
        // The worker never parses NIGHTGATE_* or ENCRYPTION_KEY* itself.
        workerData: { encryptionKeyRing: getEncryptionKey().toSpec() ?? null, config: resolvedConfigSnapshot() },
        resourceLimits: workerResourceLimits(),
        // false = worker output surfaces on the main process streams.
        stderr: false,
        stdout: false
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
        const onReady = (msg: any) => {
            if (msg?.kind === 'ready') {
                worker.off('message', onReady);
                resolve();
            }
        };
        worker.on('message', onReady);
        worker.once('error', err => reject(err));
        worker.once('exit', code => {
            if (code !== 0) reject(new Error(`wallet-worker exited with code ${code} before ready`));
        });
    });

    client = { worker, readyPromise };

    worker.on('message', (msg: any) => {
        if (msg?.kind === 'state-save') {
            // Ack only a persisted save. Chained so saves commit in arrival
            // order: the dust-restore push relies on last-sent-wins.
            stateSaveChain = stateSaveChain
                .then(() => {
                    if (!stateSaveSink) throw new Error('no state-save sink wired');
                    return stateSaveSink(msg);
                })
                .then(() => {
                    if (msg.seq != null) worker.postMessage({ kind: 'state-save-ack', sessionId: msg.sessionId, seq: msg.seq });
                })
                .catch(() => { /* no ack; sink already logged the failure */ });
        } else if (msg?.kind === 'log') {
            // Through a CAP channel so consumers control verbosity.
            const level = msg.level === 'warn' ? 'warn'
                : msg.level === 'error' ? 'error'
                    : msg.level === 'debug' ? 'debug'
                        : 'info';
            (cds.log('nightgate:worker') as any)[level](msg.message);
        } else if (msg?.kind === 'sync-progress') {
            if (msg.sessionId && msg.snapshot) {
                syncProgressCache.set(msg.sessionId, msg.snapshot as WalletSyncProgress);
            }
        } else if (msg?.kind === 'private-state-rpc') {
            dispatchPrivateStateRpc(msg);
        } else if (msg?.kind === 'rotating') {
            rotationAnnounced = true;
            drainingWorker = worker;
            log.info(`worker announced its rotation (${msg.generations} artifact generations, ${msg.inflight ?? 0} call(s) draining); new calls wait for the respawn`);
        } else if (msg?.kind === 'rotation-done') {
            // Terminated from here so the worker never exits mid-reply.
            rotationAnnounced = true;
            drainingWorker = worker;
            log.info(`worker rotation drained (${msg.generations} artifact generations); terminating it, the next call respawns`);
            void worker.terminate().catch(() => undefined);
        }
    });

    worker.on('error', err => {
        log.error('worker error:', err);
        rejectAllPendingRpcs(`wallet-worker crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    worker.on('exit', code => {
        // A replacement started meanwhile (stop, then start) must not be orphaned
        // by the old worker's late exit event.
        if (client?.worker === worker) client = null;
        if (drainingWorker === worker) drainingWorker = null;
        const stopped = stoppingWorker === worker;
        const rotated = !stopped && rotationAnnounced;
        if (stopped) {
            stoppingWorker = null;
            log.info(`worker stopped (code=${code})`);
        } else if (rotated) {
            rotationAnnounced = false;
            workerRotationCount += 1;
            log.info(`worker rotated (controlled exit after its generation budget); the next call respawns it`);
        } else {
            log.warn(`worker exited code=${code}`);
            workerExitCount += 1;
            lastExitCode = code;
            lastExitAt = new Date().toISOString();
        }
        // No facade survives an exit.
        syncProgressCache.clear();
        void notifyWorkerGone('exit');
        // A rotation names its rejection so rpc() can repeat a read on the respawn.
        rejectAllPendingRpcs(
            rotated ? `wallet-worker rotated with in-flight calls` : `wallet-worker exited (code=${code}) with in-flight calls`,
            rotated ? WORKER_ROTATED : undefined
        );
    });

    await readyPromise;
    log.info('worker ready');
}

/**
 * Evict every facade with an acked final save, then terminate. The flush needs
 * the save sink, so call this BEFORE dropping encryption keys.
 */
export async function stopWalletWorker(timeoutMs = 60_000): Promise<void> {
    if (!client) return;
    const w = client.worker;
    // Intentional teardown: do NOT let a later rpc respawn the worker.
    everStarted = false;
    try {
        const r = await rpcOnce<{ evicted: number; failed: number }>('shutdown', {}, timeoutMs);
        if (r.failed > 0) log.error(`worker shutdown: ${r.evicted} facade(s) evicted, ${r.failed} WITHOUT a confirmed final save`);
        else log.info(`worker shutdown: ${r.evicted} facade(s) evicted, all saves confirmed`);
    } catch (err) {
        if ((err as Error)?.name === WORKER_ROTATING) {
            // A rotating worker flushes its facades itself; wait for its exit.
            log.info('worker is rotating during shutdown; waiting for its own facade flush and exit');
            if (!drainingWorker) drainingWorker = w;
            await Promise.race([
                new Promise<void>(resolve => { w.once('exit', () => resolve()); if (drainingWorker !== w) resolve(); }),
                new Promise<void>(resolve => { const t = setTimeout(resolve, timeoutMs); (t as any).unref?.(); })
            ]);
        } else {
            log.warn(`worker shutdown flush did not complete: ${err instanceof Error ? err.message : String(err)}; terminating`);
        }
    }
    if (client?.worker !== w) return; // replaced or already gone meanwhile
    client = null;
    stoppingWorker = w;
    try { await w.terminate(); } catch { }
    // Also here: a forced terminate may not run the exit handler first.
    syncProgressCache.clear();
    await notifyWorkerGone('stop');
}

/**
 * Worker gone: every facade is gone. `'exit'` (crash): a listener may only keep what
 * queued work needs. `'stop'` (awaited teardown): a listener may drain and release everything.
 */
export type WorkerGoneReason = 'exit' | 'stop';
type WorkerGoneListener = (reason: WorkerGoneReason) => void | Promise<void>;
const workerGoneListeners = new Set<WorkerGoneListener>();

function notifyWorkerGone(reason: WorkerGoneReason): Promise<void> {
    const running: Array<Promise<void>> = [];
    for (const listener of workerGoneListeners) {
        try {
            const result = listener(reason);
            if (result) running.push(result.catch(err => log.warn(`worker-gone listener failed: ${String(err)}`)));
        } catch (err) {
            log.warn(`worker-gone listener failed: ${String(err)}`);
        }
    }
    return Promise.all(running).then(() => undefined);
}

/** Register a listener; returns an unsubscribe for tests. */
export function onWorkerGone(listener: WorkerGoneListener): () => void {
    workerGoneListeners.add(listener);
    return () => workerGoneListeners.delete(listener);
}

/** Register the receiver of the worker's 'state-save' pushes. */
export function setStateSaveSink(sink: StateSaveSink | undefined): void {
    if (!client) {
        throw new Error('wallet-worker not started; call startWalletWorker() first');
    }
    stateSaveSink = sink;
}

/**
 * Persists the external-effect boundary for an identifier the worker is about to
 * broadcast; the worker waits for the ack and does not broadcast if this throws.
 */
export interface SubmitIntentInfo { txHash: string; contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string }
export type SubmitIntentHook = (txHash: string, intent: SubmitIntentInfo) => Promise<void>;

async function rpc<T>(method: string, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    // Retry once on the respawn after a rotation refusal or cut-off; a submitting
    // call is never repeated (its announced identifier is reconciled instead).
    for (let attempt = 0; ; attempt++) {
        await waitForDrainingWorker();
        try {
            return await rpcOnce<T>(method, args, timeoutMs, onSubmitIntent);
        } catch (err) {
            const name = (err as Error)?.name;
            if (attempt === 0 && name === WORKER_ROTATING) {
                // The refusal can arrive before the `rotating` announcement
                // (two ports): mark the worker draining from the refusal itself.
                if (!drainingWorker && client) drainingWorker = client.worker;
                continue;
            }
            if (attempt === 0 && name === WORKER_ROTATED && !isSubmittingMethod(method)) continue;
            throw err;
        }
    }
}

async function waitForDrainingWorker(): Promise<void> {
    const w = drainingWorker;
    if (!w) return;
    const ceiling = drainMaxMs();
    await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => { if (timer) clearTimeout(timer); resolve(); };
        w.once('exit', done);
        // Exit fired before we subscribed: the exit handler cleared it.
        if (drainingWorker !== w) { w.off('exit', done); resolve(); return; }
        timer = setTimeout(() => {
            if (drainingWorker !== w) return;
            log.warn(`worker rotation drain exceeded ${ceiling}ms; terminating the draining worker (in-flight submits announced their identifiers, reconciliation resolves them)`);
            void w.terminate().catch(() => undefined);
        }, ceiling);
        (timer as any).unref?.();
    });
}

/** One RPC over its own MessageChannel. */
async function rpcOnce<T>(method: string, args: unknown, timeoutMs: number, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    if (!client) {

        if (!everStarted) {
            throw new Error('wallet-worker not started');
        }
        await startWalletWorker();
    }
    const worker = client!.worker;
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        let settled = false;
        // The worker's answer (reply, timeout, exit) is in; the call settles
        // once every intent hook of this call has settled too.
        let answered = false;
        const intentsInFlight = new Set<Promise<void>>();
        let pending: PendingRpc;
        let timer: ReturnType<typeof setTimeout>;
        const settle = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingRpcs.delete(pending);
            port2.close();
        };
        // Wait for pending intent hooks: a late commit after the caller's failure
        // bookkeeping would leave a hash on a job whose tx was never sent.
        const finish = (outcome: () => void): void => {
            if (answered) return;
            answered = true;
            clearTimeout(timer);
            void (async () => {
                while (intentsInFlight.size > 0) await Promise.allSettled([...intentsInFlight]);
                settle();
                outcome();
            })();
        };
        // Guarded, so exit sweep and timeout cannot double-settle.
        pending = { reject: (e: Error) => finish(() => reject(e)) };
        pendingRpcs.add(pending);
        timer = setTimeout(
            () => pending.reject(new Error(`wallet-worker rpc '${method}' timed out after ${timeoutMs}ms`)),
            timeoutMs
        );

        const postAck = (ack: Record<string, unknown>): void => {
            try { port2.postMessage({ kind: 'submit-intent-ack', ...ack }); } catch { /* port already closed */ }
        };
        port2.on('message', (msg: any) => {
            if (answered) return;
            if (msg?.kind === 'submit-intent') {
                // Persist, then ack or nack. No ack once the worker answered: it gave up and did not send.
                const intent: SubmitIntentInfo = { txHash: String(msg.txHash), contractAddress: msg.contractAddress, circuits: msg.circuits, note: msg.note, sponsorAccountId: msg.sponsorAccountId, ...(Array.isArray(msg.deployed) ? { deployed: msg.deployed.map(String) } : {}), ...(typeof msg.ttl === 'string' ? { ttl: msg.ttl } : {}) };
                const startedAt = Date.now();
                const tracked: Promise<void> = Promise.resolve()
                    .then(() => onSubmitIntent?.(intent.txHash, intent))
                    .then(
                        () => {
                            const ms = Date.now() - startedAt;
                            if (answered) {
                                log.warn(`submit-intent ${intent.txHash.slice(0, 16)}: persisted after ${ms}ms, after the worker had answered; not acknowledged (the worker did not broadcast)`);
                                return;
                            }
                            if (ms > INTENT_PERSIST_WARN_MS) log.warn(`submit-intent ${intent.txHash.slice(0, 16)}: persisting the boundary took ${ms}ms`);
                            postAck({ txHash: msg.txHash, ok: true });
                        },
                        (e) => {
                            if (!answered) postAck({ txHash: msg.txHash, ok: false, error: String((e as Error)?.message ?? e) });
                        }
                    )
                    .finally(() => { intentsInFlight.delete(tracked); });
                intentsInFlight.add(tracked);
                return;
            }
            finish(() => {
                if (msg?.ok) {
                    resolve(msg.result as T);
                    return;
                }
                const payload = msg?.error;
                if (payload && typeof payload === 'object' && typeof payload.message === 'string') {
                    if (isSubmitFailureCode(payload.code)) {
                        reject(new WorkerSubmitError(payload));
                        return;
                    }
                    const err = new Error(payload.message);
                    if (typeof payload.name === 'string' && payload.name) err.name = payload.name;
                    reject(err);
                } else {
                    reject(new Error(typeof payload === 'string' ? payload : 'worker rpc failed'));
                }
            });
        });
        port2.once('messageerror', err => finish(() => reject(err as Error)));
        worker.postMessage(
            { kind: 'rpc', method, args, port: port1 },
            [port1] // transfer ownership of port1
        );
    });
}

/**
 * `setContractAddress` has no reply port: parentPort ordering guarantees it is
 * applied before the next set/get arrives. Other methods reply on their port.
 */
function dispatchPrivateStateRpc(msg: any): void {
    const { proxyId, method, args, port } = msg;
    const provider = privateStateProviders.get(proxyId);

    if (method === 'setContractAddress') {
        if (!provider) {
            log.warn(`setContractAddress: unknown proxyId=${String(proxyId).slice(0, 16)}`);
            return;
        }
        try {
            provider.setContractAddress(...(args as [string]));
        } catch (err) {
            log.warn('setContractAddress failed:', formatErr(err));
        }
        return;
    }

    if (!port) {
        log.warn(`private-state-rpc missing port for method=${method}`);
        return;
    }

    if (!provider) {
        port.postMessage({
            ok: false,
            error: { name: 'PrivateStateProxyMissing', message: `Unknown proxyId=${String(proxyId).slice(0, 16)}` }
        });
        port.close();
        return;
    }

    (async () => {
        try {
            const result = await dispatchPrivateStateMethod(provider, method, args as unknown[]);
            port.postMessage({ ok: true, result });
        } catch (err: any) {
            port.postMessage({
                ok: false,
                error: {
                    name: err?.name ?? 'Error',
                    message: formatErr(err)
                }
            });
        } finally {
            port.close();
        }
    })();
}

/** Explicit switch, not a duck-typed lookup: the worker may only call these methods. */
async function dispatchPrivateStateMethod(
    provider: CapDbPrivateStateProvider,
    method: string,
    args: unknown[]
): Promise<unknown> {
    switch (method) {
        case 'set': return provider.set(args[0] as string, args[1]);
        case 'get': return provider.get(args[0] as string);
        case 'remove': return provider.remove(args[0] as string);
        case 'clear': return provider.clear();
        case 'setSigningKey': return provider.setSigningKey(args[0] as string, args[1] as string);
        case 'getSigningKey': return provider.getSigningKey(args[0] as string);
        case 'removeSigningKey': return provider.removeSigningKey(args[0] as string);
        case 'clearSigningKeys': return provider.clearSigningKeys();
        default:
            throw new Error(`Unsupported private-state RPC method: '${method}'`);
    }
}

// ---- Typed RPC surface ----------------------------------------------------

export function walletInit(args: WalletInitArgs): Promise<{
    facadeReady: boolean;
    alreadyExisted: boolean;
    sdkVersion?: string;
}> {
    return rpc('init', args);
}

/** Prewarm sync gate: `timeoutMs` absolute ceiling, `stallMs` no-progress bound; first to fire wins. */
export function walletWaitForSyncedState(sessionId: string, timeoutMs?: number, stallMs?: number): Promise<{ synced: true }> {
    const workerBudgetMs = timeoutMs ?? 12 * 60 * 60 * 1000;
    return rpc('waitForSyncedState', { sessionId, timeoutMs, stallMs }, workerBudgetMs + 5 * 60 * 1000);
}

export async function walletEvict(sessionId: string): Promise<{ evicted: boolean; saved?: boolean }> {
    try {
        // The caller drops the session from the save registry on reply, so
        // the final save must be persisted first.
        return await rpc('evict', { sessionId, awaitSaveAck: true });
    } finally {
        syncProgressCache.delete(sessionId);
    }
}

/** CPU profile of the worker thread for `seconds` (1..120); summary back, raw file on disk. Admin diagnostic. */
export function walletCpuProfile(seconds: number, dir?: string): Promise<Record<string, unknown>> {
    const secs = Math.min(120, Math.max(1, Math.floor(Number(seconds) || 20)));
    return rpc('cpuProfile', { seconds: secs, dir }, (secs + 60) * 1000);
}

/**
 * Last pushed catch-up progress, or null. A cache read, never an RPC: the worker
 * is CPU-saturated during exactly the catch-up a caller observes.
 */
export function walletGetSyncProgress(sessionId: string): WalletSyncProgress | null {
    return syncProgressCache.get(sessionId) ?? null;
}

export interface WalletWorkerStatus {
    /** The worker has been started at least once in this process. */
    started: boolean;
    /** A worker thread is alive right now. */
    running: boolean;
    /** Calls waiting for an answer; a number that only grows is a stall. */
    inFlightRpcs: number;
    /** Worker exits since process start. Climbing means crash-looping. */
    exitCount: number;
    /** Controlled rotations (generation budget), not crashes. */
    rotationCount: number;
    lastExitCode: number | null;
    lastExitAt: string | null;
    rpcTimeoutMs: number;
    /** Facades that have reported catch-up progress, newest state per facade. */
    facades: Array<{ sessionId: string; label: string; caughtUp: boolean; updatedAt: string }>;
}

/** Process-level worker health; synchronous, so it answers while the worker cannot. */
export function getWalletWorkerStatus(): WalletWorkerStatus {
    return {
        started: everStarted,
        running: client !== null,
        inFlightRpcs: pendingRpcs.size,
        exitCount: workerExitCount,
        rotationCount: workerRotationCount,
        lastExitCode,
        lastExitAt,
        rpcTimeoutMs: RPC_TIMEOUT_MS,
        facades: [...syncProgressCache.values()].map(p => ({
            sessionId: p.sessionId,
            label: p.label,
            caughtUp: p.caughtUp,
            updatedAt: p.updatedAt
        }))
    };
}

/** NIGHT-UTXO registration for DUST generation. `syncTimeoutMs` 0 or omitted waits indefinitely. */
export function walletRegisterDustGeneration(args: {
    sessionId: string;
    dustReceiverAddress?: string;
    syncTimeoutMs?: number;
}, onSubmitIntent?: SubmitIntentHook): Promise<RegisterDustGenerationOutcome> {
    return rpc('registerDustGeneration', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

export interface RegisterDustGenerationOutcome {
    /** Null when nothing was registered. */
    txId: string | null;
    changed: boolean;
    reason: 'already-registered' | 'no-night-utxos' | null;
    registeredCount: number;
    /** All NIGHT UTXOs of the wallet, registered or not, at the time of the call. */
    totalNightUtxos: number;
    /** The applied receiver; null when nothing was registered. */
    dustReceiverAddress: string | null;
    /** The receiver the call asked for (derived or supplied), applied or not. */
    requestedReceiver: string;
    registeredUtxosBefore: number;
    /** Registered NIGHT UTXOs once the tx applied locally; null when not observed within the settle window. */
    registeredUtxosAfter: number | null;
    /** Whether the resulting count was observed (NIGHTGATE_DUST_REGISTER_SETTLE_MS). */
    settled: boolean;
    /** Whether the registration consolidated inputs (fewer registered UTXOs than inputs); null when unobserved. */
    consolidated: boolean | null;
    message: string;
}

/** Deregisters ALL registered NIGHT UTXOs. */
export function walletDeregisterDustGeneration(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Fee sponsor facade (accountId), for a wallet whose generation is delegated away (own dust 0). */
    sponsorSessionId?: string;
}, onSubmitIntent?: SubmitIntentHook): Promise<{
    txId: string | null;
    deregisteredCount: number;
    totalNightUtxos: number;
}> {
    return rpc('deregisterDustGeneration', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Send NIGHT (or `tokenTypeHex`); ledger from the receiver prefix, `amount` in atoms as a decimal string. */
export function walletTransferNight(args: {
    sessionId: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to send instead of NIGHT. */
    tokenTypeHex?: string;
}, onSubmitIntent?: SubmitIntentHook): Promise<{
    txId: string;
    toLedger: 'shielded' | 'unshielded';
    amount: string;
    receiverAddress: string;
}> {
    return rpc('transferNight', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Read-only balance snapshot; amounts as decimal strings. */
export function walletGetBalance(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Bounds the RPC itself, so a monitor polling a stuck worker does not pile up pending calls. */
    rpcTimeoutMs?: number;
}): Promise<{
    shieldedNight: string;
    unshieldedNight: string;
    /** Every other shielded token type with a balance: raw 64-hex type, atoms. */
    shieldedTokens: Array<{ tokenType: string; amount: string }>;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
    dustUtxoCount: number;
    dustPendingCount: number;
    dustPendingValue: string;
    dustRestoreCount: number;
}> {
    const { rpcTimeoutMs, ...rest } = args;
    return rpc('getBalance', rest, rpcTimeoutMs);
}

/** Fee estimate for `walletTransferNight` (no proof, no submit); dust atoms as decimal string. */
export function walletEstimateTransferFee(args: {
    sessionId: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
    tokenTypeHex?: string;
}): Promise<{ fee: string; toLedger: 'shielded' | 'unshielded' }> {
    return rpc('estimateTransferFee', args);
}

// ---- Contract deploy / call -----------------------------------------------

export interface WorkerContractRegistration {
    artifactPath: string;
    /** Generation digest (module + verifier keys); the worker keys its module cache by it. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath: string;
    /** Content-tree width of a vault-family artifact (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
}

export interface WalletDeployContractArgs {
    sessionId: string;
    proxyId: string;
    contractName: string;
    registration: WorkerContractRegistration;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    /** User-supplied private state for the new contract. Plain JSON-able value. */
    initialPrivateState: unknown;
    sponsorSessionId?: string;
    /** Vault family: the recovery identity (64 hex) passed to the constructor; absent = none. */
    recoveryId?: string;
}

export interface WalletSubmitContractCallArgs {
    sessionId: string;
    proxyId: string;
    contractName: string;
    registration: WorkerContractRegistration;
    contractAddress: string;
    circuit: string;
    args: unknown[];
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    merkleProof?: MerkleProofBundle;
    initialPrivateState?: unknown;
    sponsorSessionId?: string;
}

/** Deploy a contract; private state round-trips to the provider registered under `proxyId`. */
export function walletDeployContract(args: WalletDeployContractArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    contractAddress: string;
    onChainStatus: string;
}> {
    return rpc('deployContract', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Invoke a circuit on a deployed contract; wired like `walletDeployContract`. */
export function walletSubmitContractCall(args: WalletSubmitContractCallArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    onChainStatus: string;
}> {
    return rpc('submitContractCall', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Build, sign and finalize a call under the caller's identity, fee unpaid, not submitted. */
export function walletBuildSponsorableTx(
    args: Omit<WalletSubmitContractCallArgs, 'sponsorSessionId'>
): Promise<{ finalizedTxB64: string; serializedBytes: number }> {
    return rpc('buildSponsorableTx', args);
}

/** Pay dust for a caller-finalized tx with the sponsor session and submit, after the policy check. */
export function walletSponsorFinalizedTx(args: {
    sponsorSessionId: string;
    finalizedTxB64: string;
    networkId: WalletSubmitContractCallArgs['networkId'];
    allowedContracts?: string[];
    allowedCircuits?: string[];
    /** Floor and grant both allow a sponsored ContractDeploy in this transaction. */
    allowDeploy?: boolean;
    /** Addresses deployed under the requesting grant: calls on them skip `allowedCircuits`. */
    ownContracts?: string[];
    /** Raw shielded token types whose zswap offers the sponsor pays for (floor ∩ grant); absent = no offers. */
    allowedTokenTypes?: string[];
}, onSubmitIntent?: SubmitIntentHook): Promise<{ txHash: string; circuits: string[]; contractAddress: string; deployed?: string[] }> {
    return rpc('sponsorFinalizedTx', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

export interface WalletSubmitContractCallBatchArgs extends Omit<WalletSubmitContractCallArgs, 'circuit' | 'args'> {
    /** Ordered calls in ONE transaction; a per-call `merkleProof` excludes the batch-level one. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    /** The calls past `orderedPrefix` share no state: the worker groups them by execution stage before proving. */
    independentCalls?: boolean;
    orderedPrefix?: number;
}

/** Several circuits on one contract as a single transaction. */
export function walletSubmitContractCallBatch(args: WalletSubmitContractCallBatchArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    onChainStatus: string;
    circuits: string[];
}> {
    return rpc('submitContractCallBatch', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Test-only: reset the singleton so subsequent calls re-spawn. */
export function __resetWalletWorkerForTests(): void {
    client = null;
    everStarted = false;
    stateSaveSink = undefined;
    pendingRpcs.clear();
    privateStateProviders.clear();
    workerExitCount = 0;
    lastExitCode = null;
    lastExitAt = null;
    workerRotationCount = 0;
    rotationAnnounced = false;
    drainingWorker = null;
    stoppingWorker = null;
}

/** Parallel sponsoring: the sponsor merges dust from a locked note into an unbound caller tx and binds. */
export function walletSponsorUnboundTx(args: {
    sponsorSessionId: string;
    unboundTxB64: string;
    networkId: WalletSubmitContractCallArgs['networkId'];
    allowedContracts?: string[];
    allowedCircuits?: string[];
    /** Floor and grant both allow a sponsored ContractDeploy in this transaction. */
    allowDeploy?: boolean;
    /** Addresses deployed under the requesting grant: calls on them skip `allowedCircuits`. */
    ownContracts?: string[];
    /** Raw shielded token types whose zswap offers the sponsor pays for (floor ∩ grant); absent = no offers. */
    allowedTokenTypes?: string[];
}, onSubmitIntent?: SubmitIntentHook): Promise<{ txHash: string; circuits: string[]; contractAddress: string; note: string; deployed?: string[] }> {
    return rpc('sponsorUnboundTx', args, RPC_TIMEOUT_MS, onSubmitIntent);
}
