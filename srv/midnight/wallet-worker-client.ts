// Main-thread side of the wallet worker pool. A wallet's facade key always picks the same worker,
// so the per-wallet locks inside a worker stay valid. See `NIGHTGATE_SPONSOR_WORKERS` for sponsors.

import cds from '@sap/cds';
import { Worker, MessageChannel } from 'node:worker_threads';
import path from 'node:path';
import type { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';
import type { MerkleProofBundle } from '../submission/contract-witnesses';
import type { DeclaredTransfer, UnshieldedMove } from '../submission/submit-intent';
import { errorName } from '../utils/format-error';
import { nightgateErrorFromPayload, errorMessage, NightgateError } from '../utils/errors';
import { isSubmittingMethod, WORKER_ROTATING, WORKER_ROTATED, WorkerSubmitError, isSubmitFailureCode, type SponsorPolicyArgs } from './wallet-worker-protocol';
import { getEncryptionKey } from '../utils/crypto';
import { configEnum, configMs, configNumber, configNumberFrom, resolvedConfigSnapshot } from '../utils/config';
import { recordDustCollapseSample, forgetDustCollapseStats, type DustCollapseSample } from './dust-collapse-stats';
import type { profileWorker } from '#cds-models/NightgateAdminService';
import { setTimeout as sleep } from 'node:timers/promises';
import { profileSeconds } from './cpu-profile';
import type { SyncProgressSnapshot } from './worker/facades';

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

/** A wallet's sync progress as the worker pushes it. A type import loads nothing at run time. */
export type WalletSyncProgress = SyncProgressSnapshot;

const syncProgressCache = new Map<string, WalletSyncProgress>();
/** Which worker a wallet reported from, so a crash clears only that worker's wallets. */
const sessionWorker = new Map<string, string>();

// A worker exit rejects these, because their ports would never reply.
interface PendingRpc { reject: (e: Error) => void; }

/** One worker thread of the pool and what the main thread knows about it. */
interface WorkerSlot {
    id: string;
    worker: Worker | null;
    readyPromise: Promise<void> | null;
    /** Started at least once. A crashed slot restarts on its next call. */
    everStarted: boolean;
    pendingRpcs: Set<PendingRpc>;
    /** The worker that announced a planned restart. Only its exit counts as one. */
    rotationAnnouncedBy: Worker | null;
    // Announced a planned restart but not exited yet. New calls wait for the new worker.
    drainingWorker: Worker | null;
    // Stopped on purpose. Its exit is neither a crash nor a planned restart.
    stoppingWorker: Worker | null;
}

const slots = new Map<string, WorkerSlot>();
const DEFAULT_SLOT = 'user-0';

// Tells "never started" (calls fail) apart from "crashed" (the next call restarts the worker).
let everStarted = false;

// Counts crashes only, over every worker. Planned restarts and stops are counted separately.
let workerExitCount = 0;
let lastExitCode: number | null = null;
let lastExitAt: string | null = null;
let workerRotationCount = 0;

/** How long a planned restart waits for running calls. Killing after that is safe, because each submit reported its tx id first. */
function drainMaxMs(): number {
    return configMs('NIGHTGATE_WORKER_DRAIN_MAX_MS');
}

// Kept here so it survives a worker restart.
let stateSaveSink: StateSaveSink | undefined;

/** Sets only the young generation, because saving wallet state creates large short-lived buffers. 0 keeps the V8 default. */
export function workerResourceLimits(env: NodeJS.ProcessEnv = process.env): { maxYoungGenerationSizeMb: number } | undefined {
    const n = configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', env);
    if (n <= 0) return undefined;
    return { maxYoungGenerationSizeMb: Math.max(16, n) };
}

// Stores the saves of one wallet one after another in arrival order; wallets do not wait for each other.
const stateSaveChains = new Map<string, Promise<void>>();

function rejectPendingRpcs(slot: WorkerSlot, reason: string, name?: string): void {
    for (const p of [...slot.pendingRpcs]) {
        const err = new Error(reason);
        if (name) err.name = name;
        try { p.reject(err); } catch { /* already settled */ }
    }
    slot.pendingRpcs.clear();
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

// ---- Worker pool: which worker holds which wallet --------------------------------------------

export type SponsorWorkersMode = 'shared' | 'dedicated';

/** Wallets assigned to a worker of their own (pool sponsors under `dedicated`). */
const dedicatedFacades = new Set<string>();

/** The pool as configured: user workers and whether sponsors get their own. Read once. */
let poolConfig: { walletWorkers: number; sponsorWorkers: SponsorWorkersMode } | null = null;

export function walletWorkerPoolConfig(): { walletWorkers: number; sponsorWorkers: SponsorWorkersMode } {
    if (!poolConfig) {
        poolConfig = {
            walletWorkers: Math.max(1, Math.floor(configNumber('NIGHTGATE_WALLET_WORKERS'))),
            sponsorWorkers: configEnum<SponsorWorkersMode>('NIGHTGATE_SPONSOR_WORKERS') ?? 'shared'
        };
    }
    return poolConfig;
}

/** Gives a pool sponsor's wallet its own worker. Call it before the wallet is loaded, because a wallet never moves. */
export function assignDedicatedWorker(facadeKey: string): void {
    if (walletWorkerPoolConfig().sponsorWorkers !== 'dedicated') return;
    if (dedicatedFacades.has(facadeKey)) return;
    if (sessionWorker.has(facadeKey)) {
        log.warn(`wallet ${facadeKey.slice(0, 16)} already lives in ${sessionWorker.get(facadeKey)}; it keeps that worker`);
        return;
    }
    dedicatedFacades.add(facadeKey);
}

/** FNV-1a over the key: the same wallet always lands in the same user worker. */
function hashKey(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

/** The worker of a wallet. Calls without a wallet (byte checks, profiles) use the first user worker. */
export function workerIdFor(facadeKey?: string): string {
    if (!facadeKey) return DEFAULT_SLOT;
    if (dedicatedFacades.has(facadeKey)) return `sponsor-${facadeKey.slice(0, 16)}`;
    const n = walletWorkerPoolConfig().walletWorkers;
    return n <= 1 ? DEFAULT_SLOT : `user-${hashKey(facadeKey) % n}`;
}

/** The wallet an rpc works on: the caller's, else the sponsor's (pool jobs name only the sponsor). */
function facadeKeyOf(args: unknown): string | undefined {
    const a = args as { sessionId?: unknown; sponsorSessionId?: unknown } | null;
    if (typeof a?.sessionId === 'string' && a.sessionId) return a.sessionId;
    if (typeof a?.sponsorSessionId === 'string' && a.sponsorSessionId) return a.sponsorSessionId;
    return undefined;
}

/** Refuses a call whose caller and sponsor wallets live in different workers. Run such sponsors `shared`. */
function assertSameWorker(method: string, args: unknown): void {
    const a = args as { sessionId?: unknown; sponsorSessionId?: unknown } | null;
    if (typeof a?.sessionId !== 'string' || typeof a?.sponsorSessionId !== 'string' || !a.sponsorSessionId) return;
    const mine = workerIdFor(a.sessionId), sponsors = workerIdFor(a.sponsorSessionId);
    if (mine === sponsors) return;
    throw new NightgateError('PRECONDITION_FAILED',
        `${method}: the sponsor wallet lives in worker ${sponsors}, the caller's in ${mine}; ` +
        'bound sponsoring needs both in one worker (NIGHTGATE_SPONSOR_WORKERS=shared, NIGHTGATE_WALLET_WORKERS=1)');
}

function slotOf(id: string): WorkerSlot {
    let slot = slots.get(id);
    if (!slot) {
        slot = { id, worker: null, readyPromise: null, everStarted: false, pendingRpcs: new Set(), rotationAnnouncedBy: null, drainingWorker: null, stoppingWorker: null };
        slots.set(id, slot);
    }
    return slot;
}

function sessionsOf(slotId: string): string[] {
    return [...sessionWorker.entries()].filter(([, w]) => w === slotId).map(([s]) => s);
}

/** Starts the first user worker. Further workers start on their first call. */
export async function startWalletWorker(): Promise<void> {
    await startWorkerSlot(slotOf(DEFAULT_SLOT));
}

async function startWorkerSlot(slot: WorkerSlot): Promise<void> {
    if (slot.worker) {
        await slot.readyPromise;
        return;
    }

    everStarted = true;
    slot.everStarted = true;
    const entry = resolveWorkerEntry();
    const worker = new Worker(entry, {
        // The worker gets its config from here and never reads the environment.
        workerData: { encryptionKeyRing: getEncryptionKey().toSpec() ?? null, config: resolvedConfigSnapshot(), workerId: slot.id },
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
        // Any exit before ready fails the start; after ready this reject does nothing.
        worker.once('exit', code => reject(new Error(`wallet-worker ${slot.id} exited with code ${code} before ready`)));
    });

    slot.worker = worker;
    slot.readyPromise = readyPromise;
    const tag = slots.size > 1 || slot.id !== DEFAULT_SLOT ? `worker ${slot.id}` : 'worker';

    worker.on('message', (msg: any) => {
        if (msg?.kind === 'state-save') {
            // Ack only a stored save. One wallet's saves are stored in arrival order,
            // because a restored dust state relies on the last save winning.
            const key = String(msg.sessionId ?? '');
            const chain = (stateSaveChains.get(key) ?? Promise.resolve())
                .then(async () => {
                    if (!stateSaveSink) {
                        log.error(`${tag}: state save of ${key.slice(0, 16)} dropped, no state-save sink is wired`);
                        return;
                    }
                    await stateSaveSink(msg);
                    if (msg.seq != null) worker.postMessage({ kind: 'state-save-ack', sessionId: msg.sessionId, seq: msg.seq });
                })
                .catch(() => { /* no ack; the sink logs its own failures */ });
            stateSaveChains.set(key, chain);
            void chain.then(() => { if (stateSaveChains.get(key) === chain) stateSaveChains.delete(key); });
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
                sessionWorker.set(String(msg.sessionId), slot.id);
            }
        } else if (msg?.kind === 'save-stats') {
            if (msg.sessionId && msg.dust) recordDustCollapseSample(msg.sessionId, msg.dust as DustCollapseSample);
        } else if (msg?.kind === 'private-state-rpc') {
            dispatchPrivateStateRpc(msg);
        } else if (msg?.kind === 'rotating') {
            slot.rotationAnnouncedBy = worker;
            slot.drainingWorker = worker;
            log.info(`${tag} announced its rotation (${msg.generations} artifact generations, ${msg.inflight ?? 0} call(s) draining); new calls wait for the respawn`);
        } else if (msg?.kind === 'rotation-done') {
            // Terminated from here so the worker never exits while it is still replying.
            slot.rotationAnnouncedBy = worker;
            slot.drainingWorker = worker;
            log.info(`${tag} rotation drained (${msg.generations} artifact generations); terminating it, the next call respawns`);
            void worker.terminate().catch(() => undefined);
        }
    });

    worker.on('error', err => {
        log.error(`${tag} error:`, err);
        rejectPendingRpcs(slot, `wallet-worker crashed: ${errorMessage(err)}`);
    });
    worker.on('exit', code => {
        // A newer worker may already run. The old worker's late exit must not clear it.
        if (slot.worker === worker) { slot.worker = null; slot.readyPromise = null; }
        if (slot.drainingWorker === worker) slot.drainingWorker = null;
        const stopped = slot.stoppingWorker === worker;
        const rotated = !stopped && slot.rotationAnnouncedBy === worker;
        if (slot.rotationAnnouncedBy === worker) slot.rotationAnnouncedBy = null;
        if (stopped) {
            slot.stoppingWorker = null;
            log.info(`${tag} stopped (code=${code})`);
        } else if (rotated) {
            workerRotationCount += 1;
            log.info(`${tag} rotated (controlled exit after its generation budget); the next call respawns it`);
        } else {
            log.warn(`${tag} exited code=${code}`);
            workerExitCount += 1;
            lastExitCode = code;
            lastExitAt = new Date().toISOString();
        }
        const gone = forgetWorkerSessions(slot.id);
        void notifyWorkerGone('exit', { workerId: slot.id, facades: gone });
        // Named so rpc() can retry a read on the new worker.
        rejectPendingRpcs(slot,
            rotated ? `wallet-worker rotated with in-flight calls` : `wallet-worker exited (code=${code}) with in-flight calls`,
            rotated ? WORKER_ROTATED : undefined
        );
    });

    await readyPromise;
    log.info(`${tag} ready`);
}

/** Drops the cached progress of the wallets that lived in the worker. Returns their keys. */
function forgetWorkerSessions(slotId: string): string[] {
    const gone = sessionsOf(slotId);
    for (const s of gone) forgetSession(s);
    return gone;
}

function forgetSession(sessionId: string): void {
    syncProgressCache.delete(sessionId);
    sessionWorker.delete(sessionId);
    forgetDustCollapseStats(sessionId);
}

/** Unloads every wallet after its final save, then stops every worker. Call it before dropping the encryption keys. */
export async function stopWalletWorker(timeoutMs = 60_000): Promise<void> {
    // A later call must not restart a worker that was stopped on purpose.
    everStarted = false;
    const running = [...slots.values()].filter(s => s.worker);
    await Promise.all(running.map(slot => stopWorkerSlot(slot, timeoutMs)));
}

async function stopWorkerSlot(slot: WorkerSlot, timeoutMs: number): Promise<void> {
    const w = slot.worker;
    if (!w) return;
    slot.everStarted = false;
    const tag = slots.size > 1 || slot.id !== DEFAULT_SLOT ? `worker ${slot.id}` : 'worker';
    try {
        const r = await rpcOnce<{ evicted: number; failed: number }>(slot, 'shutdown', {}, timeoutMs);
        if (r.failed > 0) log.error(`${tag} shutdown: ${r.evicted} facade(s) evicted, ${r.failed} WITHOUT a confirmed final save`);
        else log.info(`${tag} shutdown: ${r.evicted} facade(s) evicted, all saves confirmed`);
    } catch (err) {
        if ((err as Error)?.name === WORKER_ROTATING) {
            // A restarting worker saves its wallets itself, so wait for its exit.
            log.info(`${tag} is rotating during shutdown; waiting for its own facade flush and exit`);
            if (!slot.drainingWorker) slot.drainingWorker = w;
            await Promise.race([
                new Promise<void>(resolve => { w.once('exit', () => resolve()); if (slot.drainingWorker !== w) resolve(); }),
                sleep(timeoutMs, undefined, { ref: false })
            ]);
        } else {
            log.warn(`${tag} shutdown flush did not complete: ${errorMessage(err)}; terminating`);
        }
    }
    if (slot.worker !== w) return; // replaced or already gone
    slot.worker = null;
    slot.readyPromise = null;
    slot.stoppingWorker = w;
    try { await w.terminate(); } catch { /* already exited */ }
    // A forced terminate may skip the exit handler, so clear here too.
    const gone = forgetWorkerSessions(slot.id);
    await notifyWorkerGone('stop', { workerId: slot.id, facades: gone });
}

/** Why a worker is gone. After a crash (`exit`) listeners keep what queued jobs need. After `stop` they may release everything. */
export type WorkerGoneReason = 'exit' | 'stop';
/** The worker that went and the wallets it held, as far as they reported progress. */
export interface WorkerGoneInfo { workerId: string; facades: string[] }
type WorkerGoneListener = (reason: WorkerGoneReason, info: WorkerGoneInfo) => void | Promise<void>;
const workerGoneListeners = new Set<WorkerGoneListener>();

function notifyWorkerGone(reason: WorkerGoneReason, info: WorkerGoneInfo): Promise<void> {
    const running: Array<Promise<void>> = [];
    for (const listener of workerGoneListeners) {
        try {
            const result = listener(reason, info);
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
    if (!everStarted) {
        throw new Error('wallet-worker not started; call startWalletWorker() first');
    }
    stateSaveSink = sink;
}

/** A tx the worker is about to send. The hook stores it first. If the hook throws, the worker does not send. */
export interface SubmitIntentInfo {
    txHash: string; contractAddress?: string; circuits?: string[]; note?: string; sponsorAccountId?: string; deployed?: string[]; ttl?: string;
    segments?: Array<{ segment: number; calls: string[] }>;
    /** Raw token types the calls mint. */
    minted?: string[];
}
export type SubmitIntentHook = (txHash: string, intent: SubmitIntentInfo) => Promise<void>;

async function rpc<T>(method: string, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    assertSameWorker(method, args);
    const slot = slotOf(workerIdFor(facadeKeyOf(args)));
    // Retry once on the new worker after a planned restart. A submitting call is never
    // repeated, because its reported tx id is looked up instead.
    for (let attempt = 0; ; attempt++) {
        await waitForDrainingWorker(slot);
        try {
            return await rpcOnce<T>(slot, method, args, timeoutMs, onSubmitIntent);
        } catch (err) {
            const name = (err as Error)?.name;
            if (attempt === 0 && name === WORKER_ROTATING) {
                // This refusal can arrive before the `rotating` message, because they use different ports.
                if (!slot.drainingWorker && slot.worker) slot.drainingWorker = slot.worker;
                continue;
            }
            if (attempt === 0 && name === WORKER_ROTATED && !isSubmittingMethod(method)) continue;
            throw err;
        }
    }
}

async function waitForDrainingWorker(slot: WorkerSlot): Promise<void> {
    const w = slot.drainingWorker;
    if (!w) return;
    const ceiling = drainMaxMs();
    await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => { if (timer) clearTimeout(timer); resolve(); };
        w.once('exit', done);
        // The exit already happened before we subscribed.
        if (slot.drainingWorker !== w) { w.off('exit', done); resolve(); return; }
        timer = setTimeout(() => {
            if (slot.drainingWorker !== w) return;
            log.warn(`worker ${slot.id} rotation drain exceeded ${ceiling}ms; terminating the draining worker (in-flight submits announced their identifiers, reconciliation resolves them)`);
            void w.terminate().catch(() => undefined);
        }, ceiling);
        timer.unref();
    });
}

async function rpcOnce<T>(slot: WorkerSlot, method: string, args: unknown, timeoutMs: number, onSubmitIntent?: SubmitIntentHook): Promise<T> {
    if (!slot.worker) {
        if (!everStarted) {
            throw new Error('wallet-worker not started');
        }
        await startWorkerSlot(slot);
    }
    const worker = slot.worker!;
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
            slot.pendingRpcs.delete(pending);
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
        slot.pendingRpcs.add(pending);
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
            log.warn('setContractAddress failed:', errorMessage(err));
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
                    message: errorMessage(err)
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
        forgetSession(sessionId);
    }
}

/** Profiles the busiest worker, else the first user worker, for 1 to 120 seconds. Saves the raw profile to disk. */
export function walletCpuProfile(seconds: number, dir?: string): Promise<NonNullable<Awaited<ReturnType<typeof profileWorker>>>> {
    const secs = profileSeconds(seconds);
    const busiest = [...slots.values()].filter(s => s.worker).sort((a, b) => b.pendingRpcs.size - a.pendingRpcs.size)[0];
    const slot = busiest ?? slotOf(DEFAULT_SLOT);
    log.info(`cpu profile of worker ${slot.id} for ${secs}s`);
    return rpcOnce(slot, 'cpuProfile', { seconds: secs, dir }, (secs + 60) * 1000);
}

/** Returns the last progress the worker pushed, without asking it: the worker is fully busy during the sync the caller is watching. */
export function walletGetSyncProgress(sessionId: string): WalletSyncProgress | null {
    return syncProgressCache.get(sessionId) ?? null;
}

export interface WalletWorkerStatus {
    /** A worker has been started at least once in this process. */
    started: boolean;
    /** Every worker that was started is alive. */
    running: boolean;
    /** Calls waiting for an answer, over every worker. A number that only grows means a worker is stuck. */
    inFlightRpcs: number;
    /** Crashes since process start, over every worker. A rising number means a worker keeps crashing. */
    exitCount: number;
    /** Planned restarts, not crashes. */
    rotationCount: number;
    lastExitCode: number | null;
    lastExitAt: string | null;
    rpcTimeoutMs: number;
    /** Wallets that reported sync progress. */
    facades: Array<{ sessionId: string; label: string; caughtUp: boolean; updatedAt: string }>;
    /** The pool as configured. */
    pool: { walletWorkers: number; sponsorWorkers: SponsorWorkersMode };
    /** One entry per worker that was started. */
    workers: Array<{ id: string; running: boolean; inFlightRpcs: number; facades: string[] }>;
}

/** Answers without the workers, so it works even while one is stuck. */
export function getWalletWorkerStatus(): WalletWorkerStatus {
    const started = [...slots.values()].filter(s => s.everStarted || s.worker);
    return {
        started: everStarted,
        running: started.length > 0 && started.every(s => s.worker !== null),
        inFlightRpcs: started.reduce((n, s) => n + s.pendingRpcs.size, 0),
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
        })),
        pool: walletWorkerPoolConfig(),
        workers: started.map(s => ({ id: s.id, running: s.worker !== null, inFlightRpcs: s.pendingRpcs.size, facades: sessionsOf(s.id) }))
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

