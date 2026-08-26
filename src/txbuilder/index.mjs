// `@odatano/nightgate/txbuilder`: build a sponsorable Midnight transaction on
// YOUR machine, with YOUR key, without running a NIGHTGATE server.
//
// This is the caller half of cross-server fee sponsoring. You build, prove and
// sign locally; the resulting fee-unpaid transaction (~5 KB) is all a sponsor
// needs to pay the dust and submit. Your seed and your attestation secret never
// leave this process, and the on-chain attestation carries YOUR attester id.
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
// Proving runs in-process (wasm), so no proof server and no Docker. The prover
// keys are FETCHED from a public /zk-config and CACHED on disk, so the first
// build downloads and every later one is offline.
//
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import { mkdir, writeFile, access, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

/** Circuits whose proving assets are fetched by default (the vault's set). */
export const ATTESTATION_VAULT_CIRCUITS = [
    'attest', 'attestGuarded', 'anchorContentRoot', 'bindPassport', 'registerPassport',
    'grantDisclosure', 'revokeDisclosure', 'proveFieldPredicate', 'proveFieldEquality',
    'proveFieldMembership', 'proveDocumentComparison'
];

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Fetch `keys/<circuit>.{prover,verifier}` + `zkir/<circuit>.bzkir` from a
 * public /zk-config base URL into `cacheDir`, skipping what is already there.
 * The cache directory doubles as a compiled-assets directory, which is what
 * lets the local build use the same asset path the server uses.
 */
export async function ensureZkAssets({ zkConfigBaseUrl, cacheDir, circuits = ATTESTATION_VAULT_CIRCUITS, verifierCircuits, fetchFn, onProgress }) {
    if (!zkConfigBaseUrl) throw new Error('ensureZkAssets: zkConfigBaseUrl is required');
    const doFetch = fetchFn || fetch;
    const base = String(zkConfigBaseUrl).replace(/\/$/, '');
    await mkdir(join(cacheDir, 'keys'), { recursive: true });
    await mkdir(join(cacheDir, 'zkir'), { recursive: true });

    // `circuits` restricts only the HEAVY prover keys (megabytes each). The
    // ~2 KB VERIFIER keys must exist for EVERY circuit of the contract:
    // findDeployedContract reads them all when it verifies the deployment, so
    // a caller who fetched only its own circuit would fail on the first build.
    const verifierSet = [...new Set([...(verifierCircuits ?? []), ...circuits])];

    let fetched = 0;
    let cached = 0;
    const plan = [
        ...circuits.flatMap(c => [[c, 'keys', '.prover'], [c, 'zkir', '.bzkir']]),
        ...verifierSet.map(c => [c, 'keys', '.verifier'])
    ];
    {
        for (const [circuit, dir, ext] of plan) {
            const rel = dir + '/' + circuit + ext;
            const dest = join(cacheDir, dir, circuit + ext);
            if (await exists(dest)) { cached++; continue; }
            const res = await doFetch(base + '/' + rel);
            if (!res.ok) {
                // A circuit this contract does not expose is not fatal; only the
                // ones you actually call have to resolve.
                if (res.status === 404) continue;
                throw new Error('ensureZkAssets: GET ' + base + '/' + rel + ' -> HTTP ' + res.status);
            }
            // Download to a side file and rename into place. A file at `dest` is
            // treated as complete forever after, so a run interrupted mid-write
            // would otherwise poison the cache with a truncated prover key, and
            // every later build would fail deep inside the prover instead of
            // re-downloading. rename() is atomic within the directory.
            const body = Buffer.from(await res.arrayBuffer());
            const declared = Number(res.headers?.get?.('content-length') ?? NaN);
            if (Number.isFinite(declared) && declared !== body.length) {
                throw new Error('ensureZkAssets: ' + rel + ' truncated (' + body.length + ' of ' + declared + ' bytes)');
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
            onProgress?.({ phase: 'zk-asset', circuit, file: rel, fetched, cached });
        }
    }
    return { cacheDir, fetched, cached, source: 'remote' };
}

/**
 * A wallet provider that balances the caller's own side, signs, and then STOPS
 * instead of submitting: the fee-unpaid transaction is captured for the
 * sponsor. Throwing from submitTx is deliberate; returning a fake id makes the
 * SDK wait forever for a confirmation that will never come.
 *
 * `bind` chooses the handover format:
 *  - true  (default): FINALIZED (bound) tx -> sponsorFinalizedTransaction,
 *    sponsor attaches dust via balanceFinalizedTransaction (serial per wallet).
 *  - false: UNBOUND (pre-binding) signed tx -> sponsorUnboundTransaction, the
 *    sponsor merges dust from a locked note and binds (parallel, 0.18). A
 *    dust tx cannot merge into a bound tx, so parallel sponsoring REQUIRES
 *    the unbound handover.
 */
// Exported for the unit tests only (not in the .d.ts): the handover rules live here.
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
                // Return the signed UNBOUND (pre-binding) tx. The SDK's callTx
                // flow forwards whatever balanceTx returns to submitTx, where
                // we capture it. baseTransaction is the proven+signed tx.
                // A recipe that ALSO carries a balancingTransaction (the call
                // moved shielded/unshielded value and the wallet had to add
                // inputs) cannot be handed over unbound: the sponsor would bind
                // the base alone, i.e. a different, unbalanced transaction.
                // Fail closed; the bound handover (finalizeRecipe merges both)
                // covers that case.
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
 * Create a headless transaction builder bound to your seed.
 *
 * @param {object} opts
 * @param {string} opts.seedHex           128 hex chars (64-byte BIP39 seed). Never leaves this process.
 * @param {string} [opts.networkId]       'preprod' (default), 'testnet', 'devnet', ...
 * @param {number} [opts.accountIndex]    BIP32 account level, default 0.
 * @param {string} opts.indexerHttpUrl
 * @param {string} opts.indexerWsUrl
 * @param {string} opts.nodeUrl          Substrate RPC (the SDK's relayURL), e.g. wss://rpc.preprod.midnight.network/
 * @param {string} [opts.proofServerUrl] unused by default (only the SDK's config type wants it); see provingMode
 * @param {'wasm'|'server'} [opts.provingMode] 'wasm' (default): prove the contract circuit in-process, nothing
 *                                        leaves the process. 'server': prove on opts.proofServerUrl, which
 *                                        then RECEIVES THE WITNESSES: native and multi-threaded, several
 *                                        times faster on the big circuits, but only ever a proof server
 *                                        you run yourself, never the sponsor's. An EXPLICIT opt-in on
 *                                        purpose: in 0.17 proofServerUrl was documented as unused, so a
 *                                        value left over from that must not start sending witnesses.
 * @param {string} opts.zkConfigBaseUrl   a public /zk-config/<contract>
 * @param {Function} opts.contractClass   compiled contract class (e.g. '@odatano/nightgate/browser/attestation-vault')
 * @param {string} [opts.contractName]    logical name, default 'attestation-vault'
 * @param {string} [opts.privateStateId]  default 'attestationVaultPrivateState'
 * @param {string} [opts.cacheDir]        zk asset cache, default ~/.cache/nightgate-txbuilder/<contractName>
 * @param {string[]} [opts.circuits]      circuits to make available (prover keys + zkir); default: every circuit of contractClass
 * @param {number} [opts.ttlMinutes]      transaction TTL, default 30; the sponsor must submit within it
 * @param {Uint8Array} [opts.attestationSecret] bring your own, else derived from the seed
 * @param {Function} [opts.onProgress]    progress callback
 */
/**
 * `findDeployedContract` with ONE retry on the transient read the public
 * indexer serves between a block landing and being indexed (`expected a cell,
 * received null`, or a null state): building immediately after a previous call
 * landed InBlock hits it. Anything else rethrows at once.
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

/**
 * The contract address a built deploy transaction creates: the `address` of its
 * single ContractDeploy action (an action without `entryPoint`). Throws unless
 * exactly one such action with a non-empty address exists.
 */
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

/**
 * `zkConfigDir` mode: checks keys/ + zkir/ and a verifier key per circuit, fetches
 * nothing, and returns a `ZkAssetResult` (`fetched` 0, `cached` = key files found, `source: 'local'`).
 */
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
    // Verifier keys for EVERY circuit of the contract (a deploy writes them
    // all); prover key + bzkir for the circuits this builder will prove. A
    // gap here is a build that fails at proving time otherwise.
    const missing = circuits.filter(c => !files.includes(`${c}.verifier`));
    if (missing.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks verifier keys for ${missing.join(', ')}`);
    const missingProver = proveCircuits.filter(c => !files.includes(`${c}.prover`));
    if (missingProver.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks prover keys for ${missingProver.join(', ')} (keys/<circuit>.prover)`);
    const missingZkir = proveCircuits.filter(c => !zkirFiles.includes(`${c}.bzkir`));
    if (missingZkir.length > 0) throw new Error(`createTxBuilder: zkConfigDir lacks zkir for ${missingZkir.join(', ')} (zkir/<circuit>.bzkir)`);
    // `cached`: the files this check verified (every circuit's verifier key,
    // prover key + bzkir of the circuits to prove), the same set the remote
    // path would have fetched.
    const cached = circuits.length + proveCircuits.length * 2;
    return { cacheDir: zkConfigDir, fetched: 0, cached, source: 'local' };
}

export async function createTxBuilder(opts) {
    const {
        seedHex, networkId = 'preprod', accountIndex = 0,
        indexerHttpUrl, indexerWsUrl, nodeUrl, zkConfigBaseUrl, contractClass,
        contractName = 'attestation-vault',
        privateStateId = 'attestationVaultPrivateState',
        circuits, ttlMinutes = 30, onProgress
    } = opts ?? {};
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) {
        throw new Error('createTxBuilder: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    }
    if (!indexerHttpUrl || !indexerWsUrl) throw new Error('createTxBuilder: indexerHttpUrl and indexerWsUrl are required');
    if (!nodeUrl) throw new Error('createTxBuilder: nodeUrl is required (the Substrate RPC the wallet SDK talks to)');
    // Proving assets come from a public /zk-config (fetched once, cached) or
    // from a local zkConfigDir holding keys/ and zkir/.
    if (!zkConfigBaseUrl && !opts.zkConfigDir) {
        throw new Error('createTxBuilder: zkConfigBaseUrl is required (a public /zk-config/<contract>), unless zkConfigDir names a local directory with keys/ and zkir/');
    }
    if (typeof contractClass !== 'function') throw new Error('createTxBuilder: contractClass is required (the compiled Contract)');
    // Proving mode is validated HERE, before any asset fetch or SDK import,
    // like the other input checks.
    if (opts.provingMode !== undefined && opts.provingMode !== 'wasm' && opts.provingMode !== 'server') {
        throw new Error(`createTxBuilder: provingMode must be 'wasm' or 'server' (got ${String(opts.provingMode)})`);
    }
    if (opts.provingMode === 'server' && !opts.proofServerUrl) {
        throw new Error("createTxBuilder: provingMode 'server' requires proofServerUrl (a proof server YOU run; it receives the witnesses)");
    }
    const cacheDir = opts.zkConfigDir ?? opts.cacheDir ?? join(homedir(), '.cache', 'nightgate-txbuilder', contractName);

    // 1. Proving assets: fetch once, then offline. The verifier keys must
    //    cover EVERY circuit of the contract (see ensureZkAssets); introspect
    //    the compiled class with a stub witnesses object to get the full list.
    //    With zkConfigDir nothing is fetched, the directory is only checked.
    let allCircuits;
    try {
        const stub = new Proxy({}, { get: () => () => { /* never called */ }, has: () => true });
        allCircuits = Object.keys(new contractClass(stub).impureCircuits ?? {});
    } catch { allCircuits = undefined; }
    onProgress?.({ phase: 'zk-assets' });
    let assets;
    if (opts.zkConfigDir) {
        // Same fallback as the remote path: a class that cannot be introspected
        // and no `circuits` given means the vault's set, never "nothing to
        // check" (empty asset directories would otherwise pass).
        const verifierSet = allCircuits ?? ATTESTATION_VAULT_CIRCUITS;
        const proveSet = circuits ?? allCircuits ?? ATTESTATION_VAULT_CIRCUITS;
        assets = await describeLocalZkAssets(opts.zkConfigDir, verifierSet, proveSet);
    } else {
        assets = await ensureZkAssets({
            zkConfigBaseUrl, cacheDir,
            // Prover keys + zkir: the caller's list, else every circuit of the
            // contract class, else the vault's set.
            circuits: circuits ?? allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            verifierCircuits: allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
            onProgress
        });
    }

    // 2. SDK + identity. Role-specific HD derivation (matching Lace) comes from
    //    the plugin's own helper, so the builder lands on the SAME account the
    //    server would use for this seed.
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

    const { deriveRoleSeeds } = require('../../srv/utils/wallet-hd.js');
    const { deriveAttestationSecret } = await import('../browser/witnesses.mjs');
    const roleSeeds = await deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    const zswapKeys = ledger.ZswapSecretKeys.fromSeed(roleSeeds.zswap);
    const dustKey = ledger.DustSecretKey.fromSeed(roleSeeds.dust);
    const keystore = unshielded.createKeystore(roleSeeds.night, networkId);
    const attestationSecret = opts.attestationSecret ?? deriveAttestationSecret(roleSeeds.zswap);

    // 3. Facade with in-process (wasm) proving: no proof server, no Docker.
    onProgress?.({ phase: 'wallet' });
    const configuration = {
        networkId,
        // The facade wants both URLs even when it never calls the prover: wasm
        // proving replaces provingServerUrl, but the config type still needs it.
        relayURL: new URL(nodeUrl),
        provingServerUrl: new URL(opts.proofServerUrl ?? 'http://127.0.0.1:6300'),
        indexerClientConnection: { indexerHttpUrl, indexerWsUrl },
        txHistoryStorage: new abstractions.InMemoryTransactionHistoryStorage(facadeSdk.WalletEntrySchema, facadeSdk.mergeWalletEntries),
        costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
    };
    const facade = await facadeSdk.WalletFacade.init({
        configuration,
        provingService: () => proving.makeWasmProvingService({}),
        shielded: () => shielded.ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
        unshielded: () => unshielded.UnshieldedWallet(configuration).startWithPublicKey(unshielded.PublicKey.fromKeyStore(keystore)),
        dust: () => dust.DustWallet(configuration).startWithSecretKey(dustKey, ledger.LedgerParameters.initialParameters().dust)
    });
    await facade.start(zswapKeys, dustKey);

    const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
    if (!CompiledContract?.make) throw new Error('compact-js: CompiledContract.make not found');
    const zkConfigProvider = new zkNode.NodeZkConfigProvider(cacheDir);
    // Contract-circuit proving: in-process wasm by default (nothing leaves the
    // process); a holder-owned proof server when configured (it sees the
    // witnesses; native + multi-threaded, several times faster on the 38 MB
    // comparison circuit). The wallet facade's own prover stays wasm either
    // way: a sponsorable build carries no dust or zswap proof of its own.
    let proofProvider;
    const provingMode = opts.provingMode === 'server' ? 'server' : 'wasm';
    if (provingMode === 'server') {
        const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
        proofProvider = httpClientProofProvider(opts.proofServerUrl, zkConfigProvider);
    } else {
        const { buildWasmProofProvider } = require('../../srv/midnight/wasm-proof-provider.js');
        proofProvider = await buildWasmProofProvider(zkConfigProvider);
    }
    const { InMemoryPrivateStateProvider } = await import('../browser/private-state.mjs');
    const rt = require('@midnight-ntwrk/compact-runtime');
    // ONE public-data provider per builder. It owns a WebSocket to the
    // indexer; creating it per buildSponsorable leaked one open socket (plus
    // its subscriptions) per transaction, and a process that built several
    // transactions in a row degraded into a 100 % CPU stall on a later build.
    const publicDataProvider = indexerSdk.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, require('ws'));

    return {
        /** 'wasm' (in-process, default) or 'server' (opts.proofServerUrl). */
        provingMode,
        /** Your attestation secret; feed it to the browser export's prepare* helpers. */
        attestationSecret,
        /** The identity every attestation you build will carry. */
        attesterId: Buffer.from(rt.persistentHash(new rt.CompactTypeBytes(32), attestationSecret)).toString('hex'),
        /** Where the proving assets were cached, and how many were downloaded. */
        zkAssets: assets,
        addresses: { night: unshielded.PublicKey.fromKeyStore(keystore).address },

        /**
         * Build + prove + sign + finalize one transaction WITHOUT submitting:
         * ONE circuit call (`call`) or a BATCH of up to 8 calls (`calls`) in
         * ONE transaction (one balancing round, one fee event; segment order
         * = call order, fail-closed, with the 0.16.3 causality pre-check
         * aborting BEFORE proving). Hand the result to a sponsor endpoint,
         * which pays the dust and submits.
         *
         * Batch witnesses: one witnesses object serves the batch: the `witnesses`
         * input, else the object every entry carries when it is the same one,
         * else (attestation-vault family only) the builder's own, whose proof
         * holder swaps each call's `merkleProof` before the call; anything else
         * is refused up front. Per-call state goes through the entries' `before`
         * hooks; every batched vault call must be prepared with the same secret.
         * A batch containing a value-moving call refuses `bind: false`.
         *
         * @param {{ contractAddress: string, call?: { circuitId: string, args: unknown[], witnesses: object }, calls?: Array<{ circuitId: string, args: unknown[], merkleProof?: object, slotWidth?: number }>, initialPrivateState?: unknown, bind?: boolean, attestationSecret?: Uint8Array }} input
         * @returns {Promise<{ finalizedTxB64: string, serializedBytes: number }>}
         */
        async buildSponsorable({ contractAddress, call, calls, witnesses: sharedWitnesses, initialPrivateState, bind = true, attestationSecret: batchSecret }) {
            if (!contractAddress) throw new Error('buildSponsorable: contractAddress is required');
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
                // A Compact contract instance binds its witnesses once. Shared
                // witnesses source, in order: the `witnesses` input, the same
                // object on every call, the vault family's own (with the proof holder).
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
                    // EVERY call gets a hook: a proof-less call clears the holder
                    // instead of inheriting its predecessor's bundle.
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
                // One merged, segment-ordered, causality-checked transaction.
                // The build-only provider throws at submit; only an EMPTY
                // capture holder means a real build failure. The causality
                // pre-check aborts BEFORE proving; surface it with the same
                // stable code the server uses (the SDK's scope wrapper
                // discards the error NAME, so match the message).
                const { runBatchInScope } = require('../../srv/midnight/batch-call-scope.js');
                try {
                    await runBatchInScope(contracts, providers, found, scopeCalls, contractAddress);
                } catch (e) {
                    if (/violates the ledger's causality constraint/.test(String(e?.message ?? e))) {
                        try { e.code = 'BatchCausalityViolation'; } catch { /* frozen error */ }
                        throw e;
                    }
                    if (!holder.captured) throw e;
                }
            } else {
                const single = callList[0];
                const fn = found?.callTx?.[single.circuitId];
                if (typeof fn !== 'function') {
                    throw new Error("circuit '" + single.circuitId + "' is not on the contract at " + contractAddress);
                }
                // The build-only provider stops at submit; the SDK wraps that error,
                // so only an EMPTY holder means a real build failure.
                try {
                    await fn(...(single.args ?? []));
                } catch (e) {
                    if (!holder.captured) throw e;
                }
            }
            if (!holder.captured?.serialize) throw new Error('build produced no serializable transaction');
            const bytes = new Uint8Array(holder.captured.serialize());
            onProgress?.({ phase: 'built', bytes: bytes.length, bound: bind !== false });
            // finalizedTxB64 kept as the field name for the bound handover
            // (0.17.2 compat); unboundTxB64 is the 0.18 parallel handover.
            return bind === false
                ? { unboundTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: false }
                : { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: true };
        },

        /**
         * 0.21.0: build + prove + sign a contract deploy without submitting; the
         * caller's key signs it, a sponsor pays the dust. Sponsoring needs
         * NIGHTGATE_SPONSOR_ALLOW_DEPLOY on the server and, for a token caller,
         * `allowDeploy` with budget left on the grant. The landed address joins the
         * grant's sponsorable contracts. The initial private state lives in this process only.
         *
         * @param {{ initialPrivateState?: unknown, constructorArgs?: unknown[], witnesses?: object, bind?: boolean }} input
         * @returns {Promise<{ finalizedTxB64?: string, unboundTxB64?: string, serializedBytes: number, bound: boolean, contractAddress: string }>}
         */
        async buildDeploySponsorable({ initialPrivateState, constructorArgs, witnesses, bind = true } = {}) {
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
            // The build-only provider stops at submit and the SDK wraps that
            // error; only an empty holder means a real build failure.
            try {
                await contracts.deployContract(providers, {
                    compiledContract: compiled,
                    privateStateId,
                    initialPrivateState: initialPrivateState ?? {},
                    ...(Array.isArray(constructorArgs) && constructorArgs.length > 0 ? { args: constructorArgs } : {})
                });
            } catch (e) {
                if (!holder.captured) throw e;
            }
            if (!holder.captured?.serialize) throw new Error('deploy build produced no serializable transaction');
            // Read the address off the deploy action, where the sponsor's shape
            // check reads it; anything but exactly one deploy action fails the build.
            const contractAddress = readDeployAddress(holder.captured);
            const bytes = new Uint8Array(holder.captured.serialize());
            onProgress?.({ phase: 'built', bytes: bytes.length, bound: bind !== false, contractAddress });
            return bind === false
                ? { unboundTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: false, contractAddress }
                : { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length, bound: true, contractAddress };
        },

        async close() {
            try { await facade.close?.(); } catch { /* best effort */ }
        }
    };
}
