/**
 * Maps a `compiledArtifactRef` name to its compiled module, `privateStateId` and
 * `zkConfigPath`. In-memory; loaded from `cds.requires.nightgate.contracts`,
 * where an entry names an installed lineage package or the paths of a foreign artifact.
 */

import type { NightgatePluginConfig } from '../utils/nightgate-config';
import cds from '@sap/cds';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { computeArtifactGenerationDigest, artifactGenerationMatch } from './artifact-digest';
import { resolveContractPackage, contractPackageDigestProblem, type ZkAssetLayout } from '@odatano/contract-kit/node';
import { ensureProverKeys, missingProverKeys, ZK_ASSET_URL_ENV } from './prover-keys';
import { configMs } from '../utils/config';
import { NightgateError } from '../utils/errors';

/** A relative path of a foreign artifact resolves against baseDir. */
function resolveContractPath(p: string, baseDir: string): string {
    return path.isAbsolute(p) ? p : path.join(baseDir, p);
}

export interface ContractRegistration {
    /** Path to the Compact-emitted JS contract module. */
    artifactPath: string;
    privateStateId: string;
    /** Directory containing `keys/` and `zkir/`. */
    zkConfigPath: string;
    /**
     * Provable fields per document of a vault-family artifact (default 16); must
     * match the artifact's witness shapes. Non-default widths enter the digest.
     */
    slotWidth?: number;
    /** The installed lineage package the paths point into, when there is one. */
    package?: ContractPackageRef;
}

/** Identity and key source of an installed lineage package. */
export interface ContractPackageRef {
    name: string;
    version: string;
    zkAssetUrl?: string;
    zkAssetLayout?: ZkAssetLayout;
}

/** A registration's content-tree width, defaulting to the classic 16. */
export function slotWidthOf(reg: Pick<ContractRegistration, 'slotWidth'> | undefined): number {
    return reg?.slotWidth ?? 16;
}

export interface ResolvedContract {
    /** Main-thread CompiledContract wrapper; only with `{ compile: true }`. Jobs compile in the worker. */
    compiledContract?: unknown;
    privateStateId: string;
    zkConfigPath: string;
    slotWidth?: number;
    /** The worker re-imports the module from here; compiledContract does not cross threads. */
    artifactPath: string;
    artifactDigest: string;
}

const registry = new Map<string, ContractRegistration>();
const generationDigests = new Map<string, string>();

export function registerContract(name: string, reg: ContractRegistration): void {
    if (!name || !reg.artifactPath || !reg.privateStateId || !reg.zkConfigPath) {
        throw new Error('registerContract: all fields are required');
    }
    // No 64: masks use 32-bit JS bitwise ops and a signed Integer64 column.
    if (reg.slotWidth !== undefined
        && (![16, 32].includes(reg.slotWidth))) {
        throw new Error(`registerContract: slotWidth must be 16 or 32 (got ${String(reg.slotWidth)})`);
    }
    // Frozen clone: mutating the caller's object must not re-point the alias
    // behind the generation digest's back.
    registry.set(name, Object.freeze({ ...reg }));
    generationDigests.delete(name);
    currentDigestCache.delete(name);
}

/**
 * Cached digest of the registration a name resolves to (module, privateStateId,
 * zk assets). Persisted commands and evidence record it; resolves compare fail-closed.
 */
export function getArtifactGenerationDigest(name: string): string {
    const cached = generationDigests.get(name);
    if (cached) return cached;
    const reg = registry.get(name);
    if (!reg) throw new ContractNotRegisteredError(name, listRegisteredContracts());
    const digest = computeGenerationDigest(reg);
    generationDigests.set(name, digest);
    return digest;
}

/** Re-hash after this age even when the stat fingerprint is unchanged. */
const CURRENT_DIGEST_MAX_AGE_MS = configMs('NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS');

/**
 * Stat-only change detector. Inode and ctime join size and mtime because a
 * replace or restore can preserve mtime and size, but not inode or ctime.
 */
