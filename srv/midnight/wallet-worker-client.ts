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

import { Worker, MessageChannel, type MessagePort } from 'node:worker_threads';
import path from 'node:path';
import type { CapDbPrivateStateProvider } from './CapDbPrivateStateProvider';
import { formatErr } from '../utils/format-error';

export interface WalletInitArgs {
    sessionId: string;
    seedHex: string;
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
    stateSaveSink?: StateSaveSink;
}

let client: ClientState | null = null;

/**
 * Per-submission private-state provider registry (Phase 2b).
 *
 * The wallet worker invokes the SDK's `deployContract` / `findDeployedContract`
 * inside the worker. The SDK's PrivateStateProvider hook is proxied from the
 * worker back to the main thread via `private-state-rpc` messages; that's
 * where the real CapDbPrivateStateProvider (with CAP DB access + encryption)
 * lives. Each in-flight submission registers its provider here under a fresh
 * `proxyId` so concurrent deploy/call invocations don't collide on a shared
 * `currentContractAddress`.
 */
const privateStateProviders = new Map<string, CapDbPrivateStateProvider>();

export function registerPrivateStateProvider(proxyId: string, provider: CapDbPrivateStateProvider): void {
    privateStateProviders.set(proxyId, provider);
}

export function unregisterPrivateStateProvider(proxyId: string): void {
    privateStateProviders.delete(proxyId);
}

/**
 * Locate the compiled worker entry. tsc emits the worker .js next to its .ts
 * source under `srv/midnight/`, the same place this client sits at runtime.
 */
