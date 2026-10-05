/** Main-thread functions that forward `sendNight` and wallet diagnostics to the wallet worker thread. */

import {
    walletTransferNight,
    type SubmitIntentHook,
    walletGetBalance,
    walletEstimateTransferFee
} from '../midnight/wallet-worker-client';

// ---- sendNight ------------------------------------------------------------

export interface SendNightArgs {
    /** The account id. The worker keeps one wallet per account under this key. */
    cacheKey: string;
    /** Shielded (`mn_shield-addr_...`) or unshielded (`mn_addr_...`). */
    receiverAddress: string;
    /** NIGHT atoms, decimal string. */
    amount: string;
    /** Transaction expiry. Defaults to 10 minutes from now. */
    ttlIso?: string;
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to send instead of NIGHT. */
    tokenTypeHex?: string;
    /** Called before the broadcast. It saves the transaction id, and only then the worker sends. */
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
    rpcTimeoutMs?: number;
}

export interface WalletBalanceSnapshot {
    shieldedNight: string;
    unshieldedNight: string;
    shieldedTokens: Array<{ tokenType: string; amount: string }>;
    dustBalance: string;
    registeredNightUtxoCount: number;
    totalNightUtxoCount: number;
    dustUtxoCount: number;
    dustPendingCount: number;
    dustPendingValue: string;
    /** How often this process restored the dust wallet from a snapshot taken before a build. */
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
