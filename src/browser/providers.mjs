// Browser provider assembly for the wallet-connector path (Phase 4).
//
// Assembles the midnight-js provider pieces a consumer needs to build + prove a
// contract call from the browser, wired to NIGHTGATE's /contract-manifest +
// /zk-config (Phases 2-3) and a DApp-Connector wallet. The SDK packages are
// imported LAZILY so importing `@odatano/nightgate/browser` stays light.
//
// SCOPE / HONESTY: the four providers below (publicData, zkConfig, proof,
// privateState) plus the prefetched wallet keys are assembled here and the
// zk-config piece is byte-verified against the live route. The FINAL balance +
// submit round-trip is deliberately NOT fabricated: the v4 connector works in
// serialized tx strings (balanceUnsealedTransaction/submitTransaction) while
// midnight-js's WalletProvider works in typed ledger objects, and the correct
// architecture (midnight-js-native WalletProvider adapter vs connector-native
// build→prove→serialize→balance→submit) must be chosen and VERIFIED against a
// real Lace + chain. That lives in the consumer (NIGHTPASS) / Phase 5. See
// docs/feature-requests/wallet-connector-integration-plan.md Phase 4.

import { FetchZkConfigProvider } from './zk-config.mjs';
import { InMemoryPrivateStateProvider } from './private-state.mjs';

/**
 * @param {object}   opts
 * @param {object}   opts.connector  a connected DApp-Connector wallet (`@midnight-ntwrk/dapp-connector-api` ConnectedAPI)
 * @param {object}   opts.manifest   the parsed `/contract-manifest` JSON
 * @param {string}   opts.contract   contract name, e.g. 'attestation-vault'
 * @param {typeof fetch} [opts.fetchFn]    injectable fetch (defaults to global)
 * @param {any}      [opts.webSocket]      WebSocket impl (defaults to global)
 * @returns assembled providers + prefetched wallet keys + the connector
 */
export async function createNightgateConnectorProviders(opts = {}) {
    const { connector, manifest, contract, fetchFn, webSocket } = opts;
    if (!connector) throw new Error('createNightgateConnectorProviders: connector is required');
    if (!contract) throw new Error('createNightgateConnectorProviders: contract is required');

    const entry = (manifest && manifest.contracts || []).find(c => c.name === contract);
    if (!entry) throw new Error(`createNightgateConnectorProviders: contract '${contract}' not in manifest`);

    const cfg = await connector.getConfiguration(); // { indexerUri, indexerWsUri, substrateNodeUri, networkId, proverServerUri? }
    const WS = webSocket || (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WS) throw new Error('createNightgateConnectorProviders: no WebSocket available; pass opts.webSocket');

    // Lazy-load the heavier SDK provider factories (keeps the barrel import light).
    const [indexerMod, proofMod] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider')
    ]);

    const zkConfigProvider = new FetchZkConfigProvider(entry.zkConfigBaseUrl, fetchFn);
    const publicDataProvider = indexerMod.indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri, WS);
    // Self-prove modality: needs a reachable proof server URI. The wallet-delegated
    // modality instead uses connector.getProvingProvider(zkConfigProvider.asKeyMaterialProvider()).
    const proofProvider = cfg.proverServerUri
        ? proofMod.httpClientProofProvider(cfg.proverServerUri, zkConfigProvider)
        : undefined;
    const privateStateProvider = new InMemoryPrivateStateProvider();

    // Prefetch wallet keys (connector getters are async; midnight-js WalletProvider
    // getters are sync, so a live adapter would close over these).
    const addrs = await connector.getShieldedAddresses();

    return {
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        privateStateProvider,
        connector,
        config: cfg,
        walletKeys: {
            coinPublicKey: addrs && addrs.shieldedCoinPublicKey,
            encryptionPublicKey: addrs && addrs.shieldedEncryptionPublicKey,
            shieldedAddress: addrs && addrs.shieldedAddress
        },
        zkConfigBaseUrl: entry.zkConfigBaseUrl,
        /**
         * Convenience: the KeyMaterialProvider for connector-delegated proving:
         *   const pp = await connector.getProvingProvider(providers.keyMaterialProvider());
         */
        keyMaterialProvider: () => zkConfigProvider.asKeyMaterialProvider()
    };
}
