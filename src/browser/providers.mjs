// Sets up the midnight-js providers a browser app needs to build and prove a contract call.
// They use the server's /contract-manifest and /zk-config routes and a connected Midnight wallet.
// The SDK packages load only when used, so importing `@odatano/nightgate/browser` stays cheap.
//
// Paying the fee and submitting the transaction are left to the app.
// The wallet API passes transactions as strings, while midnight-js expects ledger objects,
// and how to connect the two depends on the app.

import { FetchZkConfigProvider } from './zk-config.mjs';
import { InMemoryPrivateStateProvider } from './private-state.mjs';

/**
 * Turns a manifest URL into an absolute URL.
 * The server sends relative URLs unless a public base URL is configured.
 * An app on another origin must therefore resolve them against the manifest's own URL.
 */
export function resolveManifestUrl(url, manifestUrl) {
    const raw = String(url ?? '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    if (manifestUrl) return new URL(raw, manifestUrl).toString();
    if (typeof location !== 'undefined' && location.origin) return new URL(raw, location.origin).toString();
    throw new Error(`createNightgateConnectorProviders: manifest URL '${raw}' is relative; pass opts.manifestUrl (the URL the manifest was fetched from)`);
}

/**
 * @param {object}   opts
 * @param {object}   opts.connector  A connected wallet, the ConnectedAPI of `@midnight-ntwrk/dapp-connector-api`.
 * @param {object}   opts.manifest   The parsed `/contract-manifest` JSON.
 * @param {string}   [opts.manifestUrl]  The URL the manifest was loaded from. Needed when the manifest
 *                                       has relative URLs and the app runs on another origin.
 * @param {string}   opts.contract   Contract name, for example 'attestation-vault'.
 * @param {typeof fetch} [opts.fetchFn]    Defaults to the global fetch.
 * @param {any}      [opts.webSocket]      Defaults to the global WebSocket.
 * @param {'server'|'wallet'|'auto'} [opts.proving='server']  Where proofs are made. See buildProofProvider.
 * @returns The providers, the wallet's public keys and the connector.
 */
export async function createNightgateConnectorProviders(opts = {}) {
    const { connector, manifest, manifestUrl, contract, fetchFn, webSocket, proving = 'server' } = opts;
    if (!connector) throw new Error('createNightgateConnectorProviders: connector is required');
    if (!contract) throw new Error('createNightgateConnectorProviders: contract is required');

    const found = (manifest && manifest.contracts || []).find(c => c.name === contract);
    if (!found) throw new Error(`createNightgateConnectorProviders: contract '${contract}' not in manifest`);
    const entry = { ...found, zkConfigBaseUrl: resolveManifestUrl(found.zkConfigBaseUrl, manifestUrl) };

    const cfg = await connector.getConfiguration(); // { indexerUri, indexerWsUri, substrateNodeUri, networkId, proverServerUri? }
    const WS = webSocket || (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WS) throw new Error('createNightgateConnectorProviders: no WebSocket available; pass opts.webSocket');

    // Loaded only here, so importing the package stays cheap.
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

    // Read the wallet keys now. The wallet returns them asynchronously, but midnight-js reads them synchronously.
    const addrs = await connector.getShieldedAddresses();

    return {
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        /**
         * Where proofs are actually made: 'server', 'wallet' or 'none'.
         * Log or show it. With 'server', the private inputs of the transaction are sent to the proof server.
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
         * The key source for proving in the wallet:
         *   const pp = await connector.getProvingProvider(providers.keyMaterialProvider());
         */
        keyMaterialProvider: () => zkConfigProvider.asKeyMaterialProvider()
    };
}

/**
 * Creates the proof provider for the chosen proving mode.
 *
 *   'server' - sends proofs to the proof server at `proverServerUri`. This is the default.
 *              The proof server must be reachable from the browser.
 *   'wallet' - lets the connected wallet make the proofs. No proof server is needed, and the
 *              private inputs stay on the user's machine. Throws if the wallet cannot prove,
 *              so the private inputs never go to a server without the caller asking for it.
 *   'auto'   - uses the wallet if it can prove, else the server.
 *
 * In wallet mode, `zkConfigProvider` only has the keys of this contract.
 * The wallet brings the keys for the standard Midnight circuits itself.
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
        // Loaded only here, so apps that prove on a server do not load the ledger.
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
    // No way to prove. This does not throw, because an app may only need to read.
    // A later attempt to prove fails with an error from midnight-js.
    return { provingModality: 'none', proofProvider: undefined };
}
