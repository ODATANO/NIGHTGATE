// `@odatano/nightgate/txbuilder`, shielded swaps: reading a half's terms, offer
// files, the swap wallet against a fake wallet SDK, recipients, sync modes.
// The live path is covered by the swap probes against a running server.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

const ledgerFake = vi.hoisted(() => ({ byBytes: new Map<string, { binding: string; tx: any }>() }));
vi.mock('@midnight-ntwrk/ledger-v8', () => ({
    Transaction: {
        deserialize: (_s: string, _p: string, binding: string, bytes: Uint8Array) => {
            const found = ledgerFake.byBytes.get(Buffer.from(bytes).toString('hex'));
            if (!found || found.binding !== binding) throw new Error(`expected header tag for ${binding}`);
            return found.tx;
        }
    },
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32) }) }
}));

const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

/** A stand-in for a ledger transaction that is one half of a swap. */
function half(deltas: Array<[string, bigint]>, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): any {
    return {
        intents: new Map(),
        fallibleOffer: undefined,
        guaranteedOffer: { inputs: [{}], outputs: [{}, {}], transients: [], deltas: new Map(deltas), ...over },
        ...top
    };
}

/** Registers bytes with the fake ledger, in one binding form. */
function registered(tx: any, tag: number, binding: 'binding' | 'pre-binding'): Uint8Array {
    const bytes = Uint8Array.from({ length: 40 }, (_, i) => (i * 7 + tag) & 255);
    ledgerFake.byBytes.set(Buffer.from(bytes).toString('hex'), { binding, tx });
    return bytes;
}

beforeEach(() => ledgerFake.byBytes.clear());

describe('readSwapTerms', () => {
    it('reads what a half gives and wants from its two deltas, with the coins it carries', async () => {
        const { readSwapTerms } = await importTxBuilder();
        expect(readSwapTerms(half([[A, 1000n], [B, -300n]]))).toEqual({
            gives: { tokenType: A, amount: 1000n },
            wants: { tokenType: B, amount: 300n },
            inputs: 1, outputs: 2
        });
        expect(readSwapTerms(half([['0x' + A.toUpperCase(), 1n], [B, -1n]])).gives.tokenType).toBe(A);
    });

    it('refuses anything but a plain swap half', async () => {
        const { readSwapTerms } = await importTxBuilder();
        expect(() => readSwapTerms(half([[A, 10n]]))).toThrow(/gives 1 token type\(s\) and wants 0/);
        expect(() => readSwapTerms(half([[A, -10n]]))).toThrow(/gives 0 token type\(s\) and wants 1/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n], ['c3'.repeat(32), -1n]]))).toThrow(/wants 2/);
        expect(() => readSwapTerms(half([]))).toThrow(/gives 0 token type\(s\) and wants 0/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n]], {}, { intents: new Map([[1, {}]]) }))).toThrow(/carries an intent/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n]], {}, { fallibleOffer: new Map([[1, {}]]) }))).toThrow(/fallible offer/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n]], { transients: [{}] }))).toThrow(/transient coin/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n]], { inputs: [{ contractAddress: 'aa' }] }))).toThrow(/contract-owned coin/);
        expect(() => readSwapTerms({ intents: new Map() })).toThrow(/no guaranteed offer/);
        expect(() => readSwapTerms(half([[A, 10n], [B, -3n]], { deltas: undefined }))).toThrow(/exposes no deltas/);
    });

    it('sameSwapTerms compares types and amounts, whatever form the amounts come in', async () => {
        const { sameSwapTerms } = await importTxBuilder();
        const terms = { gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } };
        expect(sameSwapTerms(terms, { gives: { tokenType: A.toUpperCase(), amount: '1000' }, wants: { tokenType: B, amount: 300 } })).toBe(true);
        expect(sameSwapTerms(terms, { gives: { tokenType: A, amount: 999n }, wants: { tokenType: B, amount: 300n } })).toBe(false);
        expect(sameSwapTerms(terms, { gives: { tokenType: B, amount: 1000n }, wants: { tokenType: A, amount: 300n } })).toBe(false);
        expect(() => sameSwapTerms(terms, { gives: { tokenType: 'CREDIT', amount: 1n }, wants: terms.wants })).toThrow(/raw token type/);
        expect(() => sameSwapTerms(terms, { gives: { tokenType: A, amount: 0 }, wants: terms.wants })).toThrow(/must be positive/);
    });
});

