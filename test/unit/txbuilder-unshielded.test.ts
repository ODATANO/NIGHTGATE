// `@odatano/nightgate/txbuilder`, unshielded transfers: the wallet builds and signs a fee-free payment of
// NIGHT or another unshielded type for `sponsorTransfer`, and `readUnshieldedTransfer` reads what the
// sponsor reads. Against a fake wallet SDK; the live path is covered by the probes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bech32m } from '@scure/base';

const NIGHT = '00'.repeat(32);
const CREDIT = 'cc'.repeat(32);
const KEY = '11'.repeat(32);
const OWN = 'a1'.repeat(32);
const TO_RAW = 'b2'.repeat(32);
const OTHER = 'c3'.repeat(32);
const addressFromKey = (k: { value: string }) => (k.value === KEY ? OWN : 'ee'.repeat(32));

vi.mock('@midnightntwrk/ledger-v9', () => ({
    Transaction: { deserialize: () => { throw new Error('not used here'); } },
    addressFromKey: (k: { value: string }) => (k.value === '11'.repeat(32) ? 'a1'.repeat(32) : 'ee'.repeat(32))
}));

// The wallet's sealed handles are plain records here: `{ sealed, tx }` going in, `{ stage, tx }` coming out.
vi.mock('../../src/txbuilder/wallet-tx.mjs', () => ({
    sealTx: async (stage: string, tx: unknown) => ({ sealed: stage, tx }),
    openTx: async (handle: { tx: unknown }) => handle.tx,
    shieldedKeysByEpoch: async () => ({ v8: 'keys-v8', v9: 'keys-v9' })
}));

const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

const input = (value: bigint, type = NIGHT, owner = KEY) => ({ value, owner: { tag: 'schnorr', value: owner }, type, intentHash: '00'.repeat(32), outputNo: 0 });
const output = (value: bigint, owner: string, type = NIGHT) => ({ value, owner, type });
/** A stand-in for a signed, proven payment: one intent with one unshielded offer. */
function paymentTx(offer: Record<string, unknown> = {}, intent: Record<string, unknown> = {}, top: Record<string, unknown> = {}): any {
    const inputs = [input(5000n)];
    const body = { inputs, outputs: [output(700n, TO_RAW), output(4300n, OWN)], signatures: inputs.map(() => ({})), ...offer };
    return { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, { actions: [], fallibleUnshieldedOffer: body, ...intent }]]), ...top };
}

describe('readUnshieldedTransfer', () => {
    it('reads type, amount and the raw recipient of a signed payment', async () => {
        const { readUnshieldedTransfer } = await importTxBuilder();
        expect(await readUnshieldedTransfer(paymentTx())).toEqual({ tokenType: NIGHT, amount: 700n, to: TO_RAW, inputs: 1, outputs: 2 });
        const guaranteed = paymentTx({}, { fallibleUnshieldedOffer: undefined, guaranteedUnshieldedOffer: { inputs: [input(9n, CREDIT)], outputs: [output(9n, TO_RAW, CREDIT)], signatures: [{}] } });
        expect(await readUnshieldedTransfer(guaranteed)).toEqual({ tokenType: CREDIT, amount: 9n, to: TO_RAW, inputs: 1, outputs: 1 });
    });

    it('refuses what the sponsor refuses', async () => {
        const { readUnshieldedTransfer } = await importTxBuilder();
        const refused = async (tx: unknown, why: RegExp) => expect(readUnshieldedTransfer(tx)).rejects.toThrow(why);
        await refused(paymentTx({}, {}, { guaranteedOffer: { inputs: [] } }), /not an unshielded transfer: it carries a shielded offer/);
        await refused({ intents: new Map() }, /carries 0 intents/);
        await refused(paymentTx({}, { actions: [{}] }), /carries a contract action/);
        await refused(paymentTx({}, { dustActions: { spends: [] } }), /carries dust actions/);
        await refused(paymentTx({}, { guaranteedUnshieldedOffer: { inputs: [], outputs: [] } }), /carries 2 unshielded offers/);
        await refused(paymentTx({ inputs: [] }), /spends nothing/);
        await refused(paymentTx({ outputs: [output(1n, TO_RAW), output(1n, TO_RAW), output(4998n, OWN)] }), /creates 3 coins/);
        await refused(paymentTx({ signatures: [] }), /is not signed: 0 signature\(s\) for 1 input\(s\)/);
        await refused(paymentTx({ outputs: [output(5000n, TO_RAW, CREDIT)] }), /creates a token type it does not spend/);
        await refused(paymentTx({ outputs: [output(700n, TO_RAW), output(4300n, OTHER)] }), /pays two addresses/);
        await refused(paymentTx({ outputs: [output(5000n, OWN)] }), /pays nobody but its own spender/);
        await refused(paymentTx({ outputs: [output(700n, TO_RAW), output(4000n, OWN)] }), /does not balance: it spends 5000 and creates 4700/);
    });
});

