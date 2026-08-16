// Browser provider assembly for the wallet-connector path.
//
// Assembles the midnight-js provider pieces a consumer needs to build + prove a
// contract call from the browser, wired to NIGHTGATE's /contract-manifest +
// /zk-config routes and a DApp-Connector wallet. The SDK packages are
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
// real Lace + chain. That live-integration step lives in the consumer (NIGHTPASS).

import { FetchZkConfigProvider } from './zk-config.mjs';
import { InMemoryPrivateStateProvider } from './private-state.mjs';

/**
 * @param {object}   opts
 * @param {object}   opts.connector  a connected DApp-Connector wallet (`@midnight-ntwrk/dapp-connector-api` ConnectedAPI)
 * @param {object}   opts.manifest   the parsed `/contract-manifest` JSON
 * @param {string}   opts.contract   contract name, e.g. 'attestation-vault'
 * @param {typeof fetch} [opts.fetchFn]    injectable fetch (defaults to global)
 * @param {any}      [opts.webSocket]      WebSocket impl (defaults to global)
 * @param {'server'|'wallet'|'auto'} [opts.proving='server']  proving modality, see below
 * @returns assembled providers + prefetched wallet keys + the connector
 */
export async function createNightgateConnectorProviders(opts = {}) {
    const { connector, manifest, contract, fetchFn, webSocket, proving = 'server' } = opts;
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
    const { proofProvider, provingModality } = await buildProofProvider({
        proving,
        connector,
        zkConfigProvider,
        proverServerUri: cfg.proverServerUri,
        proofMod
    });
    const privateStateProvider = new InMemoryPrivateStateProvider();

    // Prefetch wallet keys (connector getters are async; midnight-js WalletProvider
    // getters are sync, so a live adapter would close over these).
    const addrs = await connector.getShieldedAddresses();

    return {
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        /**
         * Which proving modality was actually assembled: 'server', 'wallet' or 'none'.
         * Returned deliberately so a consumer can LOG and display it - a silent fall from wallet
         * proving to a remote proof server changes where the transaction preimage goes, and that
         * must never be invisible.
         */
        provingModality,
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

/**
 * Assemble the proof provider for the requested modality.
 *
 *   'server' - midnight-js's httpClientProofProvider against `proverServerUri` (today's default,
 *              and what production uses). Needs a reachable, CORS-clean proof server.
 *   'wallet' - DELEGATE contract proving to the connected wallet's own prover
 *              (`connector.getProvingProvider`). No proof server, no CORS wall, and the
 *              transaction preimage never leaves the user's machine. Fails LOUDLY when the
 *              connector cannot do it: a silent fall back to a remote server would move the
 *              preimage somewhere the caller did not ask for.
 *   'auto'   - wallet when the connector offers it, else server.
 *
 * The wallet path mirrors the server-side twin (`srv/midnight/wasm-proof-provider.ts`): the
 * `{ proveTx }` contract is a thin transport, and `unprovenTx.prove(...)` runs the ledger's own
 * prove loop whose per-circuit callbacks now cross into the wallet. Only the CONTRACT's circuits
 * are answered from `zkConfigProvider`; standard circuits (zswap/dust) and the BLS ceremony
 * parameters are the wallet's own business, so a miss on our side is expected, not an error.
 *
 * Kept as a separate export so it is unit-testable without assembling every other provider.
 */
export async function buildProofProvider({ proving = 'server', connector, zkConfigProvider, proverServerUri, proofMod }) {
    if (proving !== 'server' && proving !== 'wallet' && proving !== 'auto') {
        throw new Error(`createNightgateConnectorProviders: unknown proving modality '${proving}'`);
    }

    const connectorCanProve = typeof connector?.getProvingProvider === 'function';
    if (proving === 'wallet' && !connectorCanProve) {
        throw new Error(
            "createNightgateConnectorProviders: proving:'wallet' was requested but this wallet does not " +
            'implement getProvingProvider(). Use proving:\'auto\' to fall back to a proof server.'
        );
    }

    if (connectorCanProve && (proving === 'wallet' || proving === 'auto')) {
        // Lazy, like every other heavy import here: server-only consumers must not pay for the ledger.
        const ledger = await import('@midnight-ntwrk/ledger-v8');
        const walletProver = await connector.getProvingProvider(zkConfigProvider.asKeyMaterialProvider());
        return {
            provingModality: 'wallet',
            proofProvider: {
                proveTx: (unprovenTx) => unprovenTx.prove(walletProver, ledger.CostModel.initialCostModel())
            }
        };
    }

    if (proverServerUri) {
        return {
            provingModality: 'server',
            proofProvider: proofMod.httpClientProofProvider(proverServerUri, zkConfigProvider)
        };
    }
    // No modality available. Undefined rather than a throw: a consumer may only need the read
    // providers, and the caller that actually proves gets a clear failure from midnight-js instead.
    return { provingModality: 'none', proofProvider: undefined };
}