describe('offer files in the builder', () => {
    it('encodeOffer writes swapoffer text; decodeOffer reads text, base64 and bytes and says which form it was', async () => {
        const { encodeOffer, decodeOffer, SWAP_OFFER_PREFIX } = await importTxBuilder();
        const tx = half([[A, 10n], [B, -3n]]);
        const boundBytes = registered(tx, 1, 'binding');
        const unboundBytes = registered(tx, 2, 'pre-binding');

        const text = await encodeOffer(boundBytes);
        expect(text.startsWith(`${SWAP_OFFER_PREFIX}1`)).toBe(true);
        expect(await encodeOffer({ serialize: () => boundBytes })).toBe(text);

        for (const input of [text, text.toUpperCase(), Buffer.from(boundBytes).toString('base64'), boundBytes]) {
            const decoded = await decodeOffer(input);
            expect(decoded.bound).toBe(true);
            expect(decoded.tx).toBe(tx);
            expect(Buffer.from(decoded.bytes)).toEqual(Buffer.from(boundBytes));
        }
        expect((await decodeOffer(Buffer.from(unboundBytes).toString('base64'))).bound).toBe(false);
    });

    it('refuses a damaged offer file and bytes that are no proven transaction', async () => {
        const { encodeOffer, decodeOffer } = await importTxBuilder();
        const text = await encodeOffer(registered(half([[A, 10n], [B, -3n]]), 3, 'binding'));
        await expect(decodeOffer(text.slice(0, -1) + (text.at(-1) === 'q' ? 'p' : 'q'))).rejects.toThrow(/Invalid checksum/);
        await expect(decodeOffer(Buffer.from('not a transaction').toString('base64'))).rejects.toThrow(/not a proven transaction \(17 bytes/);
        await expect(decodeOffer('')).rejects.toThrow(/neither an offer file nor base64/);
    });
});

describe('createSwapWallet', () => {
    const SEED = 'ab'.repeat(64);
    const URLS = { indexerHttpUrl: 'https://indexer.example/api/v3/graphql', indexerWsUrl: 'wss://indexer.example/api/v3/graphql/ws' };

    function fakeSdk(over: { balances?: Record<string, bigint>; built?: (inputs: any, outputs: any) => any; coins?: Array<{ type: string; value: bigint }>; unprovenInputs?: number } = {}) {
        const calls: any = { initSwap: [], reverted: [], restored: [], started: 0, stopped: 0, proven: [], picked: [] };
        const coins = over.coins ?? [{ type: A, value: 5000n }, { type: B, value: 5000n }];
        let selection: any;
        const ownAddress = { own: 'address' };
        let tag = 10;
        const proven = (deltas: Array<[string, bigint]>) => {
            const tx: any = half(deltas);
            const unboundBytes = registered(tx, tag++, 'pre-binding');
            const bound: any = { ...tx, isBound: true };
            const boundBytes = registered(bound, tag++, 'binding');
            tx.serialize = () => unboundBytes;
            tx.bind = () => bound;
            bound.serialize = () => boundBytes;
            return tx;
        };
        const wallet = {
            state: { subscribe: (o: any) => { o.next({ balances: over.balances ?? { [A]: 5000n }, availableCoins: coins.map(coin => ({ coin })) }); return { unsubscribe() { /* nothing to release */ } }; } },
            start: vi.fn(async () => { calls.started++; }),
            stop: vi.fn(async () => { calls.stopped++; }),
            getAddress: vi.fn(async () => ownAddress),
            waitForSyncedState: vi.fn(async () => ({})),
            serializeState: vi.fn(async () => '{"saved":true}'),
            initSwap: vi.fn(async (_keys: any, inputs: any, outputs: any) => {
                calls.initSwap.push({ inputs, outputs });
                // the wallet asks the configured selection for its coins, one by one
                const [[type, amount]] = Object.entries(inputs) as Array<[string, bigint]>;
                let pool = [...coins];
                let got = 0n;
                const picked: bigint[] = [];
                while (got < amount) {
                    const coin = selection(pool, type, amount - got, {});
                    if (!coin) throw new Error(`Insufficient Funds: could not balance ${type}`);
                    picked.push(coin.value);
                    got += coin.value;
                    pool = pool.filter(c => c !== coin);
                }
                calls.picked.push(picked);
                return { unproven: true, inputs, outputs, guaranteedOffer: { inputs: Array.from({ length: over.unprovenInputs ?? picked.length }) } };
            }),
            revertTransaction: vi.fn(async (tx: any) => { calls.reverted.push(tx); })
        };
        const factory = {
            startWithSecretKeys: vi.fn(() => wallet),
            restore: vi.fn((state: string) => { calls.restored.push(state); return wallet; })
        };
        const sdk = {
            ledger: { ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32) }) } },
            shielded: { CustomShieldedWallet: vi.fn((_config: unknown, _builder: unknown) => factory) },
            shieldedV1: {
                V1Builder: class {
                    withDefaults() { return this; }
                    withCoinSelection(make: () => unknown) { selection = make(); return this; }
                }
            },
            abstractions: { InMemoryTransactionHistoryStorage: class { /* storage stand-in */ } },
            facade: { WalletEntrySchema: {}, mergeWalletEntries: () => ({}) },
            addressFormat: { MidnightBech32m: { encode: (network: string) => ({ toString: () => `mn_shield-addr_${network}1own` }) } },
            networkId: { setNetworkId: vi.fn() },
            deriveRoleSeeds: async () => ({ zswap: new Uint8Array(32), dust: new Uint8Array(32), night: new Uint8Array(32) }),
            provingService: {
                prove: vi.fn(async (unproven: any) => {
                    calls.proven.push(unproven);
                    if (over.built) return over.built(unproven.inputs, unproven.outputs);
                    const [[giveType, giveAmount]] = Object.entries(unproven.inputs) as Array<[string, bigint]>;
                    return proven([[giveType, giveAmount], [unproven.outputs[0].type, -(unproven.outputs[0].amount as bigint)]]);
                })
            }
        };
        return { sdk, wallet, factory, calls, ownAddress, proven };
    }

    it('validates its input before touching the SDK', async () => {
        const { createSwapWallet } = await importTxBuilder();
        await expect(createSwapWallet({ ...URLS, seedHex: 'abc' })).rejects.toThrow(/128 hex chars/);
        await expect(createSwapWallet({ seedHex: SEED, indexerHttpUrl: URLS.indexerHttpUrl })).rejects.toThrow(/indexerHttpUrl and indexerWsUrl/);
        await expect(createSwapWallet({ ...URLS, seedHex: SEED, provingMode: 'cloud' })).rejects.toThrow(/provingMode must be 'wasm' or 'server'/);
        await expect(createSwapWallet({ ...URLS, seedHex: SEED, provingMode: 'server' })).rejects.toThrow(/requires proofServerUrl/);
        await expect(createSwapWallet({ ...URLS, seedHex: SEED, maxInputs: 0 })).rejects.toThrow(/maxInputs must be a positive integer/);
    });

    it('buildHalf spends the smallest coins that still fit the input cap', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const coins = [1n, 1n, 1n, 1n, 100n].map(value => ({ type: A, value }));
        const { sdk, calls } = fakeSdk({ coins });
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });
        expect(wallet.maxInputs).toBe(4);
        expect(await wallet.spendable(A)).toBe(103n);
        expect(await wallet.coins()).toEqual(coins.map(c => ({ tokenType: A, amount: c.value })));
        await wallet.buildHalf({ give: { tokenType: A, amount: 50n }, want: { tokenType: B, amount: 3n } });
        // smallest first alone would take all five
        expect(calls.picked[0]).toEqual([1n, 1n, 1n, 100n]);
        await wallet.buildHalf({ give: { tokenType: A, amount: 3n }, want: { tokenType: B, amount: 3n } });
        expect(calls.picked[1]).toEqual([1n, 1n, 1n]);
    });

    it('buildHalf refuses what the largest coins cannot give, before the wallet or the prover is asked', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk({ coins: [1n, 2n, 3n, 4n, 5n, 6n].map(value => ({ type: A, value })) });
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });
        await expect(wallet.buildHalf({ give: { tokenType: A, amount: 19n }, want: { tokenType: B, amount: 3n } }))
            .rejects.toThrow(/giving 19 of a1a1a1a1a1a1a1a1 needs more than 4 coins; the 4 largest free coins hold 18/);
        expect(calls.initSwap).toHaveLength(0);
        expect(calls.proven).toHaveLength(0);

        const wide = fakeSdk({ coins: [1n, 2n, 3n, 4n, 5n, 6n].map(value => ({ type: A, value })) });
        const six = await createSwapWallet({ ...URLS, seedHex: SEED, maxInputs: 6, sdk: wide.sdk });
        await six.buildHalf({ give: { tokenType: A, amount: 21n }, want: { tokenType: B, amount: 3n } });
        expect(wide.calls.picked[0]).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    });

    it('buildHalf counts the inputs of the half before proving it', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk({ unprovenInputs: 5 });
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });
        await expect(wallet.buildHalf({ give: { tokenType: A, amount: 10n }, want: { tokenType: B, amount: 3n } }))
            .rejects.toThrow(/spends 5 coins, more than the 4 a sponsor accepts/);
        expect(calls.proven).toHaveLength(0);
        expect(calls.reverted).toHaveLength(1);
    });

    it('starts the shielded wallet alone, from genesis or from a saved state', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const fresh = fakeSdk();
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: fresh.sdk });
        expect(fresh.factory.startWithSecretKeys).toHaveBeenCalledTimes(1);
        expect(fresh.calls.started).toBe(1);
        expect(wallet).toMatchObject({ address: 'mn_shield-addr_preprod1own', coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32), provingMode: 'wasm' });
        expect(await wallet.balances()).toEqual({ [A]: 5000n });
        expect(await wallet.serializeState()).toBe('{"saved":true}');
        await wallet.close();
        expect(fresh.calls.stopped).toBe(1);

        const resumed = fakeSdk();
        await createSwapWallet({ ...URLS, seedHex: SEED, walletState: '{"saved":true}', sdk: resumed.sdk });
        expect(resumed.calls.restored).toEqual(['{"saved":true}']);
        expect(resumed.factory.startWithSecretKeys).not.toHaveBeenCalled();
    });

    it('buildHalf: bound with its offer file by default, unbound as base64 only', async () => {
        const { createSwapWallet, decodeOffer } = await importTxBuilder();
        const { sdk, calls, ownAddress } = fakeSdk();
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });

        const bound = await wallet.buildHalf({ give: { tokenType: A, amount: 1000 }, want: { tokenType: B, amount: '300' } });
        expect(calls.initSwap[0]).toEqual({ inputs: { [A]: 1000n }, outputs: [{ type: B, receiverAddress: ownAddress, amount: 300n }] });
        expect(bound.bound).toBe(true);
        expect(bound.offer.startsWith('swapoffer1')).toBe(true);
        expect(bound.terms).toMatchObject({ gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } });
        expect((await decodeOffer(bound.offer)).bound).toBe(true);
        expect((await decodeOffer(bound.halfB64)).bound).toBe(true);

        const unbound = await wallet.buildHalf({ give: { tokenType: A, amount: 1n }, want: { tokenType: B, amount: 1n }, bind: false });
        expect(unbound.bound).toBe(false);
        expect(unbound.offer).toBeUndefined();
        expect((await decodeOffer(unbound.halfB64)).bound).toBe(false);

        await bound.revert();
        expect(calls.reverted).toHaveLength(1);
    });

    it('buildHalf releases the coins when proving fails or the half is not what was asked', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const failing = fakeSdk({ built: () => { throw new Error('prover unavailable'); } });
        const a = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: failing.sdk });
        await expect(a.buildHalf({ give: { tokenType: A, amount: 10n }, want: { tokenType: B, amount: 3n } })).rejects.toThrow('prover unavailable');
        expect(failing.calls.reverted).toEqual([expect.objectContaining({ unproven: true })]);

        const other = fakeSdk();
        other.sdk.provingService.prove = vi.fn(async () => other.proven([[A, 9n], [B, -3n]]));
        const b = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: other.sdk });
        await expect(b.buildHalf({ give: { tokenType: A, amount: 10n }, want: { tokenType: B, amount: 3n } })).rejects.toThrow(/not what was asked/);
        expect(other.calls.reverted).toHaveLength(1);

        await expect(b.buildHalf({ give: { tokenType: A, amount: 10n }, want: { tokenType: A, amount: 3n } })).rejects.toThrow(/same token type/);
        await expect(b.buildHalf({ give: { tokenType: 'DATA', amount: 10n }, want: { tokenType: B, amount: 3n } })).rejects.toThrow(/give.tokenType must be a raw token type/);
    });

    it('takeOffer reads the terms from the offer, builds the mirror half in the offer\'s form and returns both', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const maker = fakeSdk();
        const makerWallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: maker.sdk });
        const offer = await makerWallet.buildHalf({ give: { tokenType: A, amount: 1000n }, want: { tokenType: B, amount: 300n } });

        const taker = fakeSdk();
        const takerWallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: taker.sdk });
        const taken = await takerWallet.takeOffer({ offer: offer.offer, expect: { gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } } });
        expect(taker.calls.initSwap[0].inputs).toEqual({ [B]: 300n });
        expect(taker.calls.initSwap[0].outputs[0]).toMatchObject({ type: A, amount: 1000n });
        expect(taken.makerHalfB64).toBe(offer.halfB64);
        expect(taken.bound).toBe(true);
        expect(taken.terms).toMatchObject({ gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } });

        // an unbound offer gets an unbound mirror half: the two forms do not merge
        const unboundOffer = await makerWallet.buildHalf({ give: { tokenType: A, amount: 5n }, want: { tokenType: B, amount: 2n }, bind: false });
        expect((await takerWallet.takeOffer({ offer: unboundOffer.halfB64 })).bound).toBe(false);
    });

    it('takeOffer refuses an offer that does not say what was expected, before spending anything', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const maker = fakeSdk();
        const offer = await (await createSwapWallet({ ...URLS, seedHex: SEED, sdk: maker.sdk }))
            .buildHalf({ give: { tokenType: A, amount: 999n }, want: { tokenType: B, amount: 300n } });
        const taker = fakeSdk();
        const takerWallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: taker.sdk });
        await expect(takerWallet.takeOffer({ offer: offer.offer, expect: { gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } } }))
            .rejects.toThrow(/gives 999 of a1a1a1a1a1a1a1a1 for 300 of b2b2b2b2b2b2b2b2, which is not what was expected/);
        expect(taker.calls.initSwap).toHaveLength(0);
    });
});

