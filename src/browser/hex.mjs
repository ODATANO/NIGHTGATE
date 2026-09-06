// Hex codec shared by the browser bundle, the txbuilder and the server
// (srv/utils/hex.ts re-exports it; the CommonJS server loads this ESM file
// through Node's require(esm), Node 22.12+). ONE strictness everywhere: an
// optional 0x prefix, even length, hex digits only; output is lowercase
// without prefix. Dependency-free by design (the browser surface forbids
// Node built-ins and the server tree).

const HEX_RE = /^[0-9a-fA-F]*$/;

/**
 * Parse hex into bytes. Throws on odd length or a non-hex character; an
 * empty string yields an empty array.
 * @param {string} hex
 * @param {string} [label] name used in the error message
 * @returns {Uint8Array}
 */
export function hexToBytes(hex, label = 'value') {
    if (typeof hex !== 'string') throw new Error(`${label} must be a hex string`);
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0 || !HEX_RE.test(clean)) {
        throw new Error(`${label} must be even-length hex`);
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

/**
 * Parse exactly 32 bytes of hex (64 hex chars, optional 0x).
 * @param {string} hex
 * @param {string} [label]
 * @returns {Uint8Array}
 */
export function hexToBytes32(hex, label = 'value') {
    const out = hexToBytes(hex, label);
    if (out.length !== 32) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return out;
}

/**
 * Lowercase hex without prefix.
 * @param {Uint8Array | ArrayLike<number>} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
}

/**
 * Canonical form of a hex string: validated, prefix dropped, lowercase.
 * @param {string} hex
 * @param {string} [label]
 * @returns {string}
 */
export function normalizeHex(hex, label = 'value') {
    return bytesToHex(hexToBytes(hex, label));
}
