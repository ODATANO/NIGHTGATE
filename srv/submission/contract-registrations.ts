/**
 * Contracts registered while the server runs. They are saved and loaded again at boot.
 * Contracts named in the config cannot be changed or removed this way.
 * Loading a contract runs its code, so paths must stay inside `NIGHTGATE_CONTRACTS_DIR`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cds from '@sap/cds';
import { Worker } from 'node:worker_threads';
import { withKeyedLock } from '../utils/keyed-lock';
import {
    registerContract,
    unregisterContract,
    getContractRegistration,
    listRegisteredContracts,
    isConfigRegisteredContract,
    getArtifactGenerationDigest,
    slotWidthOf,
    type ContractRegistration
} from './contract-registry';
import { effectiveModuleFormat, runtimeNodeModulesDir } from './artifact-digest';
import { hasAllProverKeys } from './prover-keys';
import { configString } from '../utils/config';
import type { DbRunner } from '../utils/db-types';
import { NightgateError, errorMessage } from '../utils/errors';

const log = cds.log('nightgate:contracts');

export class ContractRegistrationError extends NightgateError {
    constructor(status: number, message: string) {
        super('CONTRACT_REGISTRATION_REJECTED', message, { status });
    }
    /** @deprecated use `status`. */
    get httpStatus(): number { return this.status; }
}

export interface RuntimeRegistrationInput {
    name: string;
    artifactPath: string;
    zkConfigPath: string;
    privateStateId: string;
    slotWidth?: number | null;
}

