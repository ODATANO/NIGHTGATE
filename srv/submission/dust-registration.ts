/**
 * DUST (de)registration of NIGHT UTXOs, one worker RPC each. The caller must
 * have built the worker facade for `cacheKey` first.
 */

import { walletRegisterDustGeneration, walletDeregisterDustGeneration, type RegisterDustGenerationOutcome, type SubmitIntentHook } from '../midnight/wallet-worker-client';
import type { WalletFacadeBuildArgs } from './wallet-facade-builder';

export interface RegisterDustGenerationArgs {
    cacheKey: string;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>;
    seedHex: string;
    /** Bech32m DUST address to accrue to; defaults to the wallet's own. */
    dustReceiverAddress?: string;
    /** Max wait for wallet sync; undefined waits indefinitely. */
    syncTimeoutMs?: number;
    /** Pre-broadcast handshake: persist the announced identifier, then the worker sends. */
    onSubmitIntent?: SubmitIntentHook;
}

export type RegisterDustGenerationResult = RegisterDustGenerationOutcome;

export async function registerNightUtxosForDust(
    args: RegisterDustGenerationArgs
): Promise<RegisterDustGenerationResult> {
    return walletRegisterDustGeneration({
        sessionId:           args.cacheKey,
        dustReceiverAddress: args.dustReceiverAddress,
        syncTimeoutMs:       args.syncTimeoutMs
    }, args.onSubmitIntent);
}

// ---- Deregister ----------------------------------------------------------

export interface DeregisterDustGenerationArgs {
    cacheKey: string;
    /** Max wait for sync; undefined waits indefinitely, so production callers pass a bound. */
    syncTimeoutMs?: number;
    /** Sponsor facade key that pays the fee: for a wallet whose generation is delegated away (own dust 0). */
    sponsorCacheKey?: string;
    /** Pre-broadcast handshake: persist the announced identifier, then the worker sends. */
    onSubmitIntent?: SubmitIntentHook;
}

export interface DeregisterDustGenerationResult {
    /** Null if nothing to deregister. */
    txId: string | null;
    deregisteredCount: number;
    /** Registered + unregistered. */
    totalNightUtxos: number;
}

export async function deregisterNightUtxosFromDust(
    args: DeregisterDustGenerationArgs
): Promise<DeregisterDustGenerationResult> {
    return walletDeregisterDustGeneration({
        sessionId:        args.cacheKey,
        syncTimeoutMs:    args.syncTimeoutMs,
        sponsorSessionId: args.sponsorCacheKey
    }, args.onSubmitIntent);
}
