/**
 * Server entry for the one hex codec; the implementation lives in
 * `@odatano/contract-kit`, so browser bundle, txbuilder and server parse hex
 * with the same strictness (optional 0x, even length, hex digits only,
 * lowercase out).
 */
export { hexToBytes, hexToBytes32, bytesToHex, normalizeHex } from '@odatano/contract-kit';

/** A normalized 32-byte value (token type, nullifier, hash): 64 lowercase hex characters. */
export const HEX64_RE = /^[0-9a-f]{64}$/;
