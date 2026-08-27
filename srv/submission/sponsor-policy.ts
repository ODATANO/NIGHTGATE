/**
 * Sponsor shape policy: which contract calls a fee sponsor pays for.
 * Floor: `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS` / `_CIRCUITS` from the env, or a
 * JSON file `{ allowedContracts, allowedCircuits, allowDeploy }` at
 * `NIGHTGATE_SPONSOR_POLICY_FILE`, re-read on mtime change, fail-closed when
 * unusable (last good policy, else every sponsored call refused). Grant: effective = floor ∩ grant.
 * Empty floor list = unrestricted; empty grant list = inherit; non-empty lists with empty intersection = 403.
 */
import fs from 'node:fs';
import cds from '@sap/cds';

const log = cds.log('nightgate:sponsor-policy');

export interface SponsorPolicy {
    allowedContracts: string[];
    allowedCircuits: string[];
    /**
     * The sponsor also pays for a caller-built contract deploy. Floor
     * (`NIGHTGATE_SPONSOR_ALLOW_DEPLOY=true` or the policy file's `allowDeploy`)
     * and, for a token caller, the grant must both allow it. A deploy is never
     * matched against `allowedContracts`; the landed address is recorded onto
     * the grant afterwards. Absent = false.
     */
    allowDeploy?: boolean;
    /**
     * Addresses deployed under the requesting grant. Calls on them are exempt
     * from `allowedCircuits`: the circuit floor names the shared contracts'
     * circuits, a grant-deployed contract has its own; without the exemption a
     * server with a circuit floor could sponsor the deploy but never a call
     * on it. The byte ceiling still applies. Absent/empty = no exemption.
     */
    ownContracts?: string[];
}

export interface GrantPolicyInput {
    allowedContracts?: string[] | null;
    allowedCircuits?: string[] | null;
    allowDeploy?: boolean | null;
    /** Addresses deployed under this grant; sponsorable on top of `floor ∩ grant`. */
    deployedContracts?: string[] | null;
}

/** Upper bound per list; a grant is one consumer, not a registry. */
export const MAX_POLICY_ENTRIES = 256;
const MAX_ENTRY_LENGTH = 130;

/**
 * Validate one allow-list from an operator (grant creation, policy file).
 * Returns the trimmed, de-duplicated list or throws naming the offending
 * entry. Entries are hex addresses (optional 0x) or Compact identifiers;
 * anything else is refused rather than silently never matching.
 */
export function validatePolicyList(name: string, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`${name} must be an array of strings`);
    if (raw.length > MAX_POLICY_ENTRIES) throw new Error(`${name} has ${raw.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed`);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') throw new Error(`${name} entries must be strings`);
        const v = entry.trim();
        if (!v) throw new Error(`${name} contains an empty entry`);
        if (v.length > MAX_ENTRY_LENGTH) throw new Error(`${name} entry '${v.slice(0, 16)}…' is longer than ${MAX_ENTRY_LENGTH} characters`);
        if (!/^[A-Za-z0-9_]+$/.test(v)) throw new Error(`${name} entry '${v.slice(0, 32)}' is not a contract address or circuit name`);
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

// ---- Platform floor --------------------------------------------------------

const parseEnvList = (raw: string | undefined): string[] =>
    String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean);

const envFlag = (raw: string | undefined): boolean => /^(1|true|yes|on)$/i.test(String(raw ?? '').trim());

function envPolicy(): SponsorPolicy {
    return {
        allowedContracts: parseEnvList(process.env.NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS),
        allowedCircuits: parseEnvList(process.env.NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS),
        allowDeploy: envFlag(process.env.NIGHTGATE_SPONSOR_ALLOW_DEPLOY)
    };
}

interface FileCache {
    path: string;
    mtimeMs: number;
    size: number;
    policy: SponsorPolicy | null; // null = the current file is unusable
    lastGood: SponsorPolicy | null;
}
let fileCache: FileCache | null = null;

/** Test seam: forget the cached file state. */
export function __resetSponsorPolicyForTests(): void {
    fileCache = null;
}

export class SponsorPolicyUnavailableError extends Error {
    readonly httpStatus = 503;
    readonly status = 503;
    readonly code = 'SPONSOR_POLICY_UNAVAILABLE';
    readonly $sanitize = false;
    constructor(message: string) {
        super(message);
        this.name = 'SponsorPolicyUnavailableError';
    }
}

function readPolicyFile(filePath: string): SponsorPolicy {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('policy file must be a JSON object');
    }
    const unknownKeys = Object.keys(parsed).filter(k => k !== 'allowedContracts' && k !== 'allowedCircuits' && k !== 'allowDeploy');
    if (unknownKeys.length) throw new Error(`policy file has unknown keys: ${unknownKeys.join(', ')}`);
    if (parsed.allowDeploy !== undefined && typeof parsed.allowDeploy !== 'boolean') throw new Error('allowDeploy must be a boolean');
    return {
        allowedContracts: validatePolicyList('allowedContracts', parsed.allowedContracts),
        allowedCircuits: validatePolicyList('allowedCircuits', parsed.allowedCircuits),
        allowDeploy: parsed.allowDeploy === true
    };
}

