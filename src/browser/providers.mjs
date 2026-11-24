// Sets up the midnight-js providers a browser app needs to build and prove a contract call.
// The indexer, proof and wallet proving packages load only when used.
// Paying the fee and submitting the transaction are left to the app.

import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { InMemoryPrivateStateProvider } from './private-state.mjs';

/** Turns a manifest URL into an absolute URL. The server sends relative URLs unless a public base URL is configured. */
export function resolveManifestUrl(url, manifestUrl) {
    const raw = String(url ?? '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
    if (manifestUrl) return new URL(raw, manifestUrl).toString();
    if (typeof location !== 'undefined' && location.origin) return new URL(raw, location.origin).toString();
    throw new Error(`createNightgateConnectorProviders: manifest URL '${raw}' is relative; pass opts.manifestUrl (the URL the manifest was fetched from)`);
}

/** Builds the providers for one contract from a connected wallet and the parsed `/contract-manifest`.
 *  Pass `manifestUrl` when the manifest has relative URLs and the app runs on another origin. */
export async function createNightgateConnectorProviders(opts = {}) {
    const { connector, manifest, manifestUrl, contractName, fetchFn, webSocket, proving = 'server', proofServerUrl, expectedManifestHash } = opts;
    if (!connector) throw new Error('createNightgateConnectorProviders: connector is required');
    if (!contractName) throw new Error('createNightgateConnectorProviders: contractName is required');

    const found = (manifest && manifest.contracts || []).find(c => c.name === contractName);
    if (!found) throw new Error(`createNightgateConnectorProviders: contract '${contractName}' not in manifest`);
    const entry = { ...found, zkConfigBaseUrl: resolveManifestUrl(found.zkConfigBaseUrl, manifestUrl) };

    const cfg = await connector.getConfiguration(); // { indexerUri, indexerWsUri, substrateNodeUri, networkId, proverServerUri? }
    const WS = webSocket || (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!WS) throw new Error('createNightgateConnectorProviders: no WebSocket available; pass opts.webSocket');

    // Loaded only here, so importing the package stays cheap.
    const [indexerMod, proofMod] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider')
    ]);

    const zkConfigProvider = new FetchZkConfigProvider(entry.zkConfigBaseUrl, {
        ...(fetchFn ? { fetchFunc: fetchFn } : {}),
        ...(expectedManifestHash ? { expectedManifestHash } : {})
    });
    const publicDataProvider = indexerMod.indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri, WS);
    const { proofProvider, provingModality } = await buildProofProvider({
        proving,
        connector,
        zkConfigProvider,
        proofServerUrl: proofServerUrl ?? cfg.proverServerUri,
        proofMod
    });
    const privateStateProvider = new InMemoryPrivateStateProvider();

    // Read the wallet keys now. The wallet returns them asynchronously, but midnight-js reads them synchronously.
    const addrs = await connector.getShieldedAddresses();

    return {
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        /** Where proofs are made: 'server', 'wallet' or 'none'. With 'server' the private inputs go to the proof server. */
        provingModality,
        privateStateProvider,
        connector,
        config: cfg,
        walletKeys: {
            coinPublicKey: addrs && addrs.shieldedCoinPublicKey,
            encryptionPublicKey: addrs && addrs.shieldedEncryptionPublicKey,
            shieldedAddress: addrs && addrs.shieldedAddress
        },
        zkConfigBaseUrl: entry.zkConfigBaseUrl
    };
}

/** Creates the proof provider. 'auto' uses the wallet when it can prove, else the proof server.
 *  'wallet' throws when the wallet cannot prove, so private inputs never reach a server unasked. */
export async function buildProofProvider({ proving = 'server', connector, zkConfigProvider, proofServerUrl, proofMod }) {
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
        // Loaded only here: proving on a server needs neither package.
        const [{ dappConnectorProofProvider }, { CostModel }] = await Promise.all([
            import('@midnight-ntwrk/midnight-js-dapp-connector-proof-provider'),
            import('@midnight-ntwrk/midnight-js-protocol/v9')
        ]);
        try {
            const proofProvider = await dappConnectorProofProvider(connector, zkConfigProvider, CostModel.initialCostModel());
            return { provingModality: 'wallet', proofProvider };
        } catch (err) {
            // A wallet can have the method and still refuse. 'auto' then goes on to the proof server, 'wallet' fails.
            if (proving === 'wallet') throw err;
        }
    }

    if (proofServerUrl) {
        return {
            provingModality: 'server',
            proofProvider: proofMod.httpClientProofProvider(proofServerUrl, zkConfigProvider)
        };
    }
    // No way to prove. This does not throw, because an app may only need to read.
    // A later attempt to prove fails with an error from midnight-js.
    return { provingModality: 'none', proofProvider: undefined };
}
