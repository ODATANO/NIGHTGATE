/** Main-thread functions that forward `sendToken` and wallet diagnostics to the wallet worker thread. */

import {
    walletTransferToken,
    type SubmitIntentHook,
    walletGetBalance,
    walletEstimateTransferFee
} from '../midnight/wallet-worker-client';

// ---- sendToken ------------------------------------------------------------

export interface SendTokenArgs {
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
    tokenType?: string;
    /** Called before the broadcast. It saves the transaction id, and only then the worker sends. */
    onSubmitIntent?: SubmitIntentHook;
}

export interface SendTokenResult {
    txId: string;
    toLedger: 'shielded' | 'unshielded';
    amount: string;
    receiverAddress: string;
}

export async function sendToken(args: SendTokenArgs): Promise<SendTokenResult> {
    return walletTransferToken({
        sessionId:       args.cacheKey,
        receiverAddress: args.receiverAddress,
        amount:          args.amount,
        ttlIso:          args.ttlIso,
        syncTimeoutMs:   args.syncTimeoutMs,
        tokenType:    args.tokenType
    }, args.onSubmitIntent);
}

// ---- Diagnostics: getWalletBalance ---------------------------------------

export interface GetWalletBalanceArgs {
    cacheKey: string;
    syncTimeoutMs?: number;
    rpcTimeoutMs?: number;
}

import type { WalletBalanceSnapshot } from '../midnight/wallet-worker-client';
export type { WalletBalanceSnapshot };

export async function getWalletBalance(args: GetWalletBalanceArgs): Promise<WalletBalanceSnapshot> {
    return walletGetBalance({
        sessionId:     args.cacheKey,
        syncTimeoutMs: args.syncTimeoutMs,
        rpcTimeoutMs:  args.rpcTimeoutMs
    });
}

// ---- Diagnostics: estimate fees ------------------------------------------

export interface EstimateSendTokenFeeArgs {
    cacheKey: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to price instead of NIGHT. */
    tokenType?: string;
}

export interface EstimateFeeResult {
    /** Dust atoms, decimal string. */
    fee: string;
    toLedger: 'shielded' | 'unshielded';
}

export async function estimateSendTokenFee(args: EstimateSendTokenFeeArgs): Promise<EstimateFeeResult> {
    return walletEstimateTransferFee({
        sessionId:       args.cacheKey,
        receiverAddress: args.receiverAddress,
        amount:          args.amount,
        ttlIso:          args.ttlIso,
        syncTimeoutMs:   args.syncTimeoutMs,
        tokenType:    args.tokenType
    });
}
