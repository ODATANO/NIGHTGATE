// Shielded swaps without a contract, the caller's side: build one half of a
// swap, read what a half gives and wants, take an offer. A half is a proven
// transaction that does not balance on its own; two mirrored halves merge into
// one transaction that settles both legs or none. The fee is the sponsor's
// (`sponsorSwap`), so a swap party needs the shielded wallet only: no NIGHT,
// no dust, no contract.
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

/** Prefix of an offer file (bech32m text of a serialized transaction). */
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

/** `{ tokenType, amount }` with a raw type and a positive bigint amount. */
function legOf(leg, name) {
    return { tokenType: tokenTypeOf(leg?.tokenType, `${name}.tokenType`), amount: amountOf(leg?.amount, `${name}.amount`) };
}

const sizeOf = (v) => (Array.isArray(v) ? v.length : typeof v?.size === 'number' ? v.size : typeof v?.length === 'number' ? v.length : null);

/**
 * What one half of a swap gives and wants, read from the transaction itself:
 * the two net changes of its offer. Throws for anything but a plain shielded
 * swap half, by the rules the sponsor applies: an offer and nothing else, one
 * token type given, one other wanted.
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

/** Most inputs one half may carry by default: the sponsor's own default. */
export const SWAP_MAX_INPUTS = 4;

const byValue = (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);

/** What the `maxInputs` largest coins of a token type hold: the most one half can give. */
export function spendableWithin(coins, tokenType, maxInputs = SWAP_MAX_INPUTS) {
    return coins.filter((c) => c.type === tokenType).sort(byValue).slice(-maxInputs).reduce((sum, c) => sum + c.value, 0n);
}

/**
 * The next coin of a half: the smallest one that still lets the remaining
 * slots cover the rest. Small coins go first, so trading merges them, and the
 * half never needs more coins than the sponsor accepts. `plan` is
 * `{ remaining, slots }` and is updated; undefined when no coin fits.
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

/** True when `terms` say exactly what `expect` says. */
export function sameSwapTerms(terms, expect) {
    const a = { gives: legOf(terms?.gives, 'terms.gives'), wants: legOf(terms?.wants, 'terms.wants') };
    const b = { gives: legOf(expect?.gives, 'expect.gives'), wants: legOf(expect?.wants, 'expect.wants') };
    return a.gives.tokenType === b.gives.tokenType && a.gives.amount === b.gives.amount
        && a.wants.tokenType === b.wants.tokenType && a.wants.amount === b.wants.amount;
}

/** Offer file text (`swapoffer1...`) of a transaction or of its serialized bytes. */
export async function encodeOffer(txOrBytes) {
    const bytes = txOrBytes instanceof Uint8Array ? txOrBytes : new Uint8Array(txOrBytes.serialize());
    return offerFile().encodeOfferFile(bytes);
}

/**
 * An offer file, base64 or bytes as a ledger transaction. `bound` says which
 * form it arrived in: an offer file carries a bound transaction, a half built
 * for a merge on the caller's side may be unbound.
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

/** The proving service of the chosen mode; `server` sends the spent coins to `proofServerUrl`. */
export async function swapProvingService({ provingMode = 'wasm', proofServerUrl } = {}) {
    if (provingMode !== 'wasm' && provingMode !== 'server') throw new Error(`provingMode must be 'wasm' or 'server' (got ${String(provingMode)})`);
    const proving = await import('@midnightntwrk/wallet-sdk-capabilities/proving');
    if (provingMode === 'wasm') return proving.makeWasmProvingService({});
    if (!proofServerUrl) throw new Error("provingMode 'server' requires proofServerUrl (a proof server YOU run; it sees the coins you spend)");
    return proving.makeServerProvingService({ provingServerUrl: new URL(proofServerUrl) });
}

