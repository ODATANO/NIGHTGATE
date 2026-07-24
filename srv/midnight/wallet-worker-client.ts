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
import { formatErr } from '../utils/format-error';

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

interface ClientState {
    worker: Worker;
    readyPromise: Promise<void>;
}

let client: ClientState | null = null;

// True once the worker has been started at least once. Lets rpc() distinguish
// "never started" (reject: caller must startWalletWorker() first) from "crashed
// after a successful start" (respawn). Cleared on explicit stop/reset.
let everStarted = false;

// Kept at module scope (not on ClientState) so it survives a worker respawn:
// the sink is wired once at startup and must keep persisting state-save events
// even from a freshly respawned worker.
let stateSaveSink: StateSaveSink | undefined;

// In-flight rpc rejectors, so a worker crash/exit rejects every pending call
// instead of leaving it to hang forever on a port that will never reply.
interface PendingRpc { reject: (e: Error) => void; }
const pendingRpcs = new Set<PendingRpc>();

function rejectAllPendingRpcs(reason: string): void {
    for (const p of [...pendingRpcs]) {
        try { p.reject(new Error(reason)); } catch { /* already settled */ }
    }
    pendingRpcs.clear();
}

// Backstop timeout for a single worker RPC.
const RPC_TIMEOUT_MS = Number(process.env.NIGHTGATE_WORKER_RPC_TIMEOUT_MS || 30 * 60 * 1000);

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

        workerData: {},
        // resourceLimits undefined: inherit NODE_OPTIONS (wallet SDK heap).
        resourceLimits: undefined,
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
            // Ack ONLY when the sink persisted successfully
            Promise.resolve()
                .then(() => stateSaveSink?.(msg))
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
        } else if (msg?.kind === 'private-state-rpc') {
            dispatchPrivateStateRpc(msg);
        }
    });

    worker.on('error', err => {
        log.error('worker error:', err);
        rejectAllPendingRpcs(`wallet-worker crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    worker.on('exit', code => {
        log.warn(`worker exited code=${code}`);
        client = null;
        // Fail every in-flight call now; their reply ports are dead and would
        // otherwise never settle. The next rpc() lazily respawns the worker.
        rejectAllPendingRpcs(`wallet-worker exited (code=${code}) with in-flight calls`);
    });

    await readyPromise;
    log.info('worker ready');
}

/**
 * Stop the worker. Safe to call multiple times. Waits up to `timeoutMs` for
 * graceful exit before terminating.
 */
export async function stopWalletWorker(timeoutMs = 5000): Promise<void> {
    if (!client) return;
    const w = client.worker;
    client = null;
    // Intentional teardown: do NOT let a later rpc respawn the worker.
    everStarted = false;
    try {
        await Promise.race([
            new Promise<void>(resolve => w.once('exit', () => resolve())),
            new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
        ]);
    } finally {
        // Force-terminate if still alive.
        try { await w.terminate(); } catch { }
    }
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
async function rpc<T>(method: string, args: unknown, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
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

        port2.once('message', (msg: any) => {
            if (settled) return;
            settle();
            if (msg?.ok) {
                resolve(msg.result as T);
                return;
            }
            const payload = msg?.error;
            if (payload && typeof payload === 'object' && typeof payload.message === 'string') {
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

export function walletWaitForSyncedState(sessionId: string, timeoutMs?: number): Promise<{ synced: true }> {
    const workerBudgetMs = timeoutMs ?? 3 * 60 * 60 * 1000;
    return rpc('waitForSyncedState', { sessionId, timeoutMs }, workerBudgetMs + 5 * 60 * 1000);
}

export function walletSerializeState(sessionId: string): Promise<{
    sdkVersion: string;
    blobs: SerializedBlobs;
}> {
    return rpc('serializeState', { sessionId });
}

export function walletEvict(sessionId: string): Promise<{ evicted: boolean }> {
    return rpc('evict', { sessionId });
}

export function walletPing(): Promise<{ ok: true; ts: number }> {
    return rpc('ping', {});
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
}): Promise<{
    txId: string | null;
    registeredCount: number;
    totalNightUtxos: number;
    dustReceiverAddress: string;
}> {
    return rpc('registerDustGeneration', args);
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
}): Promise<{
    txId: string | null;
    deregisteredCount: number;
    totalNightUtxos: number;
}> {
    return rpc('deregisterDustGeneration', args);
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
}): Promise<{
    txId: string;
    toLedger: 'shielded' | 'unshielded';
    amount: string;
    receiverAddress: string;
}> {
    return rpc('transferNight', args);
}

/**
 * Move NIGHT from shielded → unshielded ledger. Always targets the
 * wallet's own unshielded address (no third-party recipient parameter
 * for this primitive).
 */
export function walletUnshieldNight(args: {
    sessionId: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}): Promise<{
    txId: string;
    amount: string;
    unshieldedReceiverAddress: string;
}> {
    return rpc('unshieldNight', args);
}

/** Symmetric counterpart: unshielded → shielded for own funds. */
export function walletShieldNight(args: {
    sessionId: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}): Promise<{
    txId: string;
    amount: string;
    shieldedReceiverAddress: string;
}> {
    return rpc('shieldNight', args);
}

/**
 * Snapshot of the wallet's balances. Read-only: no transaction is
 * built or submitted. All amounts are decimal-string bigint to avoid
 * Number precision loss.
 */
export function walletGetBalance(args: {
    sessionId: string;
    syncTimeoutMs?: number;
}): Promise<{
    shieldedNight: string;
    unshieldedNight: string;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
}> {
    return rpc('getBalance', args);
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
}): Promise<{ fee: string; toLedger: 'shielded' | 'unshielded' }> {
    return rpc('estimateTransferFee', args);
}

/**
 * Pre-flight fee estimate for shield/unshield ledger shifts. Builds the
 * `initSwap` recipe without finalizing. `direction` selects which way.
 */
export function walletEstimateSwapFee(args: {
    sessionId: string;
    direction: 'shield' | 'unshield';
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}): Promise<{ fee: string; direction: 'shield' | 'unshield' }> {
    return rpc('estimateSwapFee', args);
}

// ---- Phase 2b: contract deploy / call -------------------------------------

export interface WorkerContractRegistration {
    artifactPath: string;
    privateStateId: string;
    zkConfigPath: string;
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
    witnessValues?: { attestedValue: string; valueSalt: string };
    merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] };
    initialPrivateState?: unknown;
    sponsorSessionId?: string;
}

/**
 * Deploy a Compact-emitted contract through the wallet worker. The worker
 * owns the SDK and the wallet facade; private-state CRUD round-trips back to
 * the main-side provider registered under `proxyId`.
 */
export function walletDeployContract(args: WalletDeployContractArgs): Promise<{
    txHash: string;
    contractAddress: string;
    onChainStatus: string;
}> {
    return rpc('deployContract', args);
}

/**
 * Invoke a circuit on a deployed contract through the worker. Same wiring as
 * `walletDeployContract`. Returns the submission txHash + on-chain status.
 */
export function walletSubmitContractCall(args: WalletSubmitContractCallArgs): Promise<{
    txHash: string;
    onChainStatus: string;
}> {
    return rpc('submitContractCall', args);
}

export interface WalletSubmitContractCallBatchArgs extends Omit<WalletSubmitContractCallArgs, 'circuit' | 'args'> {
    /** Ordered circuit calls, all executed inside ONE transaction scope. */
    calls: Array<{ circuit: string; args: unknown[] }>;
}

/**
 * Invoke SEVERAL circuits on one deployed contract as a SINGLE transaction
 * (the worker batches them via the SDK's withContractScopedTransaction).
 * Returns the one submission txHash + on-chain status for the whole batch.
 */
export function walletSubmitContractCallBatch(args: WalletSubmitContractCallBatchArgs): Promise<{
    txHash: string;
    onChainStatus: string;
    circuits: string[];
}> {
    return rpc('submitContractCallBatch', args);
}

/** Test-only: reset the singleton so subsequent calls re-spawn. */
export function __resetWalletWorkerForTests(): void {
    client = null;
    everStarted = false;
    stateSaveSink = undefined;
    pendingRpcs.clear();
    privateStateProviders.clear();
}
