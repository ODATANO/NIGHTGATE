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

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';

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
}

export interface ResolvedContract {
    compiledContract: unknown;
    privateStateId: string;
    zkConfigPath: string;
    /**
     * Absolute path the worker uses to re-import the Compact-emitted contract
     * module inside the worker thread (compiledContract itself doesn't survive a
     * thread boundary). Same value stored at registerContract() time.
     */
    artifactPath: string;
}

const registry = new Map<string, ContractRegistration>();
const generationDigests = new Map<string, string>();

export function registerContract(name: string, reg: ContractRegistration): void {
    if (!name || !reg.artifactPath || !reg.privateStateId || !reg.zkConfigPath) {
        throw new Error('registerContract: all fields are required');
    }
    // Store a FROZEN CLONE: the caller's object must not remain a live
    // handle into the registry (mutating it after registration would change
    // what the alias resolves to without going through registerContract,
    // silently bypassing the generation digest).
    registry.set(name, Object.freeze({ ...reg }));
    // A name is a MUTABLE alias; whatever generation it pointed at before is
    // no longer what it resolves to now.
    generationDigests.delete(name);
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
 * Uncached digest over a concrete registration SNAPSHOT's files. Used by
 * `resolveContract(name, expectedDigest)` so the check runs against exactly
 * the snapshot that is then imported (no check-then-resolve race) AND
 * against the files' CURRENT bytes (an asset overwritten under an unchanged
 * path in the running process fails the resolve instead of riding the
 * per-alias cache).
 */
function computeGenerationDigest(reg: ContractRegistration): string {
    const hash = crypto.createHash('sha256');
    const section = (label: string, data: Buffer | string) => {
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
        hash.update(`${label}:${buf.length}\n`);
        hash.update(buf);
    };
    section('module', fs.readFileSync(reg.artifactPath));
    section('privateStateId', reg.privateStateId);
    const assetDir = (sub: string, filter: (f: string) => boolean) => {
        const dir = path.join(reg.zkConfigPath, sub);
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir).filter(filter).sort();
        } catch { /* asset-less artifacts (pure-circuit-only) skip the section */ }
        for (const f of files) section(`${sub}/${f}`, fs.readFileSync(path.join(dir, f)));
    };
    assetDir('keys', (f) => f.endsWith('.verifier') || f.endsWith('.prover'));
    assetDir('zkir', () => true);
    return hash.digest('hex');
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
    if (recorded !== current) {
        throw new Error(
            `${what} was created against artifact generation ${recorded.slice(0, 16)}… but '${name}' now ` +
            `resolves to ${current.slice(0, 16)}…. Refusing to execute against a different generation; ` +
            `re-register the original artifact under this name (or a versioned alias) to proceed.`);
    }
}

export function unregisterContract(name: string): boolean {
    generationDigests.delete(name);
    return registry.delete(name);
}

export function clearRegistry(): void {
    registry.clear();
    generationDigests.clear();
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
        registerContract(name, {
            artifactPath:   resolveContractPath(r.artifactPath, baseDir),
            privateStateId: r.privateStateId,
            zkConfigPath:   resolveContractPath(r.zkConfigPath, baseDir)
        });
    }
}

/**
 * Resolve a registered contract, optionally pinned to an expected artifact
 * GENERATION. With `expectedDigest`, the registration snapshot is captured
 * ONCE, its digest is recomputed from the files' current bytes (no cache)
 * and compared BEFORE anything is imported, and the import then uses exactly
 * that snapshot: a concurrent `registerContract` between check and use
 * cannot swap generations, and an asset overwritten in place fails closed.
 */
export async function resolveContract(name: string, expectedDigest?: string): Promise<ResolvedContract> {
    const reg = registry.get(name);
    if (!reg) {
        const available = listRegisteredContracts();
        throw new ContractNotRegisteredError(name, available);
    }
    if (expectedDigest !== undefined) {
        const current = computeGenerationDigest(reg);
        if (current !== expectedDigest) {
            throw new Error(
                `Contract '${name}' currently resolves to artifact generation ${current.slice(0, 16)}… but ` +
                `${expectedDigest.slice(0, 16)}… was recorded. Refusing to load a different generation; ` +
                `re-register the original artifact under this name (or a versioned alias) to proceed.`);
        }
    }
    // Node's ESM loader on Windows rejects raw `C:\...` paths in dynamic
    // import, must be a file:// URL. pathToFileURL handles both platforms.
    const importSpec = path.isAbsolute(reg.artifactPath)
        ? pathToFileURL(reg.artifactPath).href
        : reg.artifactPath;
    const mod: any = await import(importSpec);
    const ContractClass = mod.Contract ?? mod.default ?? mod;

    // midnight-js-contracts expects a `CompiledContract` wrapper around the raw
    // Compact-emitted `Contract` class, not the class itself: it attaches
    // witnesses + ZK asset paths (keys/, zkir/) and the Symbol-keyed CompactContext
    // that `deployContract` reads. Pattern from example-counter:
    //   CompiledContract.make(name, Contract)
    //     .pipe(withVacantWitnesses, withCompiledFileAssets(zkConfigPath))
    const compactJs: any = await import('@midnight-ntwrk/compact-js');
    // CompiledContract is re-exported at top level from `effect/CompiledContract`.
    const CompiledContract = compactJs.CompiledContract ?? compactJs.effect?.CompiledContract;
    if (!CompiledContract?.make) {
        throw new Error(`CompiledContract.make not found in @midnight-ntwrk/compact-js exports; got keys: ${Object.keys(compactJs).join(',')}`);
    }
    const compiledContract = CompiledContract.make(name, ContractClass).pipe(
        CompiledContract.withVacantWitnesses,
        CompiledContract.withCompiledFileAssets(reg.zkConfigPath)
    );

    return {
        compiledContract,
        privateStateId: reg.privateStateId,
        zkConfigPath: reg.zkConfigPath,
        artifactPath: reg.artifactPath
    };
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
