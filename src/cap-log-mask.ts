/**
 * CAP's JSON log format writes EVERY request header into each log line and
 * masks only the ones matching `cds.env.log.mask_headers` (authorization,
 * cookie, cert, ssl, api-key by default). The agent token rides in its own
 * header, so without this entry every token-authenticated request logged the
 * bearer token in clear. The formatter freezes the list on its first use,
 * hence this runs at plugin registration, before anything is served.
 */
export const AGENT_TOKEN_HEADER_MASK = '/x-agent-token/i';
const AGENT_TOKEN_HEADER = 'x-agent-token';

/** The same compilation CAP applies to a `mask_headers` entry (`/body/flags` or a bare pattern). */
function maskRegExp(entry: string): RegExp | null {
    try {
        const parts = entry.match(/\/(.+)\/(\w*)/);
        return parts ? new RegExp(parts[1], parts[2]) : new RegExp(entry);
    } catch {
        return null;
    }
}

/** Whether a configured mask list already hides the agent token header, tested the way CAP tests it. */
export function masksAgentToken(masks: readonly string[]): boolean {
    return masks.some(m => maskRegExp(m)?.test(AGENT_TOKEN_HEADER) === true);
}

export function applyLogHeaderMask(env: { log?: Record<string, unknown> }): boolean {
    const log = (env.log ??= {});
    const current = Array.isArray(log.mask_headers) ? (log.mask_headers as unknown[]).map(String) : [];
    // A look-alike entry (`/x-agent-token-signature/i`) does not match the
    // header name and must not count; only a pattern that hits does.
    if (masksAgentToken(current)) return false;
    log.mask_headers = [...current, AGENT_TOKEN_HEADER_MASK];
    return true;
}
