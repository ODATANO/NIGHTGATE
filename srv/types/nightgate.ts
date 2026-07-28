/**
 * Nightgate SDK type definitions.
 *
 * The public config type is the REAL plugin config consumed by
 * `cds.requires.nightgate` (srv/utils/nightgate-config.ts), re-exported so
 * consumers get a truthful shape instead of a drifting copy.
 */

export type { NightgatePluginConfig as NightgateConfig } from '../utils/nightgate-config';
