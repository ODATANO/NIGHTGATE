/**
 * CAP's JSON log format writes every request header and hides only those in `cds.env.log.mask_headers`.
 * Without this entry, the agent token would appear in plain text in the logs.
 * CAP fixes the list when it first logs, so this runs when the plugin loads.
 */
export const AGENT_TOKEN_HEADER_MASK = '/x-agent-token/i';
const AGENT_TOKEN_HEADER = 'x-agent-token';

/** Turns a `mask_headers` entry into a RegExp the same way CAP does. */
function maskRegExp(entry: string): RegExp | null {
    try {
        const parts = entry.match(/\/(.+)\/(\w*)/);
        return parts ? new RegExp(parts[1], parts[2]) : new RegExp(entry);
    } catch {
        return null;
    }
}

/** Whether the configured list already hides the agent token header. */
export function masksAgentToken(masks: readonly string[]): boolean {
    return masks.some(m => maskRegExp(m)?.test(AGENT_TOKEN_HEADER) === true);
}

export function applyLogHeaderMask(env: { log?: Record<string, unknown> }): boolean {
    const log = (env.log ??= {});
    const current = Array.isArray(log.mask_headers) ? (log.mask_headers as unknown[]).map(String) : [];
    // Only an entry that really matches the header name counts, not one that merely looks similar.
    if (masksAgentToken(current)) return false;
    log.mask_headers = [...current, AGENT_TOKEN_HEADER_MASK];
    return true;
}
