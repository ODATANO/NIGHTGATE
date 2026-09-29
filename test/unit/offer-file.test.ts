/**
 * srv/utils/offer-file.ts: transaction bytes as bech32m text under `swapoffer`,
 * and the two forms a caller may hand a transaction over in.
 */
import { bech32, bech32m } from '@scure/base';
import {
    OFFER_FILE_HRP, OfferFileError, encodeOfferFile, decodeOfferFile, looksLikeOfferFile, transactionBytesOf
} from '../../srv/utils/offer-file';

const bytesOf = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (i * 131 + 7) & 255);

describe('offer files', () => {
    it('round-trips transaction bytes far beyond the 90-character limit of address strings', async () => {
        for (const length of [1, 32, 33, 15476]) {
            const bytes = bytesOf(length);
            const text = await encodeOfferFile(bytes);
            expect(text.startsWith(`${OFFER_FILE_HRP}1`)).toBe(true);
            expect(text).toBe(bech32m.encode(OFFER_FILE_HRP, bech32m.toWords(bytes), false));
            expect(Buffer.from(await decodeOfferFile(text))).toEqual(Buffer.from(bytes));
        }
    });

    it('reads upper case and surrounding whitespace', async () => {
        const bytes = bytesOf(64);
        const text = await encodeOfferFile(bytes);
        expect(Buffer.from(await decodeOfferFile(text.toUpperCase()))).toEqual(Buffer.from(bytes));
        expect(Buffer.from(await decodeOfferFile(`  ${text}\n`))).toEqual(Buffer.from(bytes));
    });

    it('refuses a changed character, mixed case, another prefix and the older bech32 checksum', async () => {
        const bytes = bytesOf(64);
        const text = await encodeOfferFile(bytes);
        const flipped = text.slice(0, -1) + (text.at(-1) === 'q' ? 'p' : 'q');
        await expect(decodeOfferFile(flipped)).rejects.toThrow(/not a valid offer file: Invalid checksum$/);
        await expect(decodeOfferFile(text.slice(0, 20) + text.slice(20).toUpperCase())).rejects.toThrow(/lowercase or uppercase/);
        await expect(decodeOfferFile(text.slice(0, -9) + 'b' + text.slice(-8))).rejects.toThrow(OfferFileError);
        await expect(decodeOfferFile(bech32m.encode('zswapoffer', bech32m.toWords(bytes), false)))
            .rejects.toThrow("offer file prefix is 'zswapoffer', expected 'swapoffer'");
        await expect(decodeOfferFile(bech32.encode(OFFER_FILE_HRP, bech32.toWords(bytes), false))).rejects.toThrow(/Invalid checksum/);
    });

    it('never quotes the offer in an error', async () => {
        const text = await encodeOfferFile(bytesOf(2000));
        const error: Error = await decodeOfferFile(text.slice(0, -1) + (text.at(-1) === 'q' ? 'p' : 'q')).catch(e => e);
        expect(error.message.length).toBeLessThan(80);
    });
});

describe('transactionBytesOf: an offer file or base64', () => {
    const bytes = bytesOf(600);

    it('takes both forms to the same bytes', async () => {
        expect(Buffer.from(await transactionBytesOf(await encodeOfferFile(bytes)))).toEqual(Buffer.from(bytes));
        expect(Buffer.from(await transactionBytesOf(Buffer.from(bytes).toString('base64')))).toEqual(Buffer.from(bytes));
        expect(Buffer.from(await transactionBytesOf(Buffer.from(bytes).toString('base64url')))).toEqual(Buffer.from(bytes));
    });

    it('decides by shape: bech32 text is never read as base64', async () => {
        const other = bech32m.encode('zswapoffer', bech32m.toWords(bytes), false);
        expect(looksLikeOfferFile(other)).toBe(true);
        await expect(transactionBytesOf(other)).rejects.toThrow(/prefix is 'zswapoffer'/);
        const mixed = (await encodeOfferFile(bytes)).replace(/q/g, 'Q');
        expect(looksLikeOfferFile(mixed)).toBe(true);
        await expect(transactionBytesOf(mixed)).rejects.toThrow(/lowercase or uppercase/);
        expect(looksLikeOfferFile(Buffer.from(bytes).toString('base64'))).toBe(false);
        expect(looksLikeOfferFile(undefined)).toBe(false);
    });

    it('refuses what is neither', async () => {
        for (const input of ['', '   ', 'hello world!', '{"tx":1}']) {
            await expect(transactionBytesOf(input)).rejects.toThrow('neither an offer file nor base64');
        }
    });
});
