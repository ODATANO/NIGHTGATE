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

/**
 * Canonical empty-slot field key: "nightgate/empty-leaf/v2" ASCII,
 * zero-padded to 32 bytes. MUST stay byte-identical to the contract's
 * `emptyLeafKey()` pure circuit (Compact `pad(32, ...)` right-pads); a unit
 * test pins the parity. v2 replaced the v1 blake2b-digest key in 0.16.0
 * because a Compact literal cannot express an arbitrary digest.
 */
export const EMPTY_LEAF_KEY_LABEL = 'nightgate/empty-leaf/v2';

export function emptyLeafKeyBytes(): Uint8Array {
    const out = new Uint8Array(32);
    out.set(new TextEncoder().encode(EMPTY_LEAF_KEY_LABEL));
    return out;
}

export function emptyLeafKeyHex(): string {
    return bytesToHex(emptyLeafKeyBytes());
}
