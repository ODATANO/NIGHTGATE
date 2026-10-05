// Swaps of private (shielded) tokens between two wallets, without a contract.
// Each side builds one half: a proven transaction that gives one token and wants another.
// A half alone is not valid. Two matching halves are joined into one transaction, so both sides trade or neither does.
// The sponsor pays the fee (`sponsorSwap`), so a trader only needs its shielded coins.
//
//   import { createSwapWallet, readSwapTerms, decodeOffer } from '@odatano/nightgate/txbuilder';
//
//   const maker = await createSwapWallet({ seedHex, indexerHttpUrl, indexerWsUrl });
//   const { offer } = await maker.buildHalf({ give: { tokenType: A, amount: 1000n }, want: { tokenType: B, amount: 300n } });
//   // publish `offer` (text, `swapoffer1...`)
//
//   const taker = await createSwapWallet({ seedHex: other, indexerHttpUrl, indexerWsUrl });
//   const halves = await taker.takeOffer({ offer, expect: { gives: { tokenType: A, amount: 1000n }, wants: { tokenType: B, amount: 300n } } });
//   await ng.sponsorSwap({ makerHalfB64: halves.makerHalfB64, takerHalfB64: halves.takerHalfB64, sponsorSessionId });
//
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Prefix of an offer file, the text form of a swap half. */
export const SWAP_OFFER_PREFIX = 'swapoffer';

const offerFile = () => require('../../srv/utils/offer-file.js');
const loadLedger = () => import('@midnight-ntwrk/ledger-v8');

const RAW_TOKEN_TYPE = /^[0-9a-f]{64}$/;

function tokenTypeOf(value, name) {
    const type = String(value ?? '').trim().toLowerCase().replace(/^0x/, '');
    if (!RAW_TOKEN_TYPE.test(type)) throw new Error(`${name} must be a raw token type (64 hex)`);
    return type;
}

function amountOf(value, name) {
    let amount;
    try { amount = BigInt(value); } catch { throw new Error(`${name} must be an integer amount in atoms`); }
    if (amount <= 0n) throw new Error(`${name} must be positive`);
    return amount;
}

function legOf(leg, name) {
    return { tokenType: tokenTypeOf(leg?.tokenType, `${name}.tokenType`), amount: amountOf(leg?.amount, `${name}.amount`) };
}

const sizeOf = (v) => (Array.isArray(v) ? v.length : typeof v?.size === 'number' ? v.size : typeof v?.length === 'number' ? v.length : null);

/**
 * Reads what a swap half gives and wants from the transaction itself.
 * Throws unless it is a plain swap half that gives one token type and wants another, as the sponsor requires.
 */
export function readSwapTerms(tx) {
    const refuse = (why) => { throw new Error(`not a swap half: ${why}`); };
    if (tx?.intents !== undefined && tx?.intents !== null && sizeOf(tx.intents) !== 0) refuse('it carries an intent (a contract call, unshielded value or dust actions)');
    if (tx?.fallibleOffer !== undefined && tx?.fallibleOffer !== null && sizeOf(tx.fallibleOffer) !== 0) refuse('it carries a fallible offer');
    const offer = tx?.guaranteedOffer;
    if (!offer || !Array.isArray(offer.inputs) || !Array.isArray(offer.outputs)) refuse('it carries no guaranteed offer');
    if (sizeOf(offer.transients ?? []) !== 0) refuse('it carries a transient coin');
    if ([...offer.inputs, ...offer.outputs].some((coin) => coin?.contractAddress !== undefined && coin?.contractAddress !== null)) {
        refuse('it carries a contract-owned coin');
    }
    const deltas = typeof offer.deltas?.entries === 'function' ? Array.from(offer.deltas.entries()) : null;
    if (!deltas) refuse('its offer exposes no deltas');
    const gives = deltas.filter(([, v]) => typeof v === 'bigint' && v > 0n);
    const wants = deltas.filter(([, v]) => typeof v === 'bigint' && v < 0n);
    if (gives.length + wants.length !== deltas.length) refuse('its offer exposes a delta that is not a non-zero amount');
    if (gives.length !== 1 || wants.length !== 1) refuse(`it gives ${gives.length} token type(s) and wants ${wants.length}; a half gives one and wants one`);
    const terms = {
        gives: { tokenType: tokenTypeOf(gives[0][0], 'the given type'), amount: gives[0][1] },
        wants: { tokenType: tokenTypeOf(wants[0][0], 'the wanted type'), amount: -wants[0][1] }
    };
    if (terms.gives.tokenType === terms.wants.tokenType) refuse('it gives and wants the same token type');
    return { ...terms, inputs: offer.inputs.length, outputs: offer.outputs.length };
}

