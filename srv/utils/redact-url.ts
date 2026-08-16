/**
 * Credential redaction for endpoint URLs before they are persisted, logged or
 * exposed over OData (SyncState.nodeUrl, getStatus, startup logging).
 *
 * Node/indexer URLs may embed secrets two ways: userinfo
 * (`wss://user:pass@host/`) and query parameters (`?apikey=...`). The runtime
 * keeps the full URL for connecting; everything user-visible goes through
 * this. Non-URL strings pass through unchanged (they carry no parseable
 * credential shape for us to strip).
 */
export function redactUrlCredentials(url: string | undefined | null): string {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (!u.username && !u.password && !u.search) {
            // Nothing to strip: return the INPUT verbatim (URL#toString
            // normalizes, e.g. adds a trailing slash, which would churn
            // persisted values and status output for clean URLs).
            return url;
        }
        u.username = '';
        u.password = '';
        u.search = '';
        return u.toString();
    } catch {
        return url;
    }
}
