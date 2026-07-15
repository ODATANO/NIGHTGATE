/**
 * Derive the GraphQL subscription endpoint from an indexer HTTP URL. Every
 * known indexer deployment (hosted networks + indexer-standalone) serves it
 * on the same path with a `/ws` suffix over ws(s), so overriding the HTTP URL
 * alone is enough; an explicit WS URL (env/config) still wins for setups
 * that deviate.
 *
 * Lives in its own cds-free module because the wallet worker thread also
 * needs it and must not pull in `@sap/cds` (nightgate-config does).
 */
export function deriveIndexerWsUrl(indexerHttpUrl: string): string {
    return indexerHttpUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}
