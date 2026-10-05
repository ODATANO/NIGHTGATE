/**
 * A minted token's type is rawTokenType(domainSeparator, address of the minting contract).
 * `sendNight` needs it to send a minted token.
 * SPDX-License-Identifier: Apache-2.0
 */
import { NightgateError, errorMessage } from '../utils/errors';
import { HEX64_ANY_CASE_RE, HEX64_RE } from '../utils/hex-patterns';

/** Bundled `contracts/shielded-token` test token. */
export const SHIELDED_TEST_TOKEN_DOMAIN_SEP = 'nightgate:zswap-e2e';

/** Atoms per `mint()`. */
export const SHIELDED_TEST_TOKEN_AMOUNT = 100000000n;

export const SHIELDED_TEST_TOKEN_REF = 'shielded-token';

export const SHIELDED_TEST_TOKEN_CIRCUIT = 'mint';

export class TokenTypeError extends NightgateError {
    constructor(message: string) { super('TOKEN_TYPE_INVALID', message); }
}

/**
 * 64 hex characters are read as hex. Anything else is UTF-8, padded with zeros to 32 bytes.
 * A 64-character string would not fit into 32 bytes as text anyway.
 */
export function padDomainSeparator(input?: string | null): Uint8Array {
    const value = input ?? SHIELDED_TEST_TOKEN_DOMAIN_SEP;
    if (typeof value !== 'string' || value.length === 0) {
        throw new TokenTypeError('domainSeparator must be a non-empty string');
    }
    if (HEX64_ANY_CASE_RE.test(value)) {
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

export async function deriveRawTokenType(contractAddress: string, domainSeparator?: string | null): Promise<{
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
        throw new TokenTypeError(`rawTokenType failed for '${contractAddress}': ${errorMessage(e)}`);
    }
    const tokenTypeHex = typeof raw === 'string'
        ? raw.toLowerCase()
        : Buffer.from(raw as Uint8Array).toString('hex');
    if (!HEX64_RE.test(tokenTypeHex)) {
        throw new TokenTypeError(`rawTokenType returned an unexpected shape: ${String(raw).slice(0, 80)}`);
    }
    return { tokenTypeHex, contractAddress, domainSeparator: domainSeparatorHex(sep) };
}
