/**
 * Nightgate SDK type definitions and re-exports.
 */

export interface NightgateConfig {
  network: 'testnet' | 'mainnet';
  contractAddress?: string;
  nodeUrl?: string;
  walletSeed?: string;
  credentials?: {
    walletSeed?: {
      from?: string;
    };
  };
}

export const NIGHTGATE_DEFAULTS = {
  testnet: {
    nodeUrl: 'ws://localhost:9944'
  },
  mainnet: {
    nodeUrl: 'ws://localhost:9944'
  }
} as const;

/**
 * Nightgate SDK Providers.
 *
 * The full SDK interface (from @midnight-ntwrk/midnight-js-types) requires:
 *   privateStateProvider, publicDataProvider, zkConfigProvider,
 *   proofProvider, walletProvider, midnightProvider
 *
 * We keep this as a loose record type so the plugin works even when
 * SDK packages aren't fully resolved (offline/dev mode).
 */
export interface NightgateProviders {
  proofProvider: unknown;
  publicDataProvider: unknown;
  privateStateProvider: unknown;
  walletProvider: unknown;
  zkConfigProvider?: unknown;
  midnightProvider?: unknown;
}

export interface CircuitResult {
  transactionHash: string;
  publicOutput?: Record<string, unknown>;
}
