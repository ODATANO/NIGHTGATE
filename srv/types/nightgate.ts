/**
 * Nightgate SDK type definitions.
 */

export interface NightgateConfig {
  network: 'testnet' | 'preprod' | 'mainnet';
  nodeUrl?: string;
}