function resolveWorkerEntry(): string {
    // After tsc-build the runtime file is `srv/midnight/wallet-worker.js`
    // sitting next to this compiled client. In dev (`cds watch` with TS) the
    // compiled file is still available alongside the .ts source because the
    // build:plugin step writes JS in-place. Use __dirname so we don't depend
    // on cwd.
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

    const entry = resolveWorkerEntry();
    const worker = new Worker(entry, {
        // The `web-worker` npm polyfill (used by wallet-sdk-prover-client for
        // the WASM prover) checks `worker_threads.isMainThread` at import
        // time. In a Node worker that's false, so it falls into its
        // `workerThread()` branch which destructures `threads.workerData`.
        // If we pass nothing, workerData is null and the destructure throws.
        // Passing `{}` makes web-worker's `if (!workerData.mod)` succeed and
        // redirect to its `mainThread()` code path, which is the one that
        // actually exports the Worker constructor that the SDK expects.
        workerData: {},
        // Inherit NODE_OPTIONS so the wallet SDK gets the 12 GB heap the user
        // sets for `npm run dev`. Without this the worker would default to
        // 4 GB and OOM during the shielded chain scan.
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

    // Push events from worker (state-save, log, private-state-rpc). These are
    // NOT replies to main-initiated RPC calls; those go via MessageChannel
    // ports allocated per call.
    worker.on('message', (msg: any) => {
        if (msg?.kind === 'state-save') {
            // Ack ONLY when the sink persisted successfully: the worker
            // advances its confirmed-saved blobs on ack, so a failed persist
            // is re-pushed on the next save tick instead of being stranded.
            Promise.resolve()
                .then(() => client?.stateSaveSink?.(msg))
                .then(() => {
                    if (msg.seq != null) worker.postMessage({ kind: 'state-save-ack', sessionId: msg.sessionId, seq: msg.seq });
                })
                .catch(() => { /* no ack; sink already logged the failure */ });
        } else if (msg?.kind === 'log') {
            if (msg.level === 'warn') console.warn(msg.message);
            else                       console.log(msg.message);
        } else if (msg?.kind === 'private-state-rpc') {
            dispatchPrivateStateRpc(msg);
        }
    });

    worker.on('error', err => {
        console.error('[wallet-worker-client] worker error:', err);
    });
    worker.on('exit', code => {
        console.warn(`[wallet-worker-client] worker exited code=${code}`);
        client = null;
    });

    await readyPromise;
    console.log('[wallet-worker-client] worker ready');
}

/**
 * Stop the worker. Safe to call multiple times. Waits up to `timeoutMs` for
 * graceful exit before terminating.
 */
export async function stopWalletWorker(timeoutMs = 5000): Promise<void> {
    if (!client) return;
    const w = client.worker;
    client = null;
    try {
        await Promise.race([
            new Promise<void>(resolve => w.once('exit', () => resolve())),
            new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
        ]);
    } finally {
        // Force-terminate if still alive.
        try { await w.terminate(); } catch {}
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
    client.stateSaveSink = sink;
}

/**
 * Generic RPC helper. Allocates a MessageChannel per call, posts the request
 * with port1 transferred to the worker, awaits the single reply on port2.
 *
 * Error shape: worker posts `{ ok: false, error: { name, message } }` so we
 * can rehydrate `err.name` here; TransactionSubmitter's classifySubmissionError
 * branches on `err.name === 'TxFailedError'` etc. Falls back to a plain
 * string for older message shapes (none currently, but cheap defensive).
 */
function rpc<T>(method: string, args: unknown): Promise<T> {
    if (!client) {
        return Promise.reject(new Error('wallet-worker not started'));
    }
    return new Promise<T>((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        port2.once('message', (msg: any) => {
            port2.close();
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
            port2.close();
            reject(err);
        });
        client!.worker.postMessage(
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
            console.warn(`[wallet-worker-client] setContractAddress: unknown proxyId=${String(proxyId).slice(0, 16)}`);
            return;
        }
        try {
            provider.setContractAddress(...(args as [string]));
        } catch (err) {
            console.warn('[wallet-worker-client] setContractAddress failed:', formatErr(err));
        }
        return;
    }

    if (!port) {
        console.warn(`[wallet-worker-client] private-state-rpc missing port for method=${method}`);
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
                    name:    err?.name ?? 'Error',
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
        case 'set':                return provider.set(args[0] as string, args[1]);
        case 'get':                return provider.get(args[0] as string);
        case 'remove':             return provider.remove(args[0] as string);
        case 'clear':              return provider.clear();
        case 'setSigningKey':      return provider.setSigningKey(args[0] as string, args[1] as string);
        case 'getSigningKey':      return provider.getSigningKey(args[0] as string);
        case 'removeSigningKey':   return provider.removeSigningKey(args[0] as string);
        case 'clearSigningKeys':   return provider.clearSigningKeys();
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
    return rpc('waitForSyncedState', { sessionId, timeoutMs });
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
    artifactPath:   string;
    privateStateId: string;
    zkConfigPath:   string;
}

export interface WalletDeployContractArgs {
    sessionId: string;
    /** Ephemeral key tying the worker-side PS proxy back to a main-side provider. */
    proxyId:   string;
    contractName: string;
    registration: WorkerContractRegistration;
    indexerHttpUrl: string;
    indexerWsUrl:   string;
    proofServerUrl: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    /** User-supplied private state for the new contract. Plain JSON-able value. */
    initialPrivateState: unknown;
}

export interface WalletSubmitContractCallArgs {
    sessionId: string;
    proxyId:   string;
    contractName: string;
    registration: WorkerContractRegistration;
    contractAddress: string;
    circuit: string;
    args: unknown[];
    indexerHttpUrl: string;
    indexerWsUrl:   string;
    proofServerUrl: string;
    networkId: 'preprod' | 'testnet' | 'mainnet' | 'undeployed' | 'devnet' | 'qanet' | 'preview';
    /**
     * Per-call ZK-predicate witnesses for `commitValue`/`provePredicate`
     * (decimal value + 64-hex salt). Forwarded to the witness factory so the
     * hidden value never leaves as a circuit arg. Omitted for other circuits.
     */
    witnessValues?: { attestedValue: string; valueSalt: string };
    /**
     * Per-call Merkle inclusion proof for `proveFieldPredicate` (scaled field
     * value + DEPTH=4 sibling path + direction flags). Forwarded to the witness
     * factory; never a circuit arg. Omitted for other circuits.
     */
    merkleProof?: { fieldValue: string; siblings: string[]; dirs: boolean[] };
    /**
     * Private state to seed when THIS wallet has none for the contract yet (a
     * wallet that did not deploy it: the multi-caller case, e.g. several
     * producers anchoring in one shared vault). Defaults to `{}`. Never
     * overwrites an existing private state.
     */
    initialPrivateState?: unknown;
}

/**
 * Deploy a Compact-emitted contract through the wallet worker. The worker
 * owns the SDK and the wallet facade; private-state CRUD round-trips back to
 * the main-side provider registered under `proxyId`.
 *
 * Returns primitives only (no SDK objects cross the thread boundary).
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

/** Test-only: reset the singleton so subsequent calls re-spawn. */
export function __resetWalletWorkerForTests(): void {
    client = null;
    privateStateProviders.clear();
}