describe('createUnshieldedWallet', () => {
    const SEED = 'ab'.repeat(64);
    const URLS = { networkId: 'preprod', indexerHttpUrl: 'https://indexer.example/api/v4/graphql', indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws' };
    const TO = bech32m.encode('mn_addr_preprod', bech32m.toWords(Uint8Array.from(Buffer.from(TO_RAW, 'hex'))));
    const OWN_ADDRESS = bech32m.encode('mn_addr_preprod', bech32m.toWords(Uint8Array.from(Buffer.from(OWN, 'hex'))));

    function fakeSdk(proven: any = paymentTx()) {
        const calls: any = { transfers: [], signed: [], reverted: [], decoded: [], restored: [], configuration: undefined };
        const utxo = (value: bigint, type = NIGHT) => ({ utxo: { value, type }, meta: { registeredForDustGeneration: true } });
        const wallet = {
            state: { subscribe: (o: any) => { o.next({ balances: { [NIGHT]: 5000n, [CREDIT]: 40n }, availableCoins: [utxo(5000n), utxo(40n, CREDIT)], pendingCoins: [utxo(7n)] }); return { unsubscribe() { /* nothing */ } }; } },
            start: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
            waitForSyncedState: vi.fn(async () => ({})),
            serializeState: vi.fn(async () => '{"saved":true}'),
            transferTransaction: vi.fn(async (outputs: unknown, ttl: Date) => { calls.transfers.push({ outputs, ttl }); return { stage: 'Unproven', tx: { unproven: true } }; }),
            signUnprovenTransaction: vi.fn(async (handle: any, sign: (payload: Uint8Array) => Promise<unknown>) => { calls.signed.push(await sign(new Uint8Array([1, 2]))); return { stage: 'Unproven', tx: { ...handle.tx, signed: true } }; }),
            revertTransaction: vi.fn(async (tx: any) => { calls.reverted.push(tx); })
        };
        const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
        proven.serialize = () => bytes;
        proven.bind = () => ({ ...proven, isBound: true, serialize: () => bytes });
        const sdk = {
            ledger: { nativeToken: () => ({ raw: NIGHT }), addressFromKey },
            unshielded: {
                createKeystore: vi.fn(() => ({ signData: (payload: Uint8Array) => `sig:${payload.length}` })),
                PublicKey: { fromKeyStore: () => ({ address: OWN_ADDRESS }) },
                UnshieldedWallet: vi.fn((configuration: unknown) => {
                    calls.configuration = configuration;
                    return { startWithPublicKey: vi.fn(async () => wallet), restore: vi.fn((saved: string) => { calls.restored.push(saved); return wallet; }) };
                })
            },
            abstractions: { InMemoryTransactionHistoryStorage: class { /* stand-in */ } },
            facade: { WalletEntrySchema: {}, mergeWalletEntries: () => ({}), DefaultForkSchedule: { v9: 2_000_000n } },
            addressFormat: {
                mainnet: Symbol('Mainnet'),
                MidnightBech32m: class {
                    static prefix = 'mn';
                    constructor(readonly type: string, readonly network: string | symbol, readonly data: Buffer) { /* records the parts */ }
                },
                UnshieldedAddress: { codec: { decode: (network: string, repr: { type: string; network: string; data: Buffer }) => { calls.decoded.push([network, repr.type, repr.network]); return { data: repr.data }; } } }
            },
            deriveRoleSeeds: async () => ({ zswap: new Uint8Array(32), dust: new Uint8Array(32), night: new Uint8Array(32) }),
            provingService: { prove: vi.fn(async () => proven) }
        };
        return { sdk, wallet, calls };
    }

    beforeEach(() => vi.clearAllMocks());

    it('syncs the unshielded wallet of the seed and shows its coins', async () => {
        const { createUnshieldedWallet } = await importTxBuilder();
        const { sdk, wallet, calls } = fakeSdk();
        const w = await createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk });
        expect(calls.configuration).toMatchObject({ networkId: 'preprod', forks: { v9: 2_000_000n }, indexerClientConnection: { indexerHttpUrl: URLS.indexerHttpUrl, indexerWsUrl: URLS.indexerWsUrl } });
        expect(wallet.start).toHaveBeenCalledTimes(1);
        expect(w).toMatchObject({ address: OWN_ADDRESS, nightTokenType: NIGHT });
        await w.sync();
        expect(wallet.waitForSyncedState).toHaveBeenCalledTimes(1);
        expect(await w.balances()).toEqual({ [NIGHT]: 5000n, [CREDIT]: 40n });
        expect(await w.coins()).toEqual([{ tokenType: NIGHT, amount: 5000n }, { tokenType: CREDIT, amount: 40n }]);
        expect(await w.pending()).toEqual([{ tokenType: NIGHT, amount: 7n }]);
        expect(await w.serializeState()).toBe('{"saved":true}');
        await w.close();
        expect(wallet.stop).toHaveBeenCalledTimes(1);

        const resumed = fakeSdk();
        await createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk: resumed.sdk, walletState: '{"saved":true}' });
        expect(resumed.calls.restored).toEqual(['{"saved":true}']);
    });

    it('needs an indexer or a gateway key', async () => {
        const { createUnshieldedWallet } = await importTxBuilder();
        await expect(createUnshieldedWallet({ seedHex: SEED, sdk: fakeSdk().sdk })).rejects.toThrow(/indexerHttpUrl and indexerWsUrl are required, or api/);
        const viaGateway = fakeSdk();
        await createUnshieldedWallet({ seedHex: SEED, sdk: viaGateway.sdk, api: { baseUrl: 'https://gateway.example', token: `oda_${'a'.repeat(40)}` } });
        expect(viaGateway.calls.configuration.indexerClientConnection.indexerHttpUrl).toMatch(/^https:\/\/gateway\.example\/indexer\/api\/v4\/graphql\?key=oda_/);
        await expect(createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk: fakeSdk().sdk, ttlMinutes: 0 })).rejects.toThrow(/ttlMinutes must be a positive number/);
    });

    it('builds, signs and proves a NIGHT payment to the decoded recipient and returns the bound bytes', async () => {
        const { createUnshieldedWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk();
        const w = await createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk, ttlMinutes: 10 });
        const before = Date.now();
        const built = await w.buildTransfer({ amount: '700', to: TO });
        expect(calls.decoded).toEqual([['preprod', 'addr', 'preprod']]);
        expect(calls.transfers[0].outputs).toEqual([{ type: NIGHT, receiverAddress: { data: Buffer.from(TO_RAW, 'hex') }, amount: 700n }]);
        expect(calls.transfers[0].ttl.getTime() - before).toBeGreaterThanOrEqual(10 * 60_000);
        expect(calls.transfers[0].ttl.getTime() - before).toBeLessThan(11 * 60_000);
        expect(calls.signed).toEqual(['sig:2']);
        expect(sdk.provingService.prove).toHaveBeenCalledWith({ unproven: true, signed: true });
        expect(built).toMatchObject({ bound: true, serializedBytes: 40, inputs: 1, terms: { tokenType: NIGHT, amount: 700n, to: TO } });
        expect(built.tx.isBound).toBe(true);
        expect(built.txB64).toBe(Buffer.from(Uint8Array.from({ length: 40 }, (_, i) => i)).toString('base64'));
        await built.revert();
        expect(calls.reverted).toEqual([{ sealed: 'Finalized', tx: built.tx }]);
        const unbound = await w.buildTransfer({ amount: 700n, to: TO, bind: false });
        expect(unbound.bound).toBe(false);
        await unbound.revert();
        expect(calls.reverted[1]).toMatchObject({ sealed: 'Unbound' });
    });

    it('refuses a bad address, its own address and an amount it does not hold, before the wallet books anything', async () => {
        const { createUnshieldedWallet } = await importTxBuilder();
        const { sdk, calls } = fakeSdk();
        const w = await createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk });
        await expect(w.buildTransfer({ amount: 1n, to: 'addr_test1xyz' })).rejects.toThrow(/not an unshielded address of preprod/);
        await expect(w.buildTransfer({ amount: 1n, to: '' })).rejects.toThrow(/to must be an unshielded address/);
        await expect(w.buildTransfer({ amount: 1n, to: OWN_ADDRESS })).rejects.toThrow(/to is this wallet's own address/);
        await expect(w.buildTransfer({ amount: 0, to: TO })).rejects.toThrow(/amount must be positive/);
        await expect(w.buildTransfer({ amount: 'ten', to: TO })).rejects.toThrow(/amount must be an integer/);
        await expect(w.buildTransfer({ amount: 5001n, to: TO })).rejects.toThrow(/sending 5001 of 0000000000000000 needs more than the 5000 this wallet holds unreserved/);
        await expect(w.buildTransfer({ amount: 41n, to: TO, tokenType: CREDIT })).rejects.toThrow(/needs more than the 40/);
        await expect(w.buildTransfer({ amount: 1n, to: TO, tokenType: 'abc' })).rejects.toThrow(/tokenType must be a raw token type/);
        expect(calls.transfers).toHaveLength(0);
    });

    it('gives the coins back when the built transaction is not what was asked', async () => {
        const { createUnshieldedWallet } = await importTxBuilder();
        const odd = fakeSdk(paymentTx({ outputs: [output(699n, TO_RAW), output(4301n, OWN)] }));
        const w = await createUnshieldedWallet({ ...URLS, seedHex: SEED, sdk: odd.sdk });
        await expect(w.buildTransfer({ amount: 700n, to: TO })).rejects.toThrow(/built a transfer of 699 of 0000000000000000 to b2b2b2b2b2b2b2b2, not what was asked/);
        expect(odd.calls.reverted).toEqual([{ stage: 'Unproven', tx: { unproven: true } }]);
    });
});
