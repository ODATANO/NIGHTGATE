import cds from '@sap/cds';
import { deriveIndexerWsUrl } from './indexer-url';
import { DEFAULT_PROOF_TIMEOUT_MS } from './proof-timeout';
import { configBool, configEnum, configInt, configString, setConfigOverrideSource, setConfigWarnSink } from './config';
import { configSpec, parseConfigValue } from './config-table';

// Typed accessors in `./config` also read `cds.requires.nightgate.<camelCase>`
// (env wins); parse warnings go to the plugin logger.
setConfigOverrideSource(() => getNightgatePluginConfig() as Record<string, unknown>);
setConfigWarnSink((message) => cds.log('nightgate:config').warn(message));

export { deriveIndexerWsUrl };

export const VALID_NIGHTGATE_NETWORKS = ['preview', 'testnet', 'preprod', 'mainnet', 'undeployed'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

/** Plugin configuration under `cds.requires.nightgate`; defaults are this module's DEFAULT_* values. */
export interface NightgatePluginConfig {
    network?: string;
    nodeUrl?: string;
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    proofServerUrl?: string;
    /** HTTP timeout of one proof request in server proving mode, ms; default 300000. */
    proofTimeoutMs?: number;
    crawlerNodeUrl?: string;
    privateStateBackend?: PrivateStateBackend;
    sessionTtlMs?: number;
    /** Current execution guarantee: one process, one tenant. */
    runtimeMode?: 'single-instance';
    /** Declared process/replica count. Values other than 1 fail closed. */
    replicaCount?: number;
    /** Emergency-only override for legacy production deployments on SQLite. */
    allowProductionSqlite?: boolean;
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
         * Content-tree width of attestation-vault-family artifacts: 8, 16 (default)
         * or 32. Must match the compiled artifact's witness vector shapes.
         */
        slotWidth?: number;
        /** Canonical deployed address(es), advertised in `GET /contract-manifest`; optional. */
        address?: string | string[];
    }>;
    /** Mainnet submission gate; default false (submission actions reject on mainnet). Indexing is unaffected. */
    allowMainnetSubmission?: boolean;
    /**
     * How a principal maps to the vault's `Bytes<32>` grantee id: 'wallet' (default,
     * coin public key), 'did' or 'custom'. The grant issuer must use the same derivation.
     */
    granteeBinding?: GranteeBinding;
    /**
     * Let any principal bind its own granteeId via `registerGranteeIdentity`. Default
     * false: the binding input's ownership is not verified, so a caller could inherit
     * another principal's on-chain grants.
     */
    allowSelfServiceGranteeRegistration?: boolean;
    /** Close the previous process's wallet sessions at startup; default true. */
    closeSessionsOnRestart?: boolean;
    /**
     * Indexer endpoints per network, used only when a verify call overrides to a network
     * other than the configured one; unlisted networks use `DEFAULT_INDEXER_URLS`.
     */
    networks?: Partial<Record<NightgateNetwork, {
        indexerHttpUrl?: string;
        indexerWsUrl?: string;
    }>>;
    [k: string]: unknown;
}

/** Typed accessor for `cds.env.requires.nightgate`; the only cast of the freeform CAP env. */
export function getNightgatePluginConfig(): NightgatePluginConfig {
    // `cds.env` is absent under a bare cds mock.
    const env = (cds as any).env as { requires?: { nightgate?: NightgatePluginConfig } } | undefined;
    return env?.requires?.nightgate ?? {};
}

export const DEFAULT_NETWORK: NightgateNetwork = 'preprod';
export const DEFAULT_NODE_URL = 'wss://rpc.preprod.midnight.network/';

/** Per-network default node RPC URL (crawler and SDK `relayURL`); unlisted networks use DEFAULT_NODE_URL. */
export const DEFAULT_NODE_URLS: Partial<Record<NightgateNetwork, string>> = {
    preview: 'wss://rpc.preview.midnight.network/',
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
        http: 'https://indexer.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.midnight.network/api/v4/graphql/ws'
    },
    // An indexer image that serves only /api/v3 needs NIGHTGATE_INDEXER_HTTP_URL / _WS_URL.
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
    const raw = configEnum('NIGHTGATE_PRIVATE_STATE_BACKEND') || config?.privateStateBackend;
    if (raw && (VALID_PRIVATE_STATE_BACKENDS as readonly string[]).includes(raw)) {
        return raw as PrivateStateBackend;
    }
    return DEFAULT_PRIVATE_STATE_BACKEND;
}

export const VALID_GRANTEE_BINDINGS = ['wallet', 'did', 'custom'] as const;
export type GranteeBinding = (typeof VALID_GRANTEE_BINDINGS)[number];
export const DEFAULT_GRANTEE_BINDING: GranteeBinding = 'wallet';

export function getConfiguredGranteeBinding(config?: Record<string, any>): GranteeBinding {
    const raw = configEnum('NIGHTGATE_GRANTEE_BINDING') || config?.granteeBinding;
    if (raw && (VALID_GRANTEE_BINDINGS as readonly string[]).includes(raw)) {
        return raw as GranteeBinding;
    }
    return DEFAULT_GRANTEE_BINDING;
}

export function isSelfServiceGranteeRegistrationAllowed(config?: Record<string, any>): boolean {
    const raw = configBool('NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION');
    if (raw !== undefined) return raw;
    // Off unless opted in: binding-input ownership is not verified.
    return config?.allowSelfServiceGranteeRegistration === true;
}

/**
 * Whether a restart closes the previous process's wallet sessions; default on. Leaked
 * session rows count as live users of a wallet's keys and keep seed material at rest until the TTL.
 */
