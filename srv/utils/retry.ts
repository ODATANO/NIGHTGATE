const TRANSIENT_PATTERNS = [
  'timeout', 'econnreset', 'econnrefused', 'enotfound',
  'connection closed', 'connection lost', 'not connected',
  'websocket', 'rpc timeout', 'socket hang up',
  'network', 'epipe', 'ehostunreach',
  // The node returned empty data for a block it should know.
  // Pruned nodes and lagging replicas do this, so a retry can succeed.
  'no block body',
  'no block at height',
  'no timestamp for',
  'no runtime metadata for',
  // Retried, never decoded with another runtime's type map.
  'no runtime version for',
  'no system.events for'
];

export function isTransientError(err: Error): boolean {
  const message = err.message.toLowerCase();
  return TRANSIENT_PATTERNS.some(pattern => message.includes(pattern));
}

const UNIQUE_VIOLATION_PATTERNS = [
  'duplicate key value violates unique constraint',  // PostgreSQL 23505
  'unique constraint failed',  // SQLite
  'unique constraint violated'  // SAP HANA 301
];

/**
 * A row with this key exists already.
 * The write repeats one that already succeeded, so it is not a real failure.
 */
export function isUniqueViolation(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return UNIQUE_VIOLATION_PATTERNS.some(pattern => message.includes(pattern));
}

/** Exponential backoff with some random jitter, capped at `maxDelay`. */
export function calcBackoff(attempt: number, baseDelay: number, maxDelay: number = 30000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.min(exponentialDelay + jitter, maxDelay);
}
