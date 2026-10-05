/**
 * Builds the indexer's WebSocket URL from its HTTP URL.
 * All known indexers serve WebSocket on the same path plus `/ws`.
 * This module does not import `@sap/cds`, because the wallet worker thread uses it too.
 */
export function deriveIndexerWsUrl(indexerHttpUrl: string): string {
    return indexerHttpUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}
