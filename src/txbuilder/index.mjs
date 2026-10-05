// `@odatano/nightgate/txbuilder` builds, proves and signs a Midnight transaction on your machine, with your key.
// The result has no fee paid yet. A NIGHTGATE server (the sponsor) pays the fee and submits it.
// Your seed and secrets never leave this process.
//
//   import { prepareAttest } from '@odatano/nightgate/browser';
//   import { Contract } from '@odatano/nightgate/browser/attestation-vault';
//   import { createTxBuilder } from '@odatano/nightgate/txbuilder';
//
//   const b = await createTxBuilder({
//       seedHex, networkId: 'preprod',
//       indexerHttpUrl, indexerWsUrl,
//       zkConfigBaseUrl: 'https://sponsor.example/zk-config/attestation-vault',
//       contractClass: Contract
//   });
//   const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: b.attestationSecret });
//   const { finalizedTxB64 } = await b.buildSponsorable({ contractAddress, call });
//   // POST finalizedTxB64 to the sponsor's sponsorFinalizedTransaction
//   await b.close();
//
// By default proofs are made in this process, so no proof server is needed.
// The proving keys are downloaded once and then cached on disk.
//
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, access, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    resolveContractPackage, contractPackageDigestProblem, readProverKeyManifest, verifierCircuits, missingProverKeys,
    keyMatchesManifest, proverKeyUrl
} from '@odatano/contract-kit/node';

const require = createRequire(import.meta.url);

// Paying the fee yourself and submitting to the node directly.
export {
    deserializeTransaction, txIdentifiers, submitFinalized, submitExtrinsic,
    classifyNodeReject, isPreMempoolReject, isTransportFailure, isAlreadyImported,
    probeLanded, waitLanded, withDustGuard, nodeHttpUrlFor, rebuildOnStaleTranscript
} from './submit.mjs';

export {
    SWAP_OFFER_PREFIX, SWAP_MAX_INPUTS, createSwapWallet, readSwapTerms, sameSwapTerms, encodeOffer, decodeOffer,
    chooseSwapCoin, spendableWithin
} from './swap.mjs';

export { holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from './holder.mjs';

export { tokenFactoryIssuerSecret, deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from './factory.mjs';

/** Derives the night, zswap and dust seeds from a BIP39 seed, the same way the Lace wallet does. */
export async function deriveRoleSeeds(seedHex, accountIndex = 0) {
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) throw new Error('seedHex must be 128 hex chars (64-byte BIP39 seed)');
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
        if (!/^[0-9a-f]{64}$/.test(coin)) throw new Error('recipients: coinPublicKey must be 64 hex chars');
        if (!/^[0-9a-f]{64}$/.test(enc)) throw new Error('recipients: encryptionPublicKey must be 64 hex chars');
        map.set(coin, enc);
    }
    return map.size > 0 ? map : undefined;
}

export function walletSyncMode(walletSync) {
    if (walletSync === undefined || walletSync === true) return 'all';
    if (walletSync === false) return 'none';
    if (walletSync === 'shielded') return 'shielded';
    throw new Error(`createTxBuilder: walletSync must be true, false or 'shielded' (got ${String(walletSync)})`);
}

/** The circuits of the attestation vault contract. Their proving files are fetched by default. */
export const ATTESTATION_VAULT_CIRCUITS = [
    'attest', 'retract', 'anchorContentRoot', 'bindDocument', 'registerDocument',
    'grantDisclosure', 'revokeDisclosure', 'proveFieldPredicate', 'proveFieldEquality',
    'proveFieldMembership', 'proveDocumentComparison'
];

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Downloads the proving files of a contract into `cacheDir`, skipping files already there.
 * With `package`, it fills in the missing prover keys of an installed contract package instead.
 */
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
            const tmp = dest + '.part';
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

/**
 * A contract package ships everything except the large prover keys.
 * This downloads the missing prover keys and checks each against the package's keys/manifest.json.
 */
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
        const tmp = dest + '.part';
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

/**
 * Loads an installed contract package (`@odatano/contract-<name>`) for the builder.
 * Fails if the package files do not match the build described in its contract.json.
 */
