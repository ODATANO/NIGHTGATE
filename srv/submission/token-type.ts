/**
 * Custom-token identity.
 *
 * A token minted by a contract is addressed by its RAW TOKEN TYPE, which is
 * `rawTokenType(domainSeparator, contractAddress)`: the 32-byte separator the
 * contract passes to `mintShieldedToken` (in Compact, `pad(32, "...")`) hashed
 * together with the minting contract's address. Two contracts using the same
 * separator mint DIFFERENT tokens, and one contract can mint several by using
 * several separators.
 *
 * Without this value a caller cannot spend what it just minted: `sendNight`
 * takes `tokenTypeHex`, not a contract address. Deriving it needs no wallet, no
 * chain access and no proving, which is why it is exposed as a plain function.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/** Domain separator of the bundled `contracts/shielded-token` test token. */
export const SHIELDED_TEST_TOKEN_DOMAIN_SEP = 'nightgate:zswap-e2e';

/** Atoms minted per `mint()` call by the bundled test token. */
export const SHIELDED_TEST_TOKEN_AMOUNT = 100000000n;

/** Compiled-artifact ref of the bundled test token. */
export const SHIELDED_TEST_TOKEN_REF = 'shielded-token';

/** Circuit the bundled test token exposes. */
export const SHIELDED_TEST_TOKEN_CIRCUIT = 'mint';

export class TokenTypeError extends Error {
    constructor(message: string) { super(message); this.name = 'TokenTypeError'; }
}

/**
 * Normalize a domain separator to the 32 bytes the contract actually used.
 *
 * Accepts either the plain string the contract padded (`pad(32, "x")` is the
 * UTF-8 bytes of `x` right-padded with zeros) or 64 hex characters for those
 * bytes verbatim. A string of exactly 64 hex chars is read as HEX: that is the
 * ambiguous case, and a 64-character separator string is not something Compact
 * can pad into 32 bytes anyway.
 */
export function padDomainSeparator(input?: string): Uint8Array {
    const value = input ?? SHIELDED_TEST_TOKEN_DOMAIN_SEP;
    if (typeof value !== 'string' || value.length === 0) {
        throw new TokenTypeError('domainSeparator must be a non-empty string');
    }
    if (/^[0-9a-fA-F]{64}$/.test(value)) {
        const bytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
        return bytes;
    }
    const utf8 = Buffer.from(value, 'utf8');
    if (utf8.length > 32) {
        throw new TokenTypeError(`domainSeparator '${value}' is ${utf8.length} bytes; pad(32, ...) holds at most 32`);
    }
    const bytes = new Uint8Array(32);
    bytes.set(utf8);
    return bytes;
}

/** Hex of a normalized separator, for echoing back what was actually used. */
export function domainSeparatorHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

/**
 * `rawTokenType(domainSeparator, contractAddress)` as lowercase hex.
 *
 * The runtime is ESM-only, hence the dynamic import (see sdk-loader.ts for the
 * same pattern). `contractAddress` is passed through unchanged: the runtime
 * validates it and rejects a malformed address itself.
 */
export async function deriveRawTokenType(contractAddress: string, domainSeparator?: string): Promise<{
    tokenTypeHex: string;
    contractAddress: string;
    domainSeparator: string;
}> {
    if (!contractAddress) throw new TokenTypeError('contractAddress is required');
    const sep = padDomainSeparator(domainSeparator);
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    if (typeof rt.rawTokenType !== 'function') {
        throw new TokenTypeError('compact-runtime does not expose rawTokenType');
    }
    let raw: unknown;
    try {
        raw = rt.rawTokenType(sep, contractAddress);
    } catch (e) {
        throw new TokenTypeError(`rawTokenType failed for '${contractAddress}': ${(e as Error)?.message ?? e}`);
    }
    const tokenTypeHex = typeof raw === 'string'
        ? raw.toLowerCase()
        : Buffer.from(raw as Uint8Array).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(tokenTypeHex)) {
        throw new TokenTypeError(`rawTokenType returned an unexpected shape: ${String(raw).slice(0, 80)}`);
    }
    return { tokenTypeHex, contractAddress, domainSeparator: domainSeparatorHex(sep) };
}
