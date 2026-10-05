/**
 * Offer files: a serialized swap transaction written as bech32m text with the prefix `swapoffer`.
 * Unlike addresses, they have no 90-character limit.
 * SPDX-License-Identifier: Apache-2.0
 */
import { errorMessage } from './errors';

export const OFFER_FILE_HRP = 'swapoffer';

export class OfferFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OfferFileError';
    }
}

interface Bech32m {
    encode(prefix: string, words: number[], limit: number | false): string;
    decode(text: string, limit: number | false): { prefix: string; words: number[] };
    toWords(bytes: Uint8Array): number[];
    fromWords(words: number[]): Uint8Array;
}

// `@scure/base` is ESM-only: loaded once through a dynamic import.
let cached: Promise<Bech32m> | undefined;
function loadBech32m(): Promise<Bech32m> {
    cached ??= import('@scure/base' as string).then((m: { bech32m: Bech32m }) => m.bech32m);
    return cached;
}

/**
 * True for text that is meant as an offer file, even an invalid one.
 * It starts with the prefix or has the bech32 shape. Bech32 uses one case only, base64 mixes cases.
 */
export function looksLikeOfferFile(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    const s = text.trim();
    if (s.toLowerCase().startsWith(`${OFFER_FILE_HRP}1`)) return true;
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
    return /^[a-z0-9_-]{1,83}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/.test(s.toLowerCase());
}

/** Short reason from a decode error. The library would repeat the whole input in its message. */
const reason = (e: unknown): string => errorMessage(e).split(/[:"]| in /)[0].trim().slice(0, 120);

export async function encodeOfferFile(bytes: Uint8Array): Promise<string> {
    const bech32m = await loadBech32m();
    return bech32m.encode(OFFER_FILE_HRP, bech32m.toWords(bytes), false);
}

export async function decodeOfferFile(text: string): Promise<Uint8Array> {
    const bech32m = await loadBech32m();
    let decoded: { prefix: string; words: number[] };
    try {
        decoded = bech32m.decode(String(text ?? '').trim(), false);
    } catch (e) {
        throw new OfferFileError(`not a valid offer file: ${reason(e)}`);
    }
    if (decoded.prefix !== OFFER_FILE_HRP) {
        throw new OfferFileError(`offer file prefix is '${decoded.prefix.slice(0, 20)}', expected '${OFFER_FILE_HRP}'`);
    }
    try {
        return bech32m.fromWords(decoded.words);
    } catch (e) {
        throw new OfferFileError(`not a valid offer file: ${reason(e)}`);
    }
}

/** Accepts transaction bytes as an offer file or as base64. */
export async function transactionBytesOf(input: string): Promise<Uint8Array> {
    if (looksLikeOfferFile(input)) return decodeOfferFile(input);
    const compact = String(input ?? '').replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) throw new OfferFileError('neither an offer file nor base64');
    return new Uint8Array(Buffer.from(compact, 'base64'));
}