export interface ContractListing {
    name: string;
    source: 'config' | 'runtime';
    artifactPath: string;
    zkConfigPath: string;
    privateStateId: string;
    slotWidth: number;
    artifactDigest: string | null;
    hasProverKeys: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function allowedContractRoots(): string[] {
    const raw = configString('NIGHTGATE_CONTRACTS_DIR');
    const roots = raw
        ? raw.split(path.delimiter).map(s => s.trim()).filter(Boolean)
        : [path.join(process.cwd(), 'contracts')];
    const canonical = roots.map(r => {
        const abs = path.resolve(r);
        try { return fs.realpathSync(abs); } catch { return abs; }
    });
    return Array.from(new Set(canonical));
}

function insideRoots(absolute: string, roots: string[]): boolean {
    const target = path.resolve(absolute);
    return roots.some(root => {
        const rel = path.relative(root, target);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
}

function resolveInsideRoots(what: string, p: string, roots: string[]): string {
    if (typeof p !== 'string' || !p.trim()) throw new ContractRegistrationError(400, `${what} is required`);
    // Check the resolved path, so a symlink pointing outside the allowed folders is refused.
    const candidates = path.isAbsolute(p) ? [path.resolve(p)] : roots.map(r => path.resolve(r, p));
    let real: string | null = null;
    for (const candidate of candidates) {
        try { real = fs.realpathSync(candidate); break; } catch { /* next root */ }
    }
    if (!real) {
        throw new ContractRegistrationError(400, `${what} does not exist: ${candidates.length === 1 ? candidates[0] : `${p} (tried under ${roots.join(path.delimiter)})`}`);
    }
    if (!insideRoots(real, roots)) {
        throw new ContractRegistrationError(400,
            `${what} must be inside NIGHTGATE_CONTRACTS_DIR (${roots.join(path.delimiter)}); got ${real}`);
    }
    return real;
}

/**
 * Load a copy of the compiled contract in a short-lived worker, so the main process never loads it.
 * A node_modules link next to the copy lets its runtime import resolve.
 */
export function probeArtifactModule(artifactPath: string, timeoutMs = 60_000): Promise<{ ok: boolean; hasContract: boolean; error?: string }> {
    let probeDir: string | null = null;
    const cleanup = () => { if (probeDir) { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } probeDir = null; } };
    let importPath: string;
    try {
        probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightgate-artifact-probe-'));
        fs.symlinkSync(runtimeNodeModulesDir(), path.join(probeDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        importPath = path.join(probeDir, effectiveModuleFormat(artifactPath) === 'module' ? 'artifact.mjs' : 'artifact.cjs');
        fs.copyFileSync(artifactPath, importPath);
    } catch (e) {
        cleanup();
        return Promise.resolve({ ok: false, hasContract: false, error: errorMessage(e) });
    }
    return probeCopiedModule(importPath, timeoutMs).finally(cleanup);
}

function probeCopiedModule(artifactPath: string, timeoutMs: number): Promise<{ ok: boolean; hasContract: boolean; error?: string }> {
    const code = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { pathToFileURL } = require('node:url');
        (async () => {
            try {
                const m = await import(pathToFileURL(workerData.artifactPath).href);
                const C = m && (m.Contract ?? m.default);
                parentPort.postMessage({ ok: true, hasContract: typeof C === 'function' });
            } catch (e) {
                parentPort.postMessage({ ok: false, hasContract: false, error: String((e && e.message) || e) });
            }
        })();`;
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (r: { ok: boolean; hasContract: boolean; error?: string }) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(r); } };
        let w: Worker;
        try {
            w = new Worker(code, { eval: true, workerData: { artifactPath } });
        } catch (e) {
            return done({ ok: false, hasContract: false, error: errorMessage(e) });
        }
        timer = setTimeout(() => { done({ ok: false, hasContract: false, error: `import did not finish within ${timeoutMs}ms` }); void w.terminate(); }, timeoutMs);
        w.once('message', (m: any) => { done({ ok: !!m?.ok, hasContract: !!m?.hasContract, error: m?.error }); void w.terminate(); });
        w.once('error', (e) => done({ ok: false, hasContract: false, error: errorMessage(e) }));
        w.once('exit', (code) => done({ ok: false, hasContract: false, error: `validation worker exited with code ${code} before reporting` }));
    });
}

/** Validate without changing the registry. Returns the registration with absolute paths. */
export async function validateRuntimeRegistration(input: RuntimeRegistrationInput): Promise<ContractRegistration & { hasProverKeys: boolean }> {
    const name = String(input.name ?? '').trim();
    if (!NAME_RE.test(name)) {
        throw new ContractRegistrationError(400, `name must match ${NAME_RE} (lowercase, digits, '.', '_', '-'; max 100)`);
    }
    if (typeof input.privateStateId !== 'string' || !input.privateStateId.trim() || input.privateStateId.length > 200) {
        throw new ContractRegistrationError(400, 'privateStateId is required (max 200 characters)');
    }
    let slotWidth: number | undefined;
    if (input.slotWidth !== undefined && input.slotWidth !== null) {
        slotWidth = Number(input.slotWidth);
        if (![8, 16, 32].includes(slotWidth)) throw new ContractRegistrationError(400, 'slotWidth must be 8, 16 or 32');
    }
    const roots = allowedContractRoots();
    const artifactPath = resolveInsideRoots('artifactPath', input.artifactPath, roots);
    const zkConfigPath = resolveInsideRoots('zkConfigPath', input.zkConfigPath, roots);
    if (!fs.statSync(artifactPath).isFile()) throw new ContractRegistrationError(400, `artifactPath is not a file: ${artifactPath}`);
    if (!fs.statSync(zkConfigPath).isDirectory()) throw new ContractRegistrationError(400, `zkConfigPath is not a directory: ${zkConfigPath}`);

    const keysDir = path.join(zkConfigPath, 'keys');
    let keyFiles: string[] = [];
    try { keyFiles = fs.readdirSync(keysDir); } catch { /* reported below */ }
    if (!keyFiles.some(f => f.endsWith('.verifier'))) {
        throw new ContractRegistrationError(400, `zkConfigPath has no verifier keys under ${keysDir}`);
    }
    let zkirIsDir = false;
    try { zkirIsDir = fs.statSync(path.join(zkConfigPath, 'zkir')).isDirectory(); } catch { zkirIsDir = false; }
    if (!zkirIsDir) {
        throw new ContractRegistrationError(400, `zkConfigPath has no zkir/ directory: ${zkConfigPath}`);
    }
    const hasProverKeys = hasAllProverKeys(zkConfigPath);

    const probe = await probeArtifactModule(artifactPath);
    if (!probe.ok) {
        throw new ContractRegistrationError(400, `artifactPath does not import: ${probe.error ?? 'unknown error'}`);
    }
    if (!probe.hasContract) {
        throw new ContractRegistrationError(400, 'artifactPath does not export a Compact `Contract` class');
    }

    return {
        artifactPath, zkConfigPath,
        privateStateId: input.privateStateId.trim(),
        ...(slotWidth !== undefined ? { slotWidth } : {}),
        hasProverKeys
    };
}

/** Registering a name again replaces the contract. Jobs created for the old version then refuse to run. */
export async function registerContractAtRuntime(
    db: DbRunner,
    input: RuntimeRegistrationInput,
    ctx: { registeredBy?: string; networkId?: string } = {}
): Promise<ContractListing> {
    const name = String(input.name ?? '').trim();
    // Lock per name, so the registry entry, its digest and the saved row always match.
    return withKeyedLock(registrationLockKey(name), () => registerContractAtRuntimeLocked(db, name, input, ctx));
}

const registrationLockKey = (name: string) => `contract-registration:${name}`;

async function registerContractAtRuntimeLocked(
    db: DbRunner,
    name: string,
    input: RuntimeRegistrationInput,
    ctx: { registeredBy?: string; networkId?: string }
): Promise<ContractListing> {
    if (isConfigRegisteredContract(name)) {
        throw new ContractRegistrationError(409,
            `'${name}' is registered from cds.requires.nightgate.contracts; the config is the immutable floor, change it and restart`);
    }
    const { hasProverKeys, ...registration } = await validateRuntimeRegistration({ ...input, name });

    const previous = getContractRegistration(name);
    registerContract(name, registration);
    let artifactDigest: string;
    try {
        artifactDigest = getArtifactGenerationDigest(name);
    } catch (e) {
        if (previous) registerContract(name, { ...previous }); else unregisterContract(name);
        throw new ContractRegistrationError(400, `artifact generation digest failed: ${errorMessage(e)}`);
    }

    const { UPSERT } = cds.ql as any;
    const row = {
        name,
        artifactPath: registration.artifactPath,
        zkConfigPath: registration.zkConfigPath,
        privateStateId: registration.privateStateId,
        slotWidth: registration.slotWidth ?? null,
        networkId: ctx.networkId ?? null,
        registeredBy: ctx.registeredBy ?? null
    };
    try {
        await db.run(UPSERT.into('midnight.ContractRegistrations').entries(row));
    } catch (e) {
        if (previous) registerContract(name, { ...previous }); else unregisterContract(name);
        throw e;
    }
    if (!hasProverKeys) {
        log.warn(`contract '${name}': no prover keys under ${registration.zkConfigPath}/keys; it deploys and verifies, but nothing can prove its circuits here`);
    }
    log.info(`contract '${name}' registered at runtime by ${ctx.registeredBy ?? 'admin'}: ${registration.artifactPath} (digest ${artifactDigest.slice(0, 16)}…${previous ? ', replaced a previous runtime registration' : ''})`);
    return describeContract(name, 'runtime')!;
}

export async function unregisterContractAtRuntime(
    db: DbRunner,
    name: string
): Promise<{ removed: boolean }> {
    if (isConfigRegisteredContract(name)) {
        throw new ContractRegistrationError(409, `'${name}' is registered from the config and cannot be removed at runtime`);
    }
    return withKeyedLock(registrationLockKey(name), async () => {
        const { DELETE } = cds.ql as any;
        const deleted = Number(await db.run(DELETE.from('midnight.ContractRegistrations').where({ name }))) || 0;
        const removed = unregisterContract(name) || deleted > 0;
        if (removed) log.info(`contract '${name}' unregistered at runtime`);
        return { removed };
    });
}

/** Runs at boot, after the config. Skips invalid rows and rows that clash with the config, but keeps them. Never throws. */
export async function loadPersistedRegistrations(db: DbRunner): Promise<string[]> {
    const { SELECT } = cds.ql as any;
    let rows: any[] = [];
    try {
        rows = (await db.run(SELECT.from('midnight.ContractRegistrations'))) as any[] ?? [];
    } catch (e) {
        // The table does not exist until the schema update has run.
        log.warn(`runtime contract registrations not loaded: ${errorMessage(e)}`);
        return [];
    }
    const loaded: string[] = [];
    for (const row of rows) {
        const name = String(row?.name ?? '');
        if (isConfigRegisteredContract(name)) {
            log.warn(`runtime registration '${name}' shadows a config contract; ignored (the config is the floor)`);
            continue;
        }
        try {
            const { hasProverKeys, ...registration } = await validateRuntimeRegistration({
                name, artifactPath: row.artifactPath, zkConfigPath: row.zkConfigPath,
                privateStateId: row.privateStateId, slotWidth: row.slotWidth
            });
            registerContract(name, registration);
            if (!hasProverKeys) log.warn(`contract '${name}': no prover keys under ${registration.zkConfigPath}/keys`);
            loaded.push(name);
        } catch (e) {
            log.warn(`runtime registration '${name}' skipped: ${errorMessage(e)}`);
        }
    }
    if (loaded.length) log.info(`Runtime-registered contracts: ${loaded.join(', ')}`);
    return loaded;
}

function describeContract(name: string, source: 'config' | 'runtime'): ContractListing | null {
    const reg = getContractRegistration(name);
    if (!reg) return null;
    let artifactDigest: string | null = null;
    try { artifactDigest = getArtifactGenerationDigest(name); } catch { /* reported as null */ }
    const hasProverKeys = hasAllProverKeys(reg.zkConfigPath);
    return {
        name, source,
        artifactPath: reg.artifactPath, zkConfigPath: reg.zkConfigPath, privateStateId: reg.privateStateId,
        slotWidth: slotWidthOf(reg), artifactDigest, hasProverKeys
    };
}

export function listContracts(): ContractListing[] {
    return listRegisteredContracts()
        .map(name => describeContract(name, isConfigRegisteredContract(name) ? 'config' : 'runtime'))
        .filter((c): c is ContractListing => c !== null);
}
