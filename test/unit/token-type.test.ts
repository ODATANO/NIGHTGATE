/**
 * Custom-token identity (`srv/submission/token-type.ts`).
 *
 * The separator normalization is pure and pinned here; `deriveRawTokenType`
 * itself goes through the REAL compact-runtime, so these also pin that our
 * derivation matches what the ledger addresses.
 */

import { describe, test, expect } from 'vitest';
import {
    padDomainSeparator, domainSeparatorHex, deriveRawTokenType, TokenTypeError,
    SHIELDED_TEST_TOKEN_DOMAIN_SEP, SHIELDED_TEST_TOKEN_AMOUNT
} from '../../srv/submission/token-type';

// A real preprod contract address (32 bytes, 64 hex). The runtime parses the
// address and rejects anything else, so this cannot be an invented string.
const ADDRESS = 'c8f426c52a5418f3b0acda284ee04d530a38f68ab3c701116fa42fae0e90cfd6';

describe('padDomainSeparator', () => {
    test('right-pads a plain string into 32 bytes, like Compact pad(32, ...)', () => {
        const bytes = padDomainSeparator('abc');
        expect(bytes).toHaveLength(32);
        expect(Array.from(bytes.slice(0, 3))).toEqual([0x61, 0x62, 0x63]);
        expect(Array.from(bytes.slice(3)).every(b => b === 0)).toBe(true);
    });

    test('defaults to the bundled test token separator', () => {
        expect(domainSeparatorHex(padDomainSeparator())).toBe(domainSeparatorHex(padDomainSeparator(SHIELDED_TEST_TOKEN_DOMAIN_SEP)));
    });

    test('reads 64 hex characters as the padded bytes verbatim', () => {
        const hex = 'ab'.repeat(32);
        expect(domainSeparatorHex(padDomainSeparator(hex))).toBe(hex);
        // and case-insensitively
        expect(domainSeparatorHex(padDomainSeparator(hex.toUpperCase()))).toBe(hex);
    });

    test('rejects an empty separator and one that cannot fit in 32 bytes', () => {
        expect(() => padDomainSeparator('')).toThrow(TokenTypeError);
        expect(() => padDomainSeparator('x'.repeat(33))).toThrow(/at most 32/);
        // multi-byte characters count as BYTES, not characters
        expect(() => padDomainSeparator('ä'.repeat(17))).toThrow(/34 bytes/);
        expect(padDomainSeparator('ä'.repeat(16))).toHaveLength(32);
    });
});

describe('deriveRawTokenType', () => {
    test('derives 64 lowercase hex through the real runtime', async () => {
        const r = await deriveRawTokenType(ADDRESS);
        expect(r.tokenTypeHex).toMatch(/^[0-9a-f]{64}$/);
        expect(r.contractAddress).toBe(ADDRESS);
        expect(r.domainSeparator).toBe(domainSeparatorHex(padDomainSeparator(SHIELDED_TEST_TOKEN_DOMAIN_SEP)));
    });

    test('is deterministic, and the string and hex separator forms agree', async () => {
        const viaString = await deriveRawTokenType(ADDRESS, SHIELDED_TEST_TOKEN_DOMAIN_SEP);
        const viaHex = await deriveRawTokenType(ADDRESS, domainSeparatorHex(padDomainSeparator(SHIELDED_TEST_TOKEN_DOMAIN_SEP)));
        expect(viaHex.tokenTypeHex).toBe(viaString.tokenTypeHex);
        expect((await deriveRawTokenType(ADDRESS)).tokenTypeHex).toBe(viaString.tokenTypeHex);
    });

    test('a different separator or a different contract is a DIFFERENT token', async () => {
        const base = await deriveRawTokenType(ADDRESS);
        const otherSep = await deriveRawTokenType(ADDRESS, 'nightgate:something-else');
        expect(otherSep.tokenTypeHex).not.toBe(base.tokenTypeHex);

        const otherAddress = ADDRESS.slice(0, -1) + (ADDRESS.endsWith('6') ? '7' : '6');
        const otherContract = await deriveRawTokenType(otherAddress);
        expect(otherContract.tokenTypeHex).not.toBe(base.tokenTypeHex);
    });

    test('rejects a missing or malformed contract address', async () => {
        await expect(deriveRawTokenType('')).rejects.toThrow(/contractAddress is required/);
        await expect(deriveRawTokenType('not-an-address')).rejects.toThrow(TokenTypeError);
    });

    test('the mint amount is exposed as an exact integer, not a float', () => {
        expect(SHIELDED_TEST_TOKEN_AMOUNT).toBe(100000000n);
        expect(SHIELDED_TEST_TOKEN_AMOUNT.toString()).toBe('100000000');
    });
});
