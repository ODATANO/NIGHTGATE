/**
 * Crawler-free chain-outcome confirmer.
 *
 * With the crawler off, `chainStatus` can otherwise never leave `pending`: the
 * only path that advances it (`refreshSucceededChainOutcomes`) needs the
 * crawler-populated `Transactions`/`TransactionResults` tables. This resolves a
 * submitted tx by hash through a single Indexer GraphQL query instead.
 *
 * One-shot HTTP, deliberately not `publicDataProvider.watchForTxData`:
 *   - watchForTxData looks up by `identifier`, but our jobs persist the tx
 *     `hash` (`pub.txHash`), so it would never match; this queries `offset:{hash}`.
 *   - watchForTxData is an Apollo `watchQuery` poll that keeps running until the
 *     tx appears; a not-yet-final or dropped tx would leak a poll on every tick.
 *     A one-shot `fetch` with an AbortSignal deadline cancels cleanly and just
 *     retries next tick.
 *
 * `createHttpTxConfirmer` takes a `fetch` so the mapping/parse is unit-testable.
 */

/**
 * Indexer `TransactionResultStatus` -> our `chainStatus`. Only the three known
 * values classify; the schema also declares a `%future added value` case, so an
 * unknown status returns null (not confirmed, retry) rather than a wrong verdict.
 */
export function mapIndexerStatus(status: string): 'success' | 'failure' | null {
    if (status === 'SUCCESS') return 'success';
    if (status === 'FAILURE' || status === 'PARTIAL_SUCCESS') return 'failure';
    return null;
}

/**
 * A confirmed outcome plus the indexer's coordinates of the inclusion. The
 * block height is the ONLY thing a reorg rollback can correlate a job with:
 * the ledger identifier a job stores, the indexer's transaction hash and the
 * Substrate extrinsic hash the crawler indexes are three different values.
 */
/**
 * A non-negative integer from a JSON value: a number, or a string of digits
 * (the indexer serialises heights as strings in some schemas). Anything else,
 * `null` and `''` included, is `null`; `Number(null)` would have been 0.
 */
export function nonNegativeInteger(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : null;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        return Number.isSafeInteger(n) ? n : null;
    }
    return null;
}

export type ChainOutcome = {
    status: 'success' | 'failure';
    /** Inclusion height: the ONLY key a reorg rollback correlates on, so an outcome never exists without it. */
    blockHeight: number;
    blockHash?: string | null;
    /** The indexer's own transaction hash (not the identifier, not the extrinsic hash). */
    indexerTxHash?: string | null;
};

/**
 * The indexer has NO transaction under this identifier (nor hash). Distinct
 * from `null` (indexed, but not confirmable yet: no result status, no block
 * height, an unknown status): only absence is evidence that a broadcast
 * never landed; an indexed-but-unconfirmable transaction may well be on chain.
 *
 * `asOfMs` is the indexer's tip time FROM THE SAME ANSWER: the absence and
 * the tip come from one request, so one replica, so they are consistent. A
 * separate tip query could be answered by a fresher replica (or after the
 * indexer caught up) and turn "not indexed yet" into "never included".
 * `null` = the answer carried no tip: no verdict.
 */
export type ChainAbsent = { status: 'absent'; asOfMs: number | null };
export function chainAbsent(asOfMs: number | null): ChainAbsent { return { status: 'absent', asOfMs }; }
/** Absence without a tip: never a verdict (tests, fallbacks). */
export const CHAIN_ABSENT: ChainAbsent = Object.freeze(chainAbsent(null)) as ChainAbsent;
export type ChainLookup = ChainOutcome | ChainAbsent | null;
export function isChainOutcome(lookup: ChainLookup): lookup is ChainOutcome {
    return lookup !== null && lookup.status !== 'absent';
}
export function isChainAbsent(lookup: ChainLookup): lookup is ChainAbsent {
    return lookup !== null && lookup.status === 'absent';
}

export interface IndexerTxConfirmerConfig {
    indexerHttpUrl: string;
    /** Per-lookup deadline before the fetch is aborted (retry next tick). Default 8000. */
    timeoutMs?: number;
    /** Injectable fetch (defaults to global fetch); for tests. */
    fetchFn?: typeof fetch;
}

// Minimal slice of TX_ID_QUERY: the finalized status plus the inclusion
// coordinates (block height/hash, the indexer's transaction hash), and the
// indexer's latest block IN THE SAME REQUEST (the tip an absence is as of).
const TX_STATUS_QUERY =
    'query NightgateTxStatus($offset: TransactionOffset!) {' +
    ' transactions(offset: $offset) {' +
    ' ... on RegularTransaction { hash block { hash height } transactionResult { status } } }' +
    ' block { height timestamp } }';

/** The latest-block timestamp of an answer, in ms; null when it carries none. */
function tipMsOf(body: any): number | null {
    const raw = body?.data?.block?.timestamp;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? n : n * 1000; // the indexer reports ms; seconds would be < 1e12 until 2286
}

