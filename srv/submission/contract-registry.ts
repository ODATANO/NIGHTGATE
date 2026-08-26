/**
 * Compiled-contract registry.
 *
 * The OData submission actions pass a string `compiledArtifactRef`
 * (e.g. "attestation-vault"), resolved here to the compiled contract module, its
 * `privateStateId`, and the `zkConfigPath` the SDK's NodeZkConfigProvider reads.
 *
 * In-memory, starts empty; until a contract is registered the OData actions
 * return a clear 404-style error rather than failing deep in the SDK.
 * Registrations load from `cds.requires.nightgate.contracts`
 * ({ artifactPath, privateStateId, zkConfigPath } per name).
 */

import cds from '@sap/cds';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { computeArtifactGenerationDigest, artifactGenerationMatch } from './artifact-digest';

// Package root (…/node_modules/@odatano/nightgate when installed). contract-registry
// lives at <root>/srv/submission/, so ../.. is the package root.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve a configured contract path. Absolute paths pass through. A relative
 * path prefers the package root when the target exists there, so the BUNDLED
 * contracts (counter, attestation-vault under the package's contracts/) resolve
 * in a consumer app where process.cwd() is the consumer's root, not
 * node_modules/@odatano/nightgate. A consumer's own relative path (not under the
 * package) falls back to baseDir (cwd).
 */
function resolveContractPath(p: string, baseDir: string): string {
    if (path.isAbsolute(p)) return p;
    const fromPackage = path.join(PACKAGE_ROOT, p);
    if (fs.existsSync(fromPackage)) return fromPackage;
    return path.join(baseDir, p);
}

export interface ContractRegistration {
    /** Absolute or relative path to the Compact-emitted JS contract module. Dynamic-imported on resolve. */
    artifactPath: string;
    /** Logical private-state ID, passed to deployContract / findDeployedContract. */
    privateStateId: string;
    /** Directory containing `keys/` and `zkir/` for NodeZkConfigProvider. */
    zkConfigPath: string;
    /**
     * Content-tree width of an attestation-vault-family artifact: how many
     * provable fields per document (16 for the classic vault, 32 for
     * `attestation-vault-32`). Drives every width-dependent validation and
     * claim-key computation; MUST match the compiled artifact's `Vector<N,...>`
     * witness shapes (a mismatch fails loudly at local proving, nothing is
     * submitted). Optional; absent means 16. Part of the generation digest
     * for NON-default widths (an alias re-pointed to a different width
     * changes path depth and integrity claim-key semantics and must trip
     * the guard); the default width adds no section, so every digest
     * recorded by earlier releases (all width 16) stays valid.
     */
    slotWidth?: number;
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
    /** Content-tree width of a vault-family artifact (16 default, 32 for attestation-vault-32). */
    slotWidth?: number;
    /**
     * Absolute path the worker uses to re-import the Compact-emitted contract
     * module inside the worker thread (compiledContract itself doesn't survive a
     * thread boundary). Same value stored at registerContract() time.
     */
    artifactPath: string;
    /** Generation digest of the resolved artifact (module + verifier keys). */
    artifactDigest: string;
}

const registry = new Map<string, ContractRegistration>();
const generationDigests = new Map<string, string>();

export function registerContract(name: string, reg: ContractRegistration): void {
    if (!name || !reg.artifactPath || !reg.privateStateId || !reg.zkConfigPath) {
        throw new Error('registerContract: all fields are required');
    }
    // 64 is deliberately NOT accepted: the mask path runs on JavaScript
    // 32-bit bitwise ops ((1 << 64) wraps) and a full unsigned 64-bit mask
    // does not survive Number or a signed Integer64 column. Measured, but
    // shipping it needs a BigInt/String mask path first.
    if (reg.slotWidth !== undefined
        && (![8, 16, 32].includes(reg.slotWidth))) {
        throw new Error(`registerContract: slotWidth must be 8, 16 or 32 (got ${String(reg.slotWidth)})`);
    }
    // Store a FROZEN CLONE: the caller's object must not remain a live
    // handle into the registry (mutating it after registration would change
    // what the alias resolves to without going through registerContract,
    // silently bypassing the generation digest).
    registry.set(name, Object.freeze({ ...reg }));
    // A name is a MUTABLE alias; whatever generation it pointed at before is
    // no longer what it resolves to now.
    generationDigests.delete(name);
    currentDigestCache.delete(name);
}

