import cds from '@sap/cds';
import { deriveIndexerWsUrl } from './indexer-url';
import { DEFAULT_PROOF_TIMEOUT_MS } from './proof-timeout';
import { configBool, configEnum, configInt, configList, configString, setConfigOverrideSource, setConfigWarnSink } from './config';
import { camelConfigKey, capConfigValue, configSpec, formerCapKeys, formerEnvKeys, parseConfigValue } from './config-table';
import type { CrawlerConfig } from '../crawler/Crawler';

// Lets the getters in `./config` also read `cds.requires.nightgate`, and log through cds.
setConfigOverrideSource(() => getNightgateConfig() as Record<string, unknown>);
setConfigWarnSink((message) => cds.log('nightgate:config').warn(message));

export { deriveIndexerWsUrl };

export const VALID_NIGHTGATE_NETWORKS = ['preview', 'preprod', 'mainnet', 'stagenet', 'undeployed'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

export function isNightgateNetwork(value: unknown): value is NightgateNetwork {
    return (VALID_NIGHTGATE_NETWORKS as readonly unknown[]).includes(value);
}

/** Configuration under `cds.requires.nightgate`. */
export interface NightgateConfig {
    network?: string;
    nodeUrl?: string;
    indexerHttpUrl?: string;
    indexerWsUrl?: string;
    proofServerUrl?: string;
    /** Timeout in ms for one proof server request. Default 300000. */
    proofTimeoutMs?: number | string;
    sessionTtlMs?: number;
    runtimeMode?: 'single-instance';
    /** Number of running instances. Startup fails for any value other than 1. */
    replicaCount?: number;
    palletMap?: Record<string, { name: string; txType: string; isShielded?: boolean; isSystem?: boolean }>;
    crawler?: Partial<CrawlerConfig>;
    contracts?: Record<string, {
        /** An installed contract package. The paths come from its contract.json. */
        package?: string;
        artifactPath?: string;
        privateStateId?: string;
        zkConfigPath?: string;
        /** Number of document slots of an attestation vault contract: 16 (default) or 32. Must match the compiled contract. */
        slotWidth?: number;
        /** Deployed address or addresses, published in `GET /contract-manifest`. */
        address?: string | string[];
    }>;
    /** Allows sending transactions on mainnet. Default false. Indexing works either way. */
    allowMainnetSubmission?: boolean;
    /** How a user is turned into the 32-byte grantee id the vault contract uses.
     *  'wallet' (default) uses the coin public key. The issuer of a grant must use the same method. */
    granteeBinding?: GranteeBinding;
    /** Lets any user register their own grantee id. Default false.
     *  Ownership of the input is not verified, so a caller could take over someone else's on-chain grants. */
    allowSelfServiceGranteeRegistration?: boolean;
    closeSessionsOnRestart?: boolean;
    /** Indexer URLs per network, used only when a verify call asks for a network other than the configured one. */
    networks?: Partial<Record<NightgateNetwork, {
        indexerHttpUrl?: string;
        indexerWsUrl?: string;
    }>>;
    [k: string]: unknown;
}

export function getNightgateConfig(): NightgateConfig {
    // `cds.env` is missing when tests mock `cds`.
    const config: NightgateConfig | undefined = cds.env?.requires?.nightgate;
    return config ?? {};
}

export const DEFAULT_NETWORK: NightgateNetwork = 'mainnet';

// Built-in node and indexer endpoints. Only networks with a public, keyless endpoint have one:
// preprod and mainnet need `nodeUrl` and `indexerHttpUrl` configured (an own node and indexer, or
// hosted ones with the token in the URL), see docs/self-hosted.md.
export const DEFAULT_NODE_URLS: Partial<Record<NightgateNetwork, string>> = {
    preview: 'wss://rpc.preview.midnight.network/',
    undeployed: 'ws://127.0.0.1:9944'
};

export const DEFAULT_INDEXER_URLS: Partial<Record<NightgateNetwork, { http: string; ws: string }>> = {
    preview: {
        http: 'https://indexer.preview.midnight.network/api/v4/graphql',
        ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws'
    },
    // 127.0.0.1, not localhost: Node resolves localhost to ::1 first, which a node bound to IPv4 refuses.
    // An older local indexer that serves only /api/v3 needs the indexer URLs set explicitly.
    undeployed: {
        http: 'http://127.0.0.1:8088/api/v4/graphql',
        ws: 'ws://127.0.0.1:8088/api/v4/graphql/ws'
    }
};

/** What a network without built-in endpoints still lacks; null when node and indexer are set. */
export function missingEndpointsMessage(network: NightgateNetwork, nodeUrl: string, indexerHttpUrl: string): string | null {
    const missing = [!nodeUrl && 'NIGHTGATE_NODE_URL (cds.requires.nightgate.nodeUrl)', !indexerHttpUrl && 'NIGHTGATE_INDEXER_HTTP_URL (cds.requires.nightgate.indexerHttpUrl)'].filter(Boolean);
    if (!missing.length) return null;
    const what = !nodeUrl && !indexerHttpUrl ? 'node or indexer' : !nodeUrl ? 'node' : 'indexer';
    const hosted = network === 'preprod' || network === 'mainnet'
        ? ` Use your own node and indexer, no token needed (ws://<node-host>:9944, http://<indexer-host>:8088/api/v4/graphql), or hosted ones for ${network} with the access token in the URL.`
        : '';
    return `network "${network}" has no built-in ${what}: set ${missing.join(' and ')}.${hosted} See docs/self-hosted.md.`;
}

export const DEFAULT_PROOF_SERVER_URL = 'http://localhost:6300';

export const VALID_GRANTEE_BINDINGS = ['wallet', 'did', 'custom'] as const;
export type GranteeBinding = (typeof VALID_GRANTEE_BINDINGS)[number];
export const DEFAULT_GRANTEE_BINDING: GranteeBinding = 'wallet';

export function getConfiguredGranteeBinding(config?: NightgateConfig): GranteeBinding {
    const raw = configEnum('NIGHTGATE_GRANTEE_BINDING') || config?.granteeBinding;
    if (raw && (VALID_GRANTEE_BINDINGS as readonly string[]).includes(raw)) {
        return raw as GranteeBinding;
    }
    return DEFAULT_GRANTEE_BINDING;
}

export function isSelfServiceGranteeRegistrationAllowed(config?: NightgateConfig): boolean {
    const raw = configBool('NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION');
    if (raw !== undefined) return raw;
    return config?.allowSelfServiceGranteeRegistration === true;
}

/** Whether startup closes the wallet sessions of the previous process. Default on.
 *  Otherwise old sessions keep the encrypted seed in the database until they expire. */
export function isCloseSessionsOnRestartEnabled(config?: NightgateConfig): boolean {
    const env = configBool('NIGHTGATE_CLOSE_SESSIONS_ON_RESTART');
    if (env !== undefined) return env;
    if (typeof config?.closeSessionsOnRestart === 'boolean') return config.closeSessionsOnRestart;
    return true;
}

export function getConfiguredNightgateNetwork(config?: NightgateConfig): string | undefined {
    // Read raw on purpose, so an invalid value stops startup instead of falling back to a default.
    return process.env.NIGHTGATE_NETWORK?.trim() || config?.network;
}

export function getConfiguredNightgateNodeUrl(config?: NightgateConfig): string | undefined {
    return configString('NIGHTGATE_NODE_URL') || config?.nodeUrl;
}

export function getConfiguredNightgateCrawlerNodeUrl(config?: NightgateConfig): string | undefined {
    return configString('NIGHTGATE_CRAWLER_NODE_URL') || config?.crawler?.nodeUrl;
}

/** Without a network, initialize() does nothing. */
export function isNightgateConfigured(config?: NightgateConfig): boolean {
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
}

/** NIGHTGATE_PROVING_MODE if set. Otherwise `server` when a proof server URL is configured, else `wasm`. */
export function resolveEffectiveProvingMode(config?: NightgateConfig | null): 'server' | 'wasm' {
    const explicit = configEnum<'server' | 'wasm'>('NIGHTGATE_PROVING_MODE');
    if (explicit) return explicit;
    return (configString('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl) ? 'server' : 'wasm';
}

export function resolveProofTimeoutMs(config?: NightgateConfig | null): number {
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
    config?: NightgateConfig
): SubmissionEndpointsConfig {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const httpOverride = configString('NIGHTGATE_INDEXER_HTTP_URL') || config?.indexerHttpUrl;
    const wsOverride = configString('NIGHTGATE_INDEXER_WS_URL') || config?.indexerWsUrl;
    return {
        indexerHttpUrl: httpOverride || defaults?.http || '',
        indexerWsUrl: wsOverride || (httpOverride ? deriveIndexerWsUrl(httpOverride) : defaults?.ws || ''),
        proofServerUrl: configString('NIGHTGATE_PROOF_SERVER_URL') || config?.proofServerUrl || DEFAULT_PROOF_SERVER_URL
    };
}

/** Indexer URLs for a verify call on another network.
 *  The top-level indexer settings are ignored here, because they belong to the configured network. */
export function resolveOverrideIndexerEndpoints(
    network: NightgateNetwork,
    config?: NightgateConfig
): { indexerHttpUrl: string; indexerWsUrl: string } {
    const defaults = DEFAULT_INDEXER_URLS[network];
    const perNetwork = config?.networks?.[network] ?? {};
    const http = perNetwork.indexerHttpUrl;
    return {
        indexerHttpUrl: http || defaults?.http || '',
        indexerWsUrl: perNetwork.indexerWsUrl || (http ? deriveIndexerWsUrl(http) : defaults?.ws || '')
    };
}

export const RETIRED_DEPLOY_SWITCH = 'is no longer a setting of the server: a grant with allowDeploy and budget left decides, and a caller without a token may deploy; remove it';

/** Variables an older version read, each with what holds now. */
export const RETIRED_SETTINGS: Readonly<Record<string, string>> = {
    NIGHTGATE_SPONSOR_ALLOW_DEPLOY: RETIRED_DEPLOY_SWITCH,
    NIGHTGATE_ALLOW_PRODUCTION_SQLITE: 'is no longer a setting: SQLite with one instance is a supported way to run; remove it',
    NIGHTGATE_BATCH_SEGMENT_MODE: 'is no longer a setting: a batch is always ordered and checked before proving; remove it',
    NIGHTGATE_PRIVATE_STATE_BACKEND: 'is no longer a setting: private contract state is stored encrypted in the database; remove it',
    NIGHTGATE_ZK_CONFIG_BASE: 'is no longer a setting: nothing read it, and a relative contract path counts from the working directory; remove it',
    NIGHTGATE_ACCEPT_UNBOUND_ENVELOPES: 'is no longer a setting: every stored secret is bound to its column and row; remove it',
    NIGHTGATE_ASSUME_DB_NETWORK: 'is no longer a setting: a database records its network; remove it'
};

/** The key a retired variable had under `cds.requires.nightgate`. */
const RETIRED_CAP_KEYS: Readonly<Record<string, string>> = { NIGHTGATE_ZK_CONFIG_BASE: 'zkConfigBasePath' };

/** Warns for every retired setting that is still set, as a variable or in the CDS configuration. Returns how many are. */
export function warnIfRetiredSettingsSet(config?: NightgateConfig, warn: (msg: string) => void = (m) => cds.log('nightgate:config').warn(m)): number {
    let found = 0;
    for (const [name, now] of Object.entries(RETIRED_SETTINGS)) {
        const capKey = RETIRED_CAP_KEYS[name] ?? camelConfigKey(name);
        const set = [
            String(process.env[name] ?? '').trim() !== '' && name,
            capConfigValue(config as Record<string, unknown> | undefined, capKey) !== undefined && `cds.requires.nightgate.${capKey}`
        ].filter((spelling): spelling is string => typeof spelling === 'string');
        for (const spelling of set) warn(`${spelling} ${now}`);
        found += set.length;
    }
    return found;
}

/** Warns for every setting written under a key the server does not read, and names the key it reads. */
export function warnIfFormerConfigKeys(config?: NightgateConfig, warn: (msg: string) => void = (m) => cds.log('nightgate:config').warn(m)): number {
    const former = formerCapKeys(config as Record<string, unknown> | undefined);
    for (const { former: key, now } of former) warn(`cds.requires.nightgate.${key} is not read; the setting is ${now}`);
    const renamed = formerEnvKeys(process.env);
    for (const { former: key, now } of renamed) warn(`${key} is not read; the setting is ${now}`);
    return former.length + renamed.length;
}

export function resolveNightgateRuntimeConfig(config: NightgateConfig = {}): {
    network: NightgateNetwork;
    nodeUrl: string;
    crawlerConfig: Partial<CrawlerConfig>;
    crawlerNodeUrl: string;
    submissionEndpoints: SubmissionEndpointsConfig;
    invalidNetwork?: string;
} {
    const rawCrawlerConfig = config.crawler || {};
    const fetchConcurrencyEnv = configInt('NIGHTGATE_CRAWLER_FETCH_CONCURRENCY');
    const rpcBatchSizeEnv = configInt('NIGHTGATE_CRAWLER_RPC_BATCH_SIZE');
    const startHeightEnv = configInt('NIGHTGATE_CRAWLER_START_HEIGHT');
    const maxBlocksPerSecondEnv = configInt('NIGHTGATE_CRAWLER_MAX_BPS');
    const crawlerEnabledOverride = configBool('NIGHTGATE_CRAWLER_ENABLED');
    const decodePayloadsEnv = configBool('NIGHTGATE_CRAWLER_DECODE_PAYLOADS');
    const indexerSupplementEnv = configBool('NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT');
    const supplementBlocksPerSecondEnv = configInt('NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS');
    const contractStateHistoryEnv = configEnum<string>('NIGHTGATE_CRAWLER_CONTRACT_STATE_HISTORY');
    const contractStateWatchEnv = configList('NIGHTGATE_CRAWLER_CONTRACT_STATE_WATCH');
    const crawlerConfig: Partial<CrawlerConfig> = {
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
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || DEFAULT_NODE_URLS[network] || '';
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

/** What the crawler starts with: the resolved crawler settings on the crawler's node. Defaults are the crawler's own. */
export function crawlerStartConfig(resolved: Pick<ReturnType<typeof resolveNightgateRuntimeConfig>, 'crawlerConfig' | 'crawlerNodeUrl'>): CrawlerConfig & { nodeUrl: string } {
    return { ...resolved.crawlerConfig, enabled: true, nodeUrl: resolved.crawlerNodeUrl };
}

export function mainnetSubmissionBlockReason(config: NightgateConfig): string | null {
    const { network } = resolveNightgateRuntimeConfig(config);
    const allowed = configBool('NIGHTGATE_ALLOW_MAINNET_SUBMISSION') ?? config.allowMainnetSubmission === true;
    if (network === 'mainnet' && !allowed) {
        return 'Mainnet submission is off: a transaction on mainnet spends real NIGHT and DUST. ' +
            'Set NIGHTGATE_ALLOW_MAINNET_SUBMISSION=true to turn it on. Indexing and reads work either way.';
    }
    return null;
}
