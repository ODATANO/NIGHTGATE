/**
 * Single classification of the coded dust race. Substrate `1010 Invalid
 * Transaction` with ledger error `170` (InvalidDustSpendProof: stale merkle
 * root or validity window) or `196` (nullifier already known: concurrent spend
 * on the same note): the dust spend was built against a dust state the node has
 * moved past. Pre-mempool, fee unspent; heal = rebuild and resubmit, never the same bytes.
 */
import { classificationHaystack } from '../utils/format-error';

/** Ledger error codes under Substrate 1010 that are a transient dust race. */
export const DUST_RACE_LEDGER_CODES: ReadonlySet<string> = new Set(['170', '196']);

/**
 * `'1010/170'` / `'1010/196'` when the error (message or cause chain) is a
 * coded dust-race reject, else null. Same haystack rules as
 * `classifySubmissionError`: stack frames and `:line:col` tokens stripped, the
 * bare number needs the `1010:` shape or the semantic phrase, "priority is too
 * low" (1014) never counts.
 */
export function dustRaceLedgerCode(err: unknown): string | null {
    const message = err instanceof Error ? err.message : String(err ?? '');
    const haystack = `${message} ${classificationHaystack(err)}`;
    // Our own already-classified shape, re-thrown across a boundary.
    const own = /\b1010\/(170|196)\b/.exec(haystack);
    if (own) return `1010/${own[1]}`;
    if (/priority is too low/i.test(haystack)) return null;
    if (!/\b1010\s*:|invalid transaction/i.test(haystack)) return null;
    const custom = /custom error:?\s*(\d+)/i.exec(haystack);
    return custom && DUST_RACE_LEDGER_CODES.has(custom[1]) ? `1010/${custom[1]}` : null;
}
