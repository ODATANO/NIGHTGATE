/**
 * Asks the Midnight indexer whether a submitted transaction landed, so `chainStatus`
 * updates without our own crawler. Uses a single fetch rather than `watchForTxData`,
 * whose polling would never stop for a transaction that was dropped.
 */

/** Maps the indexer's result status to `chainStatus`. An unknown status gives null, never a result. */
export function mapIndexerStatus(status: string): 'success' | 'failure' | null {
    if (status === 'SUCCESS') return 'success';
    if (status === 'FAILURE' || status === 'PARTIAL_SUCCESS') return 'failure';
    return null;
}

/** Parses a number or digit string as a non-negative integer. Anything else, like `null` or `''`, gives null, not 0. */
export function nonNegativeInteger(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : null;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        return Number.isSafeInteger(n) ? n : null;
    }
    return null;
}

/**
 * A confirmed result with the block it landed in. A chain reorg can only match
 * a job by block height, because the three transaction hashes all differ.
 * So a result always carries a block height.
 */
export type ChainOutcome = {
    status: 'success' | 'failure';
    blockHeight: number;
    blockHash?: string | null;
    /** The indexer's own transaction hash. It differs from the identifier and the node's extrinsic hash. */
    indexerTxHash?: string | null;
    /** The indexer's raw result. PARTIAL_SUCCESS counts as `failure` in `status`. */
    result?: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE';
    /** Parts of the transaction that the indexer reports as not applied. */
    failedSegments?: number[];
};

/**
 * The indexer does not know the transaction, which suggests it never landed.
 * `null` instead means it is known but has no final result yet.
 * `asOfMs` is the time of the indexer's latest block in the same answer. null means no conclusion.
 */
export type ChainAbsent = { status: 'absent'; asOfMs: number | null };
export function chainAbsent(asOfMs: number | null): ChainAbsent { return { status: 'absent', asOfMs }; }
/** Not found, with no block time. This never counts as a conclusion. */
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
    /** Timeout per lookup in ms. Default 8000. */
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}

// Ask for the latest block in the same request. A "not found" answer is only valid as of that block.
const TX_STATUS_QUERY =
    'query NightgateTxStatus($offset: TransactionOffset!) {' +
    ' transactions(offset: $offset) {' +
    ' ... on RegularTransaction { hash block { hash height } transactionResult { status segments { id success } } } }' +
    ' block { height timestamp } }';

function tipMsOf(body: any): number | null {
    const raw = body?.data?.block?.timestamp;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? n : n * 1000; // seconds stay below 1e12 until 2286
}

interface IndexedTxSlice {
    status: string;
    hash: string | null;
    blockHash: string | null;
    blockHeight: number;
    failedSegments: number[];
}

/**
 * Looks a transaction up by identifier, then by hash.
 * Returns the result, "absent", or null when it is known but not final. Throws on network or query errors.
 */
export function createHttpTxConfirmer(
    cfg: IndexerTxConfirmerConfig
): (txHash: string) => Promise<ChainLookup> {
    if (!cfg.indexerHttpUrl) throw new Error('indexerHttpUrl is required');
    const doFetch = cfg.fetchFn ?? fetch;
    const timeoutMs = cfg.timeoutMs ?? 8000;

    // The stored `txHash` is usually the ledger transaction identifier.
    // The lookup by hash covers rows that stored a hash instead.
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
            // The value has the wrong form for this lookup. That proves nothing, so try the other one.
            if (/invalid transaction (hash|identifier)|cannot convert/i.test(String(body.errors[0]?.message))) return { present: false, asOfMs: null, keyInvalid: true };
            throw new Error(`Indexer tx lookup GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
        }
        const tx = body?.data?.transactions?.[0];
        if (!tx || typeof tx !== 'object') return { present: false, asOfMs: tipMsOf(body), keyInvalid: false };
        const status = tx?.transactionResult?.status;
        if (typeof status !== 'string') return { present: true, slice: null };
        // Without a block height a reorg could not undo the result, so do not confirm it.
        const height = nonNegativeInteger(tx?.block?.height);
        if (height === null) return { present: true, slice: null };
        return {
            present: true,
            slice: {
                status,
                hash: typeof tx?.hash === 'string' ? tx.hash : null,
                blockHash: typeof tx?.block?.hash === 'string' ? tx.block.hash : null,
                blockHeight: height,
                failedSegments: Array.isArray(tx?.transactionResult?.segments)
                    ? tx.transactionResult.segments.filter((s: any) => s?.success === false).map((s: any) => Number(s.id)).filter(Number.isInteger)
                    : []
            }
        };
    };
    return async (txHash: string): Promise<ChainLookup> => {
        const byId = await lookup({ identifier: txHash });
        if (byId.present) return outcomeOf(byId.slice);
        const byHash = await lookup({ hash: txHash });
        if (byHash.present) return outcomeOf(byHash.slice);
        // The two answers may come from different indexer servers, so use the older block time.
        // A missing time means no conclusion. Lookups with a wrong value form are ignored.
        const tips = [byId, byHash].filter((l) => !l.keyInvalid).map((l) => l.asOfMs);
        const asOfMs = tips.length === 0 || tips.some((t) => t === null) ? null : Math.min(...(tips as number[]));
        return chainAbsent(asOfMs);
    };
    function outcomeOf(slice: IndexedTxSlice | null): ChainOutcome | null {
        if (slice === null) return null;
        const mapped = mapIndexerStatus(slice.status);
        if (!mapped) return null;
        return {
            status: mapped, blockHeight: slice.blockHeight, blockHash: slice.blockHash, indexerTxHash: slice.hash,
            result: slice.status as ChainOutcome['result'], failedSegments: slice.failedSegments
        };
    }
}