export async function resolveBuilderPackage({ package: packageName, from }) {
    if (!packageName) throw new Error('resolveBuilderPackage: package is required');
    const pkg = resolveContractPackage(packageName, from ?? process.cwd());
    const problem = contractPackageDigestProblem(pkg);
    if (problem) throw new Error(`contract package ${packageName} is not the generation its contract.json describes: ${problem}`);
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

/** Runs a single call. Its `before` hook runs first, just as in a batch. */
// Exported for the unit tests only.
export async function runSingleCall(single, fn) {
    if (typeof single.before === 'function') single.before();
    return fn(...(single.args ?? []));
}

/**
 * A wallet provider that signs the transaction and then stops instead of submitting it.
 * The unsubmitted transaction is kept in `holder.captured`.
 * submitTx throws on purpose. A fake id would make the SDK wait forever for a confirmation.
 *
 * `bind` chooses what is handed to the sponsor:
 *  - true: a sealed transaction, for sponsorFinalizedTransaction.
 *  - false: a signed transaction that is not sealed yet, for sponsorUnboundTransaction.
 *    The sponsor adds its fee payment and seals it. Only this form lets one sponsor pay for several transactions at once.
 *
 * Exported for the unit tests only.
 */
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

/**
 * `findDeployedContract` with one retry.
 * Right after a block lands, the indexer can briefly return an empty contract state.
 */
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

/**
 * A `ws` subclass that remembers its open sockets, so `close()` can end them.
 * The SDK's indexer provider has no close method of its own.
 */
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
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) {
        throw new Error('seedHex must be 128 hex chars (64-byte BIP39 seed)');
    }
    const [unshielded, { deriveAttestationSecret }, ledger, addressFormat] = await Promise.all([
        import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
        import('../browser/witnesses.mjs'),
        import('@midnight-ntwrk/ledger-v8'),
        import('@midnightntwrk/wallet-sdk-address-format')
    ]);
    const { deriveRoleSeeds } = require('../../srv/utils/wallet-hd.js');
    const rt = require('@midnight-ntwrk/compact-runtime');
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

/**
 * Computes the key under which the vault stores an attester's attestation of a payload, as hex.
 * Gives the same result as the vault's `recordKey` circuit.
 */
export function computeRecordKey(attesterId, payloadHash) {
    const rt = require('@midnight-ntwrk/compact-runtime');
    const u8 = new rt.CompactTypeUnsignedInteger(255n, 1);
    const b32 = new rt.CompactTypeBytes(32);
    const hexToBytes = (h, name) => {
        if (!/^[0-9a-fA-F]{64}$/.test(String(h ?? ''))) throw new Error(`${name} must be 64 hex chars (32 bytes)`);
        return Uint8Array.from(Buffer.from(h, 'hex'));
    };
    const type = {
        alignment: () => u8.alignment().concat(b32.alignment(), b32.alignment()),
        toValue: (v) => u8.toValue(v.tag).concat(b32.toValue(v.owner), b32.toValue(v.payload_hash))
    };
    return Buffer.from(rt.persistentHash(type, { tag: 21n, owner: hexToBytes(attesterId, 'attesterId'), payload_hash: hexToBytes(payloadHash, 'payloadHash') })).toString('hex');
}

/**
 * Derives the attester id, attestation secret and addresses of a seed.
 * Needs no network and gives the same result as `createTxBuilder`.
 *
 * @param {{ seedHex: string, networkId?: string, accountIndex?: number, attestationSecret?: Uint8Array }} opts
 * @returns {Promise<{ attesterId: string, attestationSecret: Uint8Array, addresses: { night: string, shielded: string }, shieldedKeys: { coinPublicKey: string, encryptionPublicKey: string } }>}
 */
export async function deriveIdentity(opts) {
    const { attesterId, attestationSecret, addresses, shieldedKeys } = await deriveKeyMaterial(opts ?? {});
    return { attesterId, attestationSecret, addresses, shieldedKeys };
}

/**
 * Creates a transaction builder for your seed.
 *
 * @param {object} opts
 * @param {string} opts.seedHex           128 hex chars (64-byte BIP39 seed). Never leaves this process.
 * @param {string} [opts.networkId]       Defaults to 'preprod'.
 * @param {number} [opts.accountIndex]    BIP32 account index. Defaults to 0.
 * @param {string} opts.indexerHttpUrl
 * @param {string} opts.indexerWsUrl
 * @param {string} opts.nodeUrl          Node RPC URL, for example wss://rpc.preprod.midnight.network/
 * @param {string} [opts.proofServerUrl] Only used with provingMode 'server'.
 * @param {number} [opts.proofTimeoutMs]  Server proving only. Timeout of one proof request in ms, default 300000.
 *                                        The SDK retries a timed-out proof, so set it above your slowest circuit.
 * @param {'wasm'|'server'} [opts.provingMode] 'wasm' (default) proves in this process.
 *                                        'server' proves on opts.proofServerUrl, which is faster for large circuits.
 *                                        The proof server sees your private inputs, so only use one you run yourself.
 * @param {string} [opts.package]         An installed contract package (`@odatano/contract-<name>`).
 *                                        It supplies the contract class, names and proving files.
 * @param {string} [opts.from]            Directory to resolve the package from. Defaults to process.cwd().
 * @param {string} opts.zkConfigBaseUrl   A server's /zk-config/<contract> URL. Not needed with `package` or `zkConfigDir`.
 * @param {Function} opts.contractClass   The compiled contract class. Not needed with `package`.
 * @param {string} [opts.contractName]    Defaults to 'attestation-vault'.
 * @param {string} [opts.privateStateId]  Defaults to 'attestationVaultPrivateState'.
 * @param {string} [opts.cacheDir]        Where proving files are cached. Defaults to ~/.cache/nightgate-txbuilder/<contractName>.
 * @param {string[]} [opts.circuits]      Circuits you will call. Defaults to all circuits of the contract.
 * @param {number} [opts.ttlMinutes]      How long the transaction stays valid, default 30. The sponsor must submit it in that time.
 * @param {Uint8Array} [opts.attestationSecret] Defaults to a secret derived from the seed.
 * @param {Function} [opts.onProgress]    Progress callback.
 */