/**
 * The current platform floor: env when no file is configured, else the file,
 * re-read when mtime/size changed (one stat per call). Throws
 * `SponsorPolicyUnavailableError` (503) when a configured file is unusable and
 * no good policy was loaded before.
 */
export function getGlobalSponsorPolicy(): SponsorPolicy {
    const filePath = process.env.NIGHTGATE_SPONSOR_POLICY_FILE?.trim();
    if (!filePath) return envPolicy();

    let stat: fs.Stats | null = null;
    let statError: unknown = null;
    try { stat = fs.statSync(filePath); } catch (e) { statError = e; }

    const unchanged = fileCache && fileCache.path === filePath && stat
        && fileCache.mtimeMs === stat.mtimeMs && fileCache.size === stat.size;
    if (unchanged) {
        if (fileCache!.policy) return fileCache!.policy;
        // Already logged for this mtime; keep the fail-closed decision.
        if (fileCache!.lastGood) return fileCache!.lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} is unusable and no policy was loaded before; refusing to sponsor`);
    }

    const lastGood = fileCache?.path === filePath ? fileCache.lastGood : null;
    if (!stat) {
        // Still missing since the last call: the same fail-closed decision,
        // said ONCE (a permanently absent file must not log per request).
        if (fileCache?.path === filePath && fileCache.mtimeMs === -1) {
            if (lastGood) return lastGood;
            throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} cannot be read and no policy was loaded before; refusing to sponsor`);
        }
        log.error(`sponsor policy file ${filePath} cannot be read (${String((statError as Error)?.message ?? statError)}); ` +
            (lastGood ? 'keeping the last good policy' : 'no policy loaded yet, refusing every sponsored call'));
        fileCache = { path: filePath, mtimeMs: -1, size: -1, policy: null, lastGood };
        if (lastGood) return lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} cannot be read and no policy was loaded before; refusing to sponsor`);
    }
    try {
        const policy = readPolicyFile(filePath);
        fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, policy, lastGood: policy };
        log.info(`sponsor policy reloaded from ${filePath}: ${policy.allowedContracts.length} contract(s), ${policy.allowedCircuits.length} circuit(s)` +
            (policy.allowedContracts.length === 0 ? ' (contracts unrestricted)' : '') +
            (policy.allowedCircuits.length === 0 ? ' (circuits unrestricted)' : ''));
        return policy;
    } catch (e) {
        log.error(`sponsor policy file ${filePath} is invalid (${String((e as Error)?.message ?? e)}); ` +
            (lastGood ? 'keeping the last good policy' : 'no policy loaded yet, refusing every sponsored call'));
        fileCache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, policy: null, lastGood };
        if (lastGood) return lastGood;
        throw new SponsorPolicyUnavailableError(`sponsor policy file ${filePath} is invalid and no policy was loaded before; refusing to sponsor`);
    }
}

// ---- Effective policy ------------------------------------------------------

export class SponsorPolicyEmptyError extends Error {
    readonly httpStatus = 403;
    readonly status = 403;
    readonly code = 'SPONSOR_POLICY_EMPTY';
    constructor(message: string) {
        super(message);
        this.name = 'SponsorPolicyEmptyError';
    }
}

function intersect(floor: string[], grant: string[] | null | undefined, what: string): string[] {
    if (!grant || grant.length === 0) return floor;      // inherit the floor
    if (floor.length === 0) return grant;                // floor unrestricted: the grant is the policy
    const both = grant.filter(g => floor.includes(g));
    if (both.length === 0) {
        throw new SponsorPolicyEmptyError(
            `this grant's ${what} (${grant.map(g => g.slice(0, 16)).join(', ')}) share nothing with the platform's ` +
            `sponsor allow-list; the grant cannot be sponsored here (revoke and re-issue it, or widen the platform policy)`);
    }
    return both;
}

/**
 * The lists a sponsored call runs under: the floor, narrowed by the grant if
 * present. Throws `SponsorPolicyEmptyError` (403) on an empty intersection,
 * before a job exists.
 */
export function effectiveSponsorPolicy(floor: SponsorPolicy, grant?: GrantPolicyInput | null): SponsorPolicy {
    const contracts = intersect(floor.allowedContracts, grant?.allowedContracts, 'allowedContracts');
    // Deployed addresses join after the intersection (no floor names them).
    // An unrestricted result (empty list) stays unrestricted.
    const deployed = [...new Set((grant?.deployedContracts ?? []).filter(a => typeof a === 'string' && a.length > 0))];
    const withDeployed = contracts.length === 0 || deployed.length === 0
        ? contracts
        : [...contracts, ...deployed.filter(a => !contracts.includes(a))];
    return {
        allowedContracts: withDeployed,
        allowedCircuits: intersect(floor.allowedCircuits, grant?.allowedCircuits, 'allowedCircuits'),
        // Floor must open it and, for a token caller, the grant must carry it.
        allowDeploy: floor.allowDeploy === true && (grant ? grant.allowDeploy === true : true),
        ...(deployed.length ? { ownContracts: deployed } : {})
    };
}

/** For the OData handlers: the current floor, narrowed by `req.agentGrant`. */
export function resolveSponsorPolicyForRequest(req: unknown): SponsorPolicy {
    const grant = (req as any)?.agentGrant as GrantPolicyInput | undefined;
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
}
