/**
 * Main-thread side of the wallet worker. One worker per process, one message channel per call.
 */

import cds from '@sap/cds';
import { Worker, MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import type { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';
import type { MerkleProofBundle } from '../submission/contract-witnesses';
import { errorName, formatErr } from '../utils/format-error';
import { nightgateErrorFromPayload, errorMessage } from '../utils/errors';
import { isSubmittingMethod, WORKER_ROTATING, WORKER_ROTATED, WorkerSubmitError, isSubmitFailureCode } from './wallet-worker-protocol';
import { getEncryptionKey } from '../utils/crypto';
import { configMs, configNumberFrom, resolvedConfigSnapshot } from '../utils/config';
import { recordDustCollapseSample, forgetDustCollapseStats, type DustCollapseSample } from './dust-collapse-stats';
import type { profileWorker } from '#cds-models/NightgateAdminService';

const log = cds.log('nightgate:worker-client');

export interface WalletInitArgs {
    sessionId: string;
    seedHex: string;
    /** BIP32 account index the seed signs with. Default 0. */
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
    /** Sent back as `state-save-ack` only after the save was stored. */
    seq?: number;
    blobs: SerializedBlobs;
}) => void | Promise<void>;

/** Copy of the worker's `SyncProgressSnapshot`. Importing it would load the ESM SDK. */
export interface WalletSyncProgress {
    sessionId: string;
    /** Dust ledger events applied so far. Decimal string. */
    appliedIndex: string;
    /** Latest dust ledger event on the chain. Decimal string, '-1' when unknown. */
    streamTip: string;
    behindEvents: string | null;
    eventsPerSecond: number | null;
    etaSeconds: number | null;
    blockHeight: string | null;
    isConnected: boolean;
    indexerFresh: boolean;
    indexerTipAgeMs?: number | null;
    indexerError?: string | null;
    caughtUp: boolean;
    elapsedMs: number;
    label: string;
    updatedAt: string;
    lastProgressAt?: string;
    dust?: {
        balance: string;
        availableNotes: number;
        pendingNotes: number;
        restoreCount: number;
        registeredNightUtxos: number;
        totalNightUtxos: number;
        at: string;
    };
}

const syncProgressCache = new Map<string, WalletSyncProgress>();

interface ClientState {
    worker: Worker;
    readyPromise: Promise<void>;
}

let client: ClientState | null = null;

// Tells "never started" (calls fail) apart from "crashed" (the next call restarts the worker).
let everStarted = false;

// Counts crashes only. Planned restarts and stops are counted separately.
let workerExitCount = 0;
let lastExitCode: number | null = null;
let lastExitAt: string | null = null;
let workerRotationCount = 0;
/** The worker that announced a planned restart. Only its exit counts as one. */
let rotationAnnouncedBy: Worker | null = null;
// Announced a planned restart but not exited yet. New calls wait for the new worker.
let drainingWorker: Worker | null = null;
// Stopped on purpose. Its exit is neither a crash nor a planned restart.
let stoppingWorker: Worker | null = null;

/**
 * How long a planned restart waits for running calls. Killing the worker after that is safe,
 * because every submit reported its tx id before sending, so it can still be looked up.
 */
function drainMaxMs(): number {
    return configMs('NIGHTGATE_WORKER_DRAIN_MAX_MS');
}

// Kept here so it survives a worker restart.
let stateSaveSink: StateSaveSink | undefined;

/**
 * Sets only the young generation, because saving wallet state creates large short-lived buffers.
 * 0 keeps the V8 default.
 */
export function workerResourceLimits(env: NodeJS.ProcessEnv = process.env): { maxYoungGenerationSizeMb: number } | undefined {
    const n = configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', env);
    if (n <= 0) return undefined;
    return { maxYoungGenerationSizeMb: Math.max(16, n) };
}

// Stores saves one after another in arrival order. A failed save does not block later ones.
let stateSaveChain: Promise<void> = Promise.resolve();

// A worker exit rejects these, because their ports would never reply.
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
const INTENT_PERSIST_WARN_MS = 5_000;

/**
 * One private state provider per submission, so concurrent calls never share the current contract address.
 */
const privateStateProviders = new Map<string, CapDbPrivateStateProvider>();

export function registerPrivateStateProvider(proxyId: string, provider: CapDbPrivateStateProvider): void {
    privateStateProviders.set(proxyId, provider);
}

export function unregisterPrivateStateProvider(proxyId: string): void {
    privateStateProviders.delete(proxyId);
}

function resolveWorkerEntry(): string {
    return path.join(__dirname, 'wallet-worker.js');
}

export async function startWalletWorker(): Promise<void> {
    if (client) {
        await client.readyPromise;
        return;
    }

    everStarted = true;
    const entry = resolveWorkerEntry();
    const worker = new Worker(entry, {
        // The worker gets its config from here and never reads the environment.
        workerData: { encryptionKeyRing: getEncryptionKey().toSpec() ?? null, config: resolvedConfigSnapshot() },
        resourceLimits: workerResourceLimits(),
        // false sends worker output to the main process streams.
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
            // Ack only a stored save. Saves are stored in arrival order,
            // because a restored dust state relies on the last save winning.
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
            const level = msg.level === 'warn' ? 'warn'
                : msg.level === 'error' ? 'error'
                    : msg.level === 'debug' ? 'debug'
                        : 'info';
            (cds.log('nightgate:worker') as any)[level](msg.message);
        } else if (msg?.kind === 'sync-progress') {
            if (msg.sessionId && msg.snapshot) {
                const snapshot = msg.snapshot as WalletSyncProgress;
                // Catch-up pushes carry no dust figures, so keep the previous ones.
                const previousDust = syncProgressCache.get(msg.sessionId)?.dust;
                if (!snapshot.dust && previousDust) snapshot.dust = previousDust;
                syncProgressCache.set(msg.sessionId, snapshot);
            }
        } else if (msg?.kind === 'save-stats') {
            if (msg.sessionId && msg.dust) recordDustCollapseSample(msg.sessionId, msg.dust as DustCollapseSample);
        } else if (msg?.kind === 'private-state-rpc') {
            dispatchPrivateStateRpc(msg);
        } else if (msg?.kind === 'rotating') {
            rotationAnnouncedBy = worker;
            drainingWorker = worker;
            log.info(`worker announced its rotation (${msg.generations} artifact generations, ${msg.inflight ?? 0} call(s) draining); new calls wait for the respawn`);
        } else if (msg?.kind === 'rotation-done') {
            // Terminated from here so the worker never exits while it is still replying.
            rotationAnnouncedBy = worker;
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
        // A newer worker may already run. The old worker's late exit must not clear it.
        if (client?.worker === worker) client = null;
        if (drainingWorker === worker) drainingWorker = null;
        const stopped = stoppingWorker === worker;
        const rotated = !stopped && rotationAnnouncedBy === worker;
        if (rotationAnnouncedBy === worker) rotationAnnouncedBy = null;
        if (stopped) {
            stoppingWorker = null;
            log.info(`worker stopped (code=${code})`);
        } else if (rotated) {
            workerRotationCount += 1;
            log.info(`worker rotated (controlled exit after its generation budget); the next call respawns it`);
        } else {
            log.warn(`worker exited code=${code}`);
            workerExitCount += 1;
            lastExitCode = code;
            lastExitAt = new Date().toISOString();
        }
        syncProgressCache.clear();
        void notifyWorkerGone('exit');
        // Named so rpc() can retry a read on the new worker.
        rejectAllPendingRpcs(
            rotated ? `wallet-worker rotated with in-flight calls` : `wallet-worker exited (code=${code}) with in-flight calls`,
            rotated ? WORKER_ROTATED : undefined
        );
    });

    await readyPromise;
    log.info('worker ready');
}

/**
 * Unloads every wallet after its final save is confirmed, then stops the worker.
 * Call this before dropping the encryption keys, because saving needs them.
 */
export async function stopWalletWorker(timeoutMs = 60_000): Promise<void> {
    if (!client) return;
    const w = client.worker;
    // A later call must not restart a worker that was stopped on purpose.
    everStarted = false;
    try {
        const r = await rpcOnce<{ evicted: number; failed: number }>('shutdown', {}, timeoutMs);
        if (r.failed > 0) log.error(`worker shutdown: ${r.evicted} facade(s) evicted, ${r.failed} WITHOUT a confirmed final save`);
        else log.info(`worker shutdown: ${r.evicted} facade(s) evicted, all saves confirmed`);
    } catch (err) {
        if ((err as Error)?.name === WORKER_ROTATING) {
            // A restarting worker saves its wallets itself, so wait for its exit.
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
    if (client?.worker !== w) return; // replaced or already gone
    client = null;
    stoppingWorker = w;
    try { await w.terminate(); } catch { /* already exited */ }
    // A forced terminate may skip the exit handler, so clear here too.
    syncProgressCache.clear();
    await notifyWorkerGone('stop');
}

/**
 * Why the worker is gone. Its loaded wallets are gone with it.
 * After `exit` (a crash) listeners keep only what queued jobs still need.
 * After `stop` (a planned shutdown) they may release everything.
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

export function onWorkerGone(listener: WorkerGoneListener): () => void {
    workerGoneListeners.add(listener);
    return () => workerGoneListeners.delete(listener);
}

export function setStateSaveSink(sink: StateSaveSink | undefined): void {
    if (!client) {
        throw new Error('wallet-worker not started; call startWalletWorker() first');
    }
    stateSaveSink = sink;
}

/**
 * A tx the worker is about to send. The hook stores it first.
 * If the hook throws, the worker does not send.
 */
export interface SubmitIntentInfo {
    txHash: string; contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string;
    segments?: Array<{ segment: number; calls: string[] }>;
    /** Raw token types the calls mint. */
    minted?: string[];
}
export type SubmitIntentHook = (txHash: string, intent: SubmitIntentInfo) => Promise<void>;

async function rpc<T>(method: string, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    // Retry once on the new worker after a planned restart. A submitting call is never
    // repeated, because its reported tx id is looked up instead.
    for (let attempt = 0; ; attempt++) {
        await waitForDrainingWorker();
        try {
            return await rpcOnce<T>(method, args, timeoutMs, onSubmitIntent);
        } catch (err) {
            const name = (err as Error)?.name;
            if (attempt === 0 && name === WORKER_ROTATING) {
                // This refusal can arrive before the `rotating` message, because they use different ports.
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
        // The exit already happened before we subscribed.
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
        // Set once the worker answered. The call settles only after this call's submit hooks are done too.
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
        // Wait for pending submit hooks. A hook finishing after the caller gave up would
        // record a tx hash for a tx that was never sent.
        const finish = (outcome: () => void): void => {
            if (answered) return;
            answered = true;
            clearTimeout(timer);
            void (async () => {
                // Limited, so a stuck database cannot hold the caller forever.
                // A hash stored later is cleaned up once the tx expires.
                const ceilingMs = configMs('NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS');
                const deadline = Date.now() + ceilingMs;
                while (intentsInFlight.size > 0) {
                    const left = deadline - Date.now();
                    if (left <= 0) {
                        log.warn(`wallet-worker rpc '${method}': ${intentsInFlight.size} submit-intent hook(s) still pending after ${ceilingMs}ms; answering without them`);
                        break;
                    }
                    let wait: ReturnType<typeof setTimeout> | undefined;
                    await Promise.race([
                        Promise.allSettled([...intentsInFlight]),
                        new Promise<void>(r => { wait = setTimeout(r, left); })
                    ]);
                    clearTimeout(wait);
                }
                settle();
                outcome();
            })();
        };
        pending = { reject: (e: Error) => finish(() => reject(e)) };
        pendingRpcs.add(pending);
        timer = setTimeout(() => {
            // The worker stops at its next wait point. Nothing is cancelled once a send was announced.
            try { port2.postMessage({ kind: 'cancel' }); } catch { /* port already closed */ }
            pending.reject(new Error(`wallet-worker rpc '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const postAck = (ack: Record<string, unknown>): void => {
            try { port2.postMessage({ kind: 'submit-intent-ack', ...ack }); } catch { /* port already closed */ }
        };
        port2.on('message', (msg: any) => {
            if (answered) return;
            if (msg?.kind === 'submit-intent') {
                // Store, then ack or nack. Once the worker answered it gave up and did not send, so no ack.
                const intent: SubmitIntentInfo = { txHash: String(msg.txHash), contractAddress: msg.contractAddress, circuits: msg.circuits, note: msg.note, sponsorAccountId: msg.sponsorAccountId, ...(Array.isArray(msg.deployed) ? { deployed: msg.deployed.map(String) } : {}), ...(typeof msg.ttl === 'string' ? { ttl: msg.ttl } : {}), ...(Array.isArray(msg.minted) && msg.minted.length ? { minted: msg.minted.map(String) } : {}) };
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
                            if (!answered) postAck({ txHash: msg.txHash, ok: false, error: errorMessage(e) });
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
                    const coded = payload.nightgate
                        ? nightgateErrorFromPayload({ ...payload.nightgate, name: payload.name, message: payload.message })
                        : undefined;
                    if (isSubmitFailureCode(payload.code)) {
                        const submitErr = new WorkerSubmitError(payload);
                        if (coded) submitErr.cause = coded;
                        reject(submitErr);
                        return;
                    }
                    if (coded) {
                        reject(coded);
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
        try {
            worker.postMessage(
                { kind: 'rpc', method, args, port: port1 },
                [port1]
            );
        } catch (err) {
            // Never sent, so fail now instead of waiting for the timeout.
            pending.reject(err as Error);
        }
    });
}

/**
 * `setContractAddress` has no reply port. Messages arrive in order, so it is applied before the next get or set.
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
        } catch (err: unknown) {
            port.postMessage({
                ok: false,
                error: {
                    name: errorName(err),
                    message: formatErr(err)
                }
            });
        } finally {
            port.close();
        }
    })();
}

/** The worker may call only these methods. */
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

export function walletInit(args: WalletInitArgs): Promise<{
    facadeReady: boolean;
    alreadyExisted: boolean;
    sdkVersion?: string;
}> {
    return rpc('init', args);
}

/** Waits until the wallet is synced. Fails after `timeoutMs` in total or after `stallMs` without progress. */
export function walletWaitForSyncedState(sessionId: string, timeoutMs?: number, stallMs?: number): Promise<{ synced: true }> {
    const workerBudgetMs = timeoutMs ?? 12 * 60 * 60 * 1000;
    return rpc('waitForSyncedState', { sessionId, timeoutMs, stallMs }, workerBudgetMs + 5 * 60 * 1000);
}

export async function walletEvict(sessionId: string): Promise<{ evicted: boolean; saved?: boolean }> {
    try {
        // The caller stops tracking saves for this session once we reply, so the final save must be stored first.
        return await rpc('evict', { sessionId, awaitSaveAck: true });
    } finally {
        syncProgressCache.delete(sessionId);
        forgetDustCollapseStats(sessionId);
    }
}

/** Profiles the worker thread for 1 to 120 seconds. The raw profile is saved to disk. */
export function walletCpuProfile(seconds: number, dir?: string): Promise<NonNullable<Awaited<ReturnType<typeof profileWorker>>>> {
    const secs = Math.min(120, Math.max(1, Math.floor(Number(seconds) || 20)));
    return rpc('cpuProfile', { seconds: secs, dir }, (secs + 60) * 1000);
}

/**
 * Returns the last progress the worker pushed, without asking the worker.
 * The worker is fully busy during the sync the caller is watching.
 */
export function walletGetSyncProgress(sessionId: string): WalletSyncProgress | null {
    return syncProgressCache.get(sessionId) ?? null;
}

export interface WalletWorkerStatus {
    /** The worker has been started at least once in this process. */
    started: boolean;
    running: boolean;
    /** Calls waiting for an answer. A number that only grows means the worker is stuck. */
    inFlightRpcs: number;
    /** Crashes since process start. A rising number means the worker keeps crashing. */
    exitCount: number;
    /** Planned restarts, not crashes. */
    rotationCount: number;
    lastExitCode: number | null;
    lastExitAt: string | null;
    rpcTimeoutMs: number;
    /** Wallets that reported sync progress. */
    facades: Array<{ sessionId: string; label: string; caughtUp: boolean; updatedAt: string }>;
}

/** Answers without the worker, so it works even while the worker is stuck. */
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

/** Registers the wallet's NIGHT UTXOs for dust generation. `syncTimeoutMs` 0 or unset waits forever. */
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
    /** The receiver that was applied. Null when nothing was registered. */
    dustReceiverAddress: string | null;
    /** The receiver the call asked for, applied or not. */
    requestedReceiver: string;
    registeredUtxosBefore: number;
    /** Registered NIGHT UTXOs after the tx applied locally. Null when not seen in time. */
    registeredUtxosAfter: number | null;
    /** Whether the new count was seen within NIGHTGATE_DUST_REGISTER_SETTLE_MS. */
    settled: boolean;
    /** Whether the registration merged the UTXOs into fewer ones. Null when not seen. */
    consolidated: boolean | null;
    message: string;
}

/** Deregisters ALL registered NIGHT UTXOs. */
export function walletDeregisterDustGeneration(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Fee sponsor session, for a wallet that has no dust of its own. */
    sponsorSessionId?: string;
}, onSubmitIntent?: SubmitIntentHook): Promise<{
    txId: string | null;
    deregisteredCount: number;
    totalNightUtxos: number;
}> {
    return rpc('deregisterDustGeneration', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/**
 * Sends NIGHT, or the token `tokenTypeHex`. The receiver address decides shielded or unshielded.
 * `amount` is in atoms as a decimal string.
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

/** Amounts are decimal strings. */
export function walletGetBalance(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Timeout for the call itself, so polling a stuck worker does not pile up calls. */
    rpcTimeoutMs?: number;
}): Promise<{
    shieldedNight: string;
    unshieldedNight: string;
    /** All other shielded tokens with a balance. Raw 64-hex type and amount in atoms. */
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

/** Fee estimate for `walletTransferNight` without proving or sending. Dust atoms as a decimal string. */
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

export interface WorkerContractRegistration {
    artifactPath: string;
    /** Hash of the contract module and its verifier keys. The worker caches modules by it. */
    artifactDigest?: string;
    privateStateId: string;
    zkConfigPath: string;
    /** Number of content slots of an attestation vault contract. 16 by default, 32 for attestation-vault-32. */
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
    /** Initial private state for the new contract. Must be plain JSON. */
    initialPrivateState: unknown;
    sponsorSessionId?: string;
    /** For attestation vault contracts: the recovery identity (64 hex) passed to the constructor. */
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

/** Private state goes through the provider registered under `proxyId`. */
export function walletDeployContract(args: WalletDeployContractArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    contractAddress: string;
    onChainStatus: string;
}> {
    return rpc('deployContract', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

export function walletSubmitContractCall(args: WalletSubmitContractCallArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    onChainStatus: string;
}> {
    return rpc('submitContractCall', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Builds, signs and finalizes a call as the caller. The fee is not paid and nothing is sent. */
export function walletBuildSponsorableTx(
    args: Omit<WalletSubmitContractCallArgs, 'sponsorSessionId'>
): Promise<{ finalizedTxB64: string; serializedBytes: number }> {
    return rpc('buildSponsorableTx', args);
}

/** Pays the dust fee for a tx the caller finalized and sends it, if the sponsor rules allow it. */
export function walletSponsorFinalizedTx(args: {
    sponsorSessionId: string;
    finalizedTxB64: string;
    networkId: WalletSubmitContractCallArgs['networkId'];
    allowedContracts?: string[];
    allowedCircuits?: string[];
    /** Both the server rules and the grant allow a contract deploy in this tx. */
    allowDeploy?: boolean;
    /** Contracts deployed under this grant. Calls on them skip `allowedCircuits`. */
    ownContracts?: string[];
    /** Shielded token types whose zswap offers the sponsor pays for. Unset means none. */
    allowedTokenTypes?: string[];
    /** Also pay for the offer of a token that a call in this tx mints. */
    allowContractMints?: boolean;
}, onSubmitIntent?: SubmitIntentHook): Promise<{ txHash: string; circuits: string[]; contractAddress: string; deployed?: string[]; minted?: string[] }> {
    return rpc('sponsorFinalizedTx', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

export interface WalletSubmitContractCallBatchArgs extends Omit<WalletSubmitContractCallArgs, 'circuit' | 'args'> {
    /** The calls of one tx, in order. A call's own `merkleProof` replaces the batch-level one. */
    calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>;
    /** The calls after `orderedPrefix` do not depend on each other, so the worker may reorder them. */
    independentCalls?: boolean;
    orderedPrefix?: number;
}

export function walletSubmitContractCallBatch(args: WalletSubmitContractCallBatchArgs, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string;
    onChainStatus: string;
    circuits: string[];
}> {
    return rpc('submitContractCallBatch', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Test only. */
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
    rotationAnnouncedBy = null;
    drainingWorker = null;
    stoppingWorker = null;
}

/** What a sponsored swap exchanged, from the maker's side. Amounts in atoms. */
export interface SponsoredSwapTerms {
    gives: { tokenType: string; amount: string };
    wants: { tokenType: string; amount: string };
}

/**
 * Pays the fee of a caller tx that is not bound yet, so the sponsor can still add its dust spend.
 * Many of these can run in parallel from one sponsor wallet.
 */
export function walletSponsorUnboundTx(args: {
    sponsorSessionId: string;
    /** The caller's transaction; absent for a swap. */
    unboundTxB64?: string;
    /** The two halves of a shielded swap, proven but not bound. The worker checks and merges them. */
    swap?: { makerHalfB64: string; takerHalfB64: string };
    allowSwaps?: boolean;
    networkId: WalletSubmitContractCallArgs['networkId'];
    allowedContracts?: string[];
    allowedCircuits?: string[];
    /** Both the server rules and the grant allow a contract deploy in this tx. */
    allowDeploy?: boolean;
    /** Contracts deployed under this grant. Calls on them skip `allowedCircuits`. */
    ownContracts?: string[];
    /** Shielded token types whose zswap offers the sponsor pays for. Unset means none. */
    allowedTokenTypes?: string[];
    /** Also pay for the offer of a token that a call in this tx mints. */
    allowContractMints?: boolean;
}, onSubmitIntent?: SubmitIntentHook): Promise<{ txHash: string; circuits: string[]; contractAddress: string; note: string; deployed?: string[]; minted?: string[]; swap?: SponsoredSwapTerms; nullifiers?: string[] }> {
    return rpc('sponsorUnboundTx', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Reads the terms and input nullifiers of one swap half. Throws for anything else. */
export async function walletDescribeSwapHalf(args: { halfB64: string }): Promise<SponsoredSwapTerms & { bound: boolean; inputs: number; nullifiers: string[] }> {
    return rpc('describeSwapHalf', args, RPC_TIMEOUT_MS);
}
