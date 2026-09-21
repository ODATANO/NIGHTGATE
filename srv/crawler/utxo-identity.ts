/**
 * The two `UnshieldedUtxos` columns the chain event does not carry.
 *
 * `Midnight.UnshieldedTokens` reports the raw 32-byte owner and the
 * `(intentHash, outputNo)` pair; the stored row wants the Bech32m address and
 * the DUST initial nonce. Both are functions of what the event already gives,
 * and both reproduce the Midnight indexer's values byte for byte.
 *
 * Loaded through dynamic `import()` like the rest of the ESM-only SDK
 * (see srv/midnight/sdk-loader.ts).
 */

import { loadLedgerV8 } from '../midnight/sdk-loader';

type AddressFormatModule = any;

let cachedAddressFormat: AddressFormatModule | undefined;
let inflightAddressFormat: Promise<AddressFormatModule> | undefined;

async function loadAddressFormat(): Promise<AddressFormatModule> {
    if (cachedAddressFormat) return cachedAddressFormat;
    if (inflightAddressFormat) return inflightAddressFormat;
    inflightAddressFormat = (async () => {
        const mod = await import('@midnightntwrk/wallet-sdk-address-format');
        cachedAddressFormat = mod;
        return mod;
    })();
    try {
        return await inflightAddressFormat;
    } finally {
        inflightAddressFormat = undefined;
    }
}

// Encoding costs ~200 us and a chain has few busy addresses, so the same owner
// recurs constantly across blocks. Cleared wholesale rather than evicted: the
// cache is a speed-up, and a cold start after a clear costs one encode.
const MAX_CACHED_ADDRESSES = 20000;
const addressCache = new Map<string, string>();

/** Bech32m address of a raw 32-byte owner, as `mn_addr_<network>1...`. */
export async function encodeUnshieldedOwner(rawHex: string, network: string): Promise<string> {
    const key = `${network}:${rawHex}`;
    const hit = addressCache.get(key);
    if (hit) return hit;

    const af = await loadAddressFormat();
    const bytes = new Uint8Array(Buffer.from(rawHex, 'hex'));
    const encoded = af.MidnightBech32m.encode(network, new af.UnshieldedAddress(bytes)).toString();

    if (addressCache.size >= MAX_CACHED_ADDRESSES) addressCache.clear();
    addressCache.set(key, encoded);
    return encoded;
}

/**
 * The UTxO's DUST initial nonce, the backing-NIGHT hash DUST generation is
 * tracked by. `intentHash` is hex without `0x`; the ledger rejects the prefix.
 */
export async function computeInitialNonce(outputNo: number, intentHash: string): Promise<string> {
    const ledger = await loadLedgerV8();
    const nonce = ledger.dustInitialNonce(BigInt(outputNo), intentHash);
    return typeof nonce === 'string'
        ? nonce.replace(/^0x/i, '').toLowerCase()
        : Buffer.from(nonce).toString('hex');
}

/** Test seam: drops the memoized module and the address cache. */
export function resetUtxoIdentityCache(): void {
    cachedAddressFormat = undefined;
    inflightAddressFormat = undefined;
    addressCache.clear();
}
