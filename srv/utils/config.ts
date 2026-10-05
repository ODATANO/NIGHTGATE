/**
 * Typed getters for the settings listed in `config-table.ts`.
 * A value comes from the environment first, then from the CAP config, then from the default.
 * In the wallet worker thread the values come from a copy made by the main thread.
 * This module does not import `@sap/cds`, because the worker loads it too.
 */

import {
    CONFIG_TABLE, configSpec, resolveOne, resolveConfigTable,
    type ConfigValue, type ConfigSpec
} from './config-table';

type WarnSink = (message: string) => void;

// eslint-disable-next-line no-console -- cds-free module: the console is the sink until the host installs one
let warnSink: WarnSink = (message) => console.warn(`[nightgate:config] ${message}`);
let overrideSource: (() => Record<string, unknown> | undefined | null) | undefined;
let pinned: Record<string, ConfigValue> | undefined;
const warned = new Set<string>();

let workerDataChecked = false;

/**
 * In the worker thread, takes the main thread's copy of the settings from `workerData` on first use.
 * `node:worker_threads` is required lazily because some tests mock it.
 */
function pinFromWorkerDataOnce(): void {
    if (workerDataChecked) return;
    workerDataChecked = true;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { workerData } = require('node:worker_threads') as { workerData?: { config?: Record<string, ConfigValue> } };
        if (workerData?.config && pinned === undefined) pinned = { ...workerData.config };
    } catch {
        // No worker_threads module available. The environment is used instead.
    }
}

/** Sets where warnings about invalid values go. The plugin installs the cds logger. */
export function setConfigWarnSink(sink: WarnSink): void {
    warnSink = sink;
}

/** Sets the source of the host app's `cds.requires.nightgate` config. It is read on every access. */
export function setConfigOverrideSource(source: (() => Record<string, unknown> | undefined | null) | undefined): void {
    overrideSource = source;
}

/** Worker thread only: use this copy of the main thread's settings. */
export function pinResolvedConfig(snapshot: Record<string, ConfigValue> | undefined | null): void {
    pinned = snapshot ? { ...snapshot } : undefined;
}

export function isConfigPinned(): boolean {
    pinFromWorkerDataOnce();
    return pinned !== undefined;
}

export function __resetConfigForTests(): void {
    pinned = undefined;
    workerDataChecked = true;
    overrideSource = undefined;
    warned.clear();
}

/** All current values, for handing to the worker thread. Secrets are left out and passed separately. */
export function resolvedConfigSnapshot(env: Record<string, string | undefined> = process.env): Record<string, ConfigValue> {
    const { values, warnings } = resolveConfigTable(env, overrideSource?.());
    for (const w of warnings) warnOnce(w);
    for (const spec of CONFIG_TABLE) if (spec.kind === 'secret') delete values[spec.key];
    return values;
}

function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    warnSink(message);
}

function read(spec: ConfigSpec): ConfigValue {
    pinFromWorkerDataOnce();
    if (pinned) {
        // A key missing from the copy keeps its default.
        return Object.prototype.hasOwnProperty.call(pinned, spec.key) ? pinned[spec.key] : spec.default;
    }
    const { value, warning } = resolveOne(spec, process.env, overrideSource?.());
    if (warning) warnOnce(warning);
    return value;
}

/** True when the key is set in the environment or the CAP config. A default value does not count. */
export function configIsSet(key: string): boolean {
    const spec = configSpec(key);
    pinFromWorkerDataOnce();
    if (pinned) return Object.prototype.hasOwnProperty.call(pinned, key) && pinned[key] !== undefined && pinned[key] !== spec.default;
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return true;
    const cap = overrideSource?.();
    if (!cap) return false;
    const camel = key.replace(/^NIGHTGATE_/, '').toLowerCase().split('_');
    const camelKey = camel[0] + camel.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    const v = cap[camelKey];
    return v !== undefined && v !== null && v !== '';
}

export function configInt(key: string): number | undefined {
    const spec = configSpec(key);
    if (spec.kind !== 'int' && spec.kind !== 'ms') throw new Error(`config: '${key}' is a ${spec.kind}, not a number`);
    const v = read(spec);
    return typeof v === 'number' ? v : undefined;
}

/** Like `configInt`, for keys that have a default and so always have a value. */
export function configNumber(key: string): number {
    const v = configInt(key);
    if (v === undefined) throw new Error(`config: '${key}' has no value and no default`);
    return v;
}

export function configMs(key: string): number {
    return configNumber(key);
}

export function configBool(key: string): boolean | undefined {
    const spec = configSpec(key);
    if (spec.kind !== 'bool') throw new Error(`config: '${key}' is a ${spec.kind}, not a boolean`);
    const v = read(spec);
    return typeof v === 'boolean' ? v : undefined;
}

export function configFlag(key: string): boolean {
    return configBool(key) === true;
}

export function configString(key: string): string | undefined {
    const spec = configSpec(key);
    if (spec.kind === 'list' || spec.kind === 'bool' || spec.kind === 'int' || spec.kind === 'ms') {
        throw new Error(`config: '${key}' is a ${spec.kind}, not a string`);
    }
    const v = read(spec);
    return typeof v === 'string' && v !== '' ? v : undefined;
}

export function configEnum<T extends string>(key: string): T | undefined {
    return configString(key) as T | undefined;
}

export function configList(key: string): string[] {
    const spec = configSpec(key);
    if (spec.kind !== 'list') throw new Error(`config: '${key}' is a ${spec.kind}, not a list`);
    const v = read(spec);
    return Array.isArray(v) ? v : [];
}

/** Reads from a given env map. For `process.env` this is the same as `configNumber`. Other maps are read on their own. */
export function configNumberFrom(key: string, env: Record<string, string | undefined>): number {
    if (env === process.env) return configNumber(key);
    const spec = configSpec(key);
    const { value, warning } = resolveOne(spec, env, undefined);
    if (warning) warnOnce(warning);
    if (typeof value !== 'number') throw new Error(`config: '${key}' has no value and no default`);
    return value;
}

export function configStringFrom(key: string, env: Record<string, string | undefined>): string | undefined {
    if (env === process.env) return configString(key);
    const spec = configSpec(key);
    const { value, warning } = resolveOne(spec, env, undefined);
    if (warning) warnOnce(warning);
    return typeof value === 'string' && value !== '' ? value : undefined;
}
