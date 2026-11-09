// Builds, proves and signs a Midnight transaction on your machine, with your key. The seed never leaves this process.
// A NIGHTGATE server pays the fee and submits it. Proofs are made in this process by default, with keys cached on disk.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { mkdir, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    resolveContractPackage, contractPackageDigestProblem, readProverKeyManifest, verifierCircuits, missingProverKeys,
    keyMatchesManifest, proverKeyUrl
} from '@odatano/contract-kit/node';
// Imported, never required: under a CJS-aware loader (tsx) require() of this
// ESM package yields a second instance whose ContractState class the circuits refuse.
import * as compactRuntime from '@midnight-ntwrk/compact-runtime';

const require = createRequire(import.meta.url);
const { assertSeedHex, HEX64_RE, HEX64_ANY_CASE_RE } = require('../../srv/utils/hex-patterns.js');
const { isLedger8Runtime, isPreForkKeyMismatch } = require('../../srv/utils/runtime-version.js');
const { fetchBody } = require('../../srv/utils/fetch-body.js');

// Paying the fee yourself and submitting to the node directly.
export {
    deserializeTransaction, txIdentifiers, submitFinalized, submitExtrinsic,
    classifyNodeReject, isPreMempoolReject, isTransportFailure, isAlreadyImported,
    probeLanded, waitLanded, nodeHttpUrlFor, rebuildOnStaleTranscript
} from './submit.mjs';

export {
    SWAP_OFFER_PREFIX, SWAP_MAX_INPUTS, createSwapWallet, readSwapTerms, readTransferShape, sameSwapTerms, encodeOffer, decodeOffer,
    chooseSwapCoin, spendableWithin
} from './swap.mjs';

export { holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from './holder.mjs';

// Reading the chain through the NIGHTGATE API instead of an indexer.
export { apiPublicDataProvider, apiClientFor, buildOnlySubmissionService, gatewayIndexerUrls } from './api-provider.mjs';
import { apiPublicDataProvider, apiClientFor, buildOnlySubmissionService, gatewayIndexerUrls } from './api-provider.mjs';
import { decodeOffer } from './swap.mjs';
import { sealTx, openTx, shieldedKeysByEpoch } from './wallet-tx.mjs';
export { sealTx, openTx };
import { createProverMaterialProvider, defaultProverMaterialDir, writeAtomically, sha256Hex } from './prover-material.mjs';
export { createProverMaterialProvider, defaultProverMaterialDir };

// With `api` and no wallet sync the facade dials neither a node nor an indexer, so these are never used.
const UNUSED_INDEXER = { indexerHttpUrl: 'http://unused.invalid/', indexerWsUrl: 'ws://unused.invalid/' };
const UNUSED_NODE_URL = 'ws://unused.invalid/';

export { tokenFactoryIssuerSecret, deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from './factory.mjs';

/** Derives the night, zswap and dust seeds from a BIP39 seed, the same way the Lace wallet does. */
export async function deriveRoleSeeds(seedHex, accountIndex = 0) {
    assertSeedHex(seedHex);
    return require('../../srv/utils/wallet-hd.js').deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
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

export function walletSyncMode(walletSync) {
    if (walletSync === undefined || walletSync === true) return 'all';
    if (walletSync === false) return 'none';
    if (walletSync === 'shielded' || walletSync === 'coins') return walletSync;
    throw new Error(`createTxBuilder: walletSync must be true, false, 'shielded' or 'coins' (got ${String(walletSync)})`);
}

/** The sub-wallets a sync mode starts, in the facade's names. */
/** A wallet that syncs keeps the SDK's default: it starts on the version that can read the chain's first block.
 *  A wallet that never syncs would stay there, and this builder builds for ledger 9 only. So it starts on ledger 9. */
export function walletConfiguration(wallet, synced, configuration, ledger9Version) {
    return synced.includes(wallet) ? configuration : { ...configuration, chainVersionProbe: async () => ledger9Version };
}

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

/** The circuits of the attestation vault contract. Their proving files are fetched by default. */
export const ATTESTATION_VAULT_CIRCUITS = [
    'attest', 'retract', 'anchorContentRoot', 'bindDocument', 'registerDocument',
    'grantDisclosure', 'revokeDisclosure', 'proveFieldPredicate', 'proveFieldEquality',
    'proveFieldMembership', 'proveDocumentComparison'
];

const exists = (p) => access(p).then(() => true, () => false);

// compactc writes it next to keys/ and zkir/. midnight-js checks every key and zkir against it before proving.
const COMPILER_MANIFEST = 'compiler/contract-manifest.json';

/** Downloads a contract's proving files into `cacheDir`, skipping files already there.
 *  With `package`, it fills in the missing prover keys of an installed contract package instead. */
export async function ensureZkAssets(input) {
    if (input?.package) return ensurePackageProverKeys(input);
    const { zkConfigBaseUrl, cacheDir, circuits = ATTESTATION_VAULT_CIRCUITS, verifierCircuits, fetchFn, retryDelaysMs, onProgress } = input ?? {};
    if (!zkConfigBaseUrl) throw new Error('ensureZkAssets: zkConfigBaseUrl is required (or `package`, an installed lineage package)');
    if (!cacheDir) throw new Error('ensureZkAssets: cacheDir is required without `package`');
    const doFetch = fetchFn || fetch;
    const base = String(zkConfigBaseUrl).replace(/\/$/, '');
    await mkdir(join(cacheDir, 'keys'), { recursive: true });
    await mkdir(join(cacheDir, 'zkir'), { recursive: true });
    await mkdir(join(cacheDir, 'compiler'), { recursive: true });

    // The compiler manifest comes first: without it nothing proves, so a server that lacks it fails before any key is downloaded.
    // A cached copy stays when the server cannot be reached, so the second run works offline like the keys.
    let fetched = 0;
    let cached = 0;
    let refreshed = 0;
    {
        const dest = join(cacheDir, COMPILER_MANIFEST);
        const have = await exists(dest);
        let res = null;
        try { res = await doFetch(base + '/' + COMPILER_MANIFEST); } catch (e) { if (!have) throw e; }
        if (res?.ok) {
            const body = Buffer.from(await res.arrayBuffer());
            if (have && Buffer.compare(await readFile(dest), body) === 0) {
                cached++;
            } else {
                if (have) refreshed++;
                await writeAtomically(dest, body);
                fetched++;
                onProgress?.({ phase: 'zk-asset', file: COMPILER_MANIFEST, fetched, cached, refreshed });
            }
        } else if (!have) {
            throw new Error(res?.status === 404
                ? 'ensureZkAssets: ' + base + ' serves no ' + COMPILER_MANIFEST + '; proving verifies every key against it. Update the server, or pass `package` to use the installed lineage package'
                : 'ensureZkAssets: GET ' + base + '/' + COMPILER_MANIFEST + ' -> HTTP ' + (res?.status ?? 'error'));
        } else {
            cached++;
        }
    }

    // keys/manifest.json lists the sha256 of every current file.
    // A cached file with another hash is from an older build of the contract and is downloaded again.
    // Without a manifest the cache is trusted as it is.
    const manifest = await fetchManifest(doFetch, base);
    const expectedSha = (dir, circuit, ext) => {
        const section = ext === '.prover' ? manifest?.prover : ext === '.verifier' ? manifest?.verifier : ext === '.bzkir' ? manifest?.zkir : undefined;
        return section?.[circuit]?.sha256;
    };

    // `circuits` limits only the large prover keys.
    // The small verifier keys are needed for every circuit, because findDeployedContract reads them all.
    const verifierSet = [...new Set([...(verifierCircuits ?? []), ...circuits])];

    const plan = [
        ...circuits.flatMap(c => [[c, 'keys', '.prover'], [c, 'zkir', '.bzkir']]),
        ...verifierSet.map(c => [c, 'keys', '.verifier'])
    ];
    {
        for (const [circuit, dir, ext] of plan) {
            const rel = dir + '/' + circuit + ext;
            const dest = join(cacheDir, dir, circuit + ext);
            const expected = expectedSha(dir, circuit, ext);
            if (await exists(dest)) {
                if (!expected || sha256Hex(await readFile(dest)) === expected) { cached++; continue; }
                await rm(dest, { force: true });
                refreshed++;
            }
            const { res, body } = await fetchBody(base + '/' + rel, { fetchFn: doFetch, delaysMs: retryDelaysMs });
            if (!body) {
                // A missing circuit is fine. Only the circuits you call must exist.
                if (res.status === 404) continue;
                throw new Error('ensureZkAssets: GET ' + base + '/' + rel + ' -> HTTP ' + res.status);
            }
            // With compression, content-length is the compressed size, so it can only be checked without it.
            const encoding = String(res.headers?.get?.('content-encoding') ?? '').trim().toLowerCase();
            const declared = encoding === '' || encoding === 'identity'
                ? Number(res.headers?.get?.('content-length') ?? NaN)
                : NaN;
            if (Number.isFinite(declared) && declared !== body.length) {
                throw new Error('ensureZkAssets: ' + rel + ' truncated (' + body.length + ' of ' + declared + ' bytes)');
            }
            if (expected && sha256Hex(body) !== expected) {
                throw new Error('ensureZkAssets: ' + rel + ' does not match the sha256 in the served keys/manifest.json');
            }
            await writeAtomically(dest, body);
            fetched++;
            onProgress?.({ phase: 'zk-asset', circuit, file: rel, fetched, cached, refreshed });
        }
    }
    return { cacheDir, fetched, cached, refreshed, verified: Boolean(manifest), source: 'remote' };
}

/** Downloads the prover keys a contract package does not ship and checks each against its keys/manifest.json. */
async function ensurePackageProverKeys({ package: packageName, from, circuits, fetchFn, retryDelaysMs, onProgress }) {
    const pkg = resolveContractPackage(packageName, from ?? process.cwd());
    const zkConfigPath = pkg.zkConfigPath;
    const manifest = readProverKeyManifest(zkConfigPath);
    if (!manifest) throw new Error(`ensureZkAssets: ${pkg.name} ships no keys/manifest.json; a downloaded key cannot be verified`);
    const all = verifierCircuits(zkConfigPath);
    const unknown = (circuits ?? []).filter(c => !all.includes(c));
    if (unknown.length) throw new Error(`ensureZkAssets: ${pkg.name} has no circuit ${unknown.join(', ')} (it has ${all.join(', ')})`);
    const wanted = circuits ?? all;
    const missing = missingProverKeys(zkConfigPath).filter(c => wanted.includes(c));
    const keysDir = join(zkConfigPath, 'keys');
    let fetched = 0;
    for (const circuit of missing) {
        const expected = manifest.prover?.[circuit];
        if (!expected) throw new Error(`ensureZkAssets: ${pkg.name}: keys/manifest.json lists no prover key for ${circuit}`);
        const url = proverKeyUrl(pkg.manifest.zkAssetUrl, pkg.manifest.zkAssetLayout, circuit);
        const { res, body } = await fetchBody(url, { fetchFn, delaysMs: retryDelaysMs });
        if (!body) throw new Error(`ensureZkAssets: GET ${url} -> HTTP ${res.status}`);
        if (!keyMatchesManifest(body, expected)) throw new Error(`ensureZkAssets: ${circuit}.prover from ${url} does not match keys/manifest.json`);
        await writeAtomically(join(keysDir, `${circuit}.prover`), body);
        fetched++;
        onProgress?.({ phase: 'zk-asset', circuit, file: `keys/${circuit}.prover`, fetched, cached: wanted.length - missing.length, refreshed: 0 });
    }
    const local = await describeLocalZkAssets(zkConfigPath, all, wanted, { ledger8: isLedger8Runtime(pkg.manifest.compactRuntime) });
    return { ...local, fetched, cached: local.cached - fetched, refreshed: 0, verified: true, source: 'package' };
}

/** Why a lineage package cannot run on this compact-runtime (major.minor differ); null when it can or says nothing. */
export function runtimeVersionProblem(manifest, installed = compactRuntime.versionString) {
    return require('../../srv/utils/runtime-version.js').runtimeVersionProblem(manifest, String(installed));
}

/** Loads an installed contract package for the builder. Fails if its files do not match the build in its contract.json. */
export async function resolveBuilderPackage({ package: packageName, from }) {
    if (!packageName) throw new Error('resolveBuilderPackage: package is required');
    const pkg = resolveContractPackage(packageName, from ?? process.cwd());
    const problem = contractPackageDigestProblem(pkg);
    if (problem) throw new Error(`contract package ${packageName} is not the generation its contract.json describes: ${problem}`);
    const ledger8 = isLedger8Runtime(pkg.manifest.compactRuntime);
    const runtimeProblem = ledger8 ? null : runtimeVersionProblem(pkg.manifest);
    if (runtimeProblem) throw new Error(`contract package ${packageName} ${runtimeProblem}`);
    const mod = await import(pathToFileURL(pkg.artifactPath).href);
    const contractClass = mod.Contract ?? mod.default?.Contract;
    if (typeof contractClass !== 'function') throw new Error(`contract package ${packageName}: ${pkg.artifactPath} exports no Contract class`);
    return {
        package: { name: pkg.name, version: pkg.version, root: pkg.root },
        ledger8,
        contractClass,
        contractName: pkg.manifest.name,
        privateStateId: pkg.manifest.privateStateId,
        zkConfigDir: pkg.zkConfigPath,
        ...(pkg.manifest.slotWidth !== undefined ? { slotWidth: pkg.manifest.slotWidth } : {}),
        circuits: verifierCircuits(pkg.zkConfigPath)
    };
}

/** Returns null when the server has no manifest or the request fails. */
async function fetchManifest(doFetch, base) {
    try {
        const res = await doFetch(base + '/keys/manifest.json');
        if (!res?.ok) return null;
        const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && parsed.version === 1 ? parsed : null;
    } catch {
        return null;
    }
}

/** Releases what a built transaction reserved, in all sub-wallets whatever they sync, and drops it from the pending list. */
// Exported for the unit tests only.
export async function revertBuilt(facade, input, forks) {
    const { tx, bound } = await decodeOffer(input);
    await facade.revertTransaction(await sealTx(bound ? 'Finalized' : 'Unbound', tx, forks));
}

/** Runs a single call. Its `before` hook runs first, just as in a batch. */
// Exported for the unit tests only.
export async function runSingleCall(single, fn) {
    if (typeof single.before === 'function') single.before();
    return fn(...(single.args ?? []));
}

/** Wallet provider that signs and keeps the transaction in `holder.captured` instead of submitting. Exported for unit tests.
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
                    throw new Error('buildSponsorable({ bind: false }): this call needs a balancing transaction (it moves value); use the bound handover (bind: true / sponsorFinalizedTransaction) for it');
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

/** `findDeployedContract` with one retry. Right after a block lands, the indexer can briefly return an empty state. */
async function findDeployedWithRetry(contracts, providers, args) {
    try {
        return await contracts.findDeployedContract(providers, args);
    } catch (e) {
        const msg = String(e?.message ?? e);
        if (!/expected a cell, received null|received null|ContractState.*null|no contract state/i.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, 10_000));
        return contracts.findDeployedContract(providers, args);
    }
}

/** A contract deployed before ledger 9 keeps its ledger 8 verifier keys, so a key mismatch on it means the wrong package. Exported for unit tests. */
export async function explainPreForkMismatch(err, ContractTypeError, publicDataProvider, contractAddress) {
    if (!await isPreForkKeyMismatch(err, ContractTypeError, publicDataProvider, contractAddress)) return err;
    return new Error(`contract ${contractAddress} was deployed before ledger 9 and keeps its ledger 8 verifier keys: build with the version of its contract package that was compiled for ledger 8 (compact-runtime 0.16)`, { cause: err });
}

/** Options for midnight-js' `httpClientProofProvider`. Without `proofTimeoutMs` the SDK default of 5 minutes applies. */
export function proofProviderConfig(opts) {
    return opts?.proofTimeoutMs ? { timeout: opts.proofTimeoutMs } : undefined;
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

/** Replaces the call of an unproven single-call transaction by one that declares `factor` times its gas.
 *  Runs before proving, because the proof commits to the transcript. `contractState` is the chain's, read for the
 *  verifier key. Returns the sealed transaction and the gas as built, for progress events. */
export function applyGasHeadroom({ ledger, mjTypes }, data, factor, { contractAddress, circuitId, contractState }) {
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
    const prototype = new ledger.ContractCallPrototype(
        contractAddress, circuitId, op,
        guaranteed ? scaleTranscriptGas(guaranteed, factor) : undefined,
        fallible ? scaleTranscriptGas(fallible, factor) : undefined,
        call.private.privateTranscriptOutputs, call.private.input, call.private.output, rand, keyLocation
    );
    // The SDK hands out a sealed handle. The edit runs on the transaction inside it, and the result is sealed again.
    const tx = data.private.unprovenTx.deserialize({ v9: ledger.Transaction });
    const intents = tx.intents;
    if (typeof intents?.entries !== 'function' || intents.size !== 1) {
        throw new Error(`buildSponsorable: gasHeadroom expects one intent in the built transaction, found ${typeof intents?.size === 'number' ? intents.size : 'none'}`);
    }
    const [[segmentId, intent]] = intents.entries();
    // Only addCall derives the call's communication commitment; intoCall leaves it wrong and the prover refuses the call.
    // The getter hands out copies, so the rebuilt intent goes back in through the setter.
    intent.actions = [];
    tx.intents = new Map([[segmentId, intent.addCall(prototype)]]);
    return {
        unprovenTx: mjTypes.LedgerTransaction.seal('v9', 'Unproven', tx),
        declared: { guaranteed: gasFigures(guaranteed?.gas), fallible: gasFigures(fallible?.gas) }
    };
}

/** Returns the address of the contract a deploy transaction creates. Throws unless it deploys exactly one contract. */
export function readDeployAddress(tx) {
    const intents = tx?.intents;
    if (!intents || typeof intents.entries !== 'function') {
        throw new Error('deploy build: transaction structure is not inspectable (no intents)');
    }
    const found = [];
    for (const [, intent] of Array.from(intents.entries())) {
        for (const action of (intent?.actions ?? [])) {
            const ep = action?.entryPoint;
            const isCall = typeof ep === 'string' || ep instanceof Uint8Array;
            if (isCall) continue;
            if (action?.updates !== undefined) throw new Error('deploy build: transaction carries a maintenance update');
            if (action?.address === undefined) continue;
            found.push(String(action.address));
        }
    }
    if (found.length !== 1 || !found[0]) {
        throw new Error(`deploy build: expected exactly one contract deploy action with an address, found ${found.length}`);
    }
    return found[0];
}

/** Whether the compiler that wrote a local directory built for ledger 8. A directory without `compiler/contract-info.json` counts as no. */
export async function isLedger8ZkDir(zkConfigDir) {
    try {
        return isLedger8Runtime(JSON.parse(await readFile(join(zkConfigDir, 'compiler', 'contract-info.json'), 'utf8'))['runtime-version']);
    } catch {
        return false;
    }
}

/** Checks that a local directory has all proving files. Downloads nothing. */
export async function describeLocalZkAssets(zkConfigDir, circuits = [], proveCircuits = circuits, { ledger8 = false } = {}) {
    const { statSync, readdirSync } = await import('node:fs');
    const keysDir = join(zkConfigDir, 'keys');
    const zkirDir = join(zkConfigDir, 'zkir');
    const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
    if (!isDir(keysDir) || !isDir(zkirDir)) {
        throw new Error(`createTxBuilder: zkConfigDir ${zkConfigDir} must hold keys/ and zkir/ directories`);
    }
    // The ledger 8 compiler writes no such manifest.
    if (!ledger8 && !(await exists(join(zkConfigDir, COMPILER_MANIFEST)))) {
        throw new Error(`createTxBuilder: zkConfigDir ${zkConfigDir} lacks ${COMPILER_MANIFEST}; compactc writes it next to keys/ and zkir/, and proving verifies every key against it`);
    }
    const files = readdirSync(keysDir);
    const zkirFiles = readdirSync(zkirDir);
    // Verifier keys are needed for every circuit. Prover keys and zkir only for the circuits that are proved.
    const missing = circuits.filter(c => !files.includes(`${c}.verifier`));
    if (missing.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks verifier keys for ${missing.join(', ')}`);
    const missingProver = proveCircuits.filter(c => !files.includes(`${c}.prover`));
    if (missingProver.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks prover keys for ${missingProver.join(', ')} (keys/<circuit>.prover)`);
    const missingZkir = proveCircuits.filter(c => !zkirFiles.includes(`${c}.bzkir`));
    if (missingZkir.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks zkir for ${missingZkir.join(', ')} (zkir/<circuit>.bzkir)`);
    const cached = circuits.length + proveCircuits.length * 2;
    return { cacheDir: zkConfigDir, fetched: 0, cached, source: 'local' };
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

/** All keys derived from the seed. `deriveIdentity` is the public version without secret keys. */
async function deriveKeyMaterial({ seedHex, networkId = 'mainnet', accountIndex = 0, attestationSecret: ownSecret }) {
    assertSeedHex(seedHex);
    const [unshielded, { deriveAttestationSecret }, ledger, addressFormat] = await Promise.all([
        import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        import('../browser/witnesses.mjs'),
        import('@midnightntwrk/ledger-v9'),
        import('@midnightntwrk/wallet-sdk-address-format')
    ]);
    const { deriveRoleSeeds } = require('../../srv/utils/wallet-hd.js');
    const rt = compactRuntime;
    const roleSeeds = await deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const keystore = unshielded.createKeystore({ kind: 'schnorr', secret: roleSeeds.night }, networkId);
    const attestationSecret = ownSecret ?? deriveAttestationSecret(roleSeeds.zswap);
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const shieldedKeys = { coinPublicKey: String(zswapKeys.coinPublicKey), encryptionPublicKey: String(zswapKeys.encryptionPublicKey) };
    const shielded = addressFormat.MidnightBech32m.encode(networkId, new addressFormat.ShieldedAddress(
        addressFormat.ShieldedCoinPublicKey.fromHexString(shieldedKeys.coinPublicKey),
        addressFormat.ShieldedEncryptionPublicKey.fromHexString(shieldedKeys.encryptionPublicKey)
    )).toString();
    zswapKeys.clear?.();
    return {
        roleSeeds,
        keystore,
        attestationSecret,
        attesterId: Buffer.from(rt.persistentHash(new rt.CompactTypeBytes(32), attestationSecret)).toString('hex'),
        addresses: { night: unshielded.PublicKey.fromKeyStore(keystore).address, shielded },
        shieldedKeys
    };
}

/** The vault's storage key for an attester's attestation of a payload, as hex. Matches the vault's `recordKey` circuit. */
export function computeRecordKey(attesterId, payloadHash) {
    const rt = compactRuntime;
    const u8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const b32 = new rt.CompactTypeBytes(32);
    const hexToBytes = (h, name) => {
        if (!HEX64_ANY_CASE_RE.test(String(h ?? ''))) throw new Error(`${name} must be 64 hex chars (32 bytes)`);
        return Uint8Array.from(Buffer.from(h, 'hex'));
    };
    const type = {
        alignment: () => u8.alignment().concat(b32.alignment(), b32.alignment()),
        toValue: (v) => u8.toValue(v.tag).concat(b32.toValue(v.owner), b32.toValue(v.payload_hash))
    };
    return Buffer.from(rt.persistentHash(type, { tag: 21n, owner: hexToBytes(attesterId, 'attesterId'), payload_hash: hexToBytes(payloadHash, 'payloadHash') })).toString('hex');
}

/** Derives the attester id, attestation secret and addresses of a seed, as `createTxBuilder` does, without a network. */
export async function deriveIdentity(opts) {
    const { attesterId, attestationSecret, addresses, shieldedKeys } = await deriveKeyMaterial(opts ?? {});
    return { attesterId, attestationSecret, addresses, shieldedKeys };
}

/** Creates a transaction builder for your seed. The options are typed and documented as `CreateTxBuilderInput` in index.d.ts. */
export async function createTxBuilder(opts) {
    const {
        seedHex, networkId = 'mainnet', accountIndex = 0,
        nodeUrl, zkConfigBaseUrl,
        circuits, ttlMinutes = 30, onProgress
    } = opts ?? {};
    let { indexerHttpUrl, indexerWsUrl } = opts ?? {};
    assertSeedHex(seedHex, 'createTxBuilder');
    const apiClient = opts.api ? apiClientFor(opts.api) : null;
    let hasIndexer = Boolean(indexerHttpUrl && indexerWsUrl);
    if (!apiClient) {
        if (!hasIndexer) throw new Error('createTxBuilder: indexerHttpUrl and indexerWsUrl are required, or api');
        if (!nodeUrl) throw new Error('createTxBuilder: nodeUrl is required (the Substrate RPC the wallet SDK talks to), or api');
    }
    // Explicit options win over the package's values.
    const fromPackage = opts.package ? await resolveBuilderPackage({ package: opts.package, from: opts.from }) : null;
    const contractClass = opts.contractClass ?? fromPackage?.contractClass;
    const contractName = opts.contractName ?? fromPackage?.contractName ?? 'attestation-vault';
    const privateStateId = opts.privateStateId ?? fromPackage?.privateStateId ?? 'attestationVaultPrivateState';
    const zkConfigDir = opts.zkConfigDir ?? (zkConfigBaseUrl ? undefined : fromPackage?.zkConfigDir);
    if (!zkConfigBaseUrl && !zkConfigDir) {
        throw new Error('createTxBuilder: zkConfigBaseUrl is required (a public /zk-config/<contract>), unless zkConfigDir names a local directory with keys/ and zkir/ or package names an installed lineage package');
    }
    if (typeof contractClass !== 'function') throw new Error('createTxBuilder: contractClass is required (the compiled Contract), or package');
    const ledger8 = fromPackage?.ledger8 === true || (zkConfigDir !== undefined && await isLedger8ZkDir(zkConfigDir));
    if (opts.provingMode !== undefined && opts.provingMode !== 'wasm' && opts.provingMode !== 'server') {
        throw new Error(`createTxBuilder: provingMode must be 'wasm' or 'server' (got ${String(opts.provingMode)})`);
    }
    if (opts.provingMode === 'server' && !opts.proofServerUrl) {
        throw new Error("createTxBuilder: provingMode 'server' requires proofServerUrl (a proof server YOU run; it receives the witnesses)");
    }
    if (opts.proofTimeoutMs !== undefined && !(Number.isInteger(opts.proofTimeoutMs) && opts.proofTimeoutMs > 0)) {
        throw new Error(`createTxBuilder: proofTimeoutMs must be a positive integer (ms), got ${String(opts.proofTimeoutMs)}`);
    }
    if (opts.proverMaterialDir !== undefined && (typeof opts.proverMaterialDir !== 'string' || opts.proverMaterialDir === '')) {
        throw new Error('createTxBuilder: proverMaterialDir must be a directory path');
    }
    const syncMode = walletSyncMode(opts.walletSync);
    const shared = opts.shieldedWallet;
    if (shared !== undefined && !isShieldedWallet(shared)) {
        throw new Error("createTxBuilder: shieldedWallet must be a started shielded wallet of the SDK, such as a swap wallet's shieldedWallet");
    }
    // The sub-wallets this builder syncs itself; a shared shielded wallet is synced by its owner.
    const ownWallets = syncedWallets(syncMode).filter(w => w !== 'shielded' || !shared);
    const synced = shared ? ['shielded', ...ownWallets] : ownWallets;
    if (apiClient && ownWallets.length && !hasIndexer) {
        // connect() options with a gateway key sync through the gateway's indexer lane; a connected client carries no key.
        const lane = gatewayIndexerUrls(opts.api);
        if (!lane) throw new Error('createTxBuilder: with api the wallet is not synced; pass walletSync: false, indexerHttpUrl and indexerWsUrl for the sync, or api as the connect() options with a gateway key (token: oda_…), which syncs through the gateway');
        ({ indexerHttpUrl, indexerWsUrl } = lane);
        hasIndexer = true;
    }
    const saved = opts.walletState;
    if (saved !== undefined && (saved === null || typeof saved !== 'object' || ['shielded', 'unshielded', 'dust'].some(k => saved[k] !== undefined && typeof saved[k] !== 'string'))) {
        throw new Error('createTxBuilder: walletState must be the object serializeWalletState() returned');
    }
    if (shared && saved?.shielded !== undefined) {
        throw new Error('createTxBuilder: walletState.shielded and shieldedWallet exclude each other; the shared wallet keeps its own state');
    }
    const cacheDir = zkConfigDir ?? opts.cacheDir ?? join(homedir(), '.cache', 'nightgate-txbuilder', contractName);

    // List all circuits of the contract by creating it with dummy witnesses.
    // Verifier keys are needed for all of them.
    let allCircuits;
    try {
        const stub = new Proxy({}, { get: () => () => { /* never called */ }, has: () => true });
        allCircuits = Object.keys(new contractClass(stub).impureCircuits ?? {});
    } catch { allCircuits = undefined; }
    onProgress?.({ phase: 'zk-assets' });
    let assets;
    if (fromPackage && !opts.zkConfigDir && !zkConfigBaseUrl) {
        assets = await ensureZkAssets({ package: opts.package, from: opts.from, circuits, fetchFn: opts.fetchFn, onProgress });
    } else if (zkConfigDir) {
        // Fall back to the vault's circuits, so an empty directory never passes the check.
        const verifierSet = allCircuits ?? ATTESTATION_VAULT_CIRCUITS;
        const proveSet = circuits ?? allCircuits ?? ATTESTATION_VAULT_CIRCUITS;
        assets = await describeLocalZkAssets(zkConfigDir, verifierSet, proveSet, { ledger8 });
    } else {
        assets = await ensureZkAssets({
            zkConfigBaseUrl, cacheDir,
            circuits: circuits ?? allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            verifierCircuits: allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            fetchFn: opts.fetchFn,
            onProgress
        });
    }

    const [ledger, facadeSdk, shielded, unshielded, dust, abstractions, compactJs, contracts, zkNode, indexerSdk, mjTypes, mjUtils, mjProtocol] = await Promise.all([
        import('@midnightntwrk/ledger-v9'),
        import('@midnightntwrk/wallet-sdk-facade'),
        import('@midnightntwrk/wallet-sdk-shielded'),
        import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        import('@midnightntwrk/wallet-sdk-dust-wallet'),
        import('@midnightntwrk/wallet-sdk-abstractions'),
        import('@midnight-ntwrk/compact-js'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-types'),
        import('@midnight-ntwrk/midnight-js-utils'),
        import('@midnight-ntwrk/midnight-js-protocol')
    ]);

    const { roleSeeds, keystore, attestationSecret, attesterId, addresses, shieldedKeys } = await deriveKeyMaterial({ seedHex, networkId, accountIndex, attestationSecret: opts.attestationSecret });
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    // The wallets derive the keys of each ledger version from these seeds, so they can follow a fork.
    const walletSeeds = { shielded: roleSeeds.zswap, unshielded: roleSeeds.night, dust: roleSeeds.dust };

    // The wallet's circuits and the contract proofs share one provider, so each file is read or fetched once per process.
    const proverMaterial = createProverMaterialProvider({ dir: opts.proverMaterialDir, onProgress });
    const provingMode = opts.provingMode === 'server' ? 'server' : 'wasm';
    onProgress?.({ phase: 'wallet' });
    const configuration = facadeSdk.WalletFacade.resolveConfiguration({
        networkId,
        relayURL: new URL(nodeUrl ?? UNUSED_NODE_URL),
        // 'server' sends the wallet's proofs and the contract's to the same proof server.
        provers: { v9: provingMode === 'server'
            ? { kind: 'server', url: new URL(opts.proofServerUrl) }
            : { kind: 'wasm', keyMaterialProvider: proverMaterial } },
        indexerClientConnection: hasIndexer ? { indexerHttpUrl, indexerWsUrl } : UNUSED_INDEXER,
        txHistoryStorage: new abstractions.InMemoryTransactionHistoryStorage(facadeSdk.WalletEntrySchema, facadeSdk.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    });
    const configurationOf = (wallet) => walletConfiguration(wallet, synced, configuration, abstractions.ProtocolVersion.V9NativeForkVersion);
    const facade = await facadeSdk.WalletFacade.init({
        configuration,
        // Without a node the SDK's default service would dial the relay at init.
        ...(nodeUrl ? {} : { submissionService: buildOnlySubmissionService() }),
        shielded: () => (shared ? sharedShieldedWallet(shared)
            : saved?.shielded ? shielded.ShieldedWallet(configurationOf('shielded')).restore(saved.shielded)
                : shielded.ShieldedWallet(configurationOf('shielded')).startWithSeed(walletSeeds.shielded)),
        unshielded: () => (saved?.unshielded
            ? unshielded.UnshieldedWallet(configurationOf('unshielded')).restore(saved.unshielded)
            : unshielded.UnshieldedWallet(configurationOf('unshielded')).startWithPublicKey(unshielded.PublicKey.fromKeyStore(keystore))),
        dust: () => (saved?.dust
            ? dust.DustWallet(configurationOf('dust')).restore(saved.dust)
            : dust.DustWallet(configurationOf('dust')).startWithSeed(walletSeeds.dust, ledger.LedgerParameters.initialParameters().dust))
    });
    // Syncing a wallet reads the whole chain and keeps this thread busy; a call that moves no
    // tokens needs none. A sponsor pays the fee, so 'shielded' and 'coins' leave the dust wallet out.
    const stopWatching = onProgress ? watchSync(facade, synced, onProgress) : () => {};
    if (syncMode === 'all') await facade.start(walletSeeds);
    else if (syncMode === 'coins') await Promise.all([facade.shielded.start(await shieldedKeysByEpoch(roleSeeds.zswap)), facade.unshielded.start()]);
    else if (syncMode === 'shielded') await facade.shielded.start(await shieldedKeysByEpoch(roleSeeds.zswap));

    const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
    if (!CompiledContract?.make) throw new Error('compact-js: CompiledContract.make not found');
    // The ledger 8 compiler writes no artifact manifest. The SDK still compares each verifier key with the chain's.
    const zkConfigProvider = new zkNode.NodeZkConfigProvider(cacheDir, ledger8 ? { verify: 'off' } : undefined);
    // The SDK tells the two contract shapes apart: a ledger 8 contract is the bare instance.
    const compiledContract = (witnesses) => (ledger8
        ? new contractClass(witnesses)
        : CompiledContract.make(contractName, contractClass).pipe(
            CompiledContract.withWitnesses(witnesses),
            CompiledContract.withCompiledFileAssets(cacheDir)
        ));
    let proofProvider;
    if (provingMode === 'server') {
        const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
        proofProvider = httpClientProofProvider(opts.proofServerUrl, zkConfigProvider, proofProviderConfig(opts));
    } else {
        const { buildWasmProofProvider } = require('../../srv/midnight/wasm-proof-provider.js');
        proofProvider = await buildWasmProofProvider(zkConfigProvider, proverMaterial);
    }
    const { InMemoryPrivateStateProvider } = await import('../browser/private-state.mjs');
    // midnight-js hands over its own transaction handles, while the wallet works on ledger transactions.
    const decoders = { v9: ledger.Transaction };
    const walletProviders = (wallet) => ({
        walletProvider: mjTypes.createLedger9WalletProvider({
            getCoinPublicKey: () => wallet.getCoinPublicKey(),
            getEncryptionPublicKey: () => wallet.getEncryptionPublicKey(),
            balanceTx: (tx, ttl) => wallet.balanceTx(tx.deserialize(decoders), ttl)
        }),
        midnightProvider: mjTypes.createLedger9MidnightProvider((tx) => wallet.submitTx(tx.deserialize(decoders)))
    });
    // One indexer provider per builder. One per transaction would leak a socket each time.
    const sockets = apiClient ? null : trackingWebSocket(require('ws'));
    const publicDataProvider = apiClient
        ? apiPublicDataProvider({ client: apiClient, mjTypes, mjUtils, mjProtocol, protocolVersion: Number(configuration.forks?.v9 ?? abstractions.ProtocolVersion.V9NativeForkVersion), ...(opts.maxLagBlocks !== undefined ? { maxLagBlocks: opts.maxLagBlocks } : {}) })
        : indexerSdk.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, sockets.WebSocket);

    return {
        provingMode,
        /** Your attestation secret. Pass it to the prepare* helpers. */
        attestationSecret,
        attesterId,
        zkAssets: assets,
        addresses,
        /** Public keys of this wallet. Another builder lists them under `recipients` to send it a private coin. */
        shieldedKeys,
        walletSync: syncMode,

        async waitForSync() {
            if (syncMode === 'all') await facade.waitForSyncedState();
            else await Promise.all(synced.map(w => facade[w].waitForSyncedState()));
        },

        /** Saves the wallet state. Pass it to `createTxBuilder({ walletState })` to skip a full sync next time. */
        async serializeWalletState() {
            const out = {};
            for (const w of synced) out[w] = await facade[w].serializeState();
            return out;
        },

        /** Builds, proves and signs one transaction of up to 8 calls for a sponsor to pay and submit.
         *  All calls share one witnesses object. A call's `before` hook sets what differs per call. */
        async buildSponsorable({ contractAddress, call, calls, witnesses: sharedWitnesses, initialPrivateState, bind = true, attestationSecret: batchSecret, independentCalls = false, orderedPrefix = 0, recipients, gasHeadroom }) {
            if (!contractAddress) throw new Error('buildSponsorable: contractAddress is required');
            const recipientKeys = recipientKeyMap(recipients);
            if (call && calls) throw new Error('buildSponsorable: pass either call or calls, not both');
            const callList = calls ?? (call ? [call] : []);
            if (!Array.isArray(callList) || callList.length === 0) {
                throw new Error('buildSponsorable: call (or a non-empty calls array) is required');
            }
            if (callList.length > 8) throw new Error('buildSponsorable: calls supports at most 8 entries per batch');
            for (const c of callList) {
                if (!c?.circuitId) throw new Error('buildSponsorable: every call must come from a prepare* helper (or carry circuitId, args and witnesses)');
            }
            const isBatch = callList.length > 1;
            if (ledger8 && isBatch) throw new Error('buildSponsorable: a contract compiled for ledger 8 takes one call per transaction after the fork; send the calls one by one');
            const headroom = gasHeadroomFactor(gasHeadroom);
            if (headroom !== undefined && isBatch) throw new Error('buildSponsorable: gasHeadroom applies to a single call, not to a batch');
            onProgress?.({ phase: 'build', circuit: callList.map(c => c.circuitId).join('+') });

            let witnesses;
            let scopeCalls;
            if (isBatch) {
                // A contract instance takes its witnesses once, so all calls must share them.
                const perCall = callList.map(c => c.witnesses).filter(w => w !== undefined);
                const sameForAll = perCall.length === callList.length && perCall.every(w => w === perCall[0]);
                if (sharedWitnesses) {
                    witnesses = sharedWitnesses;
                    scopeCalls = callList.map(c => ({ circuit: c.circuitId, args: c.args ?? [], ...(typeof c.before === 'function' ? { before: c.before } : {}) }));
                } else if (sameForAll) {
                    witnesses = perCall[0];
                    scopeCalls = callList.map(c => ({ circuit: c.circuitId, args: c.args ?? [], ...(typeof c.before === 'function' ? { before: c.before } : {}) }));
                } else if (String(contractName).startsWith('attestation-vault')) {
                    const widths = [...new Set(callList.map(c => c.slotWidth).filter(w => w !== undefined))];
                    if (widths.length > 1) throw new Error(`buildSponsorable: batched calls target different slot widths (${widths.join(', ')})`);
                    const { buildAttestationVaultWitnesses } = await import('../browser/witnesses.mjs');
                    const proofHolder = {};
                    witnesses = buildAttestationVaultWitnesses({
                        attestationSecret: batchSecret ?? attestationSecret,
                        merkleProofHolder: proofHolder,
                        ...(widths.length === 1 ? { slotWidth: widths[0] } : {})
                    });
                    // Every call sets the proof, so a call without one never sees the previous call's proof.
                    scopeCalls = callList.map(c => ({
                        circuit: c.circuitId,
                        args: c.args ?? [],
                        before: () => { proofHolder.current = c.merkleProof; }
                    }));
                } else {
                    throw new Error(
                        `buildSponsorable: a batch on '${contractName}' needs ONE shared witnesses object: pass \`witnesses\` on the input ` +
                        '(with optional per-call `before` hooks for what varies per call), or give every call the same `witnesses`. ' +
                        'Only the attestation-vault family gets its batch witnesses supplied by this builder.'
                    );
                }
            } else {
                witnesses = sharedWitnesses ?? callList[0].witnesses;
                if (!witnesses) throw new Error('buildSponsorable: the call carries no witnesses (pass `witnesses` on the call or on the input)');
            }

            const compiled = compiledContract(witnesses);
            const holder = {};
            const walletProvider = buildOnlyWalletProvider(facade, zswapKeys, keystore, holder, ttlMinutes, bind, configuration.forks);
            const privateStateProvider = new InMemoryPrivateStateProvider();
            const providers = {
                publicDataProvider,
                zkConfigProvider,
                proofProvider,
                privateStateProvider,
                ...walletProviders(walletProvider),
                config: { networkId, ttlSeconds: ttlMinutes * 60 }
            };
            const found = await findDeployedWithRetry(contracts, providers, {
                contractAddress,
                compiledContract: compiled,
                privateStateId,
                initialPrivateState: initialPrivateState ?? {}
            }).catch(async (e) => { throw await explainPreForkMismatch(e, contracts.ContractTypeError, publicDataProvider, contractAddress); });

            if (isBatch) {
                // The wallet provider throws at submit on purpose, so an error with a captured transaction is success.
                // A call order the ledger would reject fails before proving. It gets the same error code as on the server.
                // The SDK drops the error name, so the message is matched.
                const { runBatchInScope } = require('../../srv/midnight/batch-call-scope.js');
                try {
                    await runBatchInScope(contracts, providers, found, scopeCalls, contractAddress, { independentCalls: independentCalls === true, orderedPrefix: Number(orderedPrefix) || 0 },
                        recipientKeys ? { additionalCoinEncPublicKeyMappings: recipientKeys } : undefined);
                } catch (e) {
                    if (/violates the ledger's causality constraint/.test(String(e?.message ?? e))) {
                        try {
                            e.code = 'BatchCausalityViolation';
                            // Rebuild the per-call details from the message when the SDK dropped them.
                            if (!Array.isArray(e.calls)) {
                                const m = /Stages in apply order: (.*)$/.exec(String(e.message));
                                if (m) e.calls = m[1].trim().split(/\s+/).map(t => { const mm = /^(.+?)=(\d+)\[(.*)\]$/.exec(t); return mm ? { name: mm[1], segId: Number(mm[2]), stages: mm[3] } : { name: t, segId: -1, stages: '?' }; });
                            }
                        } catch { /* frozen error */ }
                        throw e;
                    }
                    if (/runs out of gas on the ledger/.test(String(e?.message ?? e))) {
                        try { e.code = 'BatchGasBudgetExceeded'; } catch { /* frozen error */ }
                        throw e;
                    }
                    if (!holder.captured) throw e;
                }
            } else {
                const single = callList[0];
                const direct = found?.callTx?.[single.circuitId];
                if (typeof direct !== 'function') {
                    throw new Error("circuit '" + single.circuitId + "' is not on the contract at " + contractAddress);
                }
                // The contract's call function takes no recipient keys, so this calls the SDK function behind it.
                // With gasHeadroom the build pauses before proving, raises the declared gas and continues with the SDK's prove, balance and submit.
                const callOptions = (args) => contracts.createCallTxOptions(compiled, single.circuitId, contractAddress, privateStateId, recipientKeys, args);
                const fn = headroom !== undefined
                    ? async (...args) => {
                        // The call result carries the state value, not the operations. The verifier key is read from the chain.
                        const [contractState, data] = await Promise.all([
                            publicDataProvider.queryContractState(contractAddress),
                            contracts.createUnprovenCallTx(providers, callOptions(args))
                        ]);
                        const { unprovenTx, declared } = applyGasHeadroom({ ledger, mjTypes }, data, headroom, { contractAddress, circuitId: single.circuitId, contractState });
                        onProgress?.({ phase: 'gas-headroom', factor: headroom, ...declared });
                        return contracts.submitTx(providers, { unprovenTx, circuitId: single.circuitId });
                    }
                    : recipientKeys ? (...args) => contracts.submitCallTx(providers, callOptions(args)) : direct;
                // The wallet provider throws at submit on purpose, so an error with a captured transaction is success.
                try {
                    await runSingleCall(single, fn);
                } catch (e) {
                    if (!holder.captured) throw e;
                }
            }
            if (!holder.captured?.serialize) throw new Error('build produced no serializable transaction');
            const bytes = new Uint8Array(holder.captured.serialize());
            onProgress?.({ phase: 'built', bytes: bytes.length, bound: bind !== false });
            return bind === false
                ? { unboundTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: false }
                : { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: true };
        },

        /** Builds, proves and signs a contract deploy for a sponsor to pay and submit.
         *  The server must allow sponsored deploys, and an agent token needs `allowDeploy` with budget left. */
        async buildDeploySponsorable({ initialPrivateState, constructorArgs, witnesses, bind = true, recipients } = {}) {
            if (ledger8) throw new Error('buildDeploySponsorable: a contract compiled for ledger 8 cannot be deployed after the fork; deploy the version of its package compiled for ledger 9');
            const recipientKeys = recipientKeyMap(recipients);
            onProgress?.({ phase: 'build', circuit: '<deploy>' });
            // The vault constructor reads the deployer's secret through a witness, so the vault family gets its witnesses here.
            if (!witnesses && String(contractName).startsWith('attestation-vault')) {
                const { buildAttestationVaultWitnesses } = await import('../browser/witnesses.mjs');
                witnesses = buildAttestationVaultWitnesses({
                    attestationSecret,
                    merkleProofHolder: {},
                    ...(fromPackage?.slotWidth !== undefined ? { slotWidth: fromPackage.slotWidth } : {})
                });
            }
            const compiled = CompiledContract.make(contractName, contractClass).pipe(
                witnesses ? CompiledContract.withWitnesses(witnesses) : CompiledContract.withVacantWitnesses,
                CompiledContract.withCompiledFileAssets(cacheDir)
            );
            const holder = {};
            const walletProvider = buildOnlyWalletProvider(facade, zswapKeys, keystore, holder, ttlMinutes, bind, configuration.forks);
            const privateStateProvider = new InMemoryPrivateStateProvider();
            const providers = {
                publicDataProvider,
                zkConfigProvider,
                proofProvider,
                privateStateProvider,
                ...walletProviders(walletProvider),
                config: { networkId, ttlSeconds: ttlMinutes * 60 }
            };
            // The wallet provider throws at submit on purpose, so an error with a captured transaction is success.
            try {
                await contracts.deployContract(providers, {
                    compiledContract: compiled,
                    privateStateId,
                    initialPrivateState: initialPrivateState ?? {},
                    ...(Array.isArray(constructorArgs) && constructorArgs.length > 0 ? { args: constructorArgs } : {}),
                    ...(recipientKeys ? { additionalCoinEncPublicKeyMappings: recipientKeys } : {})
                });
            } catch (e) {
                if (!holder.captured) throw e;
            }
            if (!holder.captured?.serialize) throw new Error('deploy build produced no serializable transaction');
            const contractAddress = readDeployAddress(holder.captured);
            const bytes = new Uint8Array(holder.captured.serialize());
            onProgress?.({ phase: 'built', bytes: bytes.length, bound: bind !== false, contractAddress });
            return bind === false
                ? { unboundTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: false, contractAddress }
                : { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: true, contractAddress };
        },

        /** Releases what a built transaction reserved in the builder's wallets, a shared shielded wallet included. */
        async revert(input) {
            await revertBuilt(facade, input, configuration.forks);
        },

        /** Stops the wallet sync and closes the indexer connections. */
        async close() {
            stopWatching();
            try { await facade.stop(); } catch { /* best effort */ }
            sockets?.closeAll();
        }
    };
}