describe('coin selection within the input cap', () => {
    const coinsOf = (values: number[]) => values.map(v => ({ type: A, value: BigInt(v) }));
    const run = async (values: number[], need: number, slots = 4) => {
        const { chooseSwapCoin } = await importTxBuilder();
        const plan = { remaining: BigInt(need), slots };
        let pool = [...coinsOf(values), { type: B, value: 1000n }];
        const picked: number[] = [];
        while (plan.remaining > 0n) {
            const coin = chooseSwapCoin(pool, A, plan);
            if (!coin) break;
            picked.push(Number(coin.value));
            pool = pool.filter(c => c !== coin);
        }
        return { picked, covered: plan.remaining <= 0n };
    };

    it('takes small coins first as long as the remaining slots can cover the rest', async () => {
        expect(await run([1, 1, 1, 1, 100], 50)).toEqual({ picked: [1, 1, 1, 100], covered: true });
        expect(await run([1, 2, 3, 4, 5, 6], 10)).toEqual({ picked: [1, 2, 3, 4], covered: true });
        expect(await run([1, 2, 3, 4, 5, 6], 18)).toEqual({ picked: [3, 4, 5, 6], covered: true });
        expect(await run([5, 5, 5, 5], 20)).toEqual({ picked: [5, 5, 5, 5], covered: true });
        expect(await run([10], 3)).toEqual({ picked: [10], covered: true });
        expect(await run([1, 1, 1, 1, 1, 1, 1, 50], 5)).toEqual({ picked: [1, 1, 1, 50], covered: true });
    });

    it('takes nothing when the cap cannot cover the amount, and never a coin of another type', async () => {
        expect(await run([1, 2, 3, 4, 5, 6], 19)).toEqual({ picked: [], covered: false });
        expect(await run([], 1)).toEqual({ picked: [], covered: false });
        expect(await run([4, 4, 4], 8, 1)).toEqual({ picked: [], covered: false });
        expect(await run([4, 9, 4], 8, 1)).toEqual({ picked: [9], covered: true });
    });

    it('spendableWithin sums the largest coins of one type', async () => {
        const { spendableWithin, SWAP_MAX_INPUTS } = await importTxBuilder();
        expect(SWAP_MAX_INPUTS).toBe(4);
        expect(spendableWithin([...coinsOf([1, 2, 3, 4, 5, 6]), { type: B, value: 99n }], A)).toBe(18n);
        expect(spendableWithin(coinsOf([1, 2, 3]), A, 2)).toBe(5n);
        expect(spendableWithin(coinsOf([1, 2, 3]), B)).toBe(0n);
    });
});

