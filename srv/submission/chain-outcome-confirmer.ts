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

export type ChainOutcome = { status: 'success' | 'failure' };

export interface IndexerTxConfirmerConfig {
    indexerHttpUrl: string;
    /** Per-lookup deadline before the fetch is aborted (retry next tick). Default 8000. */
    timeoutMs?: number;
    /** Injectable fetch (defaults to global fetch); for tests. */
    fetchFn?: typeof fetch;
}

// Minimal slice of TX_ID_QUERY: just the finalized status by tx hash.
const TX_STATUS_QUERY =
    'query NightgateTxStatus($offset: TransactionOffset!) {' +
    ' transactions(offset: $offset) {' +
    ' ... on RegularTransaction { transactionResult { status } } } }';

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
    const lookup = async (offset: Record<string, string>): Promise<string | null> => {
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
        const status = body?.data?.transactions?.[0]?.transactionResult?.status;
        return typeof status === 'string' ? status : null;
    };
    return async (txHash: string): Promise<ChainOutcome | null> => {
        const status = (await lookup({ identifier: txHash })) ?? (await lookup({ hash: txHash }));
        if (status === null) return null; // not indexed yet / no result
        const mapped = mapIndexerStatus(status);
        return mapped ? { status: mapped } : null; // unknown/future status -> not confirmed
    };
}

/** Alias kept for the wiring call site. */
export const buildIndexerTxConfirmer = createHttpTxConfirmer;
