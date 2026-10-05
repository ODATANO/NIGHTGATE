/**
 * Detects a "dust race": the node rejects a transaction because its dust spend
 * was built against an older dust state. The node reports `1010 Invalid Transaction` with:
 * - `170`: the dust proof uses an outdated merkle root.
 * - `171`: the spend's time is ahead of a lagging node's block time.
 * - `196`: another transaction already spent the same dust note.
 * The rejection happens before the mempool, so no fee is paid.
 * The fix is to rebuild the transaction. Resending the same bytes fails again.
 */
import { classificationHaystack } from '../utils/format-error';

/** Ledger error codes under Substrate 1010 that are a transient dust race. */
export const DUST_RACE_LEDGER_CODES: ReadonlySet<string> = new Set(['170', '171', '196']);

/**
 * Returns a code like `'1010/170'` when the error or one of its causes is a dust race, else null.
 * Matches the error text the same way `classifySubmissionError` does.
 */
export function dustRaceLedgerCode(err: unknown): string | null {
    const message = err instanceof Error ? err.message : String(err ?? '');
    const haystack = `${message} ${classificationHaystack(err)}`;
    // An error we already classified and that was thrown again further up.
    const own = /\b1010\/(170|171|196)\b/.exec(haystack);
    if (own) return `1010/${own[1]}`;
    if (/priority is too low/i.test(haystack)) return null;
    if (!/\b1010\s*:|invalid transaction/i.test(haystack)) return null;
    const custom = /custom error:?\s*(\d+)/i.exec(haystack);
    return custom && DUST_RACE_LEDGER_CODES.has(custom[1]) ? `1010/${custom[1]}` : null;
}
