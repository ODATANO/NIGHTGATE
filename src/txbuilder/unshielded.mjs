// Plain transfers of unshielded tokens, NIGHT included: one wallet of the seed builds and signs them.
// The sponsor pays the fee, so the wallet needs no dust.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { assertIndexerAnswers, gatewayIndexerUrls } from './api-provider.mjs';
import { decodeOffer, latest, sizeOf, swapProvingService } from './swap.mjs';
import { sealTx, openTx, ledger9Version, readsLedger9, syncedAtLedger9 } from './wallet-tx.mjs';

const require = createRequire(import.meta.url);
const { assertSeedHex, bareHex, HEX64_RE } = require('../../srv/utils/hex-patterns.js');

const midnightAddress = () => require('../../srv/utils/midnight-address.js');
const loadLedger = () => import('@midnightntwrk/ledger-v9');

function transferTermsOf(tx, addressFromKey) {
    const refuse = (why) => { throw new Error(`not an unshielded transfer: ${why}`); };
    if (tx?.guaranteedOffer != null || (tx?.fallibleOffer != null && sizeOf(tx.fallibleOffer) !== 0)) refuse('it carries a shielded offer');
    const intents = typeof tx?.intents?.values === 'function' ? Array.from(tx.intents.values()) : [];
    if (intents.length !== 1) refuse(`it carries ${intents.length} intents; a transfer has one`);
    const intent = intents[0];
    if (sizeOf(intent?.actions ?? []) !== 0) refuse('it carries a contract action');
    if (intent?.dustActions != null) refuse('it carries dust actions');
    const offers = [intent?.guaranteedUnshieldedOffer, intent?.fallibleUnshieldedOffer].filter((o) => o != null);
    if (offers.length !== 1) refuse(`it carries ${offers.length} unshielded offers; a transfer has one`);
    const { inputs, outputs, signatures } = offers[0];
    if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.length < 1) refuse('its offer spends nothing');
    if (outputs.length < 1 || outputs.length > 2) refuse(`it creates ${outputs.length} coins; a transfer creates the recipient's coin and at most its change`);
    if (sizeOf(signatures) !== inputs.length) refuse(`it is not signed: ${sizeOf(signatures) ?? 0} signature(s) for ${inputs.length} input(s)`);
    const tokenType = bareHex(inputs[0].type);
    const spenders = new Set(inputs.map((input) => bareHex(addressFromKey(input.owner))));
    let spent = 0n;
    for (const input of inputs) {
        if (bareHex(input.type) !== tokenType) refuse('it spends more than one token type');
        spent += BigInt(input.value);
    }
    let to;
    let amount = 0n;
    let created = 0n;
    for (const output of outputs) {
        if (bareHex(output.type) !== tokenType) refuse('it creates a token type it does not spend');
        created += BigInt(output.value);
        const owner = bareHex(output.owner);
        if (spenders.has(owner)) continue; // change back to a spender
        if (to !== undefined && to !== owner) refuse('it pays two addresses; a transfer pays one');
        to = owner;
        amount += BigInt(output.value);
    }
    if (to === undefined) refuse('it pays nobody but its own spender');
    if (spent !== created) refuse(`it does not balance: it spends ${spent} and creates ${created}`);
    return { tokenType, amount, to, inputs: inputs.length, outputs: outputs.length };
}

/** Reads type, amount and recipient of a plain unshielded transfer, by the sponsor's rule. `to` is the raw address. Throws for anything else. */
export async function readUnshieldedTransfer(tx) {
    return transferTermsOf(tx, (await loadLedger()).addressFromKey);
}

/** Creates a wallet that syncs only the seed's unshielded coins and builds transfers for `sponsorTransfer`. The seed never leaves this process.
 *  It needs `indexerHttpUrl` and `indexerWsUrl`, or an `api` with a gateway key to sync through the gateway's indexer. */
