/**
 * Contracts registered at runtime (0.21.0): admin action + `ContractRegistrations`
 * table, reloaded at boot. The config is the immutable floor: a runtime row may
 * add a name, never re-point or remove a config name. Importing an artifact
 * executes its module, so both paths must resolve inside a root of
 * `NIGHTGATE_CONTRACTS_DIR` (default: the package's and the cwd's `contracts/`).
 * Validation completes before the registry or the table changes.
 */
import fs from 'node:fs';
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

const log = cds.log('nightgate:contracts');
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

export class ContractRegistrationError extends Error {
    constructor(public readonly httpStatus: number, message: string) {
        super(message);
        this.name = 'ContractRegistrationError';
    }
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

/** The directories a runtime registration may point into. */
export function allowedContractRoots(): string[] {
    const raw = process.env.NIGHTGATE_CONTRACTS_DIR?.trim();
    const roots = raw
        ? raw.split(path.delimiter).map(s => s.trim()).filter(Boolean)
        : [path.join(PACKAGE_ROOT, 'contracts'), path.join(process.cwd(), 'contracts')];
    // Real paths (symlinks/junctions resolved) for the containment check; a
    // root that does not exist stays as resolved.
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
    // A relative path is tried under every root, first existing wins; an
    // absolute one must land inside a root. Containment is checked on the
    // real path, so a symlink out of the roots does not pass.
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
 * Import the artifact in a disposable worker thread and report whether it
 * exports a contract class. The main process keeps no module instance of it.
 */
export function probeArtifactModule(artifactPath: string, timeoutMs = 60_000): Promise<{ ok: boolean; hasContract: boolean; error?: string }> {
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
            return done({ ok: false, hasContract: false, error: String((e as Error)?.message ?? e) });
        }
        timer = setTimeout(() => { done({ ok: false, hasContract: false, error: `import did not finish within ${timeoutMs}ms` }); void w.terminate(); }, timeoutMs);
        w.once('message', (m: any) => { done({ ok: !!m?.ok, hasContract: !!m?.hasContract, error: m?.error }); void w.terminate(); });
        w.once('error', (e) => done({ ok: false, hasContract: false, error: String((e as Error)?.message ?? e) }));
        w.once('exit', (code) => done({ ok: false, hasContract: false, error: `validation worker exited with code ${code} before reporting` }));
    });
}

/**
 * Validate the input without touching the registry: paths contained and
 * existing, module importable and exporting a contract class, zk assets
 * present. Returns the absolute registration.
 */
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
    const hasProverKeys = keyFiles.some(f => f.endsWith('.prover'));

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

/**
 * Register a contract on the running server: validate, register in memory,
 * persist. Re-registering a runtime name under a new artifact is a new
 * generation (jobs recorded against the old one refuse). Config names: 409.
 */
export async function registerContractAtRuntime(
    db: any,
    input: RuntimeRegistrationInput,
    ctx: { registeredBy?: string; networkId?: string } = {}
): Promise<ContractListing> {
    const name = String(input.name ?? '').trim();
    // One mutation per alias at a time: registry entry, digest and persisted
    // row must belong to the same generation.
    return withKeyedLock(registrationLockKey(name), () => registerContractAtRuntimeLocked(db, name, input, ctx));
}

const registrationLockKey = (name: string) => `contract-registration:${name}`;

async function registerContractAtRuntimeLocked(
    db: any,
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
        // Roll back to the previous alias target.
        if (previous) registerContract(name, { ...previous }); else unregisterContract(name);
        throw new ContractRegistrationError(400, `artifact generation digest failed: ${String((e as Error)?.message ?? e)}`);
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

/** Remove a runtime registration (memory + table). Config names refuse (409). */
export async function unregisterContractAtRuntime(
    db: any,
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

/**
 * Boot: load persisted runtime registrations after the config. A row naming a
 * config contract or failing validation is skipped with a warning and stays
 * in the table. Never throws.
 */
export async function loadPersistedRegistrations(db: any): Promise<string[]> {
    const { SELECT } = cds.ql as any;
    let rows: any[] = [];
    try {
        rows = (await db.run(SELECT.from('midnight.ContractRegistrations'))) as any[] ?? [];
    } catch (e) {
        // Table missing until the schema delta ran: nothing to load.
        log.warn(`runtime contract registrations not loaded: ${String((e as Error)?.message ?? e)}`);
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
            log.warn(`runtime registration '${name}' skipped: ${String((e as Error)?.message ?? e)}`);
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
    let hasProverKeys = false;
    try { hasProverKeys = fs.readdirSync(path.join(reg.zkConfigPath, 'keys')).some(f => f.endsWith('.prover')); } catch { /* none */ }
    return {
        name, source,
        artifactPath: reg.artifactPath, zkConfigPath: reg.zkConfigPath, privateStateId: reg.privateStateId,
        slotWidth: slotWidthOf(reg), artifactDigest, hasProverKeys
    };
}

/** Every registered contract with its source and generation digest. */
export function listContracts(): ContractListing[] {
    return listRegisteredContracts()
        .map(name => describeContract(name, isConfigRegisteredContract(name) ? 'config' : 'runtime'))
        .filter((c): c is ContractListing => c !== null);
}
