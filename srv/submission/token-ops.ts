/**
 * Token operations — thin wrappers around the wallet-worker RPCs that
 * implement the OData `sendNight` / `shieldFunds` / `unshieldFunds`
 * actions. Each wrapper translates between the OData/user-facing shape
 * and the worker's primitive RPC contract.
 *
 * Pattern mirrors `srv/submission/dust-registration.ts`. The worker owns
 * the wallet facade; main thread just orchestrates and persists the
 * audit record.
 */

import {
    walletTransferNight,
    walletUnshieldNight,
    walletShieldNight,
    walletGetBalance,
    walletEstimateTransferFee,
    walletEstimateSwapFee
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
        syncTimeoutMs:   args.syncTimeoutMs
    });
}

// ---- unshieldFunds --------------------------------------------------------

export interface UnshieldFundsArgs {
    cacheKey: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}

export interface UnshieldFundsResult {
    txId: string;
    amount: string;
    /** The wallet's own unshielded address (Bech32m) where the funds landed. */
    unshieldedReceiverAddress: string;
}

export async function unshieldFunds(args: UnshieldFundsArgs): Promise<UnshieldFundsResult> {
    return walletUnshieldNight({
        sessionId:     args.cacheKey,
        amount:        args.amount,
        ttlIso:        args.ttlIso,
        syncTimeoutMs: args.syncTimeoutMs
    });
}

// ---- shieldFunds (symmetric counterpart) ----------------------------------

export interface ShieldFundsArgs {
    cacheKey: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}

export interface ShieldFundsResult {
    txId: string;
    amount: string;
    /** The wallet's own shielded address (Bech32m) where the funds landed. */
    shieldedReceiverAddress: string;
}

export async function shieldFunds(args: ShieldFundsArgs): Promise<ShieldFundsResult> {
    return walletShieldNight({
        sessionId:     args.cacheKey,
        amount:        args.amount,
        ttlIso:        args.ttlIso,
        syncTimeoutMs: args.syncTimeoutMs
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

export interface EstimateSwapFeeArgs {
    cacheKey: string;
    amount: string;
    ttlIso?: string;
    syncTimeoutMs?: number;
}

export interface EstimateSwapFeeResult {
    /** Dust atoms as decimal string. */
    fee: string;
    direction: 'shield' | 'unshield';
}

export async function estimateUnshieldFee(args: EstimateSwapFeeArgs): Promise<EstimateSwapFeeResult> {
    return walletEstimateSwapFee({
        sessionId:     args.cacheKey,
        direction:     'unshield',
        amount:        args.amount,
        ttlIso:        args.ttlIso,
        syncTimeoutMs: args.syncTimeoutMs
    });
}

export async function estimateShieldFee(args: EstimateSwapFeeArgs): Promise<EstimateSwapFeeResult> {
    return walletEstimateSwapFee({
        sessionId:     args.cacheKey,
        direction:     'shield',
        amount:        args.amount,
        ttlIso:        args.ttlIso,
        syncTimeoutMs: args.syncTimeoutMs
    });
}
