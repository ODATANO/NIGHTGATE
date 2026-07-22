/**
 * DUST registration.
 *
 * NIGHT UTXOs must be registered for DUST generation before they produce the
 * fee-token DUST (docs.midnight.network/guides/generating-dust-programmatically).
 * On preprod the initial accrual takes 1-2 minutes after the registration tx.
 *
 * A single RPC to the wallet worker (`walletRegisterDustGeneration`) runs the
 * whole flow in the worker's own event loop (sync → filter → build recipe →
 * finalizeRecipe → submit); no SDK objects cross the thread boundary. The caller
 * (`wallet-sessions.ts::registerForDustGeneration`) must have initialised the
 * worker for `cacheKey` via `getOrBuildWalletFacade(...)` first.
 */

import { walletRegisterDustGeneration, walletDeregisterDustGeneration } from '../midnight/wallet-worker-client';
import type { WalletFacadeBuildArgs } from './wallet-facade-builder';

export interface RegisterDustGenerationArgs {
    cacheKey: string;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>;
    seedHex: string;
    /**
     * Optional override for where generated DUST should accrue (Bech32m
     * DUST address). Defaults to the wallet's own dust address (derived from
     * the seed by the SDK).
     */
    dustReceiverAddress?: string;
    /**
     * Maximum time to wait for the wallet to be fully synced before refusing.
     * Default: undefined → wait indefinitely (initial preprod sync can take
     * hours; the facade pre-warm in `connectWalletForSigning` should have
     * started this long before).
     */
    syncTimeoutMs?: number;
}

export interface RegisterDustGenerationResult {
    /** Transaction ID of the registration submission. Null if nothing needed registering. */
    txId: string | null;
    /** Number of UTXOs that were registered in this call. */
    registeredCount: number;
    /** Total number of NIGHT UTXOs in the wallet at registration time. */
    totalNightUtxos: number;
    /** Dust receiver used (derived or user-supplied). */
    dustReceiverAddress: string;
}

export async function registerNightUtxosForDust(
    args: RegisterDustGenerationArgs
): Promise<RegisterDustGenerationResult> {
    // Delegate the whole flow via one RPC; the worker returns primitives that
    // survive the thread boundary.
    return walletRegisterDustGeneration({
        sessionId:           args.cacheKey,
        dustReceiverAddress: args.dustReceiverAddress,
        syncTimeoutMs:       args.syncTimeoutMs
    });
}

// ---- Deregister ----------------------------------------------------------

export interface DeregisterDustGenerationArgs {
    cacheKey: string;
    /**
     * Max wait for sync. Default: undefined (wait indefinitely). Production
     * callers should pass a positive bound; pre-warm runs separately, the
     * deregister handler should not block longer than a few seconds once the
     * facade is healthy.
     */
    syncTimeoutMs?: number;
    /**
     * Optional fee sponsor (facade key, i.e. accountId): the sponsor facade
     * balances the deregistration fee from ITS dust and submits. Escape hatch
     * for a wallet whose whole generation is delegated away (own dust 0).
     */
    sponsorCacheKey?: string;
}

export interface DeregisterDustGenerationResult {
    /** Transaction ID of the deregistration tx. Null if nothing to deregister. */
    txId: string | null;
    /** Number of UTXOs that were deregistered in this call. */
    deregisteredCount: number;
    /** Total NIGHT UTXOs visible to the wallet (registered + unregistered). */
    totalNightUtxos: number;
}

export async function deregisterNightUtxosFromDust(
    args: DeregisterDustGenerationArgs
): Promise<DeregisterDustGenerationResult> {
    return walletDeregisterDustGeneration({
        sessionId:        args.cacheKey,
        syncTimeoutMs:    args.syncTimeoutMs,
        sponsorSessionId: args.sponsorCacheKey
    });
}