function statFingerprint(reg: ContractRegistration): string {
    const parts: string[] = [];
    const add = (file: string) => {
        try {
            const st = fs.statSync(file);
            parts.push(`${file}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.mode}`);
        } catch {
            parts.push(`${file}:missing`);
        }
    };
    add(reg.artifactPath);
    parts.push(`privateStateId:${reg.privateStateId}`);
    parts.push(`slotWidth:${slotWidthOf(reg)}`);
    for (const sub of ['keys', 'zkir']) {
        const dir = path.join(reg.zkConfigPath, sub);
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir).sort();
        } catch { /* asset-less artifacts */ }
        for (const f of files) add(path.join(dir, f));
    }
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

const currentDigestCache = new Map<string, { fingerprint: string; digest: string; computedAt: number }>();

/**
 * Digest of the registration's files as they are on disk now (the per-alias
 * cache reports what was loaded). Memoised behind a stat fingerprint with a max age.
 */
export function getCurrentArtifactDigest(name: string): string {
    const reg = registry.get(name);
    if (!reg) throw new ContractNotRegisteredError(name, listRegisteredContracts());

    const fingerprint = statFingerprint(reg);
    const cached = currentDigestCache.get(name);
    const fresh = cached && Date.now() - cached.computedAt < CURRENT_DIGEST_MAX_AGE_MS;
    if (cached && fresh && cached.fingerprint === fingerprint) return cached.digest;

    const digest = computeGenerationDigest(reg);
    currentDigestCache.set(name, { fingerprint, digest, computedAt: Date.now() });
    return digest;
}

/** Uncached digest over a registration snapshot's current bytes. */
function computeGenerationDigest(reg: ContractRegistration): string {
    return computeArtifactGenerationDigest(reg);
}

const legacyDigestNoted = new Set<string>();
/** A legacy digest form (see artifact-digest.ts) names the same generation. */
function acceptsLegacyDigest(name: string, recorded: string): boolean {
    const reg = registry.get(name);
    if (!reg || artifactGenerationMatch(reg, recorded) !== 'legacy') return false;
    if (!legacyDigestNoted.has(name)) {
        legacyDigestNoted.add(name);
        cds.log('nightgate').info(`contract '${name}': accepting pre-0.21.0 generation digest ${recorded.slice(0, 16)}… (same CommonJS artifact; the digest format gained the module-format section)`);
    }
    return true;
}

/** Fail-closed generation check for persisted commands and stored evidence. */
export function assertArtifactGeneration(name: string, recorded: string | undefined, what: string): void {
    const current = getArtifactGenerationDigest(name);
    if (!recorded) {
        throw new Error(
            `${what} carries no artifact-generation digest (created by an older release). ` +
            `Refusing to run it against whatever '${name}' resolves to today; re-issue the action.`);
    }
    if (recorded !== current && acceptsLegacyDigest(name, recorded)) return;
    if (recorded !== current) {
        throw new Error(
            `${what} was created against artifact generation ${recorded.slice(0, 16)}… but '${name}' now ` +
            `resolves to ${current.slice(0, 16)}…. Refusing to execute against a different generation; ` +
            `re-register the original artifact under this name (or a versioned alias) to proceed.`);
    }
}

export function unregisterContract(name: string): boolean {
    generationDigests.delete(name);
    currentDigestCache.delete(name);
    return registry.delete(name);
}

export function clearRegistry(): void {
    registry.clear();
    generationDigests.clear();
    currentDigestCache.clear();
    configNames.clear();
}

/**
 * Names from `cds.requires.nightgate.contracts`: the immutable floor. Runtime
 * registrations may add names but never re-point or remove one.
 */
const configNames = new Set<string>();

export function isConfigRegisteredContract(name: string): boolean {
    return configNames.has(name);
}

export function listRegisteredContracts(): string[] {
    return Array.from(registry.keys());
}

/**
 * The frozen stored registration, without importing the artifact. Only
 * registered contracts are servable by the zk-config route.
 */
export function getContractRegistration(name: string): Readonly<ContractRegistration> | undefined {
    return registry.get(name);
}

// This file lives at <root>/srv/submission/; the lineage packages are this package's dependencies.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A `{ package }` config entry: the installed lineage package (resolved from
 * this plugin's own install first, then from baseDir), its contract.json
 * verified against the files.
 */
