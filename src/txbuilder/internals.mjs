// Parts of the builder that its unit tests reach directly.
// The package's `exports` do not name this file, so nothing in it is public API.

import { createRequire } from 'node:module';
import { decodeOffer } from './swap.mjs';
import { sealTx, openTx } from './wallet-tx.mjs';

const require = createRequire(import.meta.url);
const { isPreForkKeyMismatch } = require('../../srv/utils/runtime-version.js');
const { HEX64_RE } = require('../../srv/utils/hex-patterns.js');

/** The sync mode of a `walletSync` option: everything, nothing, or the wallets that hold coins. */
export function walletSyncMode(walletSync) {
    if (walletSync === undefined || walletSync === true) return 'all';
    if (walletSync === false) return 'none';
    if (walletSync === 'shielded' || walletSync === 'coins') return walletSync;
    throw new Error(`createTxBuilder: walletSync must be true, false, 'shielded' or 'coins' (got ${String(walletSync)})`);
}

/** A wallet that syncs keeps the SDK's default: it starts on the version that can read the chain's first block.
 *  A wallet that never syncs would stay there, and this builder builds for ledger 9 only. So it starts on ledger 9. */
export function walletConfiguration(wallet, synced, configuration, ledger9Version) {
    return synced.includes(wallet) ? configuration : { ...configuration, chainVersionProbe: async () => ledger9Version };
}

/** The sub-wallets a sync mode starts, in the facade's names. */
export function syncedWallets(mode) {
    if (mode === 'all') return ['shielded', 'unshielded', 'dust'];
    if (mode === 'coins') return ['shielded', 'unshielded'];
    if (mode === 'shielded') return ['shielded'];
    return [];
}

