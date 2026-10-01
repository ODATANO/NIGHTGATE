/** A JSON array of strings persisted in a text column; anything else reads as empty. */
export function parseJsonStringList(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
