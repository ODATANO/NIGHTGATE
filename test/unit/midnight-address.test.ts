/**
 * srv/utils/midnight-address.ts: addresses decode at the length the format's encoder writes,
 * beyond the 90-character default of bech32. The format module is a stand-in that records the parts.
 */
import { bech32m } from '@scure/base';
import { parseMidnightAddress } from '../../srv/utils/midnight-address';

const mainnet = Symbol('Mainnet');
class MidnightBech32m {
    static prefix = 'mn';
    constructor(readonly type: string, readonly network: string | symbol, readonly data: Buffer) { /* records the parts */ }
}
const af = { MidnightBech32m, mainnet } as any;

const bytesOf = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (i * 37 + 5) & 255);
const encode = (prefix: string, bytes: Uint8Array) => bech32m.encode(prefix, bech32m.toWords(bytes), false);

describe('parseMidnightAddress', () => {
    it('decodes a 132-character shielded address into its 64 bytes', async () => {
        const bytes = bytesOf(64);
        const text = encode('mn_shield-addr_preprod', bytes);
        expect(text).toHaveLength(132);
        expect(() => bech32m.decode(text)).toThrow(/length/);
        const parsed = await parseMidnightAddress(af, ` ${text} `);
        expect(parsed).toMatchObject({ type: 'shield-addr', network: 'preprod' });
        expect(parsed.data).toEqual(Buffer.from(bytes));
    });

    it('decodes an unshielded address and reads a missing network segment as mainnet', async () => {
        const unshielded = await parseMidnightAddress(af, encode('mn_addr_preprod', bytesOf(32)));
        expect(unshielded).toMatchObject({ type: 'addr', network: 'preprod' });
        const main = await parseMidnightAddress(af, encode('mn_shield-addr', bytesOf(64)));
        expect(main.network).toBe(mainnet);
    });

    it('refuses a foreign prefix and a broken checksum', async () => {
        await expect(parseMidnightAddress(af, encode('addr_test', bytesOf(32)))).rejects.toThrow(/Expected prefix mn/);
        const text = encode('mn_shield-addr_preprod', bytesOf(64));
        await expect(parseMidnightAddress(af, text.slice(0, -1) + (text.endsWith('q') ? 'p' : 'q'))).rejects.toThrow();
    });
});
