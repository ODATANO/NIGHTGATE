/**
 * Server entry for the ONE hex codec. The implementation lives in
 * src/browser/hex.mjs so browser bundle, txbuilder and server parse hex with
 * the same strictness (optional 0x, even length, hex digits only, lowercase
 * out). The CommonJS build loads the ESM file through Node's require(esm).
 */
export { hexToBytes, hexToBytes32, bytesToHex, normalizeHex } from '../../src/browser/hex.mjs';
