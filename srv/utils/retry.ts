/**
 * Retry utilities — transient error detection and exponential backoff.
 */

const TRANSIENT_PATTERNS = [
  'timeout', 'econnreset', 'econnrefused', 'enotfound',
  'connection closed', 'connection lost', 'not connected',
  'websocket', 'rpc timeout', 'socket hang up',
  'network', 'epipe', 'ehostunreach'
];

/**
 * Check if an error is transient (retryable) vs permanent.
 * Transient: timeouts, connection resets, network issues.
 * Permanent: invalid data, unknown methods, logic errors.
 */
export function isTransientError(err: Error): boolean {
  const message = err.message.toLowerCase();
  return TRANSIENT_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: baseDelay * 2^(attempt-1) + random jitter, capped at maxDelay.
 */
export function calcBackoff(attempt: number, baseDelay: number, maxDelay: number = 30000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.min(exponentialDelay + jitter, maxDelay);
}