/** Default limit of coins one half may spend. Matches the sponsor's default. */
export const SWAP_MAX_INPUTS = 4;

const byValue = (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);

/** The most one half can give of a token type: the sum of its `maxInputs` largest coins. */
export function spendableWithin(coins, tokenType, maxInputs = SWAP_MAX_INPUTS) {
    return coins.filter((c) => c.type === tokenType).sort(byValue).slice(-maxInputs).reduce((sum, c) => sum + c.value, 0n);
}

/**
 * Picks the next coin to spend: the smallest one that still lets the remaining slots cover the rest.
 * Spending small coins first merges them over time, and a half never needs more coins than allowed.
 * Updates `plan`. Returns undefined when no coin fits.
 */
export function chooseSwapCoin(coins, tokenType, plan) {
    if (plan.slots <= 0 || plan.remaining <= 0n) return undefined;
    const own = coins.filter((c) => c.type === tokenType).sort(byValue);
    for (const coin of own) {
        const rest = plan.remaining - coin.value;
        const others = own.filter((c) => c !== coin);
        const reach = plan.slots > 1 ? others.slice(-(plan.slots - 1)).reduce((sum, c) => sum + c.value, 0n) : 0n;
        if (rest <= 0n || reach >= rest) {
            plan.remaining = rest;
            plan.slots -= 1;
            return coin;
        }
    }
    return undefined;
}

export function sameSwapTerms(terms, expect) {
    const a = { gives: legOf(terms?.gives, 'terms.gives'), wants: legOf(terms?.wants, 'terms.wants') };
    const b = { gives: legOf(expect?.gives, 'expect.gives'), wants: legOf(expect?.wants, 'expect.wants') };
    return a.gives.tokenType === b.gives.tokenType && a.gives.amount === b.gives.amount
        && a.wants.tokenType === b.wants.tokenType && a.wants.amount === b.wants.amount;
}

/** Encodes a transaction as offer file text (`swapoffer1...`). */
export async function encodeOffer(txOrBytes) {
    const bytes = txOrBytes instanceof Uint8Array ? txOrBytes : new Uint8Array(txOrBytes.serialize());
    return offerFile().encodeOfferFile(bytes);
}

/**
 * Decodes an offer file, base64 or bytes into a transaction.
 * `bound` tells whether the transaction is already sealed. Offer files are always sealed.
 */
export async function decodeOffer(input) {
    const bytes = input instanceof Uint8Array ? input : await offerFile().transactionBytesOf(String(input ?? ''));
    const ledger = await loadLedger();
    const errors = [];
    for (const binding of ['binding', 'pre-binding']) {
        try {
            return { tx: ledger.Transaction.deserialize('signature', 'proof', binding, bytes), bound: binding === 'binding', bytes };
        } catch (e) {
            errors.push(`${binding}: ${String(e?.message ?? e).slice(0, 60)}`);
        }
    }
    throw new Error(`not a proven transaction (${bytes.length} bytes; ${errors.join(' | ')})`);
}

const latest = (observable, what, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    let done = false;
    const sub = observable?.subscribe?.({
        next: (v) => { if (!done) { done = true; setImmediate(() => sub?.unsubscribe?.()); resolve(v); } },
        error: (e) => { if (!done) { done = true; reject(e); } }
    });
    if (!sub) { reject(new Error(`${what} is not observable`)); return; }
    setTimeout(() => { if (!done) { done = true; try { sub.unsubscribe?.(); } catch { /* gone */ } reject(new Error(`no ${what} within ${timeoutMs} ms`)); } }, timeoutMs);
});

/** Returns the proving service. In `server` mode the proof server sees the coins you spend. */
export async function swapProvingService({ provingMode = 'wasm', proofServerUrl } = {}) {
    if (provingMode !== 'wasm' && provingMode !== 'server') throw new Error(`provingMode must be 'wasm' or 'server' (got ${String(provingMode)})`);
    const proving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    if (provingMode === 'wasm') return proving.makeWasmProvingService({});
    if (!proofServerUrl) throw new Error("provingMode 'server' requires proofServerUrl (a proof server YOU run; it sees the coins you spend)");
    return proving.makeServerProvingService({ provingServerUrl: new URL(proofServerUrl) });
}

