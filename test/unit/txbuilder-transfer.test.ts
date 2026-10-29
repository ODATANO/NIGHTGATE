// `@odatano/nightgate/txbuilder`, plain transfers: the swap wallet builds a fee-free transfer of one
// type to another shielded address for `sponsorTransfer`, and `readTransferShape` checks what the
// sponsor checks. Against a fake wallet SDK; the live path is covered by the probes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bech32m } from '@scure/base';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

vi.mock('@midnight-ntwrk/ledger-v8', () => ({
    Transaction: { deserialize: () => { throw new Error('not used here'); } },
    ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32) }) }
}));

const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

/** A stand-in for a proven transfer: one offer, no deltas, as the ledger drops zero entries. */
function transferTx(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): any {
    return {
        intents: new Map(),
        fallibleOffer: undefined,
        guaranteedOffer: { inputs: [{}], outputs: [{}, {}], transients: [], deltas: new Map(), ...over },
        ...top
    };
}

describe('readTransferShape', () => {
    it('accepts an offer and nothing else that nets to zero', async () => {
        const { readTransferShape } = await importTxBuilder();
        expect(readTransferShape(transferTx())).toEqual({ inputs: 1, outputs: 2 });
    });

    it('refuses intents, fallible offers, transients, contract coins, odd coin counts and a net change', async () => {
        const { readTransferShape } = await importTxBuilder();
        expect(() => readTransferShape(transferTx({}, { intents: new Map([[1, {}]]) }))).toThrow(/carries an intent/);
        expect(() => readTransferShape(transferTx({}, { fallibleOffer: { inputs: [{}] } }))).toThrow(/fallible offer/);
        expect(() => readTransferShape(transferTx({ transients: [{}] }))).toThrow(/transient coin/);
        expect(() => readTransferShape(transferTx({ outputs: [{ contractAddress: 'aa'.repeat(32) }] }))).toThrow(/contract-owned coin/);
        expect(() => readTransferShape(transferTx({ inputs: [] }))).toThrow(/spends no coin/);
        expect(() => readTransferShape(transferTx({ outputs: [{}, {}, {}] }))).toThrow(/creates 3 coins/);
        expect(() => readTransferShape(transferTx({ deltas: new Map([[A, 5n]]) }))).toThrow(/does not net to zero/);
    });
});

