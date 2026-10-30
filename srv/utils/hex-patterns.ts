// Hex patterns for 32-byte values and seeds. No imports, so the wallet worker and the builder can use them too.
// SPDX-License-Identifier: Apache-2.0

/** Normalized: 64 lowercase hex characters. */
export const HEX64_RE = /^[0-9a-f]{64}$/;

/** As a caller may send it: 64 hex characters in either case. */
export const HEX64_ANY_CASE_RE = /^[0-9a-fA-F]{64}$/;

/** A 64-byte BIP39 seed: 128 hex characters in either case. */
export const SEED_HEX_RE = /^[0-9a-fA-F]{128}$/;

/** Throws unless `seedHex` is a 64-byte BIP39 seed. `label` names the caller in the message. */
export function assertSeedHex(seedHex: unknown, label?: string): asserts seedHex is string {
    if (!SEED_HEX_RE.test(String(seedHex ?? ''))) throw new Error(`${label ? `${label}: ` : ''}seedHex must be 128 hex chars (64-byte BIP39 seed)`);
}

/** `value` as bare lowercase hex: trimmed, without a `0x` prefix. It does not check that the rest is hex. */
export function bareHex(value: unknown): string {
    return String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
}