/**
 * Canonical digest of the FULL REGISTRATION a registered name currently
 * resolves to: the Compact-emitted contract module, the `privateStateId`,
 * and every proving-relevant asset under `zkConfigPath` (`keys/*.verifier`,
 * `keys/*.prover`, `zkir/*`), each bound with a length-prefixed section
 * label so file/field boundaries cannot be confused. The registry name is a
 * mutable alias (`registerContract` overwrites), so persisted commands and
 * evidence rows record THIS digest at creation time and the
 * executor/verifier compares it fail-closed at resolve time; a re-pointed
 * alias (upgrade, re-config, or the same paths under a DIFFERENT
 * privateStateId, i.e. a different attester identity for the vault) can
 * then never silently execute or verify against a different registration.
 * Cached per name; the cache is invalidated by register/unregister/clear.
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

/**
 * How long a cached current-digest may be trusted before it is recomputed
 * regardless of what the stat metadata says. Bounds the residual risk below.
 */
const CURRENT_DIGEST_MAX_AGE_MS = (() => {
    const raw = Number(process.env.NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 60 * 1000;
})();

/**
 * Cheap change detector: the files' identities and metadata, without reading a
 * byte of content.
 *
 * Size and mtime alone are not enough. A rebuild can produce a byte-different
 * artifact of the same size, and an atomic replace (write temp, rename) or a
 * restore from a reproducible-build archive can carry the ORIGINAL mtime over,
 * leaving both unchanged. So the inode and ctime come along: a rename puts a
 * different inode in place, and ctime moves on any metadata change including a
 * permission flip, neither of which a writer can preserve while replacing a
 * file. Belt and braces, since the failure mode is reporting an artifact swap
 * as no-change while every job is being refused for exactly that swap; the
 * caller additionally re-hashes on a timer.
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
 * Digest over the registration's files as they are ON DISK RIGHT NOW. This is
 * what `resolveContract` compares against, so it is also the only honest
 * answer for monitoring: after an in-place artifact overwrite the per-alias
 * cache still reports the generation the process LOADED, while every job is
 * being refused against this one.
 *
 * Hashing those files is NOT cheap: the default registration set is around
 * 200 MB of prover, verifier and zkir assets, so recomputing it per request
 * blocks the event loop for hundreds of milliseconds and a handful of polls
 * would starve the process. The result is therefore memoised behind a
 * stat-only fingerprint (size, mtime, ctime, inode and mode per file), and
 * re-hashed anyway once the entry is older than
 * NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS (default 5 minutes) so no metadata
 * trick can pin a stale answer indefinitely. Repeated calls inside that window
 * cost a few stat() syscalls.
 *
 * `resolveContract` deliberately does NOT use this: its check must run against
 * the bytes it is about to import, with no cache between check and use.
 *
 * Throws like the cached accessor when the name is not registered.
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

/**
 * Uncached digest over a concrete registration SNAPSHOT's files. Used by
 * `resolveContract(name, expectedDigest)` so the check runs against exactly
 * the snapshot that is then imported (no check-then-resolve race) AND
 * against the files' CURRENT bytes (an asset overwritten under an unchanged
 * path in the running process fails the resolve instead of riding the
 * per-alias cache).
 */
function computeGenerationDigest(reg: ContractRegistration): string {
    // Algorithm in artifact-digest.ts (dependency-free); the wallet worker
    // recomputes the same digest from the files it loads.
    return computeArtifactGenerationDigest(reg);
}

const legacyDigestNoted = new Set<string>();
/**
 * The pre-0.21.0 digest form of an unchanged CommonJS artifact (no
 * module-format section; ESM digests never changed) is the same generation
 * and is accepted. Logged once per alias at INFO.
 */
function acceptsLegacyDigest(name: string, recorded: string): boolean {
    const reg = registry.get(name);
    if (!reg || artifactGenerationMatch(reg, recorded) !== 'legacy') return false;
    if (!legacyDigestNoted.has(name)) {
        legacyDigestNoted.add(name);
        cds.log('nightgate').info(`contract '${name}': accepting pre-0.21.0 generation digest ${recorded.slice(0, 16)}… (same CommonJS artifact; the digest format gained the module-format section)`);
    }
    return true;
}

/**
 * Fail-closed generation check for persisted commands and stored evidence.
 * `recorded === undefined` means the record predates 0.16.0's provenance
 * binding: refuse (the alias may have been re-pointed since; the caller
 * re-issues the action against the current generation deliberately).
 */
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
 * Look up a registered contract's stored registration (absolute paths) without
 * importing the artifact. Used by the zk-config HTTP route to resolve a
 * contract's `zkConfigPath` cheaply. Returns undefined for unknown names,
 * which the route maps to 404 (the registry is the security boundary: only
 * registered contracts are servable). The returned object is the stored
 * FROZEN snapshot: readonly by construction, so no caller can mutate the
 * registry through it.
 */
export function getContractRegistration(name: string): Readonly<ContractRegistration> | undefined {
    return registry.get(name);
}

/**
 * Load all contracts declared under `cds.requires.nightgate.contracts`.
 * Idempotent, safe to call multiple times.
 */
export function loadRegistryFromConfig(config?: Record<string, any>, baseDir = process.cwd()): void {
    const contracts = config?.contracts;
    if (!contracts || typeof contracts !== 'object') return;
    for (const [name, reg] of Object.entries(contracts)) {
        const r = reg as ContractRegistration;
        if (!r?.artifactPath || !r?.privateStateId || !r?.zkConfigPath) continue;
        const resolved = {
            artifactPath: resolveContractPath(r.artifactPath, baseDir),
            privateStateId: r.privateStateId,
            zkConfigPath: resolveContractPath(r.zkConfigPath, baseDir),
            ...(r.slotWidth !== undefined ? { slotWidth: Number(r.slotWidth) } : {})
        };
        registerContract(name, resolved);
        configNames.add(name);
        warnOnMissingProverKeys(name, resolved.zkConfigPath);
    }
}

/**
 * Verifier keys without prover keys: the contract deploys and its claims
 * verify, but its circuits cannot be proven here and `/zk-config` answers 404.
 * Said once at boot.
 */
function warnOnMissingProverKeys(name: string, zkConfigPath: string): void {
    let files: string[];
    try { files = fs.readdirSync(path.join(zkConfigPath, 'keys')); } catch { return; }
    const missing = files
        .filter(f => f.endsWith('.verifier'))
        .map(f => f.replace(/\.verifier$/, ''))
        .filter(circuit => !files.includes(`${circuit}.prover`));
    if (missing.length === 0) return;
    cds.log('nightgate').warn(
        `contract '${name}' has no prover keys for ${missing.length} circuit(s) ` +
        `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). Deploy and crawler-free ` +
        `verification work; PROVING those circuits here (and serving them over /zk-config) does not. ` +
        `Fetch them with "npx nightgate-fetch-keys ${name}" (they land in ${path.join(zkConfigPath, 'keys')}), ` +
        `then restart. Doing so changes this contract's artifact generation digest, so fetch before the first proof.`);
}

/**
 * Resolve a registered contract, optionally pinned to an expected artifact
 * GENERATION. With `expectedDigest`, the registration snapshot is captured
 * ONCE, its digest is recomputed from the files' current bytes (no cache)
 * and compared BEFORE anything is imported, and the import then uses exactly
 * that snapshot: a concurrent `registerContract` between check and use
 * cannot swap generations, and an asset overwritten in place fails closed.
 */
export async function resolveContract(name: string, expectedDigest?: string, opts: { compile?: boolean } = {}): Promise<ResolvedContract> {
    const reg = registry.get(name);
    if (!reg) {
        const available = listRegisteredContracts();
        throw new ContractNotRegisteredError(name, available);
    }
    let digest: string | undefined;
    if (expectedDigest !== undefined) {
        const current = computeGenerationDigest(reg);
        digest = current;
        // The pre-0.21.0 digest form of a CommonJS artifact is the same
        // generation; the worker is handed the current digest either way.
        if (current !== expectedDigest && artifactGenerationMatch(reg, expectedDigest) !== 'legacy') {
            throw new Error(
                `Contract '${name}' currently resolves to artifact generation ${current.slice(0, 16)}… but ` +
                `${expectedDigest.slice(0, 16)}… was recorded. Refusing to load a different generation; ` +
                `re-register the original artifact under this name (or a versioned alias) to proceed.`);
        }
    }
    digest ??= getArtifactGenerationDigest(name);
    // The main process imports no artifact for a job (the worker compiles from
    // the generation's snapshot; an import here stays in Node's module cache).
    // Only `compile: true` builds the main-thread CompiledContract wrapper.
    let compiledContract: unknown;
    if (opts.compile) {
        const mod: any = await importArtifactGeneration(reg.artifactPath, digest);
        const ContractClass = mod.Contract ?? mod.default ?? mod;
        // midnight-js-contracts expects a `CompiledContract` wrapper around the
        // raw Compact-emitted `Contract` class.
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

/**
 * Dynamic-import specifier for an artifact module of a given generation: a
 * file:// URL keyed by the digest, so an in-place revision is its own ESM
 * module instance (Node caches ESM per URL). Bare package specifiers are
 * returned as is.
 */
export function artifactImportSpec(artifactPath: string, generation: string): string {
    if (!path.isAbsolute(artifactPath)) return artifactPath;
    const url = pathToFileURL(artifactPath);
    url.searchParams.set('gen', generation.slice(0, 32));
    return url.href;
}

/**
 * Import an artifact module pinned to a generation, ESM or CommonJS. Node 22
 * serves a CommonJS module from its cache by filename regardless of the import
 * query, so the CJS cache entry is dropped first.
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

export class ContractNotRegisteredError extends Error {
    constructor(public readonly name: string, public readonly available: string[]) {
        super(
            available.length === 0
                ? `Contract '${name}' is not registered. No contracts are registered yet (register via cds.requires.nightgate.contracts or call registerContract()).`
                : `Contract '${name}' is not registered. Available: ${available.join(', ')}`
        );
        this.name = 'ContractNotRegisteredError';
    }
}
