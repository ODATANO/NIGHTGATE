const NETWORK_ENV_KEYS = ['NIGHTGATE_NETWORK', 'MIDNIGHT_NETWORK'] as const;
const NODE_URL_ENV_KEYS = ['NIGHTGATE_NODE_URL', 'MIDNIGHT_NODE_URL'] as const;
const CRAWLER_NODE_URL_ENV_KEYS = ['NIGHTGATE_CRAWLER_NODE_URL', 'MIDNIGHT_CRAWLER_NODE_URL'] as const;

export const VALID_NIGHTGATE_NETWORKS = ['testnet', 'preprod', 'mainnet'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

function readEnvOverride(keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = process.env[key]?.trim();
        if (value) {
            return value;
        }
    }

    return undefined;
}

export function getConfiguredNightgateNetwork(config?: Record<string, any>): string | undefined {
    return readEnvOverride(NETWORK_ENV_KEYS) || config?.network;
}

export function getConfiguredNightgateNodeUrl(config?: Record<string, any>): string | undefined {
    return readEnvOverride(NODE_URL_ENV_KEYS) || config?.nodeUrl;
}

export function getConfiguredNightgateCrawlerNodeUrl(config?: Record<string, any>): string | undefined {
    const crawlerConfig = config?.crawler || {};
    return readEnvOverride(CRAWLER_NODE_URL_ENV_KEYS) || crawlerConfig.nodeUrl || getConfiguredNightgateNodeUrl(config);
}

export function isNightgatePluginConfigured(config?: Record<string, any>): boolean {
    if (!config) {
        return false;
    }

    const configuredNetwork = getConfiguredNightgateNetwork(config);
    if (config.kind === 'nightgate' && !configuredNetwork) {
        return false;
    }

    return Boolean(config.kind === 'nightgate' || configuredNetwork);
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
            network: 'testnet',
            invalidNetwork: network
        };
    }

    return { network: 'testnet' };
}

export function resolveNightgateRuntimeConfig(config: Record<string, any> = {}): {
    network: NightgateNetwork;
    nodeUrl: string;
    crawlerConfig: Record<string, unknown>;
    crawlerNodeUrl: string;
    invalidNetwork?: string;
} {
    const crawlerConfig = config.crawler || {};
    const configuredNetwork = getConfiguredNightgateNetwork(config);
    const { network, invalidNetwork } = normalizeNightgateNetwork(configuredNetwork);
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || 'ws://localhost:9944';
    const crawlerNodeUrl = getConfiguredNightgateCrawlerNodeUrl(config) || nodeUrl;

    return {
        network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl,
        invalidNetwork
    };
}