import cds from '@sap/cds';
import { deriveIndexerWsUrl } from './indexer-url';
import { DEFAULT_PROOF_TIMEOUT_MS } from './proof-timeout';
import { configBool, configEnum, configInt, configList, configString, setConfigOverrideSource, setConfigWarnSink } from './config';
import { configSpec, parseConfigValue } from './config-table';

// Lets the getters in `./config` also read `cds.requires.nightgate`, and log through cds.
setConfigOverrideSource(() => getNightgatePluginConfig() as Record<string, unknown>);
setConfigWarnSink((message) => cds.log('nightgate:config').warn(message));

export { deriveIndexerWsUrl };

export const VALID_NIGHTGATE_NETWORKS = ['preview', 'testnet', 'preprod', 'mainnet', 'undeployed'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

/** Plugin configuration under `cds.requires.nightgate`. */
export interface NightgatePluginConfig {
    network?: string;
    nodeUrl?: string;
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    proofServerUrl?: string;
    /** Timeout in ms for one proof server request. Default 300000. */
    proofTimeoutMs?: number | string;
    /** Base folder of the proving keys for contracts registered by path. Default `./contracts`. */
    zkConfigBasePath?: string;
    crawlerNodeUrl?: string;
    privateStateBackend?: PrivateStateBackend;
    sessionTtlMs?: number;
    runtimeMode?: 'single-instance';
    /** Number of running instances. Startup fails for any value other than 1. */
    replicaCount?: number;
    /** Allows SQLite in production. Emergency use only. */
    allowProductionSqlite?: boolean;
    palletMap?: Record<string, { name: string; txType: string; isShielded?: boolean; isSystem?: boolean }>;
    crawler?: {
        enabled?: boolean;
        nodeUrl?: string;
        fetchConcurrency?: number;
        rpcBatchSize?: number;
        requestTimeout?: number;
        /** Indexer the crawler reads extra block data from. Defaults to the indexer used for submissions. */
        indexerUrl?: string;
        supplementBlocksPerSecond?: number;
    };
    contracts?: Record<string, {
        /** An installed contract package. The paths come from its contract.json. */
        package?: string;
        artifactPath?: string;
        privateStateId?: string;
        zkConfigPath?: string;
        /** Number of document slots of an attestation vault contract: 8, 16 (default) or 32. Must match the compiled contract. */
        slotWidth?: number;
        /** Deployed address or addresses, published in `GET /contract-manifest`. */
        address?: string | string[];
    }>;
    /** Allows sending transactions on mainnet. Default false. Indexing works either way. */
    allowMainnetSubmission?: boolean;
    /**
     * How a user is turned into the 32-byte grantee id the vault contract uses.
     * 'wallet' (default) uses the coin public key. The issuer of a grant must use the same method.
     */
    granteeBinding?: GranteeBinding;
    /**
     * Lets any user register their own grantee id. Default false.
     * Ownership of the input is not verified, so a caller could take over someone else's on-chain grants.
     */
    allowSelfServiceGranteeRegistration?: boolean;
    closeSessionsOnRestart?: boolean;
    /** Indexer URLs per network, used only when a verify call asks for a network other than the configured one. */
    networks?: Partial<Record<NightgateNetwork, {
        indexerHttpUrl?: string;
        indexerWsUrl?: string;
    }>>;
    [k: string]: unknown;
}

export function getNightgatePluginConfig(): NightgatePluginConfig {
    // `cds.env` is missing when tests mock `cds`.
    const env = (cds as any).env as { requires?: { nightgate?: NightgatePluginConfig } } | undefined;
    return env?.requires?.nightgate ?? {};
}

export const DEFAULT_NETWORK: NightgateNetwork = 'preprod';
export const DEFAULT_NODE_URL = 'wss://rpc.preprod.midnight.network/';

/** Default node URL per network. Networks not listed use DEFAULT_NODE_URL. */
export const DEFAULT_NODE_URLS: Partial<Record<NightgateNetwork, string>> = {
    preview: 'wss://rpc.preview.midnight.network/',
    mainnet: 'wss://rpc.mainnet.midnight.network/',
    undeployed: 'ws://127.0.0.1:9944'
};

export const DEFAULT_INDEXER_URLS: Record<NightgateNetwork, { http: string; ws: string }> = {
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
        http: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.mainnet.midnight.network/api/v4/graphql/ws'
    },
    // An older local indexer that serves only /api/v3 needs the indexer URLs set explicitly.
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

export function getConfiguredPrivateStateBackend(config?: NightgatePluginConfig): PrivateStateBackend {
    const raw = configEnum('NIGHTGATE_PRIVATE_STATE_BACKEND') || config?.privateStateBackend;
    if (raw && (VALID_PRIVATE_STATE_BACKENDS as readonly string[]).includes(raw)) {
        return raw as PrivateStateBackend;
    }
    return DEFAULT_PRIVATE_STATE_BACKEND;
}

export const VALID_GRANTEE_BINDINGS = ['wallet', 'did', 'custom'] as const;
export type GranteeBinding = (typeof VALID_GRANTEE_BINDINGS)[number];
export const DEFAULT_GRANTEE_BINDING: GranteeBinding = 'wallet';

export function getConfiguredGranteeBinding(config?: NightgatePluginConfig): GranteeBinding {
    const raw = configEnum('NIGHTGATE_GRANTEE_BINDING') || config?.granteeBinding;
    if (raw && (VALID_GRANTEE_BINDINGS as readonly string[]).includes(raw)) {
        return raw as GranteeBinding;
    }
    return DEFAULT_GRANTEE_BINDING;
}

export function isSelfServiceGranteeRegistrationAllowed(config?: NightgatePluginConfig): boolean {
    const raw = configBool('NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION');
    if (raw !== undefined) return raw;
    return config?.allowSelfServiceGranteeRegistration === true;
}

/**
 * Whether startup closes the wallet sessions of the previous process. Default on.
 * Otherwise old sessions keep the encrypted seed in the database until they expire.
 */
export function isCloseSessionsOnRestartEnabled(config?: NightgatePluginConfig): boolean {
    const env = configBool('NIGHTGATE_CLOSE_SESSIONS_ON_RESTART');
    if (env !== undefined) return env;
    if (typeof config?.closeSessionsOnRestart === 'boolean') return config.closeSessionsOnRestart;
    return true;
}

export function getConfiguredNightgateNetwork(config?: NightgatePluginConfig): string | undefined {
    // Read raw on purpose, so an invalid value stops startup instead of falling back to a default.
    return process.env.NIGHTGATE_NETWORK?.trim() || config?.network;
}

export function getConfiguredNightgateNodeUrl(config?: NightgatePluginConfig): string | undefined {
    return configString('NIGHTGATE_NODE_URL') || config?.nodeUrl;
}

export function getConfiguredNightgateCrawlerNodeUrl(config?: NightgatePluginConfig): string | undefined {
    return configString('NIGHTGATE_CRAWLER_NODE_URL') || config?.crawler?.nodeUrl;
}

/** Without a network, initialize() does nothing. */
export function isNightgatePluginConfigured(config?: NightgatePluginConfig): boolean {
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

/** NIGHTGATE_PROVING_MODE if set. Otherwise `server` when a proof server URL is configured, else `wasm`. */
export function resolveEffectiveProvingMode(config?: NightgatePluginConfig | null): 'server' | 'wasm' {
    const explicit = configEnum<'server' | 'wasm'>('NIGHTGATE_PROVING_MODE');
    if (explicit) return explicit;
    return (configString('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl) ? 'server' : 'wasm';
}

export function resolveProofTimeoutMs(config?: NightgatePluginConfig | null): number {
    const raw = process.env.NIGHTGATE_PROOF_TIMEOUT_MS?.trim();
    if (raw) {
        const parsed = parseConfigValue(configSpec('NIGHTGATE_PROOF_TIMEOUT_MS'), raw);
        if (!parsed.warning && typeof parsed.value === 'number') return parsed.value;
        cds.log('nightgate:config').warn(parsed.warning ?? `NIGHTGATE_PROOF_TIMEOUT_MS: '${raw}' ignored`);
    }
    const cfg = Number(config?.proofTimeoutMs);
    if (Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg);
    return DEFAULT_PROOF_TIMEOUT_MS;
}

export function resolveSubmissionEndpoints(
    network: NightgateNetwork,
    config?: NightgatePluginConfig
): SubmissionEndpointsConfig {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const httpOverride = configString('NIGHTGATE_INDEXER_HTTP_URL') || config?.indexerHttpUrl;
    const wsOverride = configString('NIGHTGATE_INDEXER_WS_URL') || config?.indexerWsUrl;
    return {
        indexerHttpUrl: httpOverride || defaults.http,
        indexerWsUrl: wsOverride || (httpOverride ? deriveIndexerWsUrl(httpOverride) : defaults.ws),
        proofServerUrl: configString('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl || DEFAULT_PROOF_SERVER_URL,
        zkConfigBasePath: process.env.NIGHTGATE_ZK_CONFIG_BASE?.trim() || config?.zkConfigBasePath || DEFAULT_ZK_CONFIG_BASE
    };
}

/**
 * Indexer URLs for a verify call on another network.
 * The top-level indexer settings are ignored here, because they belong to the configured network.
 */
export function resolveOverrideIndexerEndpoints(
    network: NightgateNetwork,
    config?: NightgatePluginConfig
): { indexerHttpUrl: string; indexerWsUrl: string } {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const perNetwork = config?.networks?.[network] ?? {};
    const http = perNetwork.indexerHttpUrl;
    return {
        indexerHttpUrl: http || defaults.http,
        indexerWsUrl: perNetwork.indexerWsUrl || (http ? deriveIndexerWsUrl(http) : defaults.ws)
    };
}

/** Warns when the no longer supported `crawlerlessChainConfirm` option is set. */
export function warnIfCrawlerlessChainConfirmSet(config?: NightgatePluginConfig, warn: (msg: string) => void = (m) => cds.log('nightgate:config').warn(m)): boolean {
    const envRaw = process.env.NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM;
    const set = (typeof envRaw === 'string' && envRaw.trim() !== '') || config?.crawlerlessChainConfirm !== undefined;
    if (set) warn('crawlerlessChainConfirm / NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM is no longer an option: the indexer confirmer is the only chain-evidence path and always runs; remove the setting');
    return set;
}

export function resolveNightgateRuntimeConfig(config: NightgatePluginConfig = {}): {
    network: NightgateNetwork;
    nodeUrl: string;
    crawlerConfig: Record<string, unknown>;
    crawlerNodeUrl: string;
    submissionEndpoints: SubmissionEndpointsConfig;
    invalidNetwork?: string;
} {
    const rawCrawlerConfig = config.crawler || {};
    const fetchConcurrencyEnv = configInt('NIGHTGATE_FETCH_CONCURRENCY');
    const rpcBatchSizeEnv = configInt('NIGHTGATE_RPC_BATCH_SIZE');
    const startHeightEnv = configInt('NIGHTGATE_CRAWLER_START_HEIGHT');
    const maxBlocksPerSecondEnv = configInt('NIGHTGATE_CRAWLER_MAX_BPS');
    const crawlerEnabledOverride = configBool('NIGHTGATE_CRAWLER_ENABLED');
    const decodePayloadsEnv = configBool('NIGHTGATE_CRAWLER_DECODE_PAYLOADS');
    const indexerSupplementEnv = configBool('NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT');
    const supplementBlocksPerSecondEnv = configInt('NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS');
    const contractStateHistoryEnv = configEnum<string>('NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY');
    const contractStateWatchEnv = configList('NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH');
    const crawlerConfig: Record<string, unknown> = {
        ...rawCrawlerConfig,
        ...(fetchConcurrencyEnv != null && { fetchConcurrency: fetchConcurrencyEnv }),
        ...(rpcBatchSizeEnv != null && { rpcBatchSize: rpcBatchSizeEnv }),
        ...(startHeightEnv != null && { startHeight: startHeightEnv }),
        ...(maxBlocksPerSecondEnv != null && { maxBlocksPerSecond: maxBlocksPerSecondEnv }),
        ...(decodePayloadsEnv != null && { decodePayloads: decodePayloadsEnv }),
        ...(indexerSupplementEnv != null && { indexerSupplement: indexerSupplementEnv }),
        ...(supplementBlocksPerSecondEnv != null && { supplementBlocksPerSecond: supplementBlocksPerSecondEnv }),
        ...(contractStateHistoryEnv != null && { contractStateHistory: contractStateHistoryEnv }),
        ...(contractStateWatchEnv.length > 0 && { contractStateWatch: contractStateWatchEnv }),
        ...(crawlerEnabledOverride != null && { enabled: crawlerEnabledOverride })
    };
    const configuredNetwork = getConfiguredNightgateNetwork(config);
    const { network, invalidNetwork } = normalizeNightgateNetwork(configuredNetwork);
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || DEFAULT_NODE_URLS[network] || DEFAULT_NODE_URL;
    const crawlerNodeUrl = getConfiguredNightgateCrawlerNodeUrl(config) || nodeUrl;
    const submissionEndpoints = resolveSubmissionEndpoints(network, config);
    // A separate private indexer for the crawler is useful because the public one
    // blocks the host's IP when it gets too many requests, which also breaks transaction sending.
    crawlerConfig.indexerUrl = configString('NIGHTGATE_CRAWLER_INDEXER_URL')
        || crawlerConfig.indexerUrl || submissionEndpoints.indexerHttpUrl;

    return {
        network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl,
        submissionEndpoints,
        invalidNetwork
    };
}

export function mainnetSubmissionBlockReason(config: NightgatePluginConfig): string | null {
    const { network } = resolveNightgateRuntimeConfig(config);
    if (network === 'mainnet' && config.allowMainnetSubmission !== true) {
        return 'Mainnet submission is disabled. Set cds.requires.nightgate.allowMainnetSubmission=true ' +
            'to enable it. Mainnet has known submission instability (1016 Immediately Dropped, ' +
            'forum thread 1190); read-only indexing is unaffected.';
    }
    return null;
}
