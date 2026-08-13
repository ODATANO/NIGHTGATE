/**
 * Off-chain hashing primitives shared by document-proof and set-root.
 *
 * Deliberately dependency-clean (only @noble/hashes, no CAP, no Node
 * builtins): this module sits under the public `@odatano/nightgate/set-root`
 * subpath, so it must load in Node (CJS + ESM) and in browser bundles alike.
 */

import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';

/** blake2b-256 hex of a UTF-8 string (the on-chain hashing scheme). */
export function blake2b256Hex(input: string): string {
    return bytesToHex(blake2b(new TextEncoder().encode(input), { dkLen: 32 }));
}

/** 64-hex string -> 32 bytes. */
export function fromHex32(hex: string): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}