export function registrationFromPackage(packageName: string, baseDir = process.cwd()): ContractRegistration {
    let pkg;
    try {
        pkg = resolveContractPackage(packageName, PLUGIN_ROOT);
    } catch {
        pkg = resolveContractPackage(packageName, baseDir);
    }
    const problem = contractPackageDigestProblem(pkg);
    if (problem) throw new Error(`contract package ${packageName} is not the generation its contract.json describes: ${problem}`);
    return {
        artifactPath: pkg.artifactPath,
        privateStateId: pkg.manifest.privateStateId,
        zkConfigPath: pkg.zkConfigPath,
        ...(pkg.manifest.slotWidth !== undefined ? { slotWidth: pkg.manifest.slotWidth } : {}),
        package: {
            name: pkg.name,
            version: pkg.version,
            zkAssetUrl: pkg.manifest.zkAssetUrl,
            zkAssetLayout: pkg.manifest.zkAssetLayout
        }
    };
}

/**
 * Load `cds.requires.nightgate.contracts`. Idempotent. An entry is either
 * `{ package }` (an installed lineage package) or `{ artifactPath, privateStateId, zkConfigPath, slotWidth? }`.
 */
export function loadRegistryFromConfig(config?: NightgatePluginConfig, baseDir = process.cwd()): void {
    const contracts = config?.contracts;
    if (!contracts || typeof contracts !== 'object') return;
    for (const [name, reg] of Object.entries(contracts)) {
        const r = reg as Partial<ContractRegistration> & { package?: string };
        let resolved: ContractRegistration;
        if (typeof r?.package === 'string' && r.package) {
            // One broken entry leaves the others registered; the alias itself stays unknown.
            try {
                resolved = registrationFromPackage(r.package, baseDir);
            } catch (err) {
                cds.log('nightgate').error(`contract '${name}' not registered: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
        } else {
            if (!r?.artifactPath || !r?.privateStateId || !r?.zkConfigPath) continue;
            resolved = {
                artifactPath: resolveContractPath(r.artifactPath, baseDir),
                privateStateId: r.privateStateId,
                zkConfigPath: resolveContractPath(r.zkConfigPath, baseDir),
                ...(r.slotWidth !== undefined ? { slotWidth: Number(r.slotWidth) } : {})
            };
        }
        registerContract(name, resolved);
        configNames.add(name);
        if (resolved.package) {
            cds.log('nightgate').info(`contract '${name}': ${resolved.package.name}@${resolved.package.version}, generation ${getArtifactGenerationDigest(name).slice(0, 16)}…`);
        }
        warnOnMissingProverKeys(name, resolved.zkConfigPath);
    }
}

/** Missing prover keys are fetched on first need; said once at boot for offline installs. */
function warnOnMissingProverKeys(name: string, zkConfigPath: string): void {
    const missing = missingProverKeys(zkConfigPath);
    if (missing.length === 0) return;
    cds.log('nightgate').info(
        `contract '${name}' has no prover keys for ${missing.length} circuit(s) ` +
        `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}); they are fetched on first need ` +
        `(${ZK_ASSET_URL_ENV}, verified against keys/manifest.json). Offline: "npx nightgate-fetch-keys ${name}" ` +
        `puts them under ${path.join(zkConfigPath, 'keys')}; no restart needed, the digest does not change.`);
}

/**
 * Resolve a contract, optionally pinned to `expectedDigest`. The snapshot is
 * captured once and checked before any import, so a concurrent re-registration cannot swap it.
 */
export async function resolveContract(name: string, expectedDigest?: string, opts: { compile?: boolean } = {}): Promise<ResolvedContract> {
    const reg = registry.get(name);
    if (!reg) {
        const available = listRegisteredContracts();
        throw new ContractNotRegisteredError(name, available);
    }
    let digest: string | undefined;
    if (expectedDigest !== undefined) {
        // A job imports nothing here (the worker hashes its snapshot), so the
        // fingerprinted digest suffices; a main-thread import checks its bytes uncached.
        const current = opts.compile ? computeGenerationDigest(reg) : getCurrentArtifactDigest(name);
        digest = current;
        if (current !== expectedDigest && artifactGenerationMatch(reg, expectedDigest) !== 'legacy') {
            throw new Error(
                `Contract '${name}' currently resolves to artifact generation ${current.slice(0, 16)}… but ` +
                `${expectedDigest.slice(0, 16)}… was recorded. Refusing to load a different generation; ` +
                `re-register the original artifact under this name (or a versioned alias) to proceed.`);
        }
    }
    digest ??= getArtifactGenerationDigest(name);
    if (expectedDigest !== undefined && !opts.compile) {
        // The worker snapshots these files, so prover keys must be on disk first;
        // after the generation check, so a stale job never triggers a download.
        const { fetched } = await ensureProverKeys(name, reg, { log: (m) => cds.log('nightgate').info(m) });
        if (fetched.length) cds.log('nightgate').info(`contract '${name}': ${fetched.length} prover key(s) fetched on first need`);
    }
    // No main-thread import for jobs: it would stay in Node's module cache.
    let compiledContract: unknown;
    if (opts.compile) {
        const mod: any = await importArtifactGeneration(reg.artifactPath, digest);
        const ContractClass = mod.Contract ?? mod.default ?? mod;
        const compactJs: any = await import('@midnight-ntwrk/compact-js');
        const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
        if (!CompiledContract?.make) {
            throw new Error(`CompiledContract.make not found in @midnight-ntwrk/compact-js exports; got keys: ${Object.keys(compactJs).join(',')}`);
        }
        compiledContract = CompiledContract.make(name, ContractClass).pipe(
            CompiledContract.withVacantWitnesses,
            CompiledContract.withCompiledFileAssets(reg.zkConfigPath)
        );
    }

    return {
        ...(compiledContract !== undefined ? { compiledContract } : {}),
        privateStateId: reg.privateStateId,
        zkConfigPath: reg.zkConfigPath,
        artifactPath: reg.artifactPath,
        artifactDigest: digest,
        ...(reg.slotWidth !== undefined ? { slotWidth: reg.slotWidth } : {})
    };
}

/** file:// URL keyed by generation: Node caches ESM per URL, so each revision is its own instance. */
export function artifactImportSpec(artifactPath: string, generation: string): string {
    if (!path.isAbsolute(artifactPath)) return artifactPath;
    const url = pathToFileURL(artifactPath);
    url.searchParams.set('gen', generation.slice(0, 32));
    return url.href;
}

/** Import a registered artifact pinned to its loaded generation (main-thread readers). */
export async function importRegisteredArtifact(name: string): Promise<any> {
    const reg = registry.get(name);
    if (!reg) throw new ContractNotRegisteredError(name, listRegisteredContracts());
    return importArtifactGeneration(reg.artifactPath, getArtifactGenerationDigest(name));
}

export async function importArtifactByPath(artifactPath: string): Promise<any> {
    const wanted = path.resolve(artifactPath);
    for (const [name, reg] of registry) {
        if (path.resolve(reg.artifactPath) === wanted) return importRegisteredArtifact(name);
    }
    return import(path.isAbsolute(artifactPath) ? pathToFileURL(artifactPath).href : artifactPath);
}

/**
 * Import an artifact pinned to a generation. Node caches CommonJS by filename
 * regardless of the query, so the CJS cache entry is dropped first.
 */
export async function importArtifactGeneration(artifactPath: string, generation: string): Promise<any> {
    if (path.isAbsolute(artifactPath)) {
        try {
            const resolved = require.resolve(artifactPath);
            delete require.cache[resolved];
        } catch { /* not resolvable as CJS (fine for ESM) */ }
    }
    return import(artifactImportSpec(artifactPath, generation));
}

export class ContractNotRegisteredError extends NightgateError {
    constructor(public readonly contractName: string, public readonly available: string[]) {
        super('CONTRACT_NOT_REGISTERED',
            available.length === 0
                ? `Contract '${contractName}' is not registered. No contracts are registered yet (register via cds.requires.nightgate.contracts or call registerContract()).`
                : `Contract '${contractName}' is not registered. Available: ${available.join(', ')}`
        );
    }
}
