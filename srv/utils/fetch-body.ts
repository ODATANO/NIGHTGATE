// Downloads a file. A lost connection, a torn body, HTTP 429 or a 5xx get more tries, any other answer is final.
// No imports: the builder and the server share this file.
export const FETCH_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];

export interface FetchBodyOptions {
    fetchFn?: typeof fetch;
    /** The pause before each further try. Empty means one try. */
    delaysMs?: readonly number[];
    onRetry?: (reason: string) => void;
}

/** The fetch error says only "fetch failed". The reason is in its cause. */
function reasonOf(err: unknown): string {
    const { message, cause } = err as { message?: string; cause?: { message?: string } };
    return cause?.message ? `${message}: ${cause.message}` : String(message ?? err);
}

/** The body is null when the server's last answer is not ok. Throws when the last try gets no answer. */
export async function fetchBody(url: string, opts: FetchBodyOptions = {}): Promise<{ res: Response; body: Buffer | null }> {
    const { fetchFn = fetch, delaysMs = FETCH_RETRY_DELAYS_MS, onRetry } = opts;
    for (let tries = 1; ; tries++) {
        const delay = delaysMs[tries - 1];
        try {
            const res = await fetchFn(url);
            if (res.ok) return { res, body: Buffer.from(await res.arrayBuffer()) };
            if ((res.status < 500 && res.status !== 429) || delay === undefined) return { res, body: null };
            onRetry?.(`HTTP ${res.status}`);
        } catch (err) {
            // fetch reports a lost connection and a torn body as TypeError. An abort or a caller's own error stays as it is.
            if (!(err instanceof TypeError)) throw err;
            if (delay === undefined) throw new Error(`${reasonOf(err)} (${tries} tries)`, { cause: err });
            onRetry?.(reasonOf(err));
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}
