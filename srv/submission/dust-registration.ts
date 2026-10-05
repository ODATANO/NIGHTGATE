/**
 * Register NIGHT UTXOs for dust generation, or deregister them.
 * The caller must have loaded the wallet for `cacheKey` in the worker first.
 */

import { walletRegisterDustGeneration, walletDeregisterDustGeneration, type RegisterDustGenerationOutcome, type SubmitIntentHook } from '../midnight/wallet-worker-client';
import type { WalletFacadeBuildArgs } from './wallet-facade-builder';

export interface RegisterDustGenerationArgs {
    cacheKey: string;
    facadeConfig: Omit<WalletFacadeBuildArgs, 'seedHex'>;
    seedHex: string;
    /** Dust address that receives the generated dust. Defaults to the wallet's own. */
    dustReceiverAddress?: string;
    syncTimeoutMs?: number;
    /** Called before the broadcast. It saves the transaction id, and only then the worker sends. */
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
    /** Undefined waits for the wallet sync without limit, so production callers should set it. */
    syncTimeoutMs?: number;
    /** Wallet that pays the fee. Needed when this wallet sends its dust elsewhere and has none itself. */
    sponsorCacheKey?: string;
    /** Called before the broadcast. It saves the transaction id, and only then the worker sends. */
    onSubmitIntent?: SubmitIntentHook;
}

export interface DeregisterDustGenerationResult {
    /** Null if nothing to deregister. */
    txId: string | null;
    deregisteredCount: number;
    /** Registered plus unregistered. */
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
