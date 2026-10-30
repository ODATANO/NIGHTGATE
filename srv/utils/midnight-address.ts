// Midnight addresses as bech32m text: `mn_<type>[_<network>]1...`.
// SPDX-License-Identifier: Apache-2.0
import type * as AddressFormat from '@midnightntwrk/wallet-sdk-address-format';
import { loadBech32m } from './bech32m';

export type AddressFormatModule = Pick<typeof AddressFormat, 'MidnightBech32m' | 'mainnet'>;

/** Like the format's own `parse`, but without a length limit: `@scure/base` 2.4.0 caps
 *  `decodeToBytes` at 90 characters and a shielded address has 132. */
export async function parseMidnightAddress(af: AddressFormatModule, text: string): Promise<AddressFormat.MidnightBech32m> {
    const bech32m = await loadBech32m();
    const decoded = bech32m.decode(text.trim(), false);
    const [prefix, type, network = af.mainnet] = decoded.prefix.split('_');
    if (prefix !== af.MidnightBech32m.prefix) throw new Error(`Expected prefix ${af.MidnightBech32m.prefix}`);
    return new af.MidnightBech32m(type, network, Buffer.from(bech32m.fromWords(decoded.words)));
}

/** What a receiver address pays to, by its prefix. Null for any other text. */
export function receiverKind(addr: string): 'shielded' | 'unshielded' | null {
    if (addr.startsWith('mn_shield-addr_')) return 'shielded';
    if (addr.startsWith('mn_addr_')) return 'unshielded';
    return null;
}

/** The accepted receiver prefixes, for error messages. */
export const RECEIVER_PREFIXES = "'mn_shield-addr_' (shielded) or 'mn_addr_' (unshielded)";
