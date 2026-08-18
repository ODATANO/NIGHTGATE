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
    return { cacheDir, fetched, cached };
}

/**
 * A wallet provider that balances the caller's own side, signs, finalizes and
 * then STOPS instead of submitting: the fee-unpaid transaction is captured for
 * the sponsor. Throwing from submitTx is deliberate; returning a fake id makes
 * the SDK wait forever for a confirmation that will never come.
 */
function buildOnlyWalletProvider(facade, zswapKeys, dustKey, keystore, holder, ttlMinutes) {
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
 * @param {string} [opts.proofServerUrl] unused in wasm proving; only the config type wants it
 * @param {string} opts.zkConfigBaseUrl   a public /zk-config/<contract>
 * @param {Function} opts.contractClass   compiled contract class (e.g. '@odatano/nightgate/browser/attestation-vault')
 * @param {string} [opts.contractName]    logical name, default 'attestation-vault'
 * @param {string} [opts.privateStateId]  default 'attestationVaultPrivateState'
 * @param {string} [opts.cacheDir]        zk asset cache, default ~/.cache/nightgate-txbuilder/<contractName>
 * @param {string[]} [opts.circuits]      circuits to make available, default the vault's set
 * @param {number} [opts.ttlMinutes]      transaction TTL, default 30; the sponsor must submit within it
 * @param {Uint8Array} [opts.attestationSecret] bring your own, else derived from the seed
 * @param {Function} [opts.onProgress]    progress callback
 */
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
    if (!zkConfigBaseUrl) throw new Error('createTxBuilder: zkConfigBaseUrl is required (a public /zk-config/<contract>)');
    if (typeof contractClass !== 'function') throw new Error('createTxBuilder: contractClass is required (the compiled Contract)');
    const cacheDir = opts.cacheDir ?? join(homedir(), '.cache', 'nightgate-txbuilder', contractName);

    // 1. Proving assets: fetch once, then offline. The verifier keys must
    //    cover EVERY circuit of the contract (see ensureZkAssets); introspect
    //    the compiled class with a stub witnesses object to get the full list.
    let allCircuits;
    try {
        const stub = new Proxy({}, { get: () => () => { /* never called */ }, has: () => true });
        allCircuits = Object.keys(new contractClass(stub).impureCircuits ?? {});
    } catch { allCircuits = undefined; }
    onProgress?.({ phase: 'zk-assets' });
    const assets = await ensureZkAssets({
        zkConfigBaseUrl, cacheDir, circuits,
        verifierCircuits: allCircuits ?? ATTESTATION_VAULT_CIRCUITS,
        onProgress
    });

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
    const { buildWasmProofProvider } = require('../../srv/midnight/wasm-proof-provider.js');
    const proofProvider = await buildWasmProofProvider(zkConfigProvider);
    const { InMemoryPrivateStateProvider } = await import('../browser/private-state.mjs');
    const rt = require('@midnight-ntwrk/compact-runtime');

    return {
        /** Your attestation secret; feed it to the browser export's prepare* helpers. */
        attestationSecret,
        /** The identity every attestation you build will carry. */
        attesterId: Buffer.from(rt.persistentHash(new rt.CompactTypeBytes(32), attestationSecret)).toString('hex'),
        /** Where the proving assets were cached, and how many were downloaded. */
        zkAssets: assets,
        addresses: { night: unshielded.PublicKey.fromKeyStore(keystore).address },

        /**
         * Build + prove + sign + finalize ONE circuit call, WITHOUT submitting.
         * Hand `finalizedTxB64` to a sponsor endpoint, which pays the dust and
         * submits. The attestation carries your attester id, not the sponsor's.
         *
         * @param {{ contractAddress: string, call: { circuitId: string, args: unknown[], witnesses: object }, initialPrivateState?: unknown }} input
         * @returns {Promise<{ finalizedTxB64: string, serializedBytes: number }>}
         */
        async buildSponsorable({ contractAddress, call, initialPrivateState }) {
            if (!contractAddress) throw new Error('buildSponsorable: contractAddress is required');
            if (!call?.circuitId) throw new Error('buildSponsorable: call must come from a prepare* helper');
            onProgress?.({ phase: 'build', circuit: call.circuitId });

            const compiled = CompiledContract.make(contractName, contractClass).pipe(
                CompiledContract.withWitnesses(call.witnesses),
                CompiledContract.withCompiledFileAssets(cacheDir)
            );
            const holder = {};
            const walletProvider = buildOnlyWalletProvider(facade, zswapKeys, dustKey, keystore, holder, ttlMinutes);
            const privateStateProvider = new InMemoryPrivateStateProvider();
            const providers = {
                publicDataProvider: indexerSdk.indexerPublicDataProvider(indexerHttpUrl, indexerWsUrl, require('ws')),
                zkConfigProvider,
                proofProvider,
                privateStateProvider,
                walletProvider,
                midnightProvider: walletProvider
            };
            privateStateProvider.setContractAddress?.(contractAddress);
            const found = await contracts.findDeployedContract(providers, {
                contractAddress,
                compiledContract: compiled,
                privateStateId,
                initialPrivateState: initialPrivateState ?? {}
            });
            const fn = found?.callTx?.[call.circuitId];
            if (typeof fn !== 'function') {
                throw new Error("circuit '" + call.circuitId + "' is not on the contract at " + contractAddress);
            }

            // The build-only provider stops at submit; the SDK wraps that error,
            // so only an EMPTY holder means a real build failure.
            try {
                await fn(...(call.args ?? []));
            } catch (e) {
                if (!holder.captured) throw e;
            }
            if (!holder.captured?.serialize) throw new Error('build produced no serializable finalized transaction');
            const bytes = new Uint8Array(holder.captured.serialize());
            onProgress?.({ phase: 'built', bytes: bytes.length });
            return { finalizedTxB64: Buffer.from(bytes).toString('base64'), serializedBytes: bytes.length };
        },

        async close() {
            try { await facade.close?.(); } catch { /* best effort */ }
        }
    };
}