/** A shielded wallet another owner started: the builder's `start` and `stop` leave it alone. */
export function sharedShieldedWallet(wallet) {
    const leave = async () => { /* the owner started it and stops it */ };
    return new Proxy(wallet, {
        get(target, prop) {
            if (prop === 'start' || prop === 'stop') return leave;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

const SHIELDED_WALLET_METHODS = ['start', 'stop', 'balanceTransaction', 'revertTransaction', 'waitForSyncedState', 'serializeState'];

/** Whether `wallet` is a shielded wallet instance of the SDK, as the facade needs it. */
export function isShieldedWallet(wallet) {
    return Boolean(wallet) && typeof wallet === 'object' && typeof wallet.state?.subscribe === 'function'
        && SHIELDED_WALLET_METHODS.every(m => typeof wallet[m] === 'function');
}

const asIndex = (v) => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : null);

/** One `onProgress` event from a sub-wallet's state. The unshielded wallet counts transactions, the others count ledger events. */
export function syncProgressEvent(wallet, state) {
    const p = state?.progress;
    if (!p || typeof p !== 'object') return null;
    const appliedIndex = asIndex(p.appliedIndex ?? p.appliedId);
    const highestIndex = asIndex(p.highestIndex ?? p.highestTransactionId);
    if (appliedIndex === null || highestIndex === null) return null;
    return { phase: 'sync', wallet, appliedIndex, highestIndex, isConnected: p.isConnected === true };
}

// Reports every wallet's position while it syncs: a change at most once a second, the arrival at the tip always.
export function watchSync(facade, wallets, onProgress, intervalMs = 1000, now = Date.now) {
    const subscriptions = [];
    for (const wallet of wallets) {
        const observable = facade?.[wallet]?.state;
        if (!observable || typeof observable.subscribe !== 'function') continue;
        let last = null;
        let lastAt = -intervalMs;
        subscriptions.push(observable.subscribe({
            next: (state) => {
                const e = syncProgressEvent(wallet, state);
                if (!e) return;
                const key = `${e.appliedIndex}/${e.highestIndex}/${e.isConnected}`;
                const atTip = e.appliedIndex === e.highestIndex;
                const t = now();
                if (key === last || (!atTip && t - lastAt < intervalMs)) return;
                last = key; lastAt = t;
                try { onProgress(e); } catch { /* a listener must not stop the sync */ }
            },
            error: () => { /* waitForSync reports the failure */ }
        }));
    }
    return () => { for (const s of subscriptions) { try { s.unsubscribe(); } catch { /* already closed */ } } };
}

/** Releases what a built transaction reserved, in all sub-wallets whatever they sync, and drops it from the pending list. */
export async function revertBuilt(facade, input, forks) {
    const { tx, bound } = await decodeOffer(input);
    await facade.revertTransaction(await sealTx(bound ? 'Finalized' : 'Unbound', tx, forks));
}

/** Builds one call and hands it to the SDK to prove, balance and submit. `built.nextPrivateState` gets the private state after the call.
 *  `adjust` may replace the unproven transaction before proving. */
export async function buildSingleCall(contracts, providers, options, circuitId, built, adjust) {
    const data = await contracts.createUnprovenCallTx(providers, options);
    built.nextPrivateState = data.private.nextPrivateState;
    const unprovenTx = adjust ? await adjust(data) : data.private.unprovenTx;
    return contracts.submitTx(providers, { unprovenTx, circuitId });
}

/** Builds a deploy and hands it to the SDK to prove, balance and submit. `built.nextPrivateState` gets the private state after the constructor.
 *  */
export async function buildDeploy(contracts, providers, options, built) {
    const data = await contracts.createUnprovenDeployTx(providers, options);
    built.nextPrivateState = data.private.initialPrivateState;
    return contracts.submitTx(providers, { unprovenTx: data.private.unprovenTx });
}

/** Runs a single call. Its `before` hook runs first, just as in a batch. */
export async function runSingleCall(single, fn) {
    if (typeof single.before === 'function') single.before();
    return fn(...(single.args ?? []));
}

/** Wallet provider that signs and keeps the transaction in `holder.captured` instead of submitting.
 *  submitTx throws on purpose, because a fake id would make the SDK wait forever for a confirmation.
 *  `bind` false leaves sealing to the sponsor, which lets one sponsor pay for several transactions at once. */
export function buildOnlyWalletProvider(facade, zswapKeys, keystore, holder, ttlMinutes, bind, forks) {
    return {
        getCoinPublicKey: () => zswapKeys.coinPublicKey,
        getEncryptionPublicKey: () => zswapKeys.encryptionPublicKey,
        async balanceTx(tx, ttl) {
            const effectiveTtl = ttl ?? new Date(Date.now() + ttlMinutes * 60 * 1000);
            const recipe = await facade.balanceUnboundTransaction(
                await sealTx('Unbound', tx, forks),
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const signed = await facade.signRecipe(recipe, async (payload) => keystore.signData(payload));
            if (bind === false) {
                // The SDK only takes a finalized answer here, so an unbound transaction is captured and the build stops.
                // If the wallet had to add its own coins, there is a second transaction.
                // The sponsor would only seal the first one, so this case needs bind: true.
                if (signed?.balancingTransaction) {
                    await facade.revert(signed).catch(() => { /* the refusal is the error to report */ });
                    throw new Error('buildSponsorable({ bind: false }): this call needs a balancing transaction (it moves value); use the bound handover (bind: true / sponsorFinalized) for it');
                }
                holder.captured = await openTx(signed.baseTransaction);
                throw new Error('BUILD_ONLY_STOP');
            }
            return openTx(await facade.finalizeRecipe(signed));
        },
        async submitTx(tx) {
            holder.captured = tx;
            throw new Error('BUILD_ONLY_STOP');
        }
    };
}

/** A contract deployed before ledger 9 keeps its ledger 8 verifier keys, so a key mismatch on it means the wrong package. */
export async function explainPreForkMismatch(err, ContractTypeError, publicDataProvider, contractAddress) {
    if (!await isPreForkKeyMismatch(err, ContractTypeError, publicDataProvider, contractAddress)) return err;
    return new Error(`contract ${contractAddress} was deployed before ledger 9 and keeps its ledger 8 verifier keys: build with the version of its contract package that was compiled for ledger 8 (compact-runtime 0.16)`, { cause: err });
}

/** The multiplier for a call's declared gas, or undefined when none was asked for. */
export function gasHeadroomFactor(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 10) {
        throw new Error(`buildSponsorable: gasHeadroom must be a number from 1 to 10, got ${String(value)}`);
    }
    return value;
}

const GAS_SCALE = 1000n;

/** The transcript with its declared gas multiplied by `factor`, rounded up.
 *  bytesDeleted stays: the ledger requires at least the declared amount, so a higher figure would fail. */
export function scaleTranscriptGas(transcript, factor) {
    const num = BigInt(Math.round(factor * Number(GAS_SCALE)));
    const up = (v) => (BigInt(v) * num + GAS_SCALE - 1n) / GAS_SCALE;
    const { readTime, computeTime, bytesWritten } = transcript.gas;
    return { ...transcript, gas: { ...transcript.gas, readTime: up(readTime), computeTime: up(computeTime), bytesWritten: up(bytesWritten) } };
}

function gasFigures(gas) {
    return gas ? Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, String(v)])) : undefined;
}

