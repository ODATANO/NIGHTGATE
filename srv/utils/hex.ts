/**
 * Hex helpers re-exported from `@odatano/contract-kit`.
 * The browser bundle, the txbuilder and the server use the same code, so they all parse hex the same way.
 */
export { hexToBytes, hexToBytes32, bytesToHex, normalizeHex } from '@odatano/contract-kit';

export { HEX64_RE, HEX64_ANY_CASE_RE } from './hex-patterns';
