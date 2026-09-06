/**
 * Prover keys on demand. The npm tarball ships every contract's module,
 * verifier keys, zkir and a `keys/manifest.json` (sha256 + size per prover
 * key), but no `*.prover` file: the two vault lineages alone are 200 MB. A
 * missing prover key is fetched the first time a job needs the contract,
 * verified against the manifest and written next to the verifier keys.
 *
 * Source (`NIGHTGATE_ZK_ASSET_URL`):
 *   unset      contracts under this package's `contracts/` fetch from the
 *              release's git tag on GitHub (the /zk-config layout); any other
 *              registration has no default source
 *   <url>      a `/zk-config` base of a NIGHTGATE that has the keys
 *              (`<url>/<contract>/keys/<circuit>.prover`)
 *   none|off   disabled (offline installs run `nightgate-fetch-keys` once)
 *
 * Prover keys are NOT part of the artifact generation digest (the manifest
 * is), so fetching them changes nothing a job was pinned to.
 * Dependency-free (fs, path, crypto): the registry calls it on the main thread.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configStringFrom } from '../utils/config';

export const PROVER_KEY_MANIFEST = 'manifest.json';
export const ZK_ASSET_URL_ENV = 'NIGHTGATE_ZK_ASSET_URL';

export interface ProverKeyManifest {
    version: 1;
    prover: Record<string, { sha256: string; bytes: number }>;
}

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/** The manifest next to the keys, or null when absent or malformed. */
export function readProverKeyManifest(zkConfigPath: string): ProverKeyManifest | null {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(zkConfigPath, 'keys', PROVER_KEY_MANIFEST), 'utf8'));
        if (raw?.version !== 1 || !raw.prover || typeof raw.prover !== 'object') return null;
        for (const entry of Object.values(raw.prover) as Array<{ sha256?: unknown; bytes?: unknown }>) {
            if (typeof entry?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
            if (!Number.isInteger(entry?.bytes) || (entry.bytes as number) < 0) return null;
        }
        return raw as ProverKeyManifest;
    } catch {
        return null;
    }
}

/** Circuits with a verifier key: the authoritative circuit list of an artifact. */
export function verifierCircuits(zkConfigPath: string): string[] {
    try {
        return fs.readdirSync(path.join(zkConfigPath, 'keys'))
            .filter(f => f.endsWith('.verifier'))
            .map(f => f.replace(/\.verifier$/, ''))
            .sort();
    } catch {
        return [];
    }
}

/** Circuits that have a verifier key but no prover key on disk. */
export function missingProverKeys(zkConfigPath: string): string[] {
    return verifierCircuits(zkConfigPath).filter(c => !fs.existsSync(path.join(zkConfigPath, 'keys', `${c}.prover`)));
}

/** Every circuit of the artifact can be proven here. */
export function hasAllProverKeys(zkConfigPath: string): boolean {
    const circuits = verifierCircuits(zkConfigPath);
    return circuits.length > 0 && missingProverKeys(zkConfigPath).length === 0;
}

export class ProverKeysUnavailableError extends Error {
    readonly code = 'PROVER_KEYS_UNAVAILABLE';
    constructor(message: string, readonly contractName: string, readonly missing: string[], readonly retryable: boolean) {
        super(message);
        this.name = 'ProverKeysUnavailableError';
    }
}

function insideDir(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function packageVersion(pkgRoot: string): string {
    try {
        return String(JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0');
    } catch {
        return '0.0.0';
    }
}

/**
 * The `/zk-config/<contract>` base the prover keys of this registration come
 * from, or null when none applies (disabled, or a foreign artifact without a
 * configured source).
 */
export function resolveZkAssetSource(
    name: string,
    zkConfigPath: string,
    env: NodeJS.ProcessEnv = process.env,
    pkgRoot: string = PACKAGE_ROOT
): string | null {
    const raw = configStringFrom(ZK_ASSET_URL_ENV, env) ?? '';
    if (/^(none|off|0|false)$/i.test(raw)) return null;
    if (raw) return `${raw.replace(/\/+$/, '')}/${name}`;
    const shipped = path.join(pkgRoot, 'contracts', name, 'src', 'managed', name);
    if (path.resolve(zkConfigPath) !== path.resolve(shipped) && !insideDir(zkConfigPath, shipped)) return null;
    return `https://raw.githubusercontent.com/ODATANO/NIGHTGATE/v${packageVersion(pkgRoot)}/contracts/${name}/src/managed/${name}`;
}

export interface EnsureProverKeysOptions {
    fetchFn?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    pkgRoot?: string;
    log?: (message: string) => void;
}

const inFlight = new Map<string, Promise<{ fetched: string[]; source: string | null }>>();

/**
 * Make every prover key of the registration present on disk, fetching the
 * missing ones from the resolved source and verifying each against the
 * manifest before it lands. Concurrent callers for one artifact share the
 * download. Throws `ProverKeysUnavailableError` when nothing can be fetched.
 */
export function ensureProverKeys(
    name: string,
    reg: { zkConfigPath: string },
    opts: EnsureProverKeysOptions = {}
): Promise<{ fetched: string[]; source: string | null }> {
    const key = path.resolve(reg.zkConfigPath);
    const running = inFlight.get(key);
    if (running) return running;
    const task = ensureProverKeysNow(name, reg.zkConfigPath, opts).finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
}

async function ensureProverKeysNow(
    name: string,
    zkConfigPath: string,
    opts: EnsureProverKeysOptions
): Promise<{ fetched: string[]; source: string | null }> {
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
    const source = resolveZkAssetSource(name, zkConfigPath, opts.env ?? process.env, opts.pkgRoot ?? PACKAGE_ROOT);
    if (!source) {
        throw new ProverKeysUnavailableError(
            `contract '${name}' has no prover keys for ${missing.join(', ')} and no source to fetch them from: ` +
            `set ${ZK_ASSET_URL_ENV} to a /zk-config base that serves them, or run "npx nightgate-fetch-keys ${name}" once`,
            name, missing, false);
    }
    const doFetch = opts.fetchFn ?? fetch;
    const keysDir = path.join(zkConfigPath, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    opts.log?.(`contract '${name}': fetching ${missing.length} prover key(s) from ${source}`);
    const fetched: string[] = [];
    for (const circuit of missing) {
        const expected = manifest.prover[circuit];
        const url = `${source}/keys/${circuit}.prover`;
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
    return { fetched, source };
}

/** Manifest for the prover keys present under `keysDir` (build-time helper). */
export function buildProverKeyManifest(keysDir: string): ProverKeyManifest {
    const prover: ProverKeyManifest['prover'] = {};
    for (const f of fs.readdirSync(keysDir).filter(f => f.endsWith('.prover')).sort()) {
        const body = fs.readFileSync(path.join(keysDir, f));
        prover[f.replace(/\.prover$/, '')] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length };
    }
    return { version: 1, prover };
}
