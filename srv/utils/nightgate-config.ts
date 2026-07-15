import cds from '@sap/cds';
import { deriveIndexerWsUrl } from './indexer-url';

export { deriveIndexerWsUrl };

export const VALID_NIGHTGATE_NETWORKS = ['preview', 'testnet', 'preprod', 'mainnet', 'undeployed'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

/**
 * Plugin configuration consumed under `cds.requires.nightgate`. CAP injects
 * this object via package.json / .cdsrc / env-var merging. Fields are
 * intentionally optional; defaults come from this module's DEFAULT_* values.
 */
export interface NightgatePluginConfig {
    network?: string;
    nodeUrl?: string;
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    proofServerUrl?: string;
    crawlerNodeUrl?: string;
    privateStateBackend?: PrivateStateBackend;
    sessionTtlMs?: number;
    corsOrigin?: string | string[];
    contentSecurityPolicy?: string | false | 'off';
    palletMap?: Record<string, { name: string; txType: string; isShielded?: boolean; isSystem?: boolean }>;
    crawler?: {
        enabled?: boolean;
        nodeUrl?: string;
        fetchConcurrency?: number;
        rpcBatchSize?: number;
        requestTimeout?: number;
    };
    contracts?: Record<string, {
        artifactPath: string;
        privateStateId: string;
        zkConfigPath: string;
        /**
         * Optional canonical deployed address(es) for this contract, advertised
         * in `GET /contract-manifest` so connector consumers can self-configure.
         * NIGHTGATE does not require it; the deployed address is otherwise
         * per-deployment and caller-supplied. Accept a single string or a list.
         */
        address?: string | string[];
    }>;
    /**
     * Safety gate for mainnet. Default false: submission actions reject when
     * `network === 'mainnet'` unless this is explicitly true. Mainnet has known
     * submission instability (`1016 Immediately Dropped`, forum thread 1190), so
     * the gate is opt-in. Read-only indexing is unaffected.
     */
    allowMainnetSubmission?: boolean;
    /**
     * How an authenticated principal maps to the AttestationVault circuit's
     * `Bytes<32>` grantee id used to match on-chain disclosure grants at read
     * time. Default 'wallet'.
     *   - 'wallet': granteeId derived from the principal's coin public key.
     *   - 'did':    granteeId derived from a registered DID string.
     *   - 'custom': granteeId is an opaque 64-hex the consumer registers.
     * The SAME derivation must be used by whoever issues the grant; see
     * srv/submission/grantee-identity.ts.
     */
    granteeBinding?: GranteeBinding;
    /**
     * Whether `registerGranteeIdentity` may be called by any authenticated
     * principal to bind their own granteeId. Default FALSE, the secure
     * choice: NIGHTGATE does NOT verify ownership of the binding input (wallet
     * pubkey / DID), so a caller could register someone else's key and inherit
     * their on-chain grants. Enable ONLY in deployments that do not gate reads
     * on on-chain grants, or that add their own ownership proof; otherwise
     * register identities through the operator's proofing flow (direct writes
     * to `GranteeIdentities`).
     */
    allowSelfServiceGranteeRegistration?: boolean;
    /**
     * Per-network indexer endpoint overrides for the crawler-free state-verify
     * surface's optional `network` parameter.
     * Only consulted when a verify call overrides to a network OTHER than the
     * configured one; the configured network keeps using the top-level
     * `indexerHttpUrl`/`indexerWsUrl` + env vars. Networks not listed here fall
     * back to the built-in public defaults (`DEFAULT_INDEXER_URLS`).
     */
    networks?: Partial<Record<NightgateNetwork, {
        indexerHttpUrl?: string;
        indexerWsUrl?: string;
    }>>;
    // CAP permits additional plugin-specific keys we don't model here.
    [k: string]: unknown;
}

/**
 * Single-cast accessor for the plugin's CAP config block.
 *
 * `cds.env` is typed as a freeform object by CAP (it merges package.json,
 * .cdsrc, and env vars at runtime, so the shape is genuinely dynamic).
 * Rather than scattering `(cds.env as any).requires?.nightgate` across every
 * callsite, the cast lives ONCE here and every other site reads a properly
 * typed `NightgatePluginConfig` via this function.
 */
export function getNightgatePluginConfig(): NightgatePluginConfig {
    const env = cds.env as { requires?: { nightgate?: NightgatePluginConfig } };
    return env.requires?.nightgate ?? {};
}

export const DEFAULT_NETWORK: NightgateNetwork = 'preprod';
export const DEFAULT_NODE_URL = 'wss://rpc.preprod.midnight.network/';

/**
 * Per-network default Substrate node RPC URL (the crawler WS endpoint, also
 * passed to the SDK as `relayURL`). `undeployed` is the local standalone stack
 * from `midnightntwrk/midnight-local-dev` (`standalone.yml`), where the node
 * listens on :9944. Falls back to DEFAULT_NODE_URL (preprod) for any network
 * not listed. Overridable via NIGHTGATE_NODE_URL / config.nodeUrl.
 */
export const DEFAULT_NODE_URLS: Partial<Record<NightgateNetwork, string>> = {
    preview: 'wss://rpc.preview.midnight.network/',
    undeployed: 'ws://127.0.0.1:9944'
};

export const DEFAULT_INDEXER_URLS: Record<NightgateNetwork, { http: string; ws: string }> = {
    // Preview is the active public dev chain. Public hosted indexer with
    // permissive CORS. This is the network the browser wallet path targets
    // by default.
    preview: {
        http: 'https://indexer.preview.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws'
    },
    preprod: {
        http: 'https://indexer.preprod.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws'
    },
    testnet: {
        http: 'http://localhost:8088/api/v4/graphql',
        ws: 'ws://localhost:8088/api/v4/graphql/ws'
    },
    mainnet: {
        http: 'https://indexer.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.midnight.network/api/v4/graphql/ws'
    },
    // Local standalone network (`networkId: undeployed`). Mirrors the existing
    // `testnet` localhost convention (:8088). Verified against a live
    // `indexer-standalone:4.3.2`: it serves BOTH `/api/v3/graphql` and
    // `/api/v4/graphql` (HTTP 200), so v4 here is correct. Older images may
    // differ; override via NIGHTGATE_INDEXER_HTTP_URL / NIGHTGATE_INDEXER_WS_URL
    // if your pinned indexer only exposes v3.
    undeployed: {
        http: 'http://127.0.0.1:8088/api/v4/graphql',
        ws: 'ws://127.0.0.1:8088/api/v4/graphql/ws'
    }
};

export const DEFAULT_PROOF_SERVER_URL = 'http://localhost:6300';
export const DEFAULT_ZK_CONFIG_BASE = './contracts';

export const VALID_PRIVATE_STATE_BACKENDS = ['cap-db', 'level'] as const;
export type PrivateStateBackend = (typeof VALID_PRIVATE_STATE_BACKENDS)[number];
export const DEFAULT_PRIVATE_STATE_BACKEND: PrivateStateBackend = 'cap-db';

export function getConfiguredPrivateStateBackend(config?: Record<string, any>): PrivateStateBackend {
    const raw = readEnv('NIGHTGATE_PRIVATE_STATE_BACKEND') || config?.privateStateBackend;
    if (raw && (VALID_PRIVATE_STATE_BACKENDS as readonly string[]).includes(raw)) {
        return raw as PrivateStateBackend;
    }
    return DEFAULT_PRIVATE_STATE_BACKEND;
}

export const VALID_GRANTEE_BINDINGS = ['wallet', 'did', 'custom'] as const;
export type GranteeBinding = (typeof VALID_GRANTEE_BINDINGS)[number];
export const DEFAULT_GRANTEE_BINDING: GranteeBinding = 'wallet';

export function getConfiguredGranteeBinding(config?: Record<string, any>): GranteeBinding {
    const raw = readEnv('NIGHTGATE_GRANTEE_BINDING') || config?.granteeBinding;
    if (raw && (VALID_GRANTEE_BINDINGS as readonly string[]).includes(raw)) {
        return raw as GranteeBinding;
    }
    return DEFAULT_GRANTEE_BINDING;
}

export function isSelfServiceGranteeRegistrationAllowed(config?: Record<string, any>): boolean {
    const raw = readEnv('NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION');
    if (raw != null) return !/^(false|0|no|off)$/i.test(raw);
    // Secure default: OFF. NIGHTGATE cannot verify ownership of
    // the binding input, so a caller could register another principal's key and
    // inherit their on-chain grants. Deployments that want self-service must
    // opt in explicitly (config flag or NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION).
    return config?.allowSelfServiceGranteeRegistration === true;
}

function readEnv(key: string): string | undefined {
    return process.env[key]?.trim() || undefined;
}

function parseIntEnv(key: string): number | undefined {
    const raw = readEnv(key);
    if (raw == null) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function getConfiguredNightgateNetwork(config?: Record<string, any>): string | undefined {
    return readEnv('NIGHTGATE_NETWORK') || config?.network;
}

export function getConfiguredNightgateNodeUrl(config?: Record<string, any>): string | undefined {
    return readEnv('NIGHTGATE_NODE_URL') || config?.nodeUrl;
}

export function getConfiguredNightgateCrawlerNodeUrl(config?: Record<string, any>): string | undefined {
    return readEnv('NIGHTGATE_CRAWLER_NODE_URL') || config?.crawler?.nodeUrl;
}

/**
 * The plugin counts as configured iff a network is selected (config or
 * NIGHTGATE_NETWORK); without one, initialize() stays idle so we never
 * auto-crawl a chain nobody chose. The legacy `kind: 'nightgate'` marker some
 * consumer configs carry is inert and simply ignored (it never enabled
 * anything: the old check reduced to exactly this predicate).
 */
export function isNightgatePluginConfigured(config?: Record<string, any>): boolean {
    return Boolean(config && getConfiguredNightgateNetwork(config));
}

export function normalizeNightgateNetwork(network?: string): {
    network: NightgateNetwork;
    invalidNetwork?: string;
} {
    if (network && VALID_NIGHTGATE_NETWORKS.includes(network as NightgateNetwork)) {
        return { network: network as NightgateNetwork };
    }

    if (network) {
        return {
            network: DEFAULT_NETWORK,
            invalidNetwork: network
        };
    }

    return { network: DEFAULT_NETWORK };
}

export interface SubmissionEndpointsConfig {
    indexerHttpUrl: string;
    indexerWsUrl: string;
    proofServerUrl: string;
    zkConfigBasePath: string;
}

export function resolveSubmissionEndpoints(
    network: NightgateNetwork,
    config?: Record<string, any>
): SubmissionEndpointsConfig {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const httpOverride = readEnv('NIGHTGATE_INDEXER_HTTP_URL') || config?.indexerHttpUrl;
    const wsOverride = readEnv('NIGHTGATE_INDEXER_WS_URL') || config?.indexerWsUrl;
    return {
        indexerHttpUrl: httpOverride || defaults.http,
        indexerWsUrl: wsOverride || (httpOverride ? deriveIndexerWsUrl(httpOverride) : defaults.ws),
        proofServerUrl: readEnv('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl || DEFAULT_PROOF_SERVER_URL,
        zkConfigBasePath: readEnv('NIGHTGATE_ZK_CONFIG_BASE') || config?.zkConfigBasePath || DEFAULT_ZK_CONFIG_BASE
    };
}

/**
 * Indexer endpoints for a state-verify `network` override that differs from the
 * configured network. Pure per-network
 * resolution: `config.networks[<network>]` wins over the built-in public
 * defaults. Top-level config and `NIGHTGATE_INDEXER_*` env vars deliberately do
 * NOT apply here: they describe the CONFIGURED network only, and applying them
 * to an override would silently point a preprod verify at a preview indexer.
 */
export function resolveOverrideIndexerEndpoints(
    network: NightgateNetwork,
    config?: Record<string, any>
): { indexerHttpUrl: string; indexerWsUrl: string } {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const perNetwork = config?.networks?.[network] ?? {};
    const http = perNetwork.indexerHttpUrl;
    return {
        indexerHttpUrl: http || defaults.http,
        indexerWsUrl: perNetwork.indexerWsUrl || (http ? deriveIndexerWsUrl(http) : defaults.ws)
    };
}

export function resolveNightgateRuntimeConfig(config: Record<string, any> = {}): {
    network: NightgateNetwork;
    nodeUrl: string;
    crawlerConfig: Record<string, unknown>;
    crawlerNodeUrl: string;
    submissionEndpoints: SubmissionEndpointsConfig;
    invalidNetwork?: string;
} {
    const rawCrawlerConfig = config.crawler || {};
    // env-var overrides for crawler tuning. Numeric vars are parsed; anything
    // unparseable falls back to the config value (or built-in default).
    const fetchConcurrencyEnv = parseIntEnv('NIGHTGATE_FETCH_CONCURRENCY');
    const rpcBatchSizeEnv = parseIntEnv('NIGHTGATE_RPC_BATCH_SIZE');
    // NIGHTGATE_CRAWLER_ENABLED=false disables the crawler at boot. Useful for
    // running submission tests in isolation so the wallet sync isn't competing
    // with block ingestion for CPU/RAM on the same event loop.
    const crawlerEnabledEnv = readEnv('NIGHTGATE_CRAWLER_ENABLED');
    const crawlerEnabledOverride = crawlerEnabledEnv == null
        ? undefined
        : !/^(false|0|no|off)$/i.test(crawlerEnabledEnv);
    const crawlerConfig: Record<string, unknown> = {
        ...rawCrawlerConfig,
        ...(fetchConcurrencyEnv != null && { fetchConcurrency: fetchConcurrencyEnv }),
        ...(rpcBatchSizeEnv != null && { rpcBatchSize: rpcBatchSizeEnv }),
        ...(crawlerEnabledOverride != null && { enabled: crawlerEnabledOverride })
    };
    const configuredNetwork = getConfiguredNightgateNetwork(config);
    const { network, invalidNetwork } = normalizeNightgateNetwork(configuredNetwork);
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || DEFAULT_NODE_URLS[network] || DEFAULT_NODE_URL;
    const crawlerNodeUrl = getConfiguredNightgateCrawlerNodeUrl(config) || nodeUrl;
    const submissionEndpoints = resolveSubmissionEndpoints(network, config);

    return {
        network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl,
        submissionEndpoints,
        invalidNetwork
    };
}

/**
 * Mainnet submission safety gate. Returns a human-readable rejection reason when
 * the resolved network is `mainnet` and `allowMainnetSubmission` is not explicitly
 * true; otherwise null (submission allowed). Used by every on-chain submission
 * action handler to fail fast before building/submitting a transaction.
 */
export function mainnetSubmissionBlockReason(config: NightgatePluginConfig): string | null {
    const { network } = resolveNightgateRuntimeConfig(config);
    if (network === 'mainnet' && config.allowMainnetSubmission !== true) {
        return 'Mainnet submission is disabled. Set cds.requires.nightgate.allowMainnetSubmission=true ' +
            'to enable it. Mainnet has known submission instability (1016 Immediately Dropped, ' +
            'forum thread 1190); read-only indexing is unaffected.';
    }
    return null;
}