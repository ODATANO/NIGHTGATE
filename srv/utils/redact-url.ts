/**
 * Removes credentials from a URL before it is stored, logged or returned over OData.
 * A URL can carry secrets as `user:pass@` or as query parameters such as `?apikey=`.
 * Strings that are not valid URLs come back unchanged.
 */
export function redactUrlCredentials(url: string | undefined | null): string {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (!u.username && !u.password && !u.search) {
            // Return the input as is. `URL.toString()` would add a trailing slash and change stored values.
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
