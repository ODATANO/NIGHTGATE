/**
 * The public config type is the plugin config read from `cds.requires.nightgate`.
 * It is re-exported, not copied, so the two can never drift apart.
 */

export type { NightgatePluginConfig as NightgateConfig } from '../utils/nightgate-config';