export function isCloseSessionsOnRestartEnabled(config?: Record<string, any>): boolean {
    const env = configBool('NIGHTGATE_CLOSE_SESSIONS_ON_RESTART');
    if (env !== undefined) return env;
    if (typeof config?.closeSessionsOnRestart === 'boolean') return config.closeSessionsOnRestart;
    return true;
}

export function getConfiguredNightgateNetwork(config?: Record<string, any>): string | undefined {
    // Raw on purpose: an invalid value must reach normalizeNightgateNetwork,
    // which refuses to start instead of silently falling back.
    return process.env.NIGHTGATE_NETWORK?.trim() || config?.network;
}

export function getConfiguredNightgateNodeUrl(config?: Record<string, any>): string | undefined {
    return configString('NIGHTGATE_NODE_URL') || config?.nodeUrl;
}

export function getConfiguredNightgateCrawlerNodeUrl(config?: Record<string, any>): string | undefined {
    return configString('NIGHTGATE_CRAWLER_NODE_URL') || config?.crawler?.nodeUrl;
}

/** Configured iff a network is selected; otherwise initialize() stays idle and crawls nothing. */
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

/**
 * NIGHTGATE_PROVING_MODE, else `server` when a proof server is explicitly configured,
 * else `wasm`. `initialize()` pins the result into the env before the worker spawns.
 */
export function resolveEffectiveProvingMode(config?: Record<string, any> | null): 'server' | 'wasm' {
    const explicit = configEnum<'server' | 'wasm'>('NIGHTGATE_PROVING_MODE');
    if (explicit) return explicit;
    return (configString('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl) ? 'server' : 'wasm';
}

/** Proof request timeout: env, `proofTimeoutMs`, else 5 min; pinned into the env before the worker spawns. */
export function resolveProofTimeoutMs(config?: Record<string, any> | null): number {
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
    config?: Record<string, any>
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
 * Indexer endpoints for a verify `network` override: `config.networks[network]`, else the
 * public defaults. Top-level URLs and `NIGHTGATE_INDEXER_*` describe the configured network only.
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

/** Warns when the removed `crawlerlessChainConfirm` option is still set; the value is ignored. */
export function warnIfCrawlerlessChainConfirmSet(config?: Record<string, any>, warn: (msg: string) => void = (m) => cds.log('nightgate:config').warn(m)): boolean {
    const envRaw = process.env.NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM;
    const set = (typeof envRaw === 'string' && envRaw.trim() !== '') || config?.crawlerlessChainConfirm !== undefined;
    if (set) warn('crawlerlessChainConfirm / NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM is no longer an option: the indexer confirmer is the only chain-evidence path and always runs; remove the setting');
    return set;
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
    const fetchConcurrencyEnv = configInt('NIGHTGATE_FETCH_CONCURRENCY');
    const rpcBatchSizeEnv = configInt('NIGHTGATE_RPC_BATCH_SIZE');
    const startHeightEnv = configInt('NIGHTGATE_CRAWLER_START_HEIGHT');
    const maxBlocksPerSecondEnv = configInt('NIGHTGATE_CRAWLER_MAX_BPS');
    const crawlerEnabledOverride = configBool('NIGHTGATE_CRAWLER_ENABLED');
    const decodePayloadsEnv = configBool('NIGHTGATE_CRAWLER_DECODE_PAYLOADS');
    const indexerSupplementEnv = configBool('NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT');
    const crawlerConfig: Record<string, unknown> = {
        ...rawCrawlerConfig,
        ...(fetchConcurrencyEnv != null && { fetchConcurrency: fetchConcurrencyEnv }),
        ...(rpcBatchSizeEnv != null && { rpcBatchSize: rpcBatchSizeEnv }),
        ...(startHeightEnv != null && { startHeight: startHeightEnv }),
        ...(maxBlocksPerSecondEnv != null && { maxBlocksPerSecond: maxBlocksPerSecondEnv }),
        ...(decodePayloadsEnv != null && { decodePayloads: decodePayloadsEnv }),
        ...(indexerSupplementEnv != null && { indexerSupplement: indexerSupplementEnv }),
        ...(crawlerEnabledOverride != null && { enabled: crawlerEnabledOverride })
    };
    const configuredNetwork = getConfiguredNightgateNetwork(config);
    const { network, invalidNetwork } = normalizeNightgateNetwork(configuredNetwork);
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || DEFAULT_NODE_URLS[network] || DEFAULT_NODE_URL;
    const crawlerNodeUrl = getConfiguredNightgateCrawlerNodeUrl(config) || nodeUrl;
    const submissionEndpoints = resolveSubmissionEndpoints(network, config);
    // The supplement reads the same indexer the submission side is configured
    // with; nothing else in the crawler knows about it.
    crawlerConfig.indexerUrl = crawlerConfig.indexerUrl || submissionEndpoints.indexerHttpUrl;

    return {
        network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl,
        submissionEndpoints,
        invalidNetwork
    };
}

/** Rejection reason on mainnet without `allowMainnetSubmission: true`, else null. */
export function mainnetSubmissionBlockReason(config: NightgatePluginConfig): string | null {
    const { network } = resolveNightgateRuntimeConfig(config);
    if (network === 'mainnet' && config.allowMainnetSubmission !== true) {
        return 'Mainnet submission is disabled. Set cds.requires.nightgate.allowMainnetSubmission=true ' +
            'to enable it. Mainnet has known submission instability (1016 Immediately Dropped, ' +
            'forum thread 1190); read-only indexing is unaffected.';
    }
    return null;
}
