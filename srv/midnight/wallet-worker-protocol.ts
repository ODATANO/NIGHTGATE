/**
 * Shared constants and types for messages between the main thread and the wallet worker.
 * Keep this file free of imports, because the main thread must never load the worker's SDK.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { NightgateErrorPayload } from '../utils/errors';

/**
 * Methods that hold the session's submit lock, so a session is never removed while they run.
 * Each one reports its tx id to the main thread before it sends the tx.
 */
export const SUBMIT_METHODS: ReadonlySet<string> = new Set([
    'deployContract', 'submitContractCall', 'submitContractCallBatch',
    'registerDustGeneration', 'deregisterDustGeneration',
    'transferNight', 'buildSponsorableTx', 'sponsorFinalizedTx'
]);

/**
 * Methods that may send a transaction. `sponsorUnboundTx` is one of them but takes no submit lock.
 * A worker restart waits for these calls and never repeats them.
 */
export function isSubmittingMethod(method: string): boolean {
    return SUBMIT_METHODS.has(method) || method === 'sponsorUnboundTx';
}

/** The worker accepts no new calls because it is about to restart. The client retries on the new worker. */
export const WORKER_ROTATING = 'WORKER_ROTATING';
/** The worker was restarted while this call was still running. */
export const WORKER_ROTATED = 'WORKER_ROTATED';

/**
 * Why a submit failed. The main thread decides on this code, never on message text.
 *  pre-mempool-reject  the node refused the tx and no fee was spent. `ledgerCode` holds the node's code.
 *  dust-race           another tx spent the same dust first. Build again and retry.
 *  transport           the connection broke before an answer. The tx may be sent again.
 *  ambiguous           the tx may have landed. Never rebuild. Look it up by its id instead.
 *  landed-not-applied  the tx is in a block, but the contract call did not apply.
 *  policy              the fee sponsor refused the tx.
 *  causality           the batch calls are in an order the ledger rejects. Found before proving.
 *  internal            anything else.
 */
export const SUBMIT_FAILURE_CODES = [
    'pre-mempool-reject', 'dust-race', 'transport', 'ambiguous',
    'landed-not-applied', 'policy', 'causality', 'internal'
] as const;
export type SubmitFailureCode = typeof SUBMIT_FAILURE_CODES[number];

export function isSubmitFailureCode(value: unknown): value is SubmitFailureCode {
    return typeof value === 'string' && (SUBMIT_FAILURE_CODES as readonly string[]).includes(value);
}

/** One call of a batch and where the ledger applies it. Used for `causality` errors. */
export interface BatchCallStageInfo { name: string; segId: number; stages: string }

export interface SubmitFailureInfo {
    code: SubmitFailureCode;
    ledgerCode?: string;
    /** Whether the same work may be tried again, by rebuilding or by sending again. */
    retryable: boolean;
    calls?: BatchCallStageInfo[];
    /** For `landed-not-applied`: the block the tx landed in. A chain rollback uses it. */
    blockHeight?: number;
}

/** The worker's error reply. `code` and the fields after it are set only for submitting methods. */
export interface RpcErrorPayload {
    name: string;
    message: string;
    /** Messages of the nested causes, outermost first. */
    causes?: string[];
    code?: SubmitFailureCode;
    ledgerCode?: string;
    retryable?: boolean;
    calls?: BatchCallStageInfo[];
    blockHeight?: number;
    /** Our own coded error, if one is among the causes, so it reaches the main thread intact. */
    nightgate?: NightgateErrorPayload;
}

/** The worker's submit error, rebuilt on the main thread. */
export class WorkerSubmitError extends Error {
    readonly code: SubmitFailureCode;
    readonly ledgerCode?: string;
    readonly retryable: boolean;
    readonly calls?: BatchCallStageInfo[];
    readonly blockHeight?: number;
    readonly causes: string[];
    constructor(payload: RpcErrorPayload & { code: SubmitFailureCode }) {
        super(payload.message);
        this.name = payload.name || 'Error';
        this.code = payload.code;
        this.ledgerCode = payload.ledgerCode;
        this.retryable = payload.retryable === true;
        this.calls = payload.calls;
        this.blockHeight = Number.isInteger(payload.blockHeight) ? payload.blockHeight : undefined;
        this.causes = Array.isArray(payload.causes) ? payload.causes : [];
    }
}

/** The failure code an error already carries from the worker, or null. */
export function carriedSubmitFailure(err: unknown): SubmitFailureInfo | null {
    const e = err as any;
    if (!e || typeof e !== 'object' || !isSubmitFailureCode(e.code)) return null;
    return {
        code: e.code,
        ledgerCode: typeof e.ledgerCode === 'string' ? e.ledgerCode : undefined,
        retryable: e.retryable === true,
        calls: Array.isArray(e.calls) ? e.calls : undefined,
        blockHeight: Number.isInteger(e.blockHeight) ? e.blockHeight : undefined
    };
}
