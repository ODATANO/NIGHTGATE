import { errorMessage } from './errors';

// The connection to the node failed or closed.
const NODE_TRANSPORT_PATTERNS = [
  'econnreset', 'econnrefused', 'enotfound', 'etimedout', 'ehostunreach', 'epipe', 'socket hang up',
  'connection closed', 'connection lost', 'closed before', 'disconnect', 'not connected', 'websocket', 'rpc timeout'
];

const TRANSIENT_PATTERNS = [
  'timeout', 'network',
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

/** The connection to the node failed or closed. */
export function isNodeTransportError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return NODE_TRANSPORT_PATTERNS.some(pattern => message.includes(pattern));
}

/** A node error that a retry can fix: a transport failure, a timeout, or data a lagging node has not served yet. */
export function isTransientError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return isNodeTransportError(err) || TRANSIENT_PATTERNS.some(pattern => message.includes(pattern));
}

/** Exponential backoff with some random jitter, capped at `maxDelay`. */
export function calcBackoff(attempt: number, baseDelay: number, maxDelay: number = 30000): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.min(exponentialDelay + jitter, maxDelay);
}