describe('createSwapWallet().buildTransfer', () => {
    const SEED = 'ab'.repeat(64);
    const URLS = { indexerHttpUrl: 'https://indexer.example/api/v3/graphql', indexerWsUrl: 'wss://indexer.example/api/v3/graphql/ws' };
    // A real shielded address: 64 bytes, 132 characters, beyond the 90-character default of bech32.
    const TO = bech32m.encode('mn_shield-addr_preprod', bech32m.toWords(Uint8Array.from({ length: 64 }, (_, i) => i)), false);

    function fakeSdk(coins: Array<{ type: string; value: bigint }> = [{ type: A, value: 5000n }, { type: B, value: 5000n }], shape: Record<string, unknown> = {}) {
        const calls: any = { initSwap: [], reverted: [], decoded: [], proven: [] };
        let selection: any;
        const wallet = {
            state: { subscribe: (o: any) => { o.next({ balances: { [A]: 5000n }, availableCoins: coins.map(coin => ({ coin })), pendingCoins: [] }); return { unsubscribe() { /* nothing */ } }; } },
            start: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
            getAddress: vi.fn(async () => ({ own: 'address' })),
            waitForSyncedState: vi.fn(async () => ({})),
            serializeState: vi.fn(async () => '{}'),
            initSwap: vi.fn(async (_keys: any, inputs: any, outputs: any) => {
                calls.initSwap.push({ inputs, outputs });
                const [[type, amount]] = Object.entries(inputs) as Array<[string, bigint]>;
                let pool = [...coins];
                let got = 0n;
                let picked = 0;
                while (got < amount) {
                    const coin = selection(pool, type, amount - got, {});
                    if (!coin) throw new Error(`Insufficient Funds: could not balance ${type}`);
                    got += coin.value; picked++;
                    pool = pool.filter(c => c !== coin);
                }
                return { unproven: true, guaranteedOffer: { inputs: Array.from({ length: picked }) } };
            }),
            revertTransaction: vi.fn(async (tx: any) => { calls.reverted.push(tx); })
        };
        const factory = { startWithSecretKeys: vi.fn(() => wallet), restore: vi.fn(() => wallet) };
        const proven: any = transferTx(shape);
        const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
        proven.serialize = () => bytes;
        proven.bind = () => ({ ...proven, isBound: true, serialize: () => bytes });
        const sdk = {
            ledger: { ZswapSecretKeys: { fromSeed: () => ({ coinPublicKey: 'c1'.repeat(32), encryptionPublicKey: 'e1'.repeat(32) }) } },
            shielded: { CustomShieldedWallet: vi.fn(() => factory) },
            shieldedV1: { V1Builder: class { withDefaults() { return this; } withCoinSelection(make: () => unknown) { selection = make(); return this; } } },
            abstractions: { InMemoryTransactionHistoryStorage: class { /* stand-in */ } },
            facade: { WalletEntrySchema: {}, mergeWalletEntries: () => ({}) },
            addressFormat: {
                mainnet: Symbol('Mainnet'),
                MidnightBech32m: class {
                    static prefix = 'mn';
                    static encode() { return { toString: () => 'mn_shield-addr_preprod1own' }; }
                    constructor(readonly type: string, readonly network: string | symbol, readonly data: Buffer) { /* records the parts */ }
                },
                ShieldedAddress: { codec: { decode: (network: string, repr: { type: string; network: string; data: Buffer }) => { calls.decoded.push([network, repr.type, repr.network, repr.data.length]); return { decoded: TO }; } } }
            },
            networkId: { setNetworkId: vi.fn() },
            deriveRoleSeeds: async () => ({ zswap: new Uint8Array(32), dust: new Uint8Array(32), night: new Uint8Array(32) }),
            provingService: { prove: vi.fn(async (unproven: any) => { calls.proven.push(unproven); return proven; }) }
        };
        return { sdk, wallet, calls, proven };
    }

    beforeEach(() => vi.clearAllMocks());

    it('asks the wallet for a same-type swap to the decoded recipient and returns the bound bytes', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk();
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });
        const built = await wallet.buildTransfer({ tokenType: A, amount: '700', to: TO });
        expect(calls.decoded).toEqual([['preprod', 'shield-addr', 'preprod', 64]]);
        expect(calls.initSwap[0]).toEqual({ inputs: { [A]: 700n }, outputs: [{ type: A, receiverAddress: { decoded: TO }, amount: 700n }] });
        expect(built).toMatchObject({ bound: true, serializedBytes: 40, inputs: 1, terms: { tokenType: A, amount: 700n, to: TO } });
        expect(built.txB64).toBe(Buffer.from(Uint8Array.from({ length: 40 }, (_, i) => i)).toString('base64'));
        await built.revert();
        expect(calls.reverted).toHaveLength(1);
        const unbound = await wallet.buildTransfer({ tokenType: A, amount: 1n, to: TO, bind: false });
        expect(unbound.bound).toBe(false);
    });

    it('refuses a bad address, an unaffordable amount and a built transaction that is not a transfer', async () => {
        const { createSwapWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk();
        const wallet = await createSwapWallet({ ...URLS, seedHex: SEED, sdk });
        await expect(wallet.buildTransfer({ tokenType: A, amount: 1n, to: 'addr_test1xyz' })).rejects.toThrow(/not a shielded address of preprod/);
        await expect(wallet.buildTransfer({ tokenType: A, amount: 1n, to: '' })).rejects.toThrow(/to must be a shielded address/);
        await expect(wallet.buildTransfer({ tokenType: A, amount: 9000n, to: TO })).rejects.toThrow(/needs more than 4 coins/);
        expect(calls.initSwap).toHaveLength(0);

        const odd = fakeSdk(undefined, { deltas: new Map([[A, 3n]]) });
        const other = await createSwapWallet({ ...URLS, seedHex: SEED, sdk: odd.sdk });
        await expect(other.buildTransfer({ tokenType: A, amount: 5n, to: TO })).rejects.toThrow(/not a transfer: it does not net to zero/);
        // the coins of the failed build go back to the wallet
        expect(odd.calls.reverted).toHaveLength(1);
    });
});
