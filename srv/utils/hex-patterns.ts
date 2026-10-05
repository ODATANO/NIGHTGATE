/**
 * Patterns for 32-byte values as hex. No imports, so the wallet worker can use them too.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Normalized: 64 lowercase hex characters. */
export const HEX64_RE = /^[0-9a-f]{64}$/;

/** As a caller may send it: 64 hex characters in either case. */
export const HEX64_ANY_CASE_RE = /^[0-9a-fA-F]{64}$/;
