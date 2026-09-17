/**
 * Submit-failure classification into the closed code set of `wallet-worker-protocol.ts`.
 * The worker attaches the code to its RPC reply; the main thread re-runs this only for
 * errors that never crossed the RPC. Downstream decisions key on the code, never on wording.
 * SPDX-License-Identifier: Apache-2.0
 */

import { classificationHaystack, formatErr } from '../utils/format-error';
import { dustRaceLedgerCode } from '../submission/dust-race';
import {
    carriedSubmitFailure, type BatchCallStageInfo, type SubmitFailureInfo
} from './wallet-worker-protocol';

/** A sponsor shape or allow-list refusal raised by the worker's inspection. */
export class SponsorRefusalError extends Error {
    readonly code = 'policy' as const;
    readonly retryable = false;
    constructor(message: string) {
        super(message);
        this.name = 'SponsorRefusalError';
    }
}

const MAX_CHAIN = 8;

/** The error and its `cause` chain, outermost first, bounded and cycle-safe. */
export function errorChain(err: unknown): unknown[] {
    const out: unknown[] = [];
    const seen = new Set<unknown>();
    let cur: any = err;
    while (cur != null && !seen.has(cur) && out.length < MAX_CHAIN) {
        seen.add(cur);
        out.push(cur);
        cur = typeof cur === 'object' ? cur.cause : undefined;
    }
    return out;
}

/** Messages of the cause chain below the top error, outermost first. */
export function causeMessages(err: unknown): string[] {
    return errorChain(err).slice(1).map(formatErr).filter((m) => m.length > 0);
}

function nameOf(e: unknown): string {
    return typeof (e as any)?.name === 'string' ? String((e as any).name) : '';
}

/**
 * Reconstruct the per-call stage list from the causality message when the
 * SDK's scope wrapper dropped the error object (it keeps only the text):
 * `Stages in apply order: attest=1158[f] anchor=1159[g]`.
 */
export function parseBatchCallStages(text: string): BatchCallStageInfo[] {
    const at = text.indexOf('Stages in apply order:');
    if (at < 0) return [];
    const calls: BatchCallStageInfo[] = [];
    // Consecutive `name=segId[stages]` tokens only: the list ends at the first
    // token of another shape (the inspected text repeats the message).
    for (const token of text.slice(at + 'Stages in apply order:'.length).trim().split(/\s+/)) {
        const hit = /^(\S+?)=(\d+)\[([^\]]*)\]$/.exec(token);
        if (!hit) break;
        calls.push({ name: hit[1], segId: Number(hit[2]), stages: hit[3] });
    }
    return calls;
}

// A connection that failed or closed: the request may never have left, the
// worker probes the indexer for the identifier before it resends the same bytes.
const TRANSPORT_RE = /disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Unable to connect/i;
// Sent, no reply: the tx may be pooled or landed, so never resend (1013 duplicate)
// or rebuild; reconciliation resolves the identifier.
const NO_REPLY_RE = /TimeoutError|TimeoutException|timed? ?out|no reply|no response|request timeout/i;

/**
 * Order matters: carried code, then outcome-shaped errors, node rejects, connection
 * wording, and no-reply last (a watch timeout also says "timed out").
 */
