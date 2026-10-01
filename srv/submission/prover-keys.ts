/**
 * Prover keys on demand: missing keys are fetched on first need and verified
 * against `keys/manifest.json`. The digest covers the manifest, not the keys,
 * so fetching changes no generation.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    readProverKeyManifest,
    verifierCircuits,
    missingProverKeys,
    hasAllProverKeys,
    proverKeyUrl,
    type ProverKeyManifest,
    type ZkAssetLayout
} from '@odatano/contract-kit/node';
import { configStringFrom } from '../utils/config';
import { NightgateError } from '../utils/errors';

export { readProverKeyManifest, verifierCircuits, missingProverKeys, hasAllProverKeys };
export type { ProverKeyManifest, ZkAssetLayout };

export const PROVER_KEY_MANIFEST = 'manifest.json';
export const ZK_ASSET_URL_ENV = 'NIGHTGATE_ZK_ASSET_URL';

export class ProverKeysUnavailableError extends NightgateError {
    constructor(message: string, readonly contractName: string, readonly missing: string[], retryable: boolean) {
        super('PROVER_KEYS_UNAVAILABLE', message, { retryable, exposeMessage: true });
    }
}

/** Where a registration's prover keys come from: an installed lineage package names its release assets. */
export interface ProverKeySourceInput {
    zkConfigPath: string;
    package?: { zkAssetUrl?: string; zkAssetLayout?: ZkAssetLayout };
}

export interface ZkAssetSource {
    /** Base URL; keys resolve by `layout`. */
    base: string;
    layout: ZkAssetLayout;
}

/**
 * `NIGHTGATE_ZK_ASSET_URL` base (a `/zk-config` layout, per contract name), else
 * the installed package's release assets; null when disabled (none/off) or a
 * foreign artifact has no source.
 */
export function resolveZkAssetSource(
    name: string,
    reg: ProverKeySourceInput,
    env: NodeJS.ProcessEnv = process.env
): ZkAssetSource | null {
    const raw = configStringFrom(ZK_ASSET_URL_ENV, env) ?? '';
    if (/^(none|off|0|false)$/i.test(raw)) return null;
    if (raw) return { base: `${raw.replace(/\/+$/, '')}/${name}`, layout: 'zk-config' };
    if (reg.package?.zkAssetUrl) return { base: reg.package.zkAssetUrl, layout: reg.package.zkAssetLayout ?? 'flat' };
    return null;
}

export interface EnsureProverKeysOptions {
    fetchFn?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
}

const inFlight = new Map<string, Promise<{ fetched: string[]; source: string | null }>>();

/** Each key is verified before it lands; concurrent callers for one artifact share the download. */
export function ensureProverKeys(
    name: string,
    reg: ProverKeySourceInput,
    opts: EnsureProverKeysOptions = {}
): Promise<{ fetched: string[]; source: string | null }> {
    const key = path.resolve(reg.zkConfigPath);
    const running = inFlight.get(key);
    if (running) return running;
    const task = ensureProverKeysNow(name, reg, opts).finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
}

async function ensureProverKeysNow(
    name: string,
    reg: ProverKeySourceInput,
    opts: EnsureProverKeysOptions
): Promise<{ fetched: string[]; source: string | null }> {
    const zkConfigPath = reg.zkConfigPath;
    const missing = missingProverKeys(zkConfigPath);
    if (missing.length === 0) return { fetched: [], source: null };
    const manifest = readProverKeyManifest(zkConfigPath);
    if (!manifest) {
        throw new ProverKeysUnavailableError(
            `contract '${name}' has no prover keys for ${missing.join(', ')} and no keys/${PROVER_KEY_MANIFEST} to verify a download against; ` +
            `place the keys under ${path.join(zkConfigPath, 'keys')} or register an artifact that ships them`,
            name, missing, false);
    }
    const unlisted = missing.filter(c => !manifest.prover[c]);
    if (unlisted.length > 0) {
        throw new ProverKeysUnavailableError(
            `contract '${name}': keys/${PROVER_KEY_MANIFEST} lists no prover key for ${unlisted.join(', ')}; the manifest is stale for this artifact`,
            name, unlisted, false);
    }
    const source = resolveZkAssetSource(name, reg, opts.env ?? process.env);
    if (!source) {
        throw new ProverKeysUnavailableError(
            `contract '${name}' has no prover keys for ${missing.join(', ')} and no source to fetch them from: ` +
            `set ${ZK_ASSET_URL_ENV} to a /zk-config base that serves them, or run "npx nightgate-fetch-keys ${name}" once`,
            name, missing, false);
    }
    const doFetch = opts.fetchFn ?? fetch;
    const keysDir = path.join(zkConfigPath, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    opts.log?.(`contract '${name}': fetching ${missing.length} prover key(s) from ${source.base}`);
    const fetched: string[] = [];
    for (const circuit of missing) {
        const expected = manifest.prover[circuit];
        const url = proverKeyUrl(source.base, source.layout, circuit);
        let res: Response;
        try {
            res = await doFetch(url);
        } catch (e) {
            throw new ProverKeysUnavailableError(
                `contract '${name}': fetching ${url} failed: ${String((e as Error)?.message ?? e)}`, name, [circuit], true);
        }
        if (!res.ok) {
            throw new ProverKeysUnavailableError(
                `contract '${name}': ${url} answered HTTP ${res.status}`, name, [circuit], res.status >= 500 || res.status === 429);
        }
        const body = Buffer.from(await res.arrayBuffer());
        const sha256 = crypto.createHash('sha256').update(body).digest('hex');
        if (body.length !== expected.bytes || sha256 !== expected.sha256) {
            throw new ProverKeysUnavailableError(
                `contract '${name}': ${url} does not match keys/${PROVER_KEY_MANIFEST} ` +
                `(${body.length} bytes, sha256 ${sha256.slice(0, 16)}…; expected ${expected.bytes} bytes, ${expected.sha256.slice(0, 16)}…); nothing written`,
                name, [circuit], false);
        }
        const dest = path.join(keysDir, `${circuit}.prover`);
        const tmp = `${dest}.part-${process.pid}`;
        try {
            fs.writeFileSync(tmp, body);
            fs.renameSync(tmp, dest);
        } catch (e) {
            try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
            throw e;
        }
        fetched.push(circuit);
        opts.log?.(`contract '${name}': prover key ${circuit} (${body.length} bytes) verified and written`);
    }
    return { fetched, source: source.base };
}
