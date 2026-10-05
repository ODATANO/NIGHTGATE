/**
 * In-memory map from a contract name (`compiledArtifactRef`) to its compiled module,
 * `privateStateId` and `zkConfigPath`. Filled from `cds.requires.nightgate.contracts`.
 * A "generation digest" identifies the exact build behind a name: module, keys and settings.
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
     * Number of provable fields per document in a vault contract, 16 by default.
     * Must match the compiled contract. A non-default value is part of the digest.
     */
    slotWidth?: number;
    package?: ContractPackageRef;
}

export interface ContractPackageRef {
    name: string;
    version: string;
    zkAssetUrl?: string;
    zkAssetLayout?: ZkAssetLayout;
}

export function slotWidthOf(reg: Pick<ContractRegistration, 'slotWidth'> | undefined): number {
    return reg?.slotWidth ?? 16;
}

export interface ResolvedContract {
    /** CompiledContract for the main thread, only set with `{ compile: true }`. Jobs compile in the worker. */
    compiledContract?: unknown;
    privateStateId: string;
    zkConfigPath: string;
    slotWidth?: number;
    /** The worker imports the module again from this path, because compiledContract cannot be sent to another thread. */
    artifactPath: string;
    artifactDigest: string;
}

const registry = new Map<string, ContractRegistration>();
const generationDigests = new Map<string, string>();

export function registerContract(name: string, reg: ContractRegistration): void {
    if (!name || !reg.artifactPath || !reg.privateStateId || !reg.zkConfigPath) {
        throw new Error('registerContract: all fields are required');
    }
    // 64 is not allowed. Field masks use 32-bit JS bit operations and a signed Integer64 column.
    if (reg.slotWidth !== undefined
        && (![16, 32].includes(reg.slotWidth))) {
        throw new Error(`registerContract: slotWidth must be 16 or 32 (got ${String(reg.slotWidth)})`);
    }
    // Store a frozen copy, so a later change to the caller's object cannot
    // change the registration without updating its digest.
    registry.set(name, Object.freeze({ ...reg }));
    generationDigests.delete(name);
    currentDigestCache.delete(name);
}

/**
 * Cached digest of the build a name points to. Stored jobs and proof results record it,
 * and loading a contract refuses to run when it no longer matches.
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
 * Cheap change check from file stats only. Inode and ctime are included because
 * replacing or restoring a file can keep its mtime and size.
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
        } catch { /* contracts without zk assets */ }
        for (const f of files) add(path.join(dir, f));
    }
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

const currentDigestCache = new Map<string, { fingerprint: string; digest: string; computedAt: number }>();

/**
 * Digest of the files as they are on disk right now, unlike the cached digest of what was loaded.
 * Reused while the file stats are unchanged and the value is not too old.
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

function computeGenerationDigest(reg: ContractRegistration): string {
    return computeArtifactGenerationDigest(reg);
}

const legacyDigestNoted = new Set<string>();
/** An older digest format can still describe the same build. See artifact-digest.ts. */
function acceptsLegacyDigest(name: string, recorded: string): boolean {
    const reg = registry.get(name);
    if (!reg || artifactGenerationMatch(reg, recorded) !== 'legacy') return false;
    if (!legacyDigestNoted.has(name)) {
        legacyDigestNoted.add(name);
        cds.log('nightgate').info(`contract '${name}': accepting pre-0.21.0 generation digest ${recorded.slice(0, 16)}… (same CommonJS artifact; the digest format gained the module-format section)`);
    }
    return true;
}

/** Throws unless a stored job or result was created for the build the name points to today. */
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
 * Names from `cds.requires.nightgate.contracts`. They are fixed: registrations at
 * runtime may add names but never change or remove one of these.
 */
const configNames = new Set<string>();

export function isConfigRegisteredContract(name: string): boolean {
    return configNames.has(name);
}

export function listRegisteredContracts(): string[] {
    return Array.from(registry.keys());
}

export function getContractRegistration(name: string): Readonly<ContractRegistration> | undefined {
    return registry.get(name);
}

// This file lives at <root>/srv/submission/. The contract packages are dependencies of this package.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

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

/** An entry is either `{ package }` or `{ artifactPath, privateStateId, zkConfigPath, slotWidth? }`. */
export function loadRegistryFromConfig(config?: NightgatePluginConfig, baseDir = process.cwd()): void {
    const contracts = config?.contracts;
    if (!contracts || typeof contracts !== 'object') return;
    for (const [name, reg] of Object.entries(contracts)) {
        const r = reg as Partial<ContractRegistration> & { package?: string };
        let resolved: ContractRegistration;
        if (typeof r?.package === 'string' && r.package) {
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
 * Resolves a contract, optionally only if it matches `expectedDigest`. The registration is read
 * once and checked before any import, so a parallel re-registration cannot swap it.
 */
export async function resolveContract(name: string, expectedDigest?: string, opts: { compile?: boolean } = {}): Promise<ResolvedContract> {
    const reg = registry.get(name);
    if (!reg) {
        const available = listRegisteredContracts();
        throw new ContractNotRegisteredError(name, available);
    }
    let digest: string | undefined;
    if (expectedDigest !== undefined) {
        // For a job nothing is imported here and the worker hashes its own copy, so the cheap
        // cached digest is enough. A main-thread import hashes the files fresh.
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
        // The worker copies these files, so prover keys must be on disk first.
        // This runs after the digest check, so an outdated job never starts a download.
        const { fetched } = await ensureProverKeys(name, reg, { log: (m) => cds.log('nightgate').info(m) });
        if (fetched.length) cds.log('nightgate').info(`contract '${name}': ${fetched.length} prover key(s) fetched on first need`);
    }
    // Jobs never import on the main thread, because the module would stay in Node's cache.
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

/** file:// URL with the digest in the query. Node caches ESM per URL, so each build loads as its own module. */
export function artifactImportSpec(artifactPath: string, generation: string): string {
    if (!path.isAbsolute(artifactPath)) return artifactPath;
    const url = pathToFileURL(artifactPath);
    url.searchParams.set('gen', generation.slice(0, 32));
    return url.href;
}

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
 * Imports the module of one specific build. Node caches CommonJS by file name and
 * ignores the query, so the CommonJS cache entry is removed first.
 */
export async function importArtifactGeneration(artifactPath: string, generation: string): Promise<any> {
    if (path.isAbsolute(artifactPath)) {
        try {
            const resolved = require.resolve(artifactPath);
            delete require.cache[resolved];
        } catch { /* not a CommonJS module, fine for ESM */ }
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
