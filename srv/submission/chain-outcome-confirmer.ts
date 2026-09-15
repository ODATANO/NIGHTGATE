/**
 * Resolves a submitted tx's chain outcome through the Indexer, so `chainStatus`
 * advances without the crawler. One-shot fetch, not `watchForTxData`: its
 * watchQuery poll would leak for every dropped tx.
 */

/** Indexer `TransactionResultStatus` -> `chainStatus`; an unknown (future) status is null, never a verdict. */
export function mapIndexerStatus(status: string): 'success' | 'failure' | null {
    if (status === 'SUCCESS') return 'success';
    if (status === 'FAILURE' || status === 'PARTIAL_SUCCESS') return 'failure';
    return null;
}

/** A number or digit string as a non-negative integer; anything else (`null`, `''`) is null, not 0. */
export function nonNegativeInteger(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 ? raw : null;
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        return Number.isSafeInteger(n) ? n : null;
    }
    return null;
}

/**
 * A confirmed outcome with its inclusion coordinates. The block height is the
 * only key a reorg rollback can correlate a job on (identifier, indexer hash
 * and extrinsic hash all differ), so an outcome never exists without it.
 */
export type ChainOutcome = {
    status: 'success' | 'failure';
    blockHeight: number;
    blockHash?: string | null;
    /** The indexer's own transaction hash (not the identifier, not the extrinsic hash). */
    indexerTxHash?: string | null;
};

/**
 * The indexer has no such transaction: unlike `null` (indexed, not confirmable
 * yet), evidence that a broadcast never landed. `asOfMs` is the tip from the
 * same answer (a separate tip query may hit a fresher replica); null = no verdict.
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
    /** Per-lookup fetch deadline; default 8000. */
    timeoutMs?: number;
    fetchFn?: typeof fetch;
}

// The latest block is in the SAME request: it is the tip an absence is as of.
const TX_STATUS_QUERY =
    'query NightgateTxStatus($offset: TransactionOffset!) {' +
    ' transactions(offset: $offset) {' +
    ' ... on RegularTransaction { hash block { hash height } transactionResult { status } } }' +
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
}

/**
 * Look a tx up by identifier, then hash: outcome, absent, or null (indexed but
 * not confirmable yet; never absence). Throws on transport/HTTP/GraphQL errors.
 */
export function createHttpTxConfirmer(
    cfg: IndexerTxConfirmerConfig
): (txHash: string) => Promise<ChainLookup> {
    if (!cfg.indexerHttpUrl) throw new Error('indexerHttpUrl is required');
    const doFetch = cfg.fetchFn ?? fetch;
    const timeoutMs = cfg.timeoutMs ?? 8000;

    // The stored `txHash` is the ledger transaction identifier (`offset.identifier`);
    // `offset.hash` is only tried for rows that stored a hash.
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
            // A value invalid for this key: no evidence, let the other key try.
            if (/invalid transaction (hash|identifier)|cannot convert/i.test(String(body.errors[0]?.message))) return { present: false, asOfMs: null, keyInvalid: true };
            throw new Error(`Indexer tx lookup GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`);
        }
        const tx = body?.data?.transactions?.[0];
        if (!tx || typeof tx !== 'object') return { present: false, asOfMs: tipMsOf(body), keyInvalid: false };
        const status = tx?.transactionResult?.status;
        if (typeof status !== 'string') return { present: true, slice: null };
        // No height, no confirmation: evidence a reorg rollback cannot revert must not be recorded.
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
        // The two answers may come from different replicas: the joint absence is
        // as of the older tip, and a missing tip means no verdict. Rejected keys do not count.
        const tips = [byId, byHash].filter((l) => !l.keyInvalid).map((l) => l.asOfMs);
        const asOfMs = tips.length === 0 || tips.some((t) => t === null) ? null : Math.min(...(tips as number[]));
        return chainAbsent(asOfMs);
    };
    function outcomeOf(slice: IndexedTxSlice | null): ChainOutcome | null {
        if (slice === null) return null;
        const mapped = mapIndexerStatus(slice.status);
        if (!mapped) return null;
        return { status: mapped, blockHeight: slice.blockHeight, blockHash: slice.blockHash, indexerTxHash: slice.hash };
    }
}

export const buildIndexerTxConfirmer = createHttpTxConfirmer;