/** What one dust spend of a sponsor adds to a transaction: its time to dismiss in picoseconds, and its size in bytes. */
const SPONSOR_DUST_SPEND = { readTime: 1.9e9, computeTime: 3.6e9, bytes: 2700 };

const PICOSECONDS = { ps: 1, ns: 1e3, 'μs': 1e6, 'µs': 1e6, us: 1e6, ms: 1e9, s: 1e12 };

/** The ledger's limits on the time a node may need to dismiss a transaction, in picoseconds. Undefined when the parameters do not print them.
 *  The ledger exposes them in its printed parameters only. */
export function timeToDismissLimits(ledgerParameters) {
    const text = String(ledgerParameters?.toString?.() ?? '');
    const read = (name) => {
        const found = new RegExp(`${name}:\\s*([0-9.]+)\\s*(ps|ns|μs|µs|us|ms|s)\\b`).exec(text);
        return found ? Number(found[1]) * PICOSECONDS[found[2]] : undefined;
    };
    const perByte = read('time_to_dismiss_per_byte');
    const min = read('min_time_to_dismiss');
    return perByte !== undefined && min !== undefined ? { perByte, min } : undefined;
}

/** The largest gas factor up to `requested` at which the call still passes the time to dismiss once a sponsor added its dust spend. At least 1.
 *  `cost` is the ledger's cost of the transaction as built. Only the guaranteed gas and the proof checks count toward that time. */
export function headroomThatFits({ cost, guaranteed, fallible, limits, requested }) {
    const cap = Math.max(limits.min, limits.perByte * (Number(cost.blockUsage) + SPONSOR_DUST_SPEND.bytes));
    let fits = requested;
    for (const time of ['readTime', 'computeTime']) {
        const scaled = Number(guaranteed?.[time] ?? 0);
        if (scaled <= 0) continue;
        const asBuilt = Number(cost[time]) - Number(fallible?.[time] ?? 0) + SPONSOR_DUST_SPEND[time];
        fits = Math.min(fits, 1 + (cap - asBuilt) / scaled);
    }
    return Math.max(1, Math.floor(fits * Number(GAS_SCALE)) / Number(GAS_SCALE));
}

/** Replaces the call of an unproven single-call transaction by one that declares up to `factor` times its gas.
 *  Runs before proving, because the proof commits to the transcript. `contractState` is the chain's, read for the
 *  verifier key. With `ledgerParameters` the factor is lowered to what the time to dismiss allows. */
