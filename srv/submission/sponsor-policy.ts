/**
 * Which calls a fee sponsor pays for. Floor = env or `NIGHTGATE_SPONSOR_POLICY_FILE`
 * (fail-closed: last good policy, else refuse); effective = floor ∩ grant.
 * Empty floor list = unrestricted, empty grant list = inherit.
 */
import fs from 'node:fs';
import cds from '@sap/cds';
import { configList, configFlag, configString } from '../utils/config';

const log = cds.log('nightgate:sponsor-policy');

export interface SponsorPolicy {
    allowedContracts: string[];
    allowedCircuits: string[];
    /** Sponsor caller-built deploys; floor and (for a token caller) grant must both allow it. */
    allowDeploy?: boolean;
    /**
     * Addresses deployed under the grant. Exempt from `allowedCircuits`, which
     * names the shared contracts' circuits; the byte ceiling still applies.
     */
    ownContracts?: string[];
    /** Raw token types (64 hex) whose zswap offers are sponsored; empty = none. */
    allowedTokenTypes?: string[];
}

export interface GrantPolicyInput {
    allowedContracts?: string[] | null;
    allowedCircuits?: string[] | null;
    allowDeploy?: boolean | null;
    /** Addresses deployed under this grant; sponsorable on top of `floor ∩ grant`. */
    deployedContracts?: string[] | null;
    allowedTokenTypes?: string[] | null;
}

/** Upper bound per list; a grant is one consumer, not a registry. */
export const MAX_POLICY_ENTRIES = 256;
const MAX_ENTRY_LENGTH = 130;

/**
 * Validate an operator allow-list: trimmed, de-duplicated. Malformed entries
 * throw rather than silently never matching.
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

/** Validate raw token types (as in offer `deltas`): lowercase, no 0x, de-duplicated. */
export function validateTokenTypeList(name: string, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`${name} must be an array of strings`);
    if (raw.length > MAX_POLICY_ENTRIES) throw new Error(`${name} has ${raw.length} entries; at most ${MAX_POLICY_ENTRIES} are allowed`);
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') throw new Error(`${name} entries must be strings`);
        const v = entry.trim().toLowerCase().replace(/^0x/, '');
        if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`${name} entry '${entry.trim().slice(0, 32)}' is not a raw token type (64 hex; use deriveTokenType)`);
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

// ---- Platform floor --------------------------------------------------------

function envPolicy(): SponsorPolicy {
    let allowedTokenTypes: string[];
    try {
        allowedTokenTypes = validateTokenTypeList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES', configList('NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES'));
    } catch (e) {
        // Fail closed rather than sponsor under a list that silently lost an entry.
        throw new SponsorPolicyUnavailableError(`${(e as Error).message}; refusing to sponsor`);
    }
    return {
        allowedContracts: configList('NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS'),
        allowedCircuits: configList('NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS'),
        allowDeploy: configFlag('NIGHTGATE_SPONSOR_ALLOW_DEPLOY'),
        allowedTokenTypes
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
    const unknownKeys = Object.keys(parsed).filter(k => k !== 'allowedContracts' && k !== 'allowedCircuits' && k !== 'allowDeploy' && k !== 'allowedTokenTypes');
    if (unknownKeys.length) throw new Error(`policy file has unknown keys: ${unknownKeys.join(', ')}`);
    if (parsed.allowDeploy !== undefined && typeof parsed.allowDeploy !== 'boolean') throw new Error('allowDeploy must be a boolean');
    return {
        allowedContracts: validatePolicyList('allowedContracts', parsed.allowedContracts),
        allowedCircuits: validatePolicyList('allowedCircuits', parsed.allowedCircuits),
        allowDeploy: parsed.allowDeploy === true,
        allowedTokenTypes: validateTokenTypeList('allowedTokenTypes', parsed.allowedTokenTypes)
    };
}

/** Current platform floor: env, or the policy file re-read on mtime/size change. */
export function getGlobalSponsorPolicy(): SponsorPolicy {
    const filePath = configString('NIGHTGATE_SPONSOR_POLICY_FILE');
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
        // Still missing: log once, not per request.
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
            (policy.allowedCircuits.length === 0 ? ' (circuits unrestricted)' : '') +
            `, ${policy.allowedTokenTypes?.length ?? 0} token type(s)`);
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

/** The floor narrowed by the grant; an empty intersection throws before a job exists. */
export function effectiveSponsorPolicy(floor: SponsorPolicy, grant?: GrantPolicyInput | null): SponsorPolicy {
    const contracts = intersect(floor.allowedContracts, grant?.allowedContracts, 'allowedContracts');
    // Deployed addresses join after the intersection; an empty (unrestricted) list stays empty.
    const deployed = [...new Set((grant?.deployedContracts ?? []).filter(a => typeof a === 'string' && a.length > 0))];
    const withDeployed = contracts.length === 0 || deployed.length === 0
        ? contracts
        : [...contracts, ...deployed.filter(a => !contracts.includes(a))];
    // Unlike contracts, an empty token floor means no offers at all.
    const floorTokens = floor.allowedTokenTypes ?? [];
    const grantTokens = (grant?.allowedTokenTypes ?? []).filter(t => typeof t === 'string' && t.length > 0);
    let allowedTokenTypes: string[] = [];
    if (floorTokens.length > 0) {
        if (grantTokens.length === 0) allowedTokenTypes = floorTokens;
        else {
            allowedTokenTypes = grantTokens.filter(t => floorTokens.includes(t));
            if (allowedTokenTypes.length === 0) {
                throw new SponsorPolicyEmptyError(
                    `this grant's allowedTokenTypes (${grantTokens.map(t => t.slice(0, 16)).join(', ')}) share nothing with the platform's ` +
                    'sponsor token-type allow-list; the grant cannot be sponsored here (revoke and re-issue it, or widen the platform policy)');
            }
        }
    }
    return {
        allowedContracts: withDeployed,
        allowedCircuits: intersect(floor.allowedCircuits, grant?.allowedCircuits, 'allowedCircuits'),
        allowedTokenTypes,
        allowDeploy: floor.allowDeploy === true && (grant ? grant.allowDeploy === true : true),
        ...(deployed.length ? { ownContracts: deployed } : {})
    };
}

/** For the OData handlers: the current floor, narrowed by `req.agentGrant`. */
export function resolveSponsorPolicyForRequest(req: unknown): SponsorPolicy {
    const grant = (req as any)?.agentGrant as GrantPolicyInput | undefined;
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
}
