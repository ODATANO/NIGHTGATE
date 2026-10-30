/** Turns the indexer HTTP URL into its WebSocket URL. The path ends in a single `/ws` before any query.
 *  No `@sap/cds` import, because the wallet worker thread uses this too. */
export function deriveIndexerWsUrl(indexerHttpUrl: string): string {
    const withWs = (path: string): string => {
        const trimmed = path.replace(/\/+$/, '');
        return trimmed.endsWith('/ws') ? trimmed : trimmed + '/ws';
    };
    let u: URL;
    try {
        u = new URL(indexerHttpUrl);
    } catch {
        return withWs(indexerHttpUrl.replace(/^http/, 'ws'));
    }
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = withWs(u.pathname);
    return u.toString();
}
