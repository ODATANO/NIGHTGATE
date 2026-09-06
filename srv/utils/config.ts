/**
 * Typed access to NIGHTGATE's configuration knobs (see `config-table.ts`).
 *
 * Main thread: every read resolves at call time from `process.env`, then the
 * CAP block a host registered with `setConfigOverrideSource`, then the
 * default. Parse warnings are logged once per key and value.
 *
 * Wallet worker: the main thread hands the RESOLVED snapshot over
 * `workerData` and the worker pins it with `pinResolvedConfig`; from then on
 * the accessors answer from the snapshot and never touch the worker's env.
 *
 * No cds import here: the worker loads this module too.
 */

import {
    CONFIG_TABLE, configSpec, resolveOne, resolveConfigTable,
    type ConfigValue, type ConfigSpec
} from './config-table';

type WarnSink = (message: string) => void;

let warnSink: WarnSink = (message) => console.warn(`[nightgate:config] ${message}`);
let overrideSource: (() => Record<string, unknown> | undefined | null) | undefined;
let pinned: Record<string, ConfigValue> | undefined;
const warned = new Set<string>();

let workerDataChecked = false;

/**
 * Inside the wallet worker the main thread's resolved snapshot arrives in
 * `workerData`. It is picked up on the first read, whatever the import order
 * of the worker modules; `node:worker_threads` is required lazily so this
 * module carries no import of it (the boot tests mock that module).
 */
function pinFromWorkerDataOnce(): void {
    if (workerDataChecked) return;
    workerDataChecked = true;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { workerData } = require('node:worker_threads') as { workerData?: { config?: Record<string, ConfigValue> } };
        if (workerData?.config && pinned === undefined) pinned = { ...workerData.config };
    } catch {
        // no worker_threads (unusual runtime): the env is read
    }
}

/** Where parse warnings go (the plugin installs the cds logger). */
export function setConfigWarnSink(sink: WarnSink): void {
    warnSink = sink;
}

/** The CAP host's `cds.requires.nightgate` block, read lazily on every access. */
export function setConfigOverrideSource(source: (() => Record<string, unknown> | undefined | null) | undefined): void {
    overrideSource = source;
}

/** Worker thread: answer from the main thread's resolved snapshot. */
export function pinResolvedConfig(snapshot: Record<string, ConfigValue> | undefined | null): void {
    pinned = snapshot ? { ...snapshot } : undefined;
}

export function isConfigPinned(): boolean {
    pinFromWorkerDataOnce();
    return pinned !== undefined;
}

/** Tests only: forget the pinned snapshot, the override source and the warned set. */
export function __resetConfigForTests(): void {
    pinned = undefined;
    workerDataChecked = true;
    overrideSource = undefined;
    warned.clear();
}

/**
 * The resolved values of every key, for the worker snapshot. Secrets are
 * left out: the key ring travels separately, already parsed.
 */
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
        // A key missing from the snapshot (older main thread) keeps its default.
        return Object.prototype.hasOwnProperty.call(pinned, spec.key) ? pinned[spec.key] : spec.default;
    }
    const { value, warning } = resolveOne(spec, process.env, overrideSource?.());
    if (warning) warnOnce(warning);
    return value;
}

/** Whether the key is set at all (env or CAP block); a bare default does not count. */
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

/** Like `configInt` for keys that carry a default (the type says so). */
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

/**
 * For functions that take an injectable env map (tests): the process env goes
 * through the accessors (CAP block included), any other map is parsed on its
 * own under the same rules, warnings included.
 */
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