/** Sends NIGHT, or the token `tokenTypeHex`. The receiver address decides shielded or unshielded. `amount` is in atoms as a decimal string. */
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

/** A wallet's balances as the worker reports them. Amounts are decimal strings in atoms. */
export interface WalletBalanceSnapshot {
    shieldedNight: string;
    unshieldedNight: string;
    /** All other shielded tokens with a balance. Raw 64-hex type and amount in atoms. */
    shieldedTokens: Array<{ tokenType: string; amount: string }>;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
    dustUtxoCount: number;
    /** Dust notes free to pay a fee now. */
    dustAvailableCount: number;
    dustPendingCount: number;
    dustPendingValue: string;
    /** How often this process restored the dust wallet from a snapshot taken before a build. */
    dustRestoreCount: number;
}

export function walletGetBalance(args: {
    sessionId: string;
    syncTimeoutMs?: number;
    /** Timeout for the call itself, so polling a stuck worker does not pile up calls. */
    rpcTimeoutMs?: number;
}): Promise<WalletBalanceSnapshot> {
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
    /** Height of the block the transaction landed in; null when the node did not report it. */
    blockHeight: number | null;
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
export function walletSponsorFinalizedTx(args: SponsorPolicyArgs & {
    sponsorSessionId: string;
    finalizedTxB64: string;
    networkId: WalletSubmitContractCallArgs['networkId'];
}, onSubmitIntent?: SubmitIntentHook): Promise<{ txHash: string; circuits: string[]; contractAddress: string; deployed?: string[]; minted?: string[]; unshielded?: UnshieldedMove[] }> {
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
    /** Height of the block the transaction landed in; null when the node did not report it. */
    blockHeight: number | null;
}> {
    return rpc('submitContractCallBatch', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Test only. */
export function __resetWalletWorkerForTests(): void {
    slots.clear();
    everStarted = false;
    stateSaveSink = undefined;
    stateSaveChains.clear();
    syncProgressCache.clear();
    sessionWorker.clear();
    dedicatedFacades.clear();
    poolConfig = null;
    privateStateProviders.clear();
    workerExitCount = 0;
    lastExitCode = null;
    lastExitAt = null;
    workerRotationCount = 0;
}

/** What a sponsored swap exchanged, from the maker's side. Amounts in atoms. */
export interface SponsoredSwapTerms {
    gives: { tokenType: string; amount: string };
    wants: { tokenType: string; amount: string };
}

/** Pays the fee of a caller tx that is not bound yet, so the sponsor can still add its dust spend. */
export function walletSponsorUnboundTx(args: SponsorPolicyArgs & {
    sponsorSessionId: string;
    /** The caller's transaction; absent for a swap. */
    unboundTxB64?: string;
    /** The two halves of a shielded swap, proven but not bound. The worker checks and merges them. */
    swap?: { makerHalfB64: string; takerHalfB64: string };
    allowSwaps?: boolean;
    /** A plain shielded transfer with the terms the caller declares. The worker checks its shape. */
    transfer?: { txB64: string; tokenType: string; amount: string };
    allowTransfers?: boolean;
    networkId: WalletSubmitContractCallArgs['networkId'];
}, onSubmitIntent?: SubmitIntentHook): Promise<{
    txHash: string; circuits: string[]; contractAddress: string; note: string; deployed?: string[]; minted?: string[];
    swap?: SponsoredSwapTerms; transfer?: DeclaredTransfer; unshielded?: UnshieldedMove[]; nullifiers?: string[];
}> {
    return rpc('sponsorUnboundTx', args, RPC_TIMEOUT_MS, onSubmitIntent);
}

/** Checks that caller bytes are a plain shielded transfer: an offer and nothing else that nets to zero. Throws `SPONSOR_REFUSED` otherwise. */
export async function walletDescribeTransfer(args: { txB64: string }): Promise<{ bound: boolean; inputs: number; outputs: number; nullifiers: string[] }> {
    return rpc('describeTransfer', args, RPC_TIMEOUT_MS);
}

/** Checks that caller bytes are a proven transaction, bound or not. Throws `SPONSOR_REFUSED` for anything else. */
export async function walletDescribeTransaction(args: { txB64: string }): Promise<{ bytes: number; bound: boolean }> {
    return rpc('describeTransaction', args, RPC_TIMEOUT_MS);
}

/** Reads the terms and input nullifiers of one swap half. Throws for anything else. */
export async function walletDescribeSwapHalf(args: { halfB64: string }): Promise<SponsoredSwapTerms & { bound: boolean; inputs: number; nullifiers: string[] }> {
    return rpc('describeSwapHalf', args, RPC_TIMEOUT_MS);
}