interface IndexedTxSlice {
    status: string;
    hash: string | null;
    blockHash: string | null;
    /** Always present: a result without its height is "present, not confirmable", never a slice. */
    blockHeight: number;
}

/**
 * Confirm a submitted tx by identifier (then hash) in one Indexer query each.
 * Returns the mapped outcome when the tx is finalized, `CHAIN_ABSENT` when the
 * indexer has no such transaction at all, or null when it is indexed but not
 * confirmable yet (no result, no height, an unknown status; caller retries
 * next tick and must NOT read this as absence). Throws on a
 * transport/HTTP/GraphQL error so the caller can surface a misconfigured endpoint.
 */
export function createHttpTxConfirmer(
    cfg: IndexerTxConfirmerConfig
): (txHash: string) => Promise<ChainLookup> {
    if (!cfg.indexerHttpUrl) throw new Error('indexerHttpUrl is required');
    const doFetch = cfg.fetchFn ?? fetch;
    const timeoutMs = cfg.timeoutMs ?? 8000;

    // What NIGHTGATE stores as `txHash` is the ledger transaction IDENTIFIER
    // (`tx.identifiers().at(-1)`, the value the wallet SDK's submit returns),
    // which the Indexer answers under `offset.identifier`; the Substrate block
    // hash (`offset.hash`) is a different value. Try identifier first, then
    // hash for rows written by older code paths.
    // Tri-state: the indexer has no such transaction (absent), has it but
    // without a usable result yet (present, slice null), or has it confirmed.
    type Lookup = { present: false; asOfMs: number | null; keyInvalid: boolean } | { present: true; slice: IndexedTxSlice | null };
    const lookup = async (offset: Record<string, string>): Promise<Lookup> => {
        const res = await doFetch(cfg.indexerHttpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: TX_STATUS_QUERY, variables: { offset } }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) throw new Error(`Indexer tx lookup HTTP ${res.status}`);
        const body: any = await res.json();
        if (body?.errors?.length) {
            // An invalid offset value (e.g. a non-hash under `hash`) is a
            // GraphQL error, not "not indexed": treat it as absent under this
            // key so the other key is tried; any other GraphQL error is a real failure.
            if (/invalid transaction (hash|identifier)|cannot convert/i.test(String(body.errors[0]?.message))) return { present: false, asOfMs: null, keyInvalid: true };
            throw new Error(`Indexer tx lookup GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
        }
        const tx = body?.data?.transactions?.[0];
        if (!tx || typeof tx !== 'object') return { present: false, asOfMs: tipMsOf(body), keyInvalid: false };
        const status = tx?.transactionResult?.status;
        if (typeof status !== 'string') return { present: true, slice: null };
        // A result without its block height is not a confirmation: the
        // height is the rollback coordinate, and evidence a reorg could never
        // revert must not be recorded. The next tick asks again. The raw value
        // is checked BEFORE conversion: Number(null) is 0, a plausible height.
        const height = nonNegativeInteger(tx?.block?.height);
        if (height === null) return { present: true, slice: null };
        return {
            present: true,
            slice: {
                status,
                hash: typeof tx?.hash === 'string' ? tx.hash : null,
                blockHash: typeof tx?.block?.hash === 'string' ? tx.block.hash : null,
                blockHeight: height
            }
        };
    };
    return async (txHash: string): Promise<ChainLookup> => {
        const byId = await lookup({ identifier: txHash });
        if (byId.present) return outcomeOf(byId.slice);
        const byHash = await lookup({ hash: txHash });
        if (byHash.present) return outcomeOf(byHash.slice);
        // Absent under both keys. Each absence is only as of ITS OWN answer's
        // tip, and the two answers are separate requests (possibly different
        // replicas, or the indexer caught up in between): the joint absence
        // is as of the OLDER tip. An answer that carried no tip leaves the
        // joint absence without one (no verdict). A key the indexer rejects
        // outright (an identifier value under `hash`) is no evidence either
        // way and does not take part.
        const tips = [byId, byHash].filter((l) => !l.keyInvalid).map((l) => l.asOfMs);
        const asOfMs = tips.length === 0 || tips.some((t) => t === null) ? null : Math.min(...(tips as number[]));
        return chainAbsent(asOfMs);
    };
    /** null = indexed, not confirmable yet (no result, or an unknown/future status): present, never absent. */
    function outcomeOf(slice: IndexedTxSlice | null): ChainOutcome | null {
        if (slice === null) return null;
        const mapped = mapIndexerStatus(slice.status);
        if (!mapped) return null;
        return { status: mapped, blockHeight: slice.blockHeight, blockHash: slice.blockHash, indexerTxHash: slice.hash };
    }
}

/** Alias kept for the wiring call site. */
export const buildIndexerTxConfirmer = createHttpTxConfirmer;
