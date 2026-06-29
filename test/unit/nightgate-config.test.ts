/**
 * Branch coverage for srv/utils/nightgate-config.ts.
 *
 * The end-to-end runtime paths are already exercised via runtime-initialize
 * and the indexer/sessions tests. This file isolates the small helpers so we
 * cover the edge branches (invalid network, empty config, env-only flows,
 * private-state backend selection, etc.) without spinning up the full plugin.
 */

import {
    DEFAULT_NETWORK,
    DEFAULT_PRIVATE_STATE_BACKEND,
    getConfiguredNightgateNetwork,
    getConfiguredNightgateNodeUrl,
    getConfiguredNightgateCrawlerNodeUrl,
    getConfiguredPrivateStateBackend,
    isNightgatePluginConfigured,
    isSelfServiceGranteeRegistrationAllowed,
    normalizeNightgateNetwork,
    resolveNightgateRuntimeConfig
} from '../../srv/utils/nightgate-config';

const ENV_KEYS = [
    'NIGHTGATE_NETWORK',
    'NIGHTGATE_NODE_URL',
    'NIGHTGATE_CRAWLER_NODE_URL',
    'NIGHTGATE_PRIVATE_STATE_BACKEND',
    'NIGHTGATE_FETCH_CONCURRENCY',
    'NIGHTGATE_RPC_BATCH_SIZE',
    'NIGHTGATE_CRAWLER_ENABLED',
    'NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION'
] as const;
const originalEnv = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
    for (const k of ENV_KEYS) {
        const v = originalEnv[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('normalizeNightgateNetwork', () => {
    it('passes valid networks through unchanged', () => {
        expect(normalizeNightgateNetwork('preprod')).toEqual({ network: 'preprod' });
        expect(normalizeNightgateNetwork('testnet')).toEqual({ network: 'testnet' });
        expect(normalizeNightgateNetwork('undeployed')).toEqual({ network: 'undeployed' });
    });

    it('reports invalidNetwork and falls back to DEFAULT_NETWORK for unknown values', () => {
        const result = normalizeNightgateNetwork('martian-net');
        expect(result.network).toBe(DEFAULT_NETWORK);
        expect(result.invalidNetwork).toBe('martian-net');
    });

    it('returns DEFAULT_NETWORK with no invalidNetwork for undefined input', () => {
        expect(normalizeNightgateNetwork(undefined)).toEqual({ network: DEFAULT_NETWORK });
    });
});

describe('isNightgatePluginConfigured', () => {
    it('returns false for undefined config', () => {
        expect(isNightgatePluginConfigured(undefined)).toBe(false);
    });

    it('returns false when kind="nightgate" but no network is configured', () => {
        expect(isNightgatePluginConfigured({ kind: 'nightgate' })).toBe(false);
    });

    it('returns true when kind="nightgate" with a network', () => {
        expect(isNightgatePluginConfigured({ kind: 'nightgate', network: 'preprod' })).toBe(true);
    });

    it('returns true when a network is set without the kind marker', () => {
        expect(isNightgatePluginConfigured({ network: 'testnet' })).toBe(true);
    });

    it('returns false for a bare empty object', () => {
        expect(isNightgatePluginConfigured({})).toBe(false);
    });
});

describe('getConfigured* helpers', () => {
    it('reads network/nodeUrl/crawlerNodeUrl from env first, config second', () => {
        process.env.NIGHTGATE_NETWORK = 'mainnet';
        process.env.NIGHTGATE_NODE_URL = 'wss://env.example/';
        process.env.NIGHTGATE_CRAWLER_NODE_URL = 'wss://env.crawler/';
        const config = { network: 'preprod', nodeUrl: 'wss://cfg/', crawler: { nodeUrl: 'wss://cfg.crawler/' } };
        expect(getConfiguredNightgateNetwork(config)).toBe('mainnet');
        expect(getConfiguredNightgateNodeUrl(config)).toBe('wss://env.example/');
        expect(getConfiguredNightgateCrawlerNodeUrl(config)).toBe('wss://env.crawler/');
    });

    it('falls back to config when env is unset', () => {
        const config = { network: 'preprod', nodeUrl: 'wss://cfg/', crawler: { nodeUrl: 'wss://cfg.crawler/' } };
        expect(getConfiguredNightgateNetwork(config)).toBe('preprod');
        expect(getConfiguredNightgateNodeUrl(config)).toBe('wss://cfg/');
        expect(getConfiguredNightgateCrawlerNodeUrl(config)).toBe('wss://cfg.crawler/');
    });

    it('returns undefined when neither env nor config provides a value', () => {
        expect(getConfiguredNightgateNetwork({})).toBeUndefined();
        expect(getConfiguredNightgateNodeUrl({})).toBeUndefined();
        expect(getConfiguredNightgateCrawlerNodeUrl({})).toBeUndefined();
    });
});

describe('getConfiguredPrivateStateBackend', () => {
    it('returns the default when nothing is configured', () => {
        expect(getConfiguredPrivateStateBackend()).toBe(DEFAULT_PRIVATE_STATE_BACKEND);
    });

    it('honours valid env-var values', () => {
        process.env.NIGHTGATE_PRIVATE_STATE_BACKEND = 'level';
        expect(getConfiguredPrivateStateBackend()).toBe('level');
    });

    it('honours valid config values', () => {
        expect(getConfiguredPrivateStateBackend({ privateStateBackend: 'cap-db' })).toBe('cap-db');
    });

    it('rejects unknown values and returns the default', () => {
        process.env.NIGHTGATE_PRIVATE_STATE_BACKEND = 'sqlite-of-the-damned';
        expect(getConfiguredPrivateStateBackend()).toBe(DEFAULT_PRIVATE_STATE_BACKEND);
    });
});

describe('isSelfServiceGranteeRegistrationAllowed', () => {
    it('defaults to allowed (shipped 0.3.4 behavior)', () => {
        expect(isSelfServiceGranteeRegistrationAllowed()).toBe(true);
        expect(isSelfServiceGranteeRegistrationAllowed({})).toBe(true);
    });

    it('config false disables it', () => {
        expect(isSelfServiceGranteeRegistrationAllowed({ allowSelfServiceGranteeRegistration: false })).toBe(false);
    });

    it('env var overrides config (falsy spellings disable)', () => {
        for (const v of ['false', '0', 'no', 'off', 'FALSE']) {
            process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION = v;
            expect(isSelfServiceGranteeRegistrationAllowed({ allowSelfServiceGranteeRegistration: true })).toBe(false);
        }
        process.env.NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION = 'true';
        expect(isSelfServiceGranteeRegistrationAllowed({ allowSelfServiceGranteeRegistration: false })).toBe(true);
    });
});

describe('resolveNightgateRuntimeConfig', () => {
    it('parses NIGHTGATE_FETCH_CONCURRENCY / RPC_BATCH_SIZE env vars when present and positive', () => {
        process.env.NIGHTGATE_FETCH_CONCURRENCY = '7';
        process.env.NIGHTGATE_RPC_BATCH_SIZE = '42';
        const { crawlerConfig } = resolveNightgateRuntimeConfig({ network: 'preprod' });
        expect(crawlerConfig.fetchConcurrency).toBe(7);
        expect(crawlerConfig.rpcBatchSize).toBe(42);
    });

    it('ignores non-numeric / non-positive env tuning values', () => {
        process.env.NIGHTGATE_FETCH_CONCURRENCY = 'banana';
        process.env.NIGHTGATE_RPC_BATCH_SIZE = '0';
        const { crawlerConfig } = resolveNightgateRuntimeConfig({
            network: 'preprod',
            crawler: { fetchConcurrency: 3, rpcBatchSize: 25 }
        });
        expect(crawlerConfig.fetchConcurrency).toBe(3);
        expect(crawlerConfig.rpcBatchSize).toBe(25);
    });

    it('disables the crawler when NIGHTGATE_CRAWLER_ENABLED is "false"/"0"/"no"', () => {
        for (const val of ['false', '0', 'no', 'OFF']) {
            process.env.NIGHTGATE_CRAWLER_ENABLED = val;
            const { crawlerConfig } = resolveNightgateRuntimeConfig({ network: 'preprod' });
            expect(crawlerConfig.enabled).toBe(false);
        }
    });

    it('enables the crawler when NIGHTGATE_CRAWLER_ENABLED is "true"/"1"', () => {
        process.env.NIGHTGATE_CRAWLER_ENABLED = 'true';
        const { crawlerConfig } = resolveNightgateRuntimeConfig({ network: 'preprod', crawler: { enabled: false } });
        expect(crawlerConfig.enabled).toBe(true);
    });

    it('flags an invalid configured network', () => {
        const result = resolveNightgateRuntimeConfig({ network: 'martian-net' });
        expect(result.network).toBe(DEFAULT_NETWORK);
        expect(result.invalidNetwork).toBe('martian-net');
    });

    it('defaults crawlerNodeUrl to nodeUrl when not separately configured', () => {
        const { crawlerNodeUrl } = resolveNightgateRuntimeConfig({ network: 'preprod', nodeUrl: 'wss://shared/' });
        expect(crawlerNodeUrl).toBe('wss://shared/');
    });

    it('resolves the undeployed local standalone network to localhost endpoints', () => {
        const resolved = resolveNightgateRuntimeConfig({ network: 'undeployed' });
        expect(resolved.network).toBe('undeployed');
        expect(resolved.invalidNetwork).toBeUndefined();
        // node defaults to the local standalone :9944 (not the preprod relay)
        expect(resolved.nodeUrl).toBe('ws://127.0.0.1:9944');
        expect(resolved.submissionEndpoints.indexerHttpUrl).toContain('127.0.0.1:8088');
        expect(resolved.submissionEndpoints.indexerWsUrl).toContain('127.0.0.1:8088');
    });

    it('honours an explicit nodeUrl override even on undeployed', () => {
        const { nodeUrl } = resolveNightgateRuntimeConfig({ network: 'undeployed', nodeUrl: 'ws://host.docker.internal:9944' });
        expect(nodeUrl).toBe('ws://host.docker.internal:9944');
    });
});
