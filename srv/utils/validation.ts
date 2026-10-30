const HEX_REGEX = /^[0-9a-fA-F]+$/;

export function validateViewingKey(viewingKey: string | undefined | null): string | undefined {
  if (!viewingKey || typeof viewingKey !== 'string') {
    return 'viewingKey is required';
  }
  if (!HEX_REGEX.test(viewingKey)) {
    return 'viewingKey must be hex-encoded';
  }
  if (viewingKey.length !== 64) {
    return `viewingKey must be 64 hex characters (32 bytes), got ${viewingKey.length}`;
  }
  return undefined;
}

/** An optional ISO-8601 time that must lie ahead, and at most `maxAheadMs` ahead when given.
 *  Returns the problem as text, or null when the value is absent or fine. */
export function futureTimeProblem(raw: unknown, name: string, maxAheadMs?: number, maxText?: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return `${name} must be an ISO-8601 timestamp`;
  if (ms <= Date.now()) return `${name} must be in the future`;
  if (maxAheadMs !== undefined && ms - Date.now() > maxAheadMs) return `${name}: at most ${maxText} ahead`;
  return null;
}