describe('recipients and sync modes', () => {
    it('recipientKeyMap maps coin public keys to encryption public keys', async () => {
        const { recipientKeyMap } = await importTxBuilder();
        const map = recipientKeyMap([{ coinPublicKey: 'C1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32) }]);
        expect(Array.from(map.entries())).toEqual([['c1'.repeat(32), 'e1'.repeat(32)]]);
        expect(recipientKeyMap(undefined)).toBeUndefined();
        expect(recipientKeyMap([])).toBeUndefined();
        expect(() => recipientKeyMap('x')).toThrow(/must be an array/);
        expect(() => recipientKeyMap([{ coinPublicKey: 'c1', encryptionPublicKey: 'e1'.repeat(32) }])).toThrow(/coinPublicKey must be 64 hex/);
        expect(() => recipientKeyMap([{ coinPublicKey: 'c1'.repeat(32) }])).toThrow(/encryptionPublicKey must be 64 hex/);
    });

    it('walletSyncMode: true and absent sync everything, false nothing, shielded the coins', async () => {
        const { walletSyncMode } = await importTxBuilder();
        expect([undefined, true, false, 'shielded'].map(walletSyncMode)).toEqual(['all', 'all', 'none', 'shielded']);
        expect(() => walletSyncMode('dust')).toThrow(/walletSync must be true, false or 'shielded'/);
    });

    it('deriveRoleSeeds validates the seed', async () => {
        const { deriveRoleSeeds } = await importTxBuilder();
        await expect(deriveRoleSeeds('abc')).rejects.toThrow(/128 hex chars/);
    });
});
