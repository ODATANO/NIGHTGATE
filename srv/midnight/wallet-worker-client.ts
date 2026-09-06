/**
 * Main-thread side of the wallet-worker RPC.
 *
 * Spawns ONE Node `worker_threads` worker, holds a handle for the lifetime of
 * the cds-serve process, and exposes a typed async API that maps to the
 * worker's message handlers.
 *
 * RPC shape: per-call `MessageChannel`. We send `{ kind: 'rpc', method, args,
 * port: port1 }` (transferring port1's MessagePort to the worker), then await
 * a single message on `port2` carrying `{ ok, result | error }`.
 *
 * Push events from the worker (`state-save` and `log`) are handled by
 * listeners registered via `setStateSaveSink(...)` and the default log relay.
 * The save sink is where we wire CAP `db.run` from the main thread (which is
 * NOT blocked by the wallet SDK because the SDK now lives in the worker).
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
    /** Save sequence number; echoed back to the worker as `state-save-ack`
     *  when (and only when) the sink persisted successfully. */
    seq?: number;
    blobs: SerializedBlobs;
}) => void | Promise<void>;

/**
 * A catch-up progress snapshot as the worker reports it. Mirrors
 * `SyncProgressSnapshot` in wallet-worker.ts; declared here rather than
 * imported so the main thread does not pull in the worker module (which loads
 * the ESM SDK on import).
 */
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
    /** When appliedIndex last advanced; absent from snapshots of a pre-0.21 worker. */
    lastProgressAt?: string;
}

// Latest pushed snapshot per facade. Module scope (not ClientState) because
// its lifecycle is per-facade, not per-worker-start: entries are replaced by
// the next push, dropped on evict, and cleared wholesale on worker exit (no
// facade survives one).
const syncProgressCache = new Map<string, WalletSyncProgress>();

interface ClientState {
    worker: Worker;
    readyPromise: Promise<void>;
}

let client: ClientState | null = null;

// True once the worker has been started at least once. Lets rpc() distinguish
// "never started" (reject: caller must startWalletWorker() first) from "crashed
// after a successful start" (respawn). Cleared on explicit stop/reset.
let everStarted = false;

// Worker exits since process start, for getWorkerStatus()/metrics. A climbing
// count is the signal that the submission side is crash-looping, which is
// otherwise only visible as individual jobs failing.
let workerExitCount = 0;
let lastExitCode: number | null = null;
let lastExitAt: string | null = null;
// Controlled rotations (the worker exits after NIGHTGATE_WORKER_MAX_GENERATIONS
// artifact generations to release Node's module cache), counted apart from crashes.
let workerRotationCount = 0;
let rotationAnnounced = false;
// Worker that announced its rotation and has not exited yet; new calls wait
// for its exit and go to the respawned worker.
let drainingWorker: Worker | null = null;
// Worker being stopped on purpose (stopWalletWorker): its exit is neither a
// crash nor a rotation.
let stoppingWorker: Worker | null = null;

/**
 * Ceiling on a rotation drain (`NIGHTGATE_WORKER_DRAIN_MAX_MS`, default 10
 * min). A drain waits for in-flight submits only; past the ceiling the worker
 * is terminated: every submit announced its identifier before sending, so
 * reconciliation resolves whatever was cut.
 */
function drainMaxMs(): number {
    return configMs('NIGHTGATE_WORKER_DRAIN_MAX_MS');
}

// Kept at module scope (not on ClientState) so it survives a worker respawn:
// the sink is wired once at startup and must keep persisting state-save events
// even from a freshly respawned worker.
let stateSaveSink: StateSaveSink | undefined;

// Serializes state-save persists in arrival order (each handler settles, so
// the chain never rejects and a failed persist doesn't block later ones).
/**
 * Worker thread heap sizing. Only the young generation is set; the old
 * generation keeps the limit NODE_OPTIONS gives the process (measured: a
 * worker with `maxYoungGenerationSizeMb` alone still reports the inherited
 * 8 GB `heap_size_limit`). `NIGHTGATE_WORKER_YOUNG_GEN_MB`: default 128,
 * `0` = V8 default (16 MB semi-spaces), clamped to 16..2048.
 */
export function workerResourceLimits(env: NodeJS.ProcessEnv = process.env): { maxYoungGenerationSizeMb: number } | undefined {
    const n = configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', env);
    if (n <= 0) return undefined;
    return { maxYoungGenerationSizeMb: Math.max(16, n) };
}

let stateSaveChain: Promise<void> = Promise.resolve();