export function applyGasHeadroom({ ledger, mjTypes }, data, factor, { contractAddress, circuitId, contractState, ledgerParameters }) {
    const calls = data?.calls;
    if (!Array.isArray(calls) || calls.length !== 1) {
        throw new Error(`buildSponsorable: gasHeadroom covers a call on one contract; this call tree has ${Array.isArray(calls) ? calls.length : 'no'} calls`);
    }
    const [call] = calls;
    const [guaranteed, fallible] = call.public.partitionedTranscript;
    const state = contractState?.contractState;
    if (typeof state?.serialize !== 'function') throw new Error(`buildSponsorable: no contract state found at ${contractAddress}`);
    const op = ledger.ContractState.deserialize(state.serialize()).operation(circuitId);
    if (!op?.verifierKey) throw new Error(`buildSponsorable: the contract state carries no verifier key for '${circuitId}'`);
    const commitment = call.communicationCommitment;
    const rand = commitment?._tag === 'Some' ? commitment.value.commCommRand : ledger.communicationCommitmentRandomness();
    const keyLocation = mjTypes.encodeContractKeyLocation({ contractAddress, circuitId, verifierKeyHash: mjTypes.hashVerifierKey(op.verifierKey) });
    // The SDK hands out a sealed handle. The edit runs on the transaction inside it, and the result is sealed again.
    const tx = data.private.unprovenTx.deserialize({ v9: ledger.Transaction });
    const intents = tx.intents;
    if (typeof intents?.entries !== 'function' || intents.size !== 1) {
        throw new Error(`buildSponsorable: gasHeadroom expects one intent in the built transaction, found ${typeof intents?.size === 'number' ? intents.size : 'none'}`);
    }
    const limits = timeToDismissLimits(ledgerParameters);
    let applied = factor;
    if (limits) {
        // A cost the ledger cannot give leaves the factor as asked. The sponsor checks the finished transaction anyway.
        try { applied = headroomThatFits({ cost: tx.cost(ledgerParameters, false), guaranteed: guaranteed?.gas, fallible: fallible?.gas, limits, requested: factor }); }
        catch { applied = factor; }
    }
    const prototype = new ledger.ContractCallPrototype(
        contractAddress, circuitId, op,
        guaranteed ? scaleTranscriptGas(guaranteed, applied) : undefined,
        fallible ? scaleTranscriptGas(fallible, applied) : undefined,
        call.private.privateTranscriptOutputs, call.private.input, call.private.output, rand, keyLocation
    );
    const [[segmentId, intent]] = intents.entries();
    // Only addCall derives the call's communication commitment; intoCall leaves it wrong and the prover refuses the call.
    // The getter hands out copies, so the rebuilt intent goes back in through the setter.
    intent.actions = [];
    tx.intents = new Map([[segmentId, intent.addCall(prototype)]]);
    return {
        unprovenTx: mjTypes.LedgerTransaction.seal('v9', 'Unproven', tx),
        factor: applied,
        declared: { guaranteed: gasFigures(guaranteed?.gas), fallible: gasFigures(fallible?.gas) }
    };
}

/** Converts `recipients` into the SDK's map from coin public key to encryption public key. */
export function recipientKeyMap(recipients) {
    if (recipients === undefined || recipients === null) return undefined;
    if (!Array.isArray(recipients)) throw new Error('recipients must be an array of { coinPublicKey, encryptionPublicKey }');
    const map = new Map();
    for (const r of recipients) {
        const coin = String(r?.coinPublicKey ?? '').trim().toLowerCase();
        const enc = String(r?.encryptionPublicKey ?? '').trim().toLowerCase();
        if (!HEX64_RE.test(coin)) throw new Error('recipients: coinPublicKey must be 64 hex chars');
        if (!HEX64_RE.test(enc)) throw new Error('recipients: encryptionPublicKey must be 64 hex chars');
        map.set(coin, enc);
    }
    return map.size > 0 ? map : undefined;
}

/** Options for midnight-js' `httpClientProofProvider`. Without `proofTimeoutMs` the SDK default of 5 minutes applies. */
export function proofProviderConfig(opts) {
    return opts?.proofTimeoutMs ? { timeout: opts.proofTimeoutMs } : undefined;
}

/** A `ws` subclass that remembers its open sockets, so `close()` can end them. The SDK's indexer provider cannot. */
export function trackingWebSocket(WebSocketImpl) {
    const open = new Set();
    class TrackedWebSocket extends WebSocketImpl {
        constructor(...args) {
            super(...args);
            open.add(this);
            this.once?.('close', () => open.delete(this));
        }
    }
    return {
        WebSocket: TrackedWebSocket,
        get size() { return open.size; },
        closeAll() {
            for (const s of open) {
                try { if (typeof s.terminate === 'function') s.terminate(); else s.close?.(); } catch { /* already gone */ }
            }
            open.clear();
        }
    };
}

const VAULT_PACKAGES = { 'attestation-vault': '@odatano/contract-attestation-vault', 'attestation-vault-32': '@odatano/contract-attestation-vault-32' };

/** The vault package a contract class belongs to, or null. A class that came with a package counts by that package's contract name,
 *  any other by being the class of an installed vault package. The name the builder calls the contract does not count. */
export async function vaultLineageOf(contractClass, fromPackage, load = (name) => import(name)) {
    if (fromPackage && fromPackage.contractClass === contractClass) {
        return Object.hasOwn(VAULT_PACKAGES, fromPackage.contractName) ? fromPackage.contractName : null;
    }
    for (const [lineage, name] of Object.entries(VAULT_PACKAGES)) {
        try {
            const mod = await load(name);
            if ((mod.Contract ?? mod.default?.Contract) === contractClass) return lineage;
        } catch { /* not installed, so the class cannot be this package's */ }
    }
    return null;
}
