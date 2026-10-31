// Builds, proves and signs a Midnight transaction on your machine, with your key. The seed never leaves this process.
// A NIGHTGATE server pays the fee and submits it. Proofs are made in this process by default, with keys cached on disk.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, access, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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

// Each writer gets its own temporary file, so builders sharing a cache directory never mix their bytes.
const partFileFor = (dest) => `${dest}.${process.pid}.${randomUUID()}.part`;

// Paying the fee yourself and submitting to the node directly.
export {
    deserializeTransaction, txIdentifiers, submitFinalized, submitExtrinsic,
    classifyNodeReject, isPreMempoolReject, isTransportFailure, isAlreadyImported,
    probeLanded, waitLanded, withDustGuard, nodeHttpUrlFor, rebuildOnStaleTranscript
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

/** Downloads a contract's proving files into `cacheDir`, skipping files already there.
 *  With `package`, it fills in the missing prover keys of an installed contract package instead. */
export async function ensureZkAssets(input) {
    if (input?.package) return ensurePackageProverKeys(input);
    const { zkConfigBaseUrl, cacheDir, circuits = ATTESTATION_VAULT_CIRCUITS, verifierCircuits, fetchFn, onProgress } = input ?? {};
    if (!zkConfigBaseUrl) throw new Error('ensureZkAssets: zkConfigBaseUrl is required (or `package`, an installed lineage package)');
    if (!cacheDir) throw new Error('ensureZkAssets: cacheDir is required without `package`');
    const doFetch = fetchFn || fetch;
    const base = String(zkConfigBaseUrl).replace(/\/$/, '');
    await mkdir(join(cacheDir, 'keys'), { recursive: true });
    await mkdir(join(cacheDir, 'zkir'), { recursive: true });

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

    let fetched = 0;
    let cached = 0;
    let refreshed = 0;
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
            const res = await doFetch(base + '/' + rel);
            if (!res.ok) {
                // A missing circuit is fine. Only the circuits you call must exist.
                if (res.status === 404) continue;
                throw new Error('ensureZkAssets: GET ' + base + '/' + rel + ' -> HTTP ' + res.status);
            }
            // Write to a temporary file, then rename it.
            // A file in the cache counts as complete, so a half-written key must never appear there.
            const body = Buffer.from(await res.arrayBuffer());
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
            const tmp = partFileFor(dest);
            try {
                await writeFile(tmp, body);
                await rename(tmp, dest);
            } catch (e) {
                await rm(tmp, { force: true }).catch(() => { /* best effort */ });
                throw e;
            }
            fetched++;
            onProgress?.({ phase: 'zk-asset', circuit, file: rel, fetched, cached, refreshed });
        }
    }
    return { cacheDir, fetched, cached, refreshed, verified: Boolean(manifest), source: 'remote' };
}

