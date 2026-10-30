// One POST client for the indexer's GraphQL API, shared by every server-side lookup.
// SPDX-License-Identifier: Apache-2.0

/** A non-2xx response from the indexer. The caller uses the status to decide how long to back off. */
export class IndexerHttpError extends Error {
    constructor(readonly status: number) {
        super(`indexer answered ${status}`);
        this.name = 'IndexerHttpError';
    }
}

/** The indexer answered with GraphQL errors. */
export class IndexerQueryError extends Error {
    constructor(readonly messages: string[]) {
        super(`indexer rejected the query: ${messages.join('; ').slice(0, 200)}`);
        this.name = 'IndexerQueryError';
    }
}

/** True for 403 and 429. The indexer refuses this client, often for the whole host IP. */
export function isIndexerRateLimit(err: unknown): boolean {
    return err instanceof IndexerHttpError && (err.status === 403 || err.status === 429);
}

export interface IndexerQueryOptions {
    variables?: Record<string, unknown>;
    timeoutMs?: number; // ms; default 15000
    fetchFn?: typeof fetch;
}

/** Runs one query and returns its `data`. Throws on network, HTTP and GraphQL errors. */
export async function indexerQuery<T = unknown>(url: string, query: string, opts: IndexerQueryOptions = {}): Promise<T> {
    const res = await (opts.fetchFn ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts.variables ? { query, variables: opts.variables } : { query }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    });
    if (!res.ok) throw new IndexerHttpError(res.status);
    const body: { data?: T; errors?: Array<{ message?: unknown }> } = await res.json();
    if (body?.errors?.length) throw new IndexerQueryError(body.errors.map(e => String(e?.message ?? 'unknown')));
    return body?.data as T;
}

/** A block timestamp in ms. Values below 1e12 are seconds, which stays unambiguous until the year 2286. */
export function indexerTimestampMs(raw: unknown): number | null {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1e12 ? n : n * 1000;
}
