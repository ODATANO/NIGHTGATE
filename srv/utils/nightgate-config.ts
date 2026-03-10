export const VALID_NIGHTGATE_NETWORKS = ['testnet', 'preprod', 'mainnet'] as const;

export type NightgateNetwork = (typeof VALID_NIGHTGATE_NETWORKS)[number];

export const DEFAULT_NETWORK: NightgateNetwork = 'preprod';
export const DEFAULT_NODE_URL = 'wss://rpc.preprod.midnight.network/';

function readEnv(key: string): string | undefined {
    return process.env[key]?.trim() || undefined;
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
            network: DEFAULT_NETWORK,
            invalidNetwork: network
        };
    }

    return { network: DEFAULT_NETWORK };
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
    const nodeUrl = getConfiguredNightgateNodeUrl(config) || DEFAULT_NODE_URL;
    const crawlerNodeUrl = getConfiguredNightgateCrawlerNodeUrl(config) || nodeUrl;

    return {
        network,
        nodeUrl,
        crawlerConfig,
        crawlerNodeUrl,
        invalidNetwork
    };
}