/** Downloads the prover keys a contract package does not ship and checks each against its keys/manifest.json. */
async function ensurePackageProverKeys({ package: packageName, from, circuits, fetchFn, onProgress }) {
    const pkg = resolveContractPackage(packageName, from ?? process.cwd());
    const zkConfigPath = pkg.zkConfigPath;
    const manifest = readProverKeyManifest(zkConfigPath);
    if (!manifest) throw new Error(`ensureZkAssets: ${pkg.name} ships no keys/manifest.json; a downloaded key cannot be verified`);
    const all = verifierCircuits(zkConfigPath);
    const unknown = (circuits ?? []).filter(c => !all.includes(c));
    if (unknown.length) throw new Error(`ensureZkAssets: ${pkg.name} has no circuit ${unknown.join(', ')} (it has ${all.join(', ')})`);
    const wanted = circuits ?? all;
    const missing = missingProverKeys(zkConfigPath).filter(c => wanted.includes(c));
    const doFetch = fetchFn || fetch;
    const keysDir = join(zkConfigPath, 'keys');
    let fetched = 0;
    for (const circuit of missing) {
        const expected = manifest.prover?.[circuit];
        if (!expected) throw new Error(`ensureZkAssets: ${pkg.name}: keys/manifest.json lists no prover key for ${circuit}`);
        const url = proverKeyUrl(pkg.manifest.zkAssetUrl, pkg.manifest.zkAssetLayout, circuit);
        const res = await doFetch(url);
        if (!res.ok) throw new Error(`ensureZkAssets: GET ${url} -> HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (!keyMatchesManifest(body, expected)) throw new Error(`ensureZkAssets: ${circuit}.prover from ${url} does not match keys/manifest.json`);
        const dest = join(keysDir, `${circuit}.prover`);
        const tmp = partFileFor(dest);
        try {
            await writeFile(tmp, body);
            await rename(tmp, dest);
        } catch (e) {
            await rm(tmp, { force: true }).catch(() => { /* best effort */ });
            throw e;
        }
        fetched++;
        onProgress?.({ phase: 'zk-asset', circuit, file: `keys/${circuit}.prover`, fetched, cached: wanted.length - missing.length, refreshed: 0 });
    }
    const local = await describeLocalZkAssets(zkConfigPath, all, wanted);
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
    const runtimeProblem = runtimeVersionProblem(pkg.manifest);
    if (runtimeProblem) throw new Error(`contract package ${packageName} ${runtimeProblem}`);
    const mod = await import(pathToFileURL(pkg.artifactPath).href);
    const contractClass = mod.Contract ?? mod.default?.Contract;
    if (typeof contractClass !== 'function') throw new Error(`contract package ${packageName}: ${pkg.artifactPath} exports no Contract class`);
    return {
        package: { name: pkg.name, version: pkg.version, root: pkg.root },
        contractClass,
        contractName: pkg.manifest.name,
        privateStateId: pkg.manifest.privateStateId,
        zkConfigDir: pkg.zkConfigPath,
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

function sha256Hex(body) {
    return createHash('sha256').update(body).digest('hex');
}

/** Releases what a built transaction reserved, in all sub-wallets whatever they sync, and drops it from the pending list. */
// Exported for the unit tests only.
export async function revertBuilt(facade, input) {
    const { tx } = await decodeOffer(input);
    await facade.revertTransaction(tx);
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
export function buildOnlyWalletProvider(facade, zswapKeys, dustKey, keystore, holder, ttlMinutes, bind) {
    return {
        getCoinPublicKey: () => zswapKeys.coinPublicKey,
        getEncryptionPublicKey: () => zswapKeys.encryptionPublicKey,
        async balanceTx(tx, ttl) {
            const effectiveTtl = ttl ?? new Date(Date.now() + ttlMinutes * 60 * 1000);
            const recipe = await facade.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
                { ttl: effectiveTtl, tokenKindsToBalance: ['shielded', 'unshielded'] }
            );
            const signed = await facade.signRecipe(recipe, (payload) => keystore.signData(payload));
            if (bind === false) {
                // The SDK passes what balanceTx returns on to submitTx, where it is captured.
                // If the wallet had to add its own coins, there is a second transaction.
                // The sponsor would only seal the first one, so this case needs bind: true.
                if (signed?.balancingTransaction) {
                    await facade.revert(signed).catch(() => { /* the refusal is the error to report */ });
                    throw new Error('buildSponsorable({ bind: false }): this call needs a balancing transaction (it moves value); use the bound handover (bind: true / sponsorFinalizedTransaction) for it');
                }
                holder.unbound = true;
                return signed?.baseTransaction ?? signed;
            }
            return await facade.finalizeRecipe(signed);
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

/** Options for midnight-js' `httpClientProofProvider`. Without `proofTimeoutMs` the SDK default of 5 minutes applies. */
export function proofProviderConfig(opts) {
    return opts?.proofTimeoutMs ? { timeout: opts.proofTimeoutMs } : undefined;
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

/** Checks that a local directory has all proving files. Downloads nothing. */
export async function describeLocalZkAssets(zkConfigDir, circuits = [], proveCircuits = circuits) {
    const { statSync, readdirSync } = await import('node:fs');
    const keysDir = join(zkConfigDir, 'keys');
    const zkirDir = join(zkConfigDir, 'zkir');
    const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
    if (!isDir(keysDir) || !isDir(zkirDir)) {
        throw new Error(`createTxBuilder: zkConfigDir ${zkConfigDir} must hold keys/ and zkir/ directories`);
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
async function deriveKeyMaterial({ seedHex, networkId = 'preprod', accountIndex = 0, attestationSecret: ownSecret }) {
    assertSeedHex(seedHex);
    const [unshielded, { deriveAttestationSecret }, ledger, addressFormat] = await Promise.all([
        import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        import('../browser/witnesses.mjs'),
        import('@midnight-ntwrk/ledger-v8'),
        import('@midnightntwrk/wallet-sdk-address-format')
    ]);
    const { deriveRoleSeeds } = require('../../srv/utils/wallet-hd.js');
    const rt = compactRuntime;
    const roleSeeds = await deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const keystore = unshielded.createKeystore(roleSeeds.night, networkId);
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
        seedHex, networkId = 'preprod', accountIndex = 0,
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
    if (opts.provingMode !== undefined && opts.provingMode !== 'wasm' && opts.provingMode !== 'server') {
        throw new Error(`createTxBuilder: provingMode must be 'wasm' or 'server' (got ${String(opts.provingMode)})`);
    }
    if (opts.provingMode === 'server' && !opts.proofServerUrl) {
        throw new Error("createTxBuilder: provingMode 'server' requires proofServerUrl (a proof server YOU run; it receives the witnesses)");
    }
    if (opts.proofTimeoutMs !== undefined && !(Number.isInteger(opts.proofTimeoutMs) && opts.proofTimeoutMs > 0)) {
        throw new Error(`createTxBuilder: proofTimeoutMs must be a positive integer (ms), got ${String(opts.proofTimeoutMs)}`);
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
        assets = await describeLocalZkAssets(zkConfigDir, verifierSet, proveSet);
    } else {
        assets = await ensureZkAssets({
            zkConfigBaseUrl, cacheDir,
            circuits: circuits ?? allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            verifierCircuits: allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            fetchFn: opts.fetchFn,
            onProgress
        });
    }

    const [ledger, facadeSdk, shielded, unshielded, dust, abstractions, netId, compactJs, contracts, zkNode, indexerSdk, proving] = await Promise.all([
        import('@midnight-ntwrk/ledger-v8'),
        import('@midnightntwrk/wallet-sdk-facade'),
        import('@midnightntwrk/wallet-sdk-shielded'),
        import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        import('@midnightntwrk/wallet-sdk-dust-wallet'),
        import('@midnightntwrk/wallet-sdk-abstractions'),
        import('@midnight-ntwrk/midnight-js-network-id'),
        import('@midnight-ntwrk/compact-js'),
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnightntwrk/wallet-sdk-capabilities/proving')
    ]);
    netId.setNetworkId?.(networkId);

    const { roleSeeds, keystore, attestationSecret, attesterId, addresses, shieldedKeys } = await deriveKeyMaterial({ seedHex, networkId, accountIndex, attestationSecret: opts.attestationSecret });
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey = ledger.DustSecretKey.fromSeed(roleSeeds.dust);

    onProgress?.({ phase: 'wallet' });
    const configuration = {
        networkId,
        // The SDK requires provingServerUrl even though the wallet proves in this process.
        relayURL: new URL(nodeUrl ?? UNUSED_NODE_URL),
        provingServerUrl: new URL(opts.proofServerUrl ?? 'http://127.0.0.1:6300'),
        indexerClientConnection: hasIndexer ? { indexerHttpUrl, indexerWsUrl } : UNUSED_INDEXER,
        txHistoryStorage: new abstractions.InMemoryTransactionHistoryStorage(facadeSdk.WalletEntrySchema, facadeSdk.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };
    const facade = await facadeSdk.WalletFacade.init({
        configuration,
        // Without a node the SDK's default service would dial the relay at init.
        ...(nodeUrl ? {} : { submissionService: buildOnlySubmissionService() }),
        provingService: () => proving.makeWasmProvingService({}),
        shielded: () => (shared ? sharedShieldedWallet(shared)
            : saved?.shielded ? shielded.ShieldedWallet(configuration).restore(saved.shielded)
                : shielded.ShieldedWallet(configuration).startWithSecretKeys(zswapKeys)),
        unshielded: () => (saved?.unshielded
            ? unshielded.UnshieldedWallet(configuration).restore(saved.unshielded)
            : unshielded.UnshieldedWallet(configuration).startWithPublicKey(unshielded.PublicKey.fromKeyStore(keystore))),
        dust: () => (saved?.dust
            ? dust.DustWallet(configuration).restore(saved.dust)
            : dust.DustWallet(configuration).startWithSecretKey(dustKey, ledger.LedgerParameters.initialParameters().dust))
    });
    // Syncing a wallet reads the whole chain and keeps this thread busy; a call that moves no
    // tokens needs none. A sponsor pays the fee, so 'shielded' and 'coins' leave the dust wallet out.
    const stopWatching = onProgress ? watchSync(facade, synced, onProgress) : () => {};
    if (syncMode === 'all') await facade.start(zswapKeys, dustKey);
    else if (syncMode === 'coins') await Promise.all([facade.shielded.start(zswapKeys), facade.unshielded.start()]);
    else if (syncMode === 'shielded') await facade.shielded.start(zswapKeys);

    const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
    if (!CompiledContract?.make) throw new Error('compact-js: CompiledContract.make not found');
    const zkConfigProvider = new zkNode.NodeZkConfigProvider(cacheDir);
    // provingMode only affects the contract's circuits. The wallet's own proofs are always made in this process.
    let proofProvider;
    const provingMode = opts.provingMode === 'server' ? 'server' : 'wasm';
    if (provingMode === 'server') {
        const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
        proofProvider = httpClientProofProvider(opts.proofServerUrl, zkConfigProvider, proofProviderConfig(opts));
    } else {
        const { buildWasmProofProvider } = require('../../srv/midnight/wasm-proof-provider.js');
        proofProvider = await buildWasmProofProvider(zkConfigProvider);
    }
    const { InMemoryPrivateStateProvider } = await import('../browser/private-state.mjs');
    // One indexer provider per builder. One per transaction would leak a socket each time.
    const sockets = apiClient ? null : trackingWebSocket(require('ws'));
    const publicDataProvider = apiClient
        ? apiPublicDataProvider({ client: apiClient, ledger, runtime: compactRuntime, ...(opts.maxLagBlocks !== undefined ? { maxLagBlocks: opts.maxLagBlocks } : {}) })
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
        async buildSponsorable({ contractAddress, call, calls, witnesses: sharedWitnesses, initialPrivateState, bind = true, attestationSecret: batchSecret, independentCalls = false, orderedPrefix = 0, recipients }) {
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

            const compiled = CompiledContract.make(contractName, contractClass).pipe(
                CompiledContract.withWitnesses(witnesses),
                CompiledContract.withCompiledFileAssets(cacheDir)
            );
            const holder = {};
            const walletProvider = buildOnlyWalletProvider(facade, zswapKeys, dustKey, keystore, holder, ttlMinutes, bind);
            const privateStateProvider = new InMemoryPrivateStateProvider();
            const providers = {
                publicDataProvider,
                zkConfigProvider,
                proofProvider,
                privateStateProvider,
                walletProvider,
                midnightProvider: walletProvider
            };
            privateStateProvider.setContractAddress?.(contractAddress);
            const found = await findDeployedWithRetry(contracts, providers, {
                contractAddress,
                compiledContract: compiled,
                privateStateId,
                initialPrivateState: initialPrivateState ?? {}
            });

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
                    if (!holder.captured) throw e;
                }
            } else {
                const single = callList[0];
                const direct = found?.callTx?.[single.circuitId];
                if (typeof direct !== 'function') {
                    throw new Error("circuit '" + single.circuitId + "' is not on the contract at " + contractAddress);
                }
                // The contract's call function takes no recipient keys, so this calls the SDK function behind it.
                const fn = recipientKeys
                    ? (...args) => contracts.submitCallTx(providers, contracts.createCallTxOptions(compiled, single.circuitId, contractAddress, privateStateId, recipientKeys, args))
                    : direct;
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
            const recipientKeys = recipientKeyMap(recipients);
            onProgress?.({ phase: 'build', circuit: '<deploy>' });
            const compiled = CompiledContract.make(contractName, contractClass).pipe(
                witnesses ? CompiledContract.withWitnesses(witnesses) : CompiledContract.withVacantWitnesses,
                CompiledContract.withCompiledFileAssets(cacheDir)
            );
            const holder = {};
            const walletProvider = buildOnlyWalletProvider(facade, zswapKeys, dustKey, keystore, holder, ttlMinutes, bind);
            const privateStateProvider = new InMemoryPrivateStateProvider();
            const providers = {
                publicDataProvider,
                zkConfigProvider,
                proofProvider,
                privateStateProvider,
                walletProvider,
                midnightProvider: walletProvider
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
            await revertBuilt(facade, input);
        },

        /** Stops the wallet sync and closes the indexer connections. */
        async close() {
            stopWatching();
            try { await facade.stop(); } catch { /* best effort */ }
            sockets?.closeAll();
        }
    };
}