export async function createTxBuilder(opts) {
    const {
        seedHex, networkId = 'preprod', accountIndex = 0,
        indexerHttpUrl, indexerWsUrl, nodeUrl, zkConfigBaseUrl,
        circuits, ttlMinutes = 30, onProgress
    } = opts ?? {};
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) {
        throw new Error('createTxBuilder: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    }
    if (!indexerHttpUrl || !indexerWsUrl) throw new Error('createTxBuilder: indexerHttpUrl and indexerWsUrl are required');
    if (!nodeUrl) throw new Error('createTxBuilder: nodeUrl is required (the Substrate RPC the wallet SDK talks to)');
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
    const saved = opts.walletState;
    if (saved !== undefined && (saved === null || typeof saved !== 'object' || ['shielded', 'unshielded', 'dust'].some(k => saved[k] !== undefined && typeof saved[k] !== 'string'))) {
        throw new Error('createTxBuilder: walletState must be the object serializeWalletState() returned');
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
        relayURL: new URL(nodeUrl),
        provingServerUrl: new URL(opts.proofServerUrl ?? 'http://127.0.0.1:6300'),
        indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
        txHistoryStorage: new abstractions.InMemoryTransactionHistoryStorage(facadeSdk.WalletEntrySchema, facadeSdk.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };
    const facade = await facadeSdk.WalletFacade.init({
        configuration,
        provingService: () => proving.makeWasmProvingService({}),
        shielded: () => (saved?.shielded
            ? shielded.ShieldedWallet(configuration).restore(saved.shielded)
            : shielded.ShieldedWallet(configuration).startWithSecretKeys(zswapKeys)),
        unshielded: () => (saved?.unshielded
            ? unshielded.UnshieldedWallet(configuration).restore(saved.unshielded)
            : unshielded.UnshieldedWallet(configuration).startWithPublicKey(unshielded.PublicKey.fromKeyStore(keystore))),
        dust: () => (saved?.dust
            ? dust.DustWallet(configuration).restore(saved.dust)
            : dust.DustWallet(configuration).startWithSecretKey(dustKey, ledger.LedgerParameters.initialParameters().dust))
    });
    // Syncing a wallet reads the whole chain and keeps this thread busy.
    // A call that moves no tokens needs no synced wallet, so `walletSync: false` skips it.
    // A call that does move tokens then fails at balancing.
    // `'shielded'` syncs only the private coins, which is enough when a sponsor pays the fee.
    if (syncMode === 'all') await facade.start(zswapKeys, dustKey);
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
    const sockets = trackingWebSocket(require('ws'));
    const publicDataProvider = indexerSdk.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, sockets.WebSocket);

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
            else if (syncMode === 'shielded') await facade.shielded.waitForSyncedState();
        },

        /** Saves the wallet state. Pass it to `createTxBuilder({ walletState })` to skip a full sync next time. */
        async serializeWalletState() {
            if (syncMode === 'none') return {};
            const out = { shielded: await facade.shielded.serializeState() };
            if (syncMode === 'all') {
                out.unshielded = await facade.unshielded.serializeState();
                out.dust = await facade.dust.serializeState();
            }
            return out;
        },

        /**
         * Builds, proves and signs one transaction without submitting it.
         * It holds one call (`call`) or up to 8 calls (`calls`). Send the result to a sponsor, which pays the fee and submits.
         *
         * All calls of a batch share one witnesses object, the functions that supply private inputs.
         * Pass it as `witnesses`, or give every call the same one.
         * For the attestation vault the builder supplies it. Use a call's `before` hook for what differs per call.
         *
         * @param {{ contractAddress: string, call?: { circuitId: string, args: unknown[], witnesses: object }, calls?: Array<{ circuitId: string, args: unknown[], merkleProof?: object, slotWidth?: number }>, initialPrivateState?: unknown, bind?: boolean, attestationSecret?: Uint8Array }} input
         * @returns {Promise<{ finalizedTxB64: string, serializedBytes: number }>}
         */
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

        /**
         * Builds, proves and signs a contract deploy without submitting it. A sponsor pays the fee.
         * The server must allow sponsored deploys, and an agent token needs `allowDeploy` with budget left.
         *
         * @param {{ initialPrivateState?: unknown, constructorArgs?: unknown[], witnesses?: object, bind?: boolean }} input
         * @returns {Promise<{ finalizedTxB64?: string, unboundTxB64?: string, serializedBytes: number, bound: boolean, contractAddress: string }>}
         */
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

        /** Stops the wallet sync and closes the indexer connections. */
        async close() {
            try { await facade.stop(); } catch { /* best effort */ }
            sockets.closeAll();
        }
    };
}