/**
 * Creates a wallet for swapping. It syncs only the shielded coins of the seed.
 *
 * @param {object} opts
 * @param {string} opts.seedHex          128 hex chars (64-byte BIP39 seed). Never leaves this process.
 * @param {string} [opts.networkId]      Defaults to 'preprod'.
 * @param {number} [opts.accountIndex]   Defaults to 0.
 * @param {string} opts.indexerHttpUrl
 * @param {string} opts.indexerWsUrl
 * @param {string} [opts.nodeUrl]        Not needed for swapping.
 * @param {'wasm'|'server'} [opts.provingMode]
 * @param {string} [opts.proofServerUrl]
 * @param {string} [opts.walletState]    Saved state from `serializeState()`.
 * @param {number} [opts.maxInputs]      Most coins one half may spend. Defaults to 4.
 * @param {object} [opts.sdk]            Replaces the SDK modules, for tests.
 */
export async function createSwapWallet(opts) {
    const { seedHex, networkId = 'preprod', accountIndex = 0, indexerHttpUrl, indexerWsUrl, nodeUrl, walletState } = opts ?? {};
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) throw new Error('createSwapWallet: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    if (!indexerHttpUrl || !indexerWsUrl) throw new Error('createSwapWallet: indexerHttpUrl and indexerWsUrl are required');
    const provingMode = opts.provingMode ?? 'wasm';
    if (provingMode !== 'wasm' && provingMode !== 'server') throw new Error(`createSwapWallet: provingMode must be 'wasm' or 'server' (got ${String(provingMode)})`);
    if (provingMode === 'server' && !opts.proofServerUrl) throw new Error("createSwapWallet: provingMode 'server' requires proofServerUrl (a proof server YOU run; it sees the coins you spend)");
    const maxInputs = opts.maxInputs ?? SWAP_MAX_INPUTS;
    if (!Number.isInteger(maxInputs) || maxInputs < 1) throw new Error(`createSwapWallet: maxInputs must be a positive integer (got ${String(opts.maxInputs)})`);

    const sdk = opts.sdk ?? {
        ledger: await loadLedger(),
        shielded: await import('@midnightntwrk/wallet-sdk-shielded'),
        shieldedV1: await import('@midnightntwrk/wallet-sdk-shielded/v1'),
        abstractions: await import('@midnightntwrk/wallet-sdk-abstractions'),
        facade: await import('@midnightntwrk/wallet-sdk-facade'),
        addressFormat: await import('@midnightntwrk/wallet-sdk-address-format'),
        networkId: await import('@midnight-ntwrk/midnight-js-network-id'),
        provingService: await swapProvingService({ provingMode, proofServerUrl: opts.proofServerUrl }),
        deriveRoleSeeds: require('../../srv/utils/wallet-hd.js').deriveRoleSeeds
    };
    sdk.networkId?.setNetworkId?.(networkId);
    const roleSeeds = await sdk.deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const keys = sdk.ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);

    const configuration = {
        networkId,
        ...(nodeUrl ? { relayURL: new URL(nodeUrl) } : {}),
        provingServerUrl: new URL(opts.proofServerUrl ?? 'http://127.0.0.1:6300'),
        indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
        txHistoryStorage: new sdk.abstractions.InMemoryTransactionHistoryStorage(sdk.facade.WalletEntrySchema, sdk.facade.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };
    // The wallet asks for coins one at a time, so only one half may be built at a time.
    let plan = null;
    const selection = (coins, tokenType) => (plan ? chooseSwapCoin(coins, tokenType, plan) : coins.filter((c) => c.type === tokenType).sort(byValue).at(0));
    const factory = sdk.shielded.CustomShieldedWallet(configuration, new sdk.shieldedV1.V1Builder().withDefaults().withCoinSelection(() => selection));
    const wallet = walletState ? factory.restore(walletState) : factory.startWithSecretKeys(keys);
    await wallet.start(keys);
    const freeCoins = async () => ((await latest(wallet.state, 'wallet state'))?.availableCoins ?? []).map((c) => c.coin);
    let queue = Promise.resolve();
    const oneAtATime = (fn) => {
        const run = queue.then(fn, fn);
        queue = run.catch(() => { /* the caller has the error */ });
        return run;
    };
    const ownAddress = await wallet.getAddress();
    const address = sdk.addressFormat.MidnightBech32m.encode(networkId, ownAddress).toString();

    const handover = async (proven, bind) => {
        const tx = bind ? proven.bind() : proven;
        const bytes = new Uint8Array(tx.serialize());
        return {
            tx, bound: bind, serializedBytes: bytes.length,
            halfB64: Buffer.from(bytes).toString('base64'),
            // Only a sealed half has an offer file.
            ...(bind ? { offer: await offerFile().encodeOfferFile(bytes) } : {})
        };
    };

    const buildHalf = ({ give, want, bind = true } = {}) => oneAtATime(async () => {
        const g = legOf(give, 'give');
        const w = legOf(want, 'want');
        if (g.tokenType === w.tokenType) throw new Error('buildHalf: give and want name the same token type');
        const spendable = spendableWithin(await freeCoins(), g.tokenType, maxInputs);
        if (spendable < g.amount) {
            throw new Error(`buildHalf: giving ${g.amount} of ${g.tokenType.slice(0, 16)} needs more than ${maxInputs} coins; the ${maxInputs} largest free coins hold ${spendable}`);
        }
        plan = { remaining: g.amount, slots: maxInputs };
        let unproven;
        try {
            unproven = await wallet.initSwap(keys, { [g.tokenType]: g.amount }, [{ type: w.tokenType, receiverAddress: ownAddress, amount: w.amount }]);
        } finally {
            plan = null;
        }
        try {
            const inputs = unproven?.guaranteedOffer?.inputs?.length;
            if (Number.isInteger(inputs) && inputs > maxInputs) throw new Error(`buildHalf: the half spends ${inputs} coins, more than the ${maxInputs} a sponsor accepts`);
            const proven = await sdk.provingService.prove(unproven);
            const terms = readSwapTerms(proven);
            if (!sameSwapTerms(terms, { gives: g, wants: w })) {
                throw new Error(`buildHalf: the wallet built a half that gives ${terms.gives.amount} of ${terms.gives.tokenType.slice(0, 16)} for ${terms.wants.amount} of ${terms.wants.tokenType.slice(0, 16)}, not what was asked`);
            }
            const out = await handover(proven, bind !== false);
            // The wallet keeps the half's coins reserved until the swap lands or `revert` is called.
            return { ...out, terms, revert: () => wallet.revertTransaction(out.tx) };
        } catch (e) {
            await wallet.revertTransaction(unproven).catch(() => { /* the build error is the one to report */ });
            throw e;
        }
    });

    return {
        provingMode,
        /** The wallet's shielded address and public keys. A sender needs them to send it a coin. */
        address,
        coinPublicKey: keys.coinPublicKey,
        encryptionPublicKey: keys.encryptionPublicKey,

        async sync() { await wallet.waitForSyncedState(); },

        maxInputs,

        /** Balance per token type, in the smallest unit. */
        async balances() {
            const state = await latest(wallet.state, 'wallet state');
            return Object.fromEntries(Object.entries(state?.balances ?? {}).map(([t, v]) => [String(t).toLowerCase(), BigInt(v)]));
        },

        /** The unreserved coins, smallest first. */
        async coins() {
            return (await freeCoins()).sort(byValue).map((c) => ({ tokenType: String(c.type).toLowerCase(), amount: c.value }));
        },

        /** The most one half can give of a token type. */
        async spendable(tokenType) {
            return spendableWithin(await freeCoins(), tokenTypeOf(tokenType, 'tokenType'), maxInputs);
        },

        /**
         * Builds and proves one half of a swap that gives `give` and receives `want`.
         * By default the half is sealed and comes with an offer file. With `bind: false` it is unsealed and only base64.
         */
        buildHalf,

        /**
         * Accepts an offer. Checks its terms against `expect` if given, builds the matching half,
         * and returns both halves for `sponsorSwap`.
         */
        async takeOffer({ offer, expect } = {}) {
            const maker = await decodeOffer(offer);
            const terms = readSwapTerms(maker.tx);
            if (expect && !sameSwapTerms(terms, expect)) {
                throw new Error(
                    `takeOffer: the offer gives ${terms.gives.amount} of ${terms.gives.tokenType.slice(0, 16)} for ${terms.wants.amount} of ${terms.wants.tokenType.slice(0, 16)}, ` +
                    'which is not what was expected');
            }
            const half = await buildHalf({ give: terms.wants, want: terms.gives, bind: maker.bound });
            return {
                makerHalfB64: Buffer.from(maker.bytes).toString('base64'),
                takerHalfB64: half.halfB64,
                bound: maker.bound,
                terms,
                revert: half.revert
            };
        },

        /** Saves the wallet state. Pass it to `createSwapWallet({ walletState })` to skip a full sync next time. */
        serializeState: () => wallet.serializeState(),

        async close() { try { await wallet.stop(); } catch { /* best effort */ } }
    };
}
