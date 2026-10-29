// The bech32m codec of `@scure/base`, loaded once since the package is ESM-only.
// SPDX-License-Identifier: Apache-2.0
export interface Bech32m {
    encode(prefix: string, words: number[], limit: number | false): string;
    decode(text: string, limit: number | false): { prefix: string; words: number[] };
    toWords(bytes: Uint8Array): number[];
    fromWords(words: number[]): Uint8Array;
}

let cached: Promise<Bech32m> | undefined;
export function loadBech32m(): Promise<Bech32m> {
    cached ??= import('@scure/base' as string).then((m: { bech32m: Bech32m }) => m.bech32m);
    return cached;
}