export function classifySubmitFailure(err: unknown): SubmitFailureInfo {
    const carried = carriedSubmitFailure(err);
    if (carried) return carried;

    const chain = errorChain(err);
    const names = chain.map(nameOf);
    const message = formatErr(err);
    const haystack = `${message} ${classificationHaystack(err)}`;

    // The SDK's scope wrapper may keep only the message, hence the parse fallback.
    const causality = chain.find((e: any) => e?.code === 'BatchCausalityViolation' || nameOf(e) === 'BatchCausalityError');
    if (causality || /violates the ledger's causality constraint/.test(haystack)) {
        const own = Array.isArray((causality as any)?.calls) ? (causality as any).calls as BatchCallStageInfo[] : undefined;
        return { code: 'causality', retryable: false, calls: own?.length ? own : parseBatchCallStages(haystack) };
    }
    // An earlier send of the same bytes is unresolved: whatever the later attempt said, the
    // identifier may still land. Checked before the phase and reject rules, which sit in its cause.
    if (names.includes('SubmitOutcomeUnknownError')) return { code: 'ambiguous', ledgerCode: 'unresolved-send', retryable: false };
    // Only a connect-phase failure is safe to resend; request and watch may have reached the node.
    const phased = chain.find((e: any) => nameOf(e) === 'SubmitPhaseError' && typeof e?.phase === 'string') as any;
    if (phased) {
        if (phased.phase === 'connect') return { code: 'transport', ledgerCode: 'not-sent', retryable: true };
        if (phased.phase === 'request') return { code: 'ambiguous', ledgerCode: 'no-reply', retryable: false };
        return { code: 'ambiguous', retryable: false };
    }
    if (names.includes('SubmitWatchTimeoutError') || /submit watch timed out/i.test(haystack)) {
        return { code: 'ambiguous', retryable: false };
    }
    if (names.includes('TxFailedError') || /did NOT apply|but did not apply/i.test(haystack)) {
        // Block height = rollback coordinate; without it the job parks for the indexer confirmer.
        const blockHeight = errorChain(err).map(e => (e as any)?.blockHeight).find(v => Number.isInteger(v) && v >= 0);
        return { code: 'landed-not-applied', retryable: false, ...(Number.isInteger(blockHeight) ? { blockHeight } : {}) };
    }
    if (names.includes('SponsorRefusalError') || /refusing to sponsor/i.test(haystack)) {
        return { code: 'policy', retryable: false };
    }
    if (/submit-intent was not acknowledged/i.test(haystack)) {
        return { code: 'pre-mempool-reject', ledgerCode: 'intent-timeout', retryable: false };
    }
    if (/submit-intent rejected/i.test(haystack)) {
        return { code: 'pre-mempool-reject', ledgerCode: 'intent-rejected', retryable: false };
    }
    const dustRace = dustRaceLedgerCode(err);
    if (dustRace) return { code: 'dust-race', ledgerCode: dustRace, retryable: true };
    if (/InvalidDustSpendProof/i.test(haystack)) return { code: 'dust-race', ledgerCode: '1010/170', retryable: true };
    // Pool status Invalid without a ledger code: the loser of a note race, or a
    // caller transaction that is structurally allowed but invalid. One rebuild.
    if (/TransactionInvalidError|Transaction is invalid and was rejected by the node/i.test(haystack)) {
        return { code: 'dust-race', ledgerCode: 'pool-invalid', retryable: true };
    }
    // Our own closing socket: nothing was broadcast.
    if (/closing socket/i.test(haystack)) return { code: 'transport', ledgerCode: 'closing-socket', retryable: true };
    // "priority is too low" first: its "(X vs Y)" numbers must not be misread as a 1010 code.
    if (/priority is too low|\b1014\s*:/i.test(haystack)) {
        return { code: 'pre-mempool-reject', ledgerCode: '1014', retryable: false };
    }
    if (/\b1016\s*:|immediately dropped/i.test(haystack)) {
        return { code: 'pre-mempool-reject', ledgerCode: '1016', retryable: true };
    }
    if (/\b1010\s*:|invalid transaction/i.test(haystack)) {
        const custom = /custom error:?\s*(\d+)/i.exec(haystack);
        return { code: 'pre-mempool-reject', ledgerCode: custom ? `1010/${custom[1]}` : '1010', retryable: false };
    }
    if (TRANSPORT_RE.test(haystack)) return { code: 'transport', retryable: true };
    if (NO_REPLY_RE.test(haystack)) return { code: 'ambiguous', ledgerCode: 'no-reply', retryable: false };
    return { code: 'internal', retryable: false };
}

/** The node refused the transaction before the mempool and no fee was spent. */
export function isPreMempoolFailure(info: SubmitFailureInfo): boolean {
    if (info.code === 'pre-mempool-reject') return info.ledgerCode !== 'intent-rejected' && info.ledgerCode !== 'intent-timeout';
    return info.code === 'dust-race' && info.ledgerCode !== 'pool-invalid';
}
