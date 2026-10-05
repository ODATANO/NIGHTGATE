/**
 * Sorts a failed submit into one of the codes in `wallet-worker-protocol.ts`.
 * The worker sends the code along with its error reply.
 * Later decisions use only the code, never the message text.
 * SPDX-License-Identifier: Apache-2.0
 */

import { classificationHaystack, formatErr } from '../utils/format-error';
import { findNightgateError, NightgateError } from '../utils/errors';
import { dustRaceLedgerCode } from '../submission/dust-race';
import {
    carriedSubmitFailure, type BatchCallStageInfo, type SubmitFailureInfo
} from './wallet-worker-protocol';

/** The worker refused to pay fees for a transaction, because of its content or the allow list. */
export class SponsorRefusalError extends NightgateError {
    constructor(message: string) {
        super('SPONSOR_REFUSED', message);
    }
}

const MAX_CHAIN = 8;

/** The error followed by its nested causes, outermost first. Stops at a loop or after a few entries. */
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
 * Reads the call list back out of a batch order error message.
 * Needed because the SDK sometimes passes on only the message text.
 * Example: `Stages in apply order: callA=1158[f] callB=1159[g]`.
 */
export function parseBatchCallStages(text: string): BatchCallStageInfo[] {
    const at = text.indexOf('Stages in apply order:');
    if (at < 0) return [];
    const calls: BatchCallStageInfo[] = [];
    // The list ends at the first word of another shape, because the text may repeat the message.
    for (const token of text.slice(at + 'Stages in apply order:'.length).trim().split(/\s+/)) {
        const hit = /^(\S+?)=(\d+)\[([^\]]*)\]$/.exec(token);
        if (!hit) break;
        calls.push({ name: hit[1], segId: Number(hit[2]), stages: hit[3] });
    }
    return calls;
}

// The connection failed or closed, so the request may never have been sent.
// The worker asks the indexer whether the transaction exists before it sends it again.
const TRANSPORT_RE = /disconnected from|Normal Closure|Abnormal Closure|WebSocket is not connected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Unable to connect/i;
// Sent but no reply. The tx may already be in the mempool or in a block, so never send it
// again (that fails with 1013, duplicate) and never rebuild it. A later check looks it up.
const NO_REPLY_RE = /TimeoutError|TimeoutException|timed? ?out|no reply|no response|request timeout/i;

/** Maps our own error codes to a submit failure. */
function codedSubmitFailure(err: NightgateError | undefined): SubmitFailureInfo | undefined {
    switch (err?.code) {
        // Nothing was built or sent yet, so another wallet or a later retry may succeed.
        case 'WALLET_NOT_SYNCED': return { code: 'transport', ledgerCode: 'wallet-not-synced', retryable: true };
        case 'SUBMIT_INTENT_TIMEOUT': return { code: 'pre-mempool-reject', ledgerCode: 'intent-timeout', retryable: false };
        case 'SUBMIT_INTENT_REJECTED': return { code: 'pre-mempool-reject', ledgerCode: 'intent-rejected', retryable: false };
        case 'SPONSOR_REFUSED': return { code: 'policy', retryable: false };
        default: return undefined;
    }
}

/**
 * The checks run in a fixed order and the first match wins.
 * The "no reply" check comes last because other errors also contain "timed out".
 */
export function classifySubmitFailure(err: unknown): SubmitFailureInfo {
    const carried = carriedSubmitFailure(err);
    if (carried) return carried;

    const chain = errorChain(err);
    const names = chain.map(nameOf);
    const message = formatErr(err);
    const haystack = `${message} ${classificationHaystack(err)}`;

    // The SDK may pass on only the message, so the message text is also checked.
    const causality = chain.find((e: any) => e?.code === 'BatchCausalityViolation' || nameOf(e) === 'BatchCausalityError');
    if (causality || /violates the ledger's causality constraint/.test(haystack)) {
        const own = Array.isArray((causality as any)?.calls) ? (causality as any).calls as BatchCallStageInfo[] : undefined;
        return { code: 'causality', retryable: false, calls: own?.length ? own : parseBatchCallStages(haystack) };
    }
    // An earlier send of the same transaction has no known outcome, so it may still land.
    // This wins over the checks below, which would match its nested causes.
    if (names.includes('SubmitOutcomeUnknownError')) return { code: 'ambiguous', ledgerCode: 'unresolved-send', retryable: false };
    const coded = codedSubmitFailure(findNightgateError(err));
    if (coded) return coded;
    // Only a failure while connecting is safe to resend. Later failures may have reached the node.
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
        // The block height lets a chain rollback find the job. Without it the job waits for the indexer check.
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
    // The node marked the tx invalid without a ledger code. Usually another tx spent the
    // same dust first. It can also be a caller tx that is invalid. One rebuild is allowed.
    if (/TransactionInvalidError|Transaction is invalid and was rejected by the node/i.test(haystack)) {
        return { code: 'dust-race', ledgerCode: 'pool-invalid', retryable: true };
    }
    // We sent on a socket we were closing ourselves, so nothing was sent.
    if (/closing socket/i.test(haystack)) return { code: 'transport', ledgerCode: 'closing-socket', retryable: true };
    // Checked before 1010, because the numbers in this message could be misread as a 1010 code.
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