// In-flight rpc rejectors, so a worker crash/exit rejects every pending call
// instead of leaving it to hang forever on a port that will never reply.
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

// Backstop timeout for a single worker RPC.
const RPC_TIMEOUT_MS = configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS');

/**
 * Per-submission private-state provider registry (Phase 2b).
 *
 * The worker proxies the SDK's PrivateStateProvider hook back to the main
 * thread via `private-state-rpc` messages, where the real
 * CapDbPrivateStateProvider (CAP DB + encryption) lives. Each in-flight
 * submission registers under a fresh `proxyId` so concurrent deploy/call
 * invocations don't collide on a shared `currentContractAddress`.
 */
const privateStateProviders = new Map<string, CapDbPrivateStateProvider>();

export function registerPrivateStateProvider(proxyId: string, provider: CapDbPrivateStateProvider): void {
    privateStateProviders.set(proxyId, provider);
}

export function unregisterPrivateStateProvider(proxyId: string): void {
    privateStateProviders.delete(proxyId);
}

/**
 * Locate the compiled worker entry: tsc emits `wallet-worker.js` next to this
 * compiled client (build:plugin writes JS in-place, so it's there in dev too).
 * Use __dirname so we don't depend on cwd.
 */
function resolveWorkerEntry(): string {
    return path.join(__dirname, 'wallet-worker.js');
}

/**
 * Start the worker. Idempotent: a second call returns the existing client.
 * Resolves when the worker has emitted its `ready` message.
 */
