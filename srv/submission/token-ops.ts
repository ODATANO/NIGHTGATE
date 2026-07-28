/**
 * Token operations: thin wrappers around the wallet-worker RPCs backing the
 * OData `sendNight` action and wallet diagnostics, translating the
 * user-facing shape to the worker's primitive RPC contract. The worker owns the
 * wallet facade; the main thread only orchestrates.
 */

import {
    walletTransferNight,
    walletGetBalance,
    walletEstimateTransferFee
} from '../midnight/wallet-worker-client';

// ---- sendNight ------------------------------------------------------------

export interface SendNightArgs {
    /** Worker facade key (typically the accountId derived from the viewing key). */
    cacheKey: string;
    /** Bech32m receiver address, either shielded (`mn_shield-addr_...`) or unshielded (`mn_addr_...`). */
    receiverAddress: string;
    /** NIGHT atoms as decimal string; parsed to bigint inside the worker. */
    amount: string;
    /** ISO-8601 TTL for the transaction. Defaults to +10min in the worker. */
    ttlIso?: string;
    /** Max wait for wallet sync before send. Undefined = wait indefinitely. */
    syncTimeoutMs?: number;
    /** Raw token type (64 hex) to send instead of NIGHT; e.g. a contract-minted shielded token. */
    tokenTypeHex?: string;
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
    });
}

// ---- Diagnostics: getWalletBalance ---------------------------------------

export interface GetWalletBalanceArgs {
    cacheKey: string;
    syncTimeoutMs?: number;
}

export interface WalletBalanceSnapshot {
    /** NIGHT atoms held on the shielded ledger, decimal string. */
    shieldedNight: string;
    /** NIGHT atoms held on the unshielded ledger, decimal string. */
    unshieldedNight: string;
    /** Current DUST atoms (accrued from registered NIGHT), decimal string. */
    dustBalance: string;
    /** Number of NIGHT UTXOs currently registered for dust generation. */
    registeredNightUtxoCount: number;
    /** Total NIGHT UTXOs the wallet tracks (registered + unregistered). */
    totalNightUtxoCount: number;
}

export async function getWalletBalance(args: GetWalletBalanceArgs): Promise<WalletBalanceSnapshot> {
    return walletGetBalance({
        sessionId:     args.cacheKey,
        syncTimeoutMs: args.syncTimeoutMs
    });
}

// ---- Diagnostics: estimate fees ------------------------------------------

export interface EstimateSendNightFeeArgs {
    cacheKey: string;
    receiverAddress: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}

export interface EstimateFeeResult {
    /** Dust atoms as decimal string. */
    fee: string;
    /** Destination ledger derived from receiver address prefix. */
    toLedger: 'shielded' | 'unshielded';
}

export async function estimateSendNightFee(args: EstimateSendNightFeeArgs): Promise<EstimateFeeResult> {
    return walletEstimateTransferFee({
        sessionId:       args.cacheKey,
        receiverAddress: args.receiverAddress,
        amount:          args.amount,
        ttlIso:          args.ttlIso,
        syncTimeoutMs:   args.syncTimeoutMs
    });
}
