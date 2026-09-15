/** Main-thread wrappers mapping `sendNight` and wallet diagnostics onto worker RPCs. */

import {
    walletTransferNight,
    type SubmitIntentHook,
    walletGetBalance,
    walletEstimateTransferFee
} from '../midnight/wallet-worker-client';

// ---- sendNight ------------------------------------------------------------

export interface SendNightArgs {
    /** Worker facade key (the accountId). */
    cacheKey: string;
    /** Shielded (`mn_shield-addr_...`) or unshielded (`mn_addr_...`). */
    receiverAddress: string;
    /** NIGHT atoms, decimal string. */
    amount: string;
    /** Defaults to +10 min in the worker. */
    ttlIso?: string;
    /** Undefined waits indefinitely. */
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to send instead of NIGHT. */
    tokenTypeHex?: string;
    /** Pre-broadcast handshake: persist the announced identifier, then the worker sends. */
    onSubmitIntent?: SubmitIntentHook;
}

export interface SendNightResult {
    txId: string;
    toLedger: 'shielded' | 'unshielded';
    amount: string;
    receiverAddress: string;
}

export async function sendNight(args: SendNightArgs): Promise<SendNightResult> {
    return walletTransferNight({
        sessionId:       args.cacheKey,
        receiverAddress: args.receiverAddress,
        amount:          args.amount,
        ttlIso:          args.ttlIso,
        syncTimeoutMs:   args.syncTimeoutMs,
        tokenTypeHex:    args.tokenTypeHex
    }, args.onSubmitIntent);
}

// ---- Diagnostics: getWalletBalance ---------------------------------------

export interface GetWalletBalanceArgs {
    cacheKey: string;
    syncTimeoutMs?: number;
    /** Bounds the worker RPC itself, so an abandoned read cannot linger. */
    rpcTimeoutMs?: number;
}

export interface WalletBalanceSnapshot {
    shieldedNight: string;
    unshieldedNight: string;
    /** Non-NIGHT shielded tokens with a non-zero balance: raw 64-hex type, atoms. */
    shieldedTokens: Array<{ tokenType: string; amount: string }>;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
    dustUtxoCount: number;
    /** DUST spends in flight, awaiting confirmation. */
    dustPendingCount: number;
    dustPendingValue: string;
    /** Dust sub-wallet restores from a pre-build snapshot in this process. */
    dustRestoreCount: number;
}

export async function getWalletBalance(args: GetWalletBalanceArgs): Promise<WalletBalanceSnapshot> {
    return walletGetBalance({
        sessionId:     args.cacheKey,
        syncTimeoutMs: args.syncTimeoutMs,
        rpcTimeoutMs:  args.rpcTimeoutMs
    });
}

// ---- Diagnostics: estimate fees ------------------------------------------

export interface EstimateSendNightFeeArgs {
    cacheKey: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to price instead of NIGHT. */
    tokenTypeHex?: string;
}

export interface EstimateFeeResult {
    /** Dust atoms, decimal string. */
    fee: string;
    toLedger: 'shielded' | 'unshielded';
}

export async function estimateSendNightFee(args: EstimateSendNightFeeArgs): Promise<EstimateFeeResult> {
    return walletEstimateTransferFee({
        sessionId:       args.cacheKey,
        receiverAddress: args.receiverAddress,
        amount:          args.amount,
        ttlIso:          args.ttlIso,
        syncTimeoutMs:   args.syncTimeoutMs,
        tokenTypeHex:    args.tokenTypeHex
    });
}