export async function createUnshieldedWallet(opts) {
    const { seedHex, networkId = 'mainnet', accountIndex = 0, walletState, ttlMinutes = 30 } = opts ?? {};
    assertSeedHex(seedHex, 'createUnshieldedWallet');
    let { indexerHttpUrl, indexerWsUrl } = opts ?? {};
    if (!indexerHttpUrl || !indexerWsUrl) {
        const lane = gatewayIndexerUrls(opts?.api);
        if (!lane) throw new Error('createUnshieldedWallet: indexerHttpUrl and indexerWsUrl are required, or api as the connect() options with a gateway key (token: oda_…), which syncs through the gateway');
        ({ indexerHttpUrl, indexerWsUrl } = lane);
    }
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error(`createUnshieldedWallet: ttlMinutes must be a positive number (got ${String(opts.ttlMinutes)})`);
    await assertIndexerAnswers(indexerHttpUrl, 'createUnshieldedWallet');

    const sdk = opts.sdk ?? {
        ledger: await loadLedger(),
        unshielded: await import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        abstractions: await import('@midnightntwrk/wallet-sdk-abstractions'),
        facade: await import('@midnightntwrk/wallet-sdk-facade'),
        addressFormat: await import('@midnightntwrk/wallet-sdk-address-format'),
        // An unshielded transfer has no circuit, so proving it needs no key material and takes milliseconds.
        provingService: await swapProvingService(),
        deriveRoleSeeds: require('../../srv/utils/wallet-hd.js').deriveRoleSeeds
    };
    const roleSeeds = await sdk.deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const keystore = sdk.unshielded.createKeystore({ kind: 'schnorr', secret: roleSeeds.night }, networkId);
    const publicKey = sdk.unshielded.PublicKey.fromKeyStore(keystore);
    const night = bareHex(sdk.ledger.nativeToken().raw);

    const configuration = {
        networkId,
        // Where ledger 9 starts on the chain. The SDK's default fits chains that began on it.
        forks: opts.forks ?? sdk.facade.DefaultForkSchedule,
        indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
        txHistoryStorage: new sdk.abstractions.InMemoryTransactionHistoryStorage(sdk.facade.WalletEntrySchema, sdk.facade.mergeWalletEntries)
    };
    const Wallet = sdk.unshielded.UnshieldedWallet(configuration);
    const wallet = walletState ? Wallet.restore(walletState) : await Wallet.startWithPublicKey(publicKey);
    await wallet.start();

    const state = () => latest(wallet.state, 'wallet state');
    const typeOf = (value, name) => {
        const type = bareHex(value ?? night);
        if (!HEX64_RE.test(type)) throw new Error(`${name} must be a raw token type (64 hex)`);
        return type;
    };
    const revertBuilt = async (tx, bound) => wallet.revertTransaction(await sealTx(bound ? 'Finalized' : 'Unbound', tx, configuration.forks));
    // One build at a time, so two transfers never pick the same coin.
    let queue = Promise.resolve();
    const oneAtATime = (fn) => {
        const run = queue.then(fn, fn);
        queue = run.catch(() => { /* the caller has the error */ });
        return run;
    };

    const buildTransfer = ({ amount, to, tokenType, bind = true } = {}) => oneAtATime(async () => {
        const type = typeOf(tokenType, 'tokenType');
        let atoms;
        try { atoms = BigInt(amount); } catch { throw new Error('buildTransfer: amount must be an integer amount in atoms'); }
        if (atoms <= 0n) throw new Error('buildTransfer: amount must be positive');
        if (typeof to !== 'string' || to.trim() === '') throw new Error('buildTransfer: to must be an unshielded address (mn_addr_...)');
        let receiver;
        try {
            receiver = sdk.addressFormat.UnshieldedAddress.codec.decode(networkId, await midnightAddress().parseMidnightAddress(sdk.addressFormat, to));
        } catch (e) {
            throw new Error(`buildTransfer: to is not an unshielded address of ${networkId}: ${e?.message ?? String(e)}`);
        }
        if (to.trim() === publicKey.address) throw new Error('buildTransfer: to is this wallet\'s own address; a sponsor pays only a transfer to another address');
        const current = await state();
        if (!readsLedger9(current, await ledger9Version(configuration.forks))) {
            throw new Error('buildTransfer: the wallet does not read the chain at ledger 9 yet and would build for the ledger before it; await sync() first');
        }
        const free = BigInt(current?.balances?.[type] ?? 0n);
        if (free < atoms) throw new Error(`buildTransfer: sending ${atoms} of ${type.slice(0, 16)} needs more than the ${free} this wallet holds unreserved`);

        const handle = await wallet.transferTransaction([{ type, receiverAddress: receiver, amount: atoms }], new Date(Date.now() + ttlMinutes * 60_000));
        try {
            const signed = await wallet.signUnprovenTransaction(handle, async (payload) => keystore.signData(payload));
            const proven = await sdk.provingService.prove(await openTx(signed));
            const terms = transferTermsOf(proven, sdk.ledger.addressFromKey);
            if (terms.tokenType !== type || terms.amount !== atoms || terms.to !== bareHex(receiver.data?.toString('hex'))) {
                throw new Error(`buildTransfer: the wallet built a transfer of ${terms.amount} of ${terms.tokenType.slice(0, 16)} to ${terms.to.slice(0, 16)}, not what was asked`);
            }
            const tx = bind !== false ? proven.bind() : proven;
            const bytes = new Uint8Array(tx.serialize());
            return {
                tx, bound: bind !== false, serializedBytes: bytes.length, txB64: Buffer.from(bytes).toString('base64'),
                terms: { tokenType: type, amount: atoms, to: to.trim() }, inputs: terms.inputs,
                // The wallet keeps the transfer's coins reserved until it lands or `revert` is called.
                revert: () => revertBuilt(tx, bind !== false)
            };
        } catch (e) {
            await wallet.revertTransaction(handle).catch(() => { /* the build error is the one to report */ });
            throw e;
        }
    });

    return {
        /** The wallet's unshielded address. A sender needs it to pay this wallet. */
        address: publicKey.address,
        /** The raw token type of NIGHT, the default of `buildTransfer`. */
        nightTokenType: night,

        async sync() { await syncedAtLedger9(wallet, configuration.forks); },

        /** Balance of the unreserved coins per token type, in the smallest unit. */
        async balances() {
            return Object.fromEntries(Object.entries((await state())?.balances ?? {}).map(([t, v]) => [String(t).toLowerCase(), BigInt(v)]));
        },

        /** The unreserved coins. */
        async coins() {
            return ((await state())?.availableCoins ?? []).map(({ utxo }) => ({ tokenType: String(utxo.type).toLowerCase(), amount: BigInt(utxo.value) }));
        },

        /** The coins the transfers built here keep reserved. */
        async pending() {
            return ((await state())?.pendingCoins ?? []).map(({ utxo }) => ({ tokenType: String(utxo.type).toLowerCase(), amount: BigInt(utxo.value) }));
        },

        /** Builds and signs a fee-free transfer of `amount` of `tokenType` (default NIGHT) to the unshielded address `to`, for `sponsorTransfer`. */
        buildTransfer,

        /** Releases the coins of a transfer whose build-time `revert` is gone: its base64 or bytes. Only for one that did not land. */
        async revert(input) {
            const { tx, bound } = await decodeOffer(input);
            await revertBuilt(tx, bound);
        },

        /** Saves the wallet state. Pass it to `createUnshieldedWallet({ walletState })` to skip a full sync next time. */
        serializeState: () => wallet.serializeState(),

        async close() { try { await wallet.stop(); } catch { /* best effort */ } }
    };
}
