/**
 * Crawler Retry Utilities Tests
 *
 * Tests for isTransientError() and calcBackoff() from srv/utils/retry.ts.
 */

import { isTransientError, calcBackoff } from '../../srv/utils/retry';

describe('isTransientError', () => {
  it('should classify timeout errors as transient', () => {
    expect(isTransientError(new Error('RPC timeout: chain_getBlock (30000ms)'))).toBe(true);
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
  });

  it('should classify connection errors as transient', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:9944'))).toBe(true);
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('getaddrinfo ENOTFOUND midnight-node'))).toBe(true);
    expect(isTransientError(new Error('Connection closed'))).toBe(true);
  });

  it('should classify network errors as transient', () => {
    expect(isTransientError(new Error('WebSocket connection failed'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('write EPIPE'))).toBe(true);
    expect(isTransientError(new Error('connect EHOSTUNREACH'))).toBe(true);
  });

  it('should classify non-network errors as permanent', () => {
    expect(isTransientError(new Error('Invalid block data at height 42'))).toBe(false);
    expect(isTransientError(new Error('RPC error -32601: Method not found'))).toBe(false);
    expect(isTransientError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isTransientError(new Error('JSON parse error'))).toBe(false);
  });
});

describe('calcBackoff', () => {
  it('should use exponential formula', () => {
    // Seed random for deterministic jitter isn't possible, so test range
    const base = 2000;
    const d1 = calcBackoff(1, base);
    const d2 = calcBackoff(2, base);
    const d3 = calcBackoff(3, base);

    // Attempt 1: 2000 * 2^0 + jitter = 2000-3000
    expect(d1).toBeGreaterThanOrEqual(2000);
    expect(d1).toBeLessThanOrEqual(3000);

    // Attempt 2: 2000 * 2^1 + jitter = 4000-5000
    expect(d2).toBeGreaterThanOrEqual(4000);
    expect(d2).toBeLessThanOrEqual(5000);

    // Attempt 3: 2000 * 2^2 + jitter = 8000-9000
    expect(d3).toBeGreaterThanOrEqual(8000);
    expect(d3).toBeLessThanOrEqual(9000);
  });

  it('should cap at maxDelay', () => {
    const delay = calcBackoff(10, 2000, 30000);
    expect(delay).toBeLessThanOrEqual(30000);
  });

  it('should use default maxDelay of 30000', () => {
    const delay = calcBackoff(20, 5000);
    expect(delay).toBeLessThanOrEqual(30000);
  });

  it('should always return positive value', () => {
    for (let i = 1; i <= 10; i++) {
      expect(calcBackoff(i, 1000)).toBeGreaterThan(0);
    }
  });
});
