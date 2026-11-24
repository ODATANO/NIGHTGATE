/**
 * The owner address and DUST nonce of an unshielded UTXO (`srv/crawler/utxo-identity.ts`), with the SDK packages
 * replaced at their import seam. The real derivations are pinned by scripts/integration-test-utxo-identity.mjs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const encodeCalls = vi.hoisted(() => [] as Array<{ network: string; bytes: string }>);
const dustInitialNonce = vi.hoisted(() => vi.fn());

vi.mock('@midnightntwrk/wallet-sdk-address-format', () => ({
    UnshieldedAddress: class { constructor(readonly data: Buffer) {} },
    MidnightBech32m: {
        encode: (network: string, address: { data: Buffer }) => {
            encodeCalls.push({ network, bytes: address.data.toString('hex') });
            return { toString: () => `mn_addr_${network}1${address.data.toString('hex').slice(0, 6)}` };
        }
    }
}));
vi.mock('../../srv/midnight/sdk-loader', () => ({ loadLedger: async () => ({ dustInitialNonce }) }));

import { encodeUnshieldedOwner, computeInitialNonce, resetUtxoIdentityCache } from '../../srv/crawler/utxo-identity';

const OWNER = 'ab'.repeat(32);

beforeEach(() => {
    resetUtxoIdentityCache();
    encodeCalls.length = 0;
    dustInitialNonce.mockReset();
});

describe('encodeUnshieldedOwner', () => {
    it('encodes the raw owner bytes under the given network', async () => {
        expect(await encodeUnshieldedOwner(OWNER, 'preprod')).toBe('mn_addr_preprod1ababab');
        expect(encodeCalls).toEqual([{ network: 'preprod', bytes: OWNER }]);
    });

    it('encodes an owner once per network and answers repeats from the cache', async () => {
        await encodeUnshieldedOwner(OWNER, 'preprod');
        await encodeUnshieldedOwner(OWNER, 'preprod');
        expect(await encodeUnshieldedOwner(OWNER, 'mainnet')).toBe('mn_addr_mainnet1ababab');
        expect(encodeCalls.map(c => c.network)).toEqual(['preprod', 'mainnet']);
    });

    it('a full cache starts over instead of growing', async () => {
        for (let i = 0; i < 20_000; i++) await encodeUnshieldedOwner(i.toString(16).padStart(64, '0'), 'preview');
        encodeCalls.length = 0;
        await encodeUnshieldedOwner('ff'.repeat(32), 'preview');
        await encodeUnshieldedOwner('0'.repeat(64), 'preview');
        expect(encodeCalls).toHaveLength(2);
    });
});

describe('computeInitialNonce', () => {
    it('passes the output number as a bigint and the intent hash as given', async () => {
        dustInitialNonce.mockReturnValue('cd'.repeat(32));
        expect(await computeInitialNonce(3, 'ef'.repeat(32))).toBe('cd'.repeat(32));
        expect(dustInitialNonce).toHaveBeenCalledWith(3n, 'ef'.repeat(32));
    });

    it('a nonce the ledger returns as text loses its 0x and its capitals', async () => {
        dustInitialNonce.mockReturnValue('0xABCD');
        expect(await computeInitialNonce(0, 'ef')).toBe('abcd');
    });

    it('a nonce the ledger returns as bytes becomes lowercase hex', async () => {
        dustInitialNonce.mockReturnValue(new Uint8Array([0xab, 0x01, 0xff]));
        expect(await computeInitialNonce(0, 'ef')).toBe('ab01ff');
    });
});