export async function startWalletWorker(): Promise<void> {
    if (client) {
        await client.readyPromise;
        return;
    }

    everStarted = true;
    const entry = resolveWorkerEntry();
    const worker = new Worker(entry, {
        // The worker never parses ENCRYPTION_KEY* itself: it receives the
        // resolved key ring (sync-state blob binding) from the main thread.
        // The worker never parses NIGHTGATE_* or ENCRYPTION_KEY* itself: it
        // receives the resolved configuration and key ring from the main thread.
        workerData: { encryptionKeyRing: getEncryptionKey().toSpec() ?? null, config: resolvedConfigSnapshot() },
        // Old-generation limit is inherited from NODE_OPTIONS (wallet SDK
        // heap) whether or not resourceLimits is given. The YOUNG generation
        // is sized explicitly (0.21.6): every save tick serializes multi-MB
        // wallet blobs, and with the default 16 MB semi-space the worker
        // spent ~40 % of its time in scavenges (~180 ms each) on the hosted
        // pool. NIGHTGATE_WORKER_YOUNG_GEN_MB, default 128, 0 = V8 default.
        resourceLimits: workerResourceLimits(),
        // stdout/stderr from the worker should surface to the main process.
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

    // Push events from worker (state-save, log, private-state-rpc)
    worker.on('message', (msg: any) => {
        if (msg?.kind === 'state-save') {
            // Ack ONLY when the sink persisted successfully. Persists are
            // CHAINED so they commit in arrival order: the sink is async, and
            // two in-flight saves for the same session could otherwise land
            // out of order in the DB. The dust-restore push (wallet-worker's
            // dust wedge protection) relies on last-sent-wins.
            stateSaveChain = stateSaveChain
                .then(() => {
                    // No sink = nothing persisted = no ack; the worker keeps
                    // the blobs unconfirmed and re-pushes them. Acking here
                    // would silently drop a save.
                    if (!stateSaveSink) throw new Error('no state-save sink wired');
                    return stateSaveSink(msg);
                })
                .then(() => {
                    if (msg.seq != null) worker.postMessage({ kind: 'state-save-ack', sessionId: msg.sessionId, seq: msg.seq });
                })
                .catch(() => { /* no ack; sink already logged the failure */ });
        } else if (msg?.kind === 'log') {
            // Worker runs in a worker_thread without CAP; surface its log lines
            // through a CAP channel so consumers control verbosity
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
            // Nothing submitting is in flight any more; every reply the worker
            // posted before this message has been delivered. Terminate it here
            // rather than letting it exit itself mid-reply.
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
        // No facade survived the exit, so no snapshot describes anything that
        // is still running. Keeping them would report phantom catch-ups.
        syncProgressCache.clear();
        // A crash cannot be waited on: the worker is already gone, so a
        // listener may only keep what queued work still needs.
        void notifyWorkerGone('exit');
        // Fail every in-flight call now; their reply ports are dead and would
        // otherwise never settle. The next rpc() lazily respawns the worker.
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
 * Stop the worker. Safe to call multiple times. First asks the worker to
 * evict every facade (final state save, acked by the sink, keys zeroed),
 * bounded by `timeoutMs`; then terminates it. The flush needs the save sink
 * still wired, so callers run this BEFORE dropping encryption keys.
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
            // A rotating worker flushes its facades itself and asks to be
            // terminated (rotation-done); wait for that instead of cutting it.
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
    // Terminate (the flush is done or timed out; nothing else keeps the thread).
    try { await w.terminate(); } catch { }
    // The exit handler normally does this, but a forced terminate after
    // the timeout must not leave the main thread believing in facades.
    syncProgressCache.clear();
    // Intentional teardown, so listeners may finish their work and release
    // everything; this is the only path that can wait for them.
    await notifyWorkerGone('stop');
}

/**
 * Callbacks to run when the worker is gone, on crash or on intentional stop.
 *
 * Anything the MAIN thread believes about facades is wrong from that moment:
 * a facade lives inside the worker, so a crash takes every one of them with
 * it. Without this the main-thread registry kept reporting facades a
 * respawned, empty worker does not have, which makes `facadeCount` a lie and
 * lets a "is it warm?" guard wave a cold wallet through.
 */
/**
 * `'exit'` is a crash: the worker is already gone, so nothing can be finished
 * off and a listener may only keep what still-queued work needs. `'stop'` is
 * an intentional teardown, where the caller CAN wait, so a listener may drain
 * and then release everything, including material a crash path has to hold on
 * to. Same event, opposite obligations.
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

/**
 * Register the callback that receives push 'state-save' events from the
 * worker. Called by the persistence layer at startup.
 */
export function setStateSaveSink(sink: StateSaveSink | undefined): void {
    if (!client) {
        throw new Error('wallet-worker not started; call startWalletWorker() first');
    }
    stateSaveSink = sink;
}

/**
 * Generic RPC helper. Allocates a MessageChannel per call, posts the request
 * with port1 transferred to the worker, awaits the single reply on port2.
 */
/**
 * Optional per-call hook: the worker announces the transaction identifier it
 * is ABOUT to broadcast (`submit-intent`) and waits for the ack. The hook
 * persists the external-effect boundary (job row: txHash + external_execution
 * + submitted) before the broadcast happens; if it throws, the worker does not
 * broadcast.
 */
export interface SubmitIntentInfo { txHash: string; contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[] }
export type SubmitIntentHook = (txHash: string, intent: SubmitIntentInfo) => Promise<void>;

async function rpc<T>(method: string, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    // A rotating worker takes no new work: wait for its exit, then call the
    // respawned worker. A WORKER_ROTATING refusal is retried once the same way,
    // and so is a read or wait the rotation exit cut off (WORKER_ROTATED); a
    // submitting call is never repeated (its identifier was announced; the
    // job reconciles it).
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
        let pending: PendingRpc;
        let timer: ReturnType<typeof setTimeout>;
        const settle = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pendingRpcs.delete(pending);
            port2.close();
        };
        // Stored reject is the guarded one, so a worker-exit sweep and the
        // timeout can't double-settle or leak the port/timer.
        pending = { reject: (e: Error) => { if (!settled) { settle(); reject(e); } } };
        pendingRpcs.add(pending);
        timer = setTimeout(
            () => pending.reject(new Error(`wallet-worker rpc '${method}' timed out after ${timeoutMs}ms`)),
            timeoutMs
        );

        port2.on('message', (msg: any) => {
            if (settled) return;
            if (msg?.kind === 'submit-intent') {
                // Intermediate message, not the reply: persist the boundary,
                // then ack (or nack) so the worker broadcasts (or does not).
                const intent: SubmitIntentInfo = { txHash: String(msg.txHash), contractAddress: msg.contractAddress, circuits: msg.circuits, note: msg.note, sponsorAccountId: msg.sponsorAccountId, ...(Array.isArray(msg.deployed) ? { deployed: msg.deployed.map(String) } : {}) };
                Promise.resolve()
                    .then(() => onSubmitIntent?.(intent.txHash, intent))
                    .then(() => port2.postMessage({ kind: 'submit-intent-ack', txHash: msg.txHash, ok: true }))
                    .catch((e) => port2.postMessage({ kind: 'submit-intent-ack', txHash: msg.txHash, ok: false, error: String((e as Error)?.message ?? e) }));
                return;
            }
            settle();
            if (msg?.ok) {
                resolve(msg.result as T);
                return;
            }
            const payload = msg?.error;
            if (payload && typeof payload === 'object' && typeof payload.message === 'string') {
                // A classified failure (submitting methods) keeps its code,
                // ledger code, retryability, batch stages and cause chain as
                // data; the main thread never re-derives them from the text.
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
        port2.once('messageerror', err => {
            if (settled) return;
            settle();
            reject(err as Error);
        });
        worker.postMessage(
            { kind: 'rpc', method, args, port: port1 },
            [port1] // transfer ownership of port1
        );
    });
}

/**
 * Handle a `private-state-rpc` message from the worker.
 *
 * - `setContractAddress` is fire-and-forget (worker sends no `port`). The SDK
 *   contract is synchronous; ordering on parentPort guarantees the next
 *   async set/get arrives AFTER the address has been applied here.
 * - All other methods reply on the supplied MessagePort.
 */
function dispatchPrivateStateRpc(msg: any): void {
    const { proxyId, method, args, port } = msg;
    const provider = privateStateProviders.get(proxyId);

    if (method === 'setContractAddress') {
        // No port: set synchronously, log on error.
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

/**
 * Type-safe dispatch into CapDbPrivateStateProvider for the 8 async methods
 * the SDK uses. A `switch` over the known method names lets TypeScript check
 * each call signature; the worker can only request methods we explicitly
 * support, and an unknown name produces a stable error rather than a runtime
 * "fn is not a function" from a duck-typed lookup.
 */
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

/**
 * Prewarm sync gate. `timeoutMs` is the absolute ceiling, `stallMs` the
 * no-progress bound (the worker's env default when omitted); the wait fails
 * on whichever fires first and its message says which.
 */
export function walletWaitForSyncedState(sessionId: string, timeoutMs?: number, stallMs?: number): Promise<{ synced: true }> {
    const workerBudgetMs = timeoutMs ?? 12 * 60 * 60 * 1000;
    return rpc('waitForSyncedState', { sessionId, timeoutMs, stallMs }, workerBudgetMs + 5 * 60 * 1000);
}

export async function walletEvict(sessionId: string): Promise<{ evicted: boolean; saved?: boolean }> {
    try {
        // awaitSaveAck: the reply lets the caller drop the session from the
        // save registry, so the worker's final save must be persisted first.
        return await rpc('evict', { sessionId, awaitSaveAck: true });
    } finally {
        // The facade is gone either way; a surviving snapshot would report a
        // catch-up that nothing is running any more.
        syncProgressCache.delete(sessionId);
    }
}

/**
 * Last catch-up progress the worker reported for a facade, or null when it has
 * never reported one (no sync wait ran yet, or the worker restarted).
 *
 * Synchronous main-thread cache read, deliberately: the worker pushes these
 * snapshots because it is CPU-saturated during exactly the catch-up a caller
 * wants to observe, so asking it would be slow or time out. `updatedAt` says
 * how fresh the answer is; a snapshot that stops advancing while `elapsedMs`
 * grows is the signature of a genuine stall.
 */
/** CPU profile of the worker thread for `seconds` (1..120); summary back, raw file on disk. Admin diagnostic. */
export function walletCpuProfile(seconds: number, dir?: string): Promise<Record<string, unknown>> {
    const secs = Math.min(120, Math.max(1, Math.floor(Number(seconds) || 20)));
    return rpc('cpuProfile', { seconds: secs, dir }, (secs + 60) * 1000);
}

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

/**
 * Worker health at PROCESS level, as opposed to `walletGetSyncProgress`, which
 * answers per facade. When the worker is wedged every session looks
 * individually slow and nothing says why; this says why.
 *
 * Synchronous and main-thread only: it reads state the client already keeps,
 * so it stays answerable exactly when the worker cannot answer anything.
 */
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

/**
 * End-to-end NIGHT-UTXO registration for DUST generation.
 * Single RPC that wraps wait-sync → filter → register → finalize → submit.
 * `syncTimeoutMs: 0` (or omitted) waits indefinitely for sync; provide a
 * positive number to bound the wait for tests.
 */
export function walletRegisterDustGeneration(args: {
    sessionId: string;
    dustReceiverAddress?: string;
    syncTimeoutMs?: number;
}, onSubmitIntent?: SubmitIntentHook): Promise<RegisterDustGenerationOutcome> {
    return rpc('registerDustGeneration', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Outcome of `registerDustGeneration` (0.21.0). */
export interface RegisterDustGenerationOutcome {
    /** Transaction ID of the registration submission; null when nothing was registered. */
    txId: string | null;
    /** Whether a registration was submitted. */
    changed: boolean;
    /** Why nothing changed: 'already-registered' | 'no-night-utxos'; null when changed. */
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

/**
 * Symmetric pair to `walletRegisterDustGeneration`. Deregisters all
 * registered NIGHT UTXOs so they become spendable. Per-UTXO narrowing
 * is a follow-up; today this is all-or-nothing.
 */
export function walletDeregisterDustGeneration(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /**
     * Optional fee sponsor (facade key, i.e. accountId): that facade balances
     * the deregistration fee from ITS dust and submits. Escape hatch for a
     * wallet whose whole generation is delegated away (own dust stays 0).
     */
    sponsorSessionId?: string;
}, onSubmitIntent?: SubmitIntentHook): Promise<{
    txId: string | null;
    deregisteredCount: number;
    totalNightUtxos: number;
}> {
    return rpc('deregisterDustGeneration', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/**
 * Send NIGHT to any Midnight address. Ledger is auto-detected from the
 * receiver's Bech32m prefix (mn_shield-addr_ vs mn_addr_).
 *
 * Amount is a decimal string parseable as bigint (NIGHT atoms); strings
 * avoid the precision pitfalls of JS Number when atom counts exceed 2^53.
 */
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

/**
 * Snapshot of the wallet's balances. Read-only: no transaction is
 * built or submitted. All amounts are decimal-string bigint to avoid
 * Number precision loss.
 */
export function walletGetBalance(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /**
     * Bound for the WORKER RPC itself, not just the caller's wait. Without it
     * an abandoned read keeps its pendingRpcs entry until the 30-minute
     * backstop, so a monitor polling a stuck worker piles up entries. The
     * worker still finishes whatever it started, but the client side settles
     * and the backlog cannot grow.
     */
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

/**
 * Pre-flight fee estimate for `walletTransferNight`. Builds the recipe
 * but does NOT finalize (no proof generation) or submit. Returns dust
 * atoms as decimal string.
 */
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

// ---- Phase 2b: contract deploy / call -------------------------------------

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

/**
 * Deploy a Compact-emitted contract through the wallet worker. The worker
 * owns the SDK and the wallet facade; private-state CRUD round-trips back to
 * the main-side provider registered under `proxyId`.
 */
export function walletDeployContract(args: WalletDeployContractArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    contractAddress: string;
    onChainStatus: string;
}> {
    return rpc('deployContract', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/**
 * Invoke a circuit on a deployed contract through the worker. Same wiring as
 * `walletDeployContract`. Returns the submission txHash + on-chain status.
 */
export function walletSubmitContractCall(args: WalletSubmitContractCallArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    onChainStatus: string;
}> {
    return rpc('submitContractCall', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/**
 * Cross-server sponsoring PHASE 1 (0.17.0): build + sign + finalize a contract
 * call under the CALLER's identity and return the fee-unpaid finalized tx as
 * base64, without submitting. A remote sponsor pays dust and submits.
 */
export function walletBuildSponsorableTx(
    args: Omit<WalletSubmitContractCallArgs, 'sponsorSessionId'>
): Promise<{ finalizedTxB64: string; serializedBytes: number }> {
    return rpc('buildSponsorableTx', args);
}

/**
 * Cross-server sponsoring PHASE 2 (0.17.0): balance dust onto a caller-finalized
 * tx (base64) with the sponsor session and submit, after an allow-list policy
 * check. The attestation stays the caller's; the sponsor only pays.
 */
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
    /** Ordered circuit calls, all executed inside ONE transaction scope. A
     *  call may carry its own `merkleProof` (per-call witness binding for
     *  proveFieldPredicate); mutually exclusive with the batch-level
     *  `merkleProof` inherited from WalletSubmitContractCallArgs. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    /** The calls past `orderedPrefix` share no state: the worker groups them by execution stage before proving. */
    independentCalls?: boolean;
    orderedPrefix?: number;
}

/**
 * Invoke SEVERAL circuits on one deployed contract as a SINGLE transaction
 * (the worker batches them via the SDK's withContractScopedTransaction).
 * Returns the one submission txHash + on-chain status for the whole batch.
 */
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

/**
 * 0.18 PARALLEL sponsoring (dust-note-pool): submit an UNBOUND caller tx, the
 * sponsor merges dust from a locked note and binds. Keyed by the sponsor
 * account like walletSponsorFinalizedTx.
 */
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
