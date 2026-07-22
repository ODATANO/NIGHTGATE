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

export function registerContract(name: string, reg: ContractRegistration): void {
    if (!name || !reg.artifactPath || !reg.privateStateId || !reg.zkConfigPath) {
        throw new Error('registerContract: all fields are required');
    }
    registry.set(name, reg);
}

export function unregisterContract(name: string): boolean {
    return registry.delete(name);
}

export function clearRegistry(): void {
    registry.clear();
}

export function listRegisteredContracts(): string[] {
    return Array.from(registry.keys());
}

/**
 * Look up a registered contract's stored registration (absolute paths) without
 * importing the artifact. Used by the zk-config HTTP route to resolve a
 * contract's `zkConfigPath` cheaply. Returns undefined for unknown names,
 * which the route maps to 404 (the registry is the security boundary: only
 * registered contracts are servable).
 */
export function getContractRegistration(name: string): ContractRegistration | undefined {
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

export async function resolveContract(name: string): Promise<ResolvedContract> {
    const reg = registry.get(name);
    if (!reg) {
        const available = listRegisteredContracts();
        throw new ContractNotRegisteredError(name, available);
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
