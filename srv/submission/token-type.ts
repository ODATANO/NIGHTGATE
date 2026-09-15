/**
 * Raw token type = rawTokenType(domainSeparator, minting contract address);
 * `sendNight` needs it to spend a minted token.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Bundled `contracts/shielded-token` test token. */
export const SHIELDED_TEST_TOKEN_DOMAIN_SEP = 'nightgate:zswap-e2e';

/** Atoms per `mint()`. */
export const SHIELDED_TEST_TOKEN_AMOUNT = 100000000n;

export const SHIELDED_TEST_TOKEN_REF = 'shielded-token';

export const SHIELDED_TEST_TOKEN_CIRCUIT = 'mint';

export class TokenTypeError extends Error {
    constructor(message: string) { super(message); this.name = 'TokenTypeError'; }
}

/**
 * The 32 bytes of `pad(32, input)` (UTF-8, zero right-padded), or 64 hex
 * verbatim. Exactly 64 hex chars read as hex: such a string cannot fit pad(32).
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

export function domainSeparatorHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

/** Lowercase hex; the runtime validates `contractAddress` itself. */
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
