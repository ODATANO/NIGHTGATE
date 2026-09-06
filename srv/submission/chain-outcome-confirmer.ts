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

export interface IndexerTxConfirmerConfig {
    indexerHttpUrl: string;
    /** Per-lookup deadline before the fetch is aborted (retry next tick). Default 8000. */
    timeoutMs?: number;
    /** Injectable fetch (defaults to global fetch); for tests. */
    fetchFn?: typeof fetch;
}

// Minimal slice of TX_ID_QUERY: the finalized status plus the inclusion
// coordinates (block height/hash, the indexer's transaction hash).
const TX_STATUS_QUERY =
    'query NightgateTxStatus($offset: TransactionOffset!) {' +
    ' transactions(offset: $offset) {' +
    ' ... on RegularTransaction { hash block { hash height } transactionResult { status } } } }';

interface IndexedTxSlice {
    status: string;
    hash: string | null;
    blockHash: string | null;
    blockHeight: number | null;
}

/**
 * Confirm a submitted tx by hash in one Indexer query. Returns the mapped
 * outcome when the tx is finalized, or null when it is not yet indexed / not a
 * regular tx (caller retries next tick). Throws on a transport/HTTP/GraphQL
 * error so the caller can surface a misconfigured endpoint.
 */
export function createHttpTxConfirmer(
    cfg: IndexerTxConfirmerConfig
): (txHash: string) => Promise<ChainOutcome | null> {
    if (!cfg.indexerHttpUrl) throw new Error('indexerHttpUrl is required');
    const doFetch = cfg.fetchFn ?? fetch;
    const timeoutMs = cfg.timeoutMs ?? 8000;

    // What NIGHTGATE stores as `txHash` is the ledger transaction IDENTIFIER
    // (`tx.identifiers().at(-1)`, the value the wallet SDK's submit returns),
    // which the Indexer answers under `offset.identifier`; the Substrate block
    // hash (`offset.hash`) is a different value. Try identifier first, then
    // hash for rows written by older code paths.
    const lookup = async (offset: Record<string, string>): Promise<IndexedTxSlice | null> => {
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
            // GraphQL error, not "not indexed": surface it as null so the other
            // key is tried; any other GraphQL error is a real failure.
            if (/invalid transaction (hash|identifier)|cannot convert/i.test(String(body.errors[0]?.message))) return null;
            throw new Error(`Indexer tx lookup GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
        }
        const tx = body?.data?.transactions?.[0];
        const status = tx?.transactionResult?.status;
        if (typeof status !== 'string') return null;
        // A result without its block height is not a confirmation: the
        // height is the rollback coordinate, and evidence a reorg could never
        // revert must not be recorded. The next tick asks again. The raw value
        // is checked BEFORE conversion: Number(null) is 0, a plausible height.
        const height = nonNegativeInteger(tx?.block?.height);
        if (height === null) return null;
        return {
            status,
            hash: typeof tx?.hash === 'string' ? tx.hash : null,
            blockHash: typeof tx?.block?.hash === 'string' ? tx.block.hash : null,
            blockHeight: height
        };
    };
    return async (txHash: string): Promise<ChainOutcome | null> => {
        const found = (await lookup({ identifier: txHash })) ?? (await lookup({ hash: txHash }));
        if (found === null) return null; // not indexed yet / no result
        const mapped = mapIndexerStatus(found.status);
        if (!mapped) return null; // unknown/future status -> not confirmed
        return { status: mapped, blockHeight: found.blockHeight as number, blockHash: found.blockHash, indexerTxHash: found.hash };
    };
}

/** Alias kept for the wiring call site. */
export const buildIndexerTxConfirmer = createHttpTxConfirmer;
