/**
 * Constants both sides of the wallet-worker RPC share. Dependency-free: the
 * main thread must never import the worker module (it loads the ESM SDK).
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Methods that run under the worker's per-session submit lock (an evict waits
 * for them); each announces its tx identifier before broadcasting.
 */
export const SUBMIT_METHODS: ReadonlySet<string> = new Set([
    'deployContract', 'submitContractCall', 'submitContractCallBatch',
    'registerDustGeneration', 'deregisterDustGeneration',
    'transferNight', 'buildSponsorableTx', 'sponsorFinalizedTx'
]);

/**
 * Methods that may broadcast: SUBMIT_METHODS plus the unbound sponsor path (no
 * whole-call lock). A rotation drain waits for these and never repeats them.
 */
export function isSubmittingMethod(method: string): boolean {
    return SUBMIT_METHODS.has(method) || method === 'sponsorUnboundTx';
}

/** Refusal name: admission closed for a rotation; the client retries on the respawn. */
export const WORKER_ROTATING = 'WORKER_ROTATING';
/** Rejection name: the worker was terminated for its rotation while this call was in flight. */
export const WORKER_ROTATED = 'WORKER_ROTATED';

// ---- Submit-failure classification, shared by both sides -------------------

/**
 * Submit-failure codes. The worker classifies against the SDK error objects;
 * the main thread branches on the code, never on message text.
 *  pre-mempool-reject  refused before the mempool, fee unspent; `ledgerCode` =
 *                      node code, `intent-rejected` or `intent-timeout`
 *  dust-race           1010/170, 1010/196 or `pool-invalid`; rebuild-retryable
 *  transport           send died before an answer; resend-eligible
 *                      (`closing-socket`: never left the client)
 *  ambiguous           may have landed; never rebuild, reconcile by identifier
 *  landed-not-applied  in a block, the contract call did not apply
 *  policy              sponsor shape or allow-list refusal
 *  causality           batch causality refusal before proving (`calls`)
 *  internal            anything else
 */
export const SUBMIT_FAILURE_CODES = [
    'pre-mempool-reject', 'dust-race', 'transport', 'ambiguous',
    'landed-not-applied', 'policy', 'causality', 'internal'
] as const;
export type SubmitFailureCode = typeof SUBMIT_FAILURE_CODES[number];

export function isSubmitFailureCode(value: unknown): value is SubmitFailureCode {
    return typeof value === 'string' && (SUBMIT_FAILURE_CODES as readonly string[]).includes(value);
}

/** One batched call's apply position, for a `causality` refusal. */
export interface BatchCallStageInfo { name: string; segId: number; stages: string }

export interface SubmitFailureInfo {
    code: SubmitFailureCode;
    ledgerCode?: string;
    /** Whether the SAME work may be attempted again (rebuild or resend). */
    retryable: boolean;
    calls?: BatchCallStageInfo[];
    /** `landed-not-applied`: the block height the indexer placed the transaction in (rollback coordinate). */
    blockHeight?: number;
}

/** The worker's RPC failure reply. `code` and friends are present on submitting methods only. */
export interface RpcErrorPayload {
    name: string;
    message: string;
    /** Messages of the nested cause chain, outermost first (bounded). */
    causes?: string[];
    code?: SubmitFailureCode;
    ledgerCode?: string;
    retryable?: boolean;
    calls?: BatchCallStageInfo[];    blockHeight?: number;
}

/** Client-side error rebuilt from a classified failure payload. */
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

/** The classification an error carries, when it was classified upstream (worker RPC). */
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
