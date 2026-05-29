/**
 * Compiled-contract registry.
 *
 * The OData submission actions (T6) accept a string `compiledArtifactRef`
 * (e.g. "attestation-vault") and resolve it through this registry to:
 *   - the compiled contract module (Compact `compactc` output under
 *     `<base>/<name>/src/managed/<name>/contract/`)
 *   - the contract's `privateStateId`
 *   - the `zkConfigPath` the SDK's NodeZkConfigProvider reads from
 *
 * The registry is in-memory and starts empty. T10 (AttestationVault Compact
 * contract) is the first consumer; until a contract is registered, the
 * OData actions return a clear 404-style error rather than failing somewhere
 * deep in the SDK.
 *
 * Registration shape is loaded from `cds.requires.nightgate.contracts` if
 * present:
 *
 *   contracts: {
 *     "attestation-vault": {
 *       artifactPath:   "<repo>/contracts/attestation-vault/src/managed/attestation-vault/contract/index.js",
 *       privateStateId: "attestationVaultPrivateState",
 *       zkConfigPath:   "<repo>/contracts/attestation-vault/src/managed/attestation-vault"
 *     }
 *   }
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// Package root (…/node_modules/@odatano/nightgate when installed). contract-registry
// lives at <root>/srv/submission/, so ../.. is the package root.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve a configured contract path. Absolute paths pass through. For a
 * RELATIVE path we prefer the package root when the target exists there — this
 * is how the BUNDLED contracts (counter, attestation-vault, shipped under the
 * package's contracts/ dir) resolve correctly in a consumer app, where
 * process.cwd() is the consumer's project root, not node_modules/@odatano/nightgate.
 * A consumer's OWN relative path (not present under the package) falls back to
 * baseDir (cwd), preserving the prior behaviour for consumer-registered contracts.
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
     * Absolute path (or file:// URL on Windows) the worker uses to dynamic-
     * import the Compact-emitted contract module. Same value the registry
     * stored at registerContract() time, already normalised to absolute.
     * Surfaced so Phase 2b's wallet-worker handler can re-import inside the
     * worker thread (compiledContract itself doesn't survive a thread boundary).
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

    // The midnight-js-contracts SDK expects a `CompiledContract` wrapper around
    // the raw Compact-emitted `Contract` class, not the class itself. The wrapper
    // attaches witnesses + ZK asset paths (keys/, zkir/) and adds the Symbol-keyed
    // CompactContext that `deployContract` reads. Pattern from example-counter:
    //   CompiledContract.make(name, Contract)
    //     .pipe(withVacantWitnesses, withCompiledFileAssets(zkConfigPath))
    const compactJs: any = await import('@midnight-ntwrk/compact-js');
    // CompiledContract namespace lives under `effect/CompiledContract` in the
    // compact-js package — re-exported at the top level.
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