/**
 * A shielded wallet for swapping: it syncs the shielded coins of `seedHex` and
 * nothing else. `walletState` resumes from an earlier `serializeState()`.
 *
 * @param {object} opts
 * @param {string} opts.seedHex          128 hex chars (64-byte BIP39 seed). Never leaves this process.
 * @param {string} [opts.networkId]      'preprod' (default)
 * @param {number} [opts.accountIndex]   default 0
 * @param {string} opts.indexerHttpUrl
 * @param {string} opts.indexerWsUrl
 * @param {string} [opts.nodeUrl]        not used for swapping; passed to the wallet when given
 * @param {'wasm'|'server'} [opts.provingMode]
 * @param {string} [opts.proofServerUrl]
 * @param {string} [opts.walletState]    from `serializeState()`
 * @param {number} [opts.maxInputs]      most coins one half spends, default 4 (the sponsor's default)
 * @param {object} [opts.sdk]            test seam: the SDK modules
 */
export async function createSwapWallet(opts) {
    const { seedHex, networkId = 'preprod', accountIndex = 0, indexerHttpUrl, indexerWsUrl, nodeUrl, walletState } = opts ?? {};
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) throw new Error('createSwapWallet: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    if (!indexerHttpUrl || !indexerWsUrl) throw new Error('createSwapWallet: indexerHttpUrl and indexerWsUrl are required');
    const provingMode = opts.provingMode ?? 'wasm';
    // Validated before any SDK import, like the other inputs.
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
    // One half is planned at a time; the wallet asks for its coins one by one.
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

    /** A proven half in the form it is handed over in. */
    const handover = async (proven, bind) => {
        const tx = bind ? proven.bind() : proven;
        const bytes = new Uint8Array(tx.serialize());
        return {
            tx, bound: bind, serializedBytes: bytes.length,
            halfB64: Buffer.from(bytes).toString('base64'),
            // An offer file carries a bound transaction; an unbound half has no text form.
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
            // The coins of a half stay pending in this wallet until it lands or is reverted.
            return { ...out, terms, revert: () => wallet.revertTransaction(out.tx) };
        } catch (e) {
            await wallet.revertTransaction(unproven).catch(() => { /* the build error is the one to report */ });
            throw e;
        }
    });

    return {
        provingMode,
        /** Shielded address (bech32m) and the two public keys a sender needs to create a coin for this wallet. */
        address,
        coinPublicKey: keys.coinPublicKey,
        encryptionPublicKey: keys.encryptionPublicKey,

        /** Resolves once the wallet has caught up with the indexer. */
        async sync() { await wallet.waitForSyncedState(); },

        /** Most coins one half spends. */
        maxInputs,

        /** Shielded balance per raw token type, in atoms. */
        async balances() {
            const state = await latest(wallet.state, 'wallet state');
            return Object.fromEntries(Object.entries(state?.balances ?? {}).map(([t, v]) => [String(t).toLowerCase(), BigInt(v)]));
        },

        /** The free coins, smallest first: `{ tokenType, amount }` each. */
        async coins() {
            return (await freeCoins()).sort(byValue).map((c) => ({ tokenType: String(c.type).toLowerCase(), amount: c.value }));
        },

        /** The most one half can give of a token type: what the `maxInputs` largest free coins hold. */
        async spendable(tokenType) {
            return spendableWithin(await freeCoins(), tokenTypeOf(tokenType, 'tokenType'), maxInputs);
        },

        /**
         * One half of a swap: spends `give`, creates `want` and the change for this
         * wallet, proves it. `bind: true` (default) returns it bound, with its offer
         * file; `bind: false` returns it unbound, as base64 only.
         */
        buildHalf,

        /**
         * Takes an offer: reads its terms from the transaction, compares them with
         * `expect` when given, builds the mirror half in the offer's form and returns
         * both halves for `sponsorSwap`.
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

        /** The wallet's state as text; hand it to `createSwapWallet({ walletState })` to resume without a sync from genesis. */
        serializeState: () => wallet.serializeState(),

        /** Stops the sync. */
        async close() { try { await wallet.stop(); } catch { /* best effort */ } }
    };
}